'use strict';

// ─────────────────────────────────────────────────────────────────
//  HLS Live Translation Server — healingstreams.tv
//  Architecture: Puppeteer discovery → ffmpeg PCM → Deepgram REST
//                → Anthropic translate → WebSocket broadcast
// ─────────────────────────────────────────────────────────────────

const express  = require('express');
const http     = require('http');
const WebSocket = require('ws');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer');
const path     = require('path');
const fs       = require('fs');

// ── Config ───────────────────────────────────────────────────────
const PORT           = process.env.PORT || 3000;
const DEEPGRAM_KEY   = process.env.DEEPGRAM_KEY   || '';
const ANTHROPIC_KEY  = process.env.ANTHROPIC_KEY  || process.env.ANTHROPIC_API_KEY || '';
const HLS_URL_OVERRIDE = process.env.HLS_URL || '';
const STREAM_PAGE    = 'https://healingstreams.tv/live';

const SAMPLE_RATE    = 16000;
const CHANNELS       = 1;
const BYTES_PER_SAMPLE = 2;
const CHUNK_SECONDS  = 6;
const CHUNK_BYTES    = SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE * CHUNK_SECONDS; // 192 000

const LANGUAGES = [
  { code: 'es', name: 'Spanish'    },
  { code: 'fr', name: 'French'     },
  { code: 'de', name: 'German'     },
  { code: 'pt', name: 'Portuguese' },
  { code: 'it', name: 'Italian'    },
  { code: 'ar', name: 'Arabic'     },
  { code: 'ru', name: 'Russian'    },
  { code: 'zh', name: 'Chinese'    },
  { code: 'ja', name: 'Japanese'   },
  { code: 'ko', name: 'Korean'     },
  { code: 'hi', name: 'Hindi'      },
  { code: 'nl', name: 'Dutch'      },
  { code: 'pl', name: 'Polish'     },
  { code: 'tr', name: 'Turkish'    },
  { code: 'sw', name: 'Swahili'    },
  { code: 'id', name: 'Indonesian' },
];

// ── State ────────────────────────────────────────────────────────
const state = {
  status: 'idle',          // idle | discovering | connecting | streaming | error
  hlsUrl: HLS_URL_OVERRIDE || null,
  ffmpegPid: null,
  clientCount: 0,
  chunkCount: 0,
  errorCount: 0,
  lastTranscript: '',
  lastChunkAt: null,
  logs: [],                // ring buffer, max 200 entries
  translations: [],        // ring buffer, max 20 entries
  sseClients: new Set(),   // admin SSE connections
};

function log(level, msg) {
  const entry = { t: new Date().toISOString(), level, msg };
  state.logs.unshift(entry);
  if (state.logs.length > 200) state.logs.pop();
  console[level === 'error' ? 'error' : 'log'](`[${level.toUpperCase()}] ${msg}`);
  broadcastSSE({ type: 'log', ...entry });
}

function broadcastSSE(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of state.sseClients) {
    try { res.write(payload); } catch (_) {}
  }
}

function updateStatus(newStatus) {
  state.status = newStatus;
  broadcastSSE({ type: 'status', status: newStatus, hlsUrl: state.hlsUrl });
}

// ── WAV header builder ───────────────────────────────────────────
function buildWav(pcm) {
  const h = Buffer.alloc(44);
  const dataLen = pcm.length;
  h.write('RIFF',     0);  h.writeUInt32LE(36 + dataLen,                    4);
  h.write('WAVE',     8);  h.write('fmt ',                                  12);
  h.writeUInt32LE(16,  16); h.writeUInt16LE(1,  20); // PCM
  h.writeUInt16LE(CHANNELS,                         22);
  h.writeUInt32LE(SAMPLE_RATE,                      24);
  h.writeUInt32LE(SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE, 28);
  h.writeUInt16LE(CHANNELS * BYTES_PER_SAMPLE,      32);
  h.writeUInt16LE(BYTES_PER_SAMPLE * 8,             34);
  h.write('data', 36);     h.writeUInt32LE(dataLen,                         40);
  return Buffer.concat([h, pcm]);
}

// ── Deepgram REST transcription ──────────────────────────────────
async function transcribeChunk(pcmChunk) {
  const wav = buildWav(pcmChunk);
  const res = await fetch(
    'https://api.deepgram.com/v1/listen?model=nova-2&language=en&punctuate=true&smart_format=true',
    {
      method: 'POST',
      headers: {
        'Authorization': `Token ${DEEPGRAM_KEY}`,
        'Content-Type':  'audio/wav',
      },
      body: wav,
      signal: AbortSignal.timeout(15_000),
    }
  );
  if (!res.ok) {
    const txt = await res.text().catch(() => res.status);
    throw new Error(`Deepgram ${res.status}: ${txt}`);
  }
  const data = await res.json();
  return data?.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() || '';
}

// ── Anthropic translation ─────────────────────────────────────────
async function translateText(text) {
  const langList = LANGUAGES.map(l => `${l.code}: ${l.name}`).join(', ');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key':         ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'content-type':      'application/json',
    },
    body: JSON.stringify({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      system: `You are a real-time sermon/speech translator. Translate the given English text into ALL of these languages and return ONLY a JSON object (no markdown, no extra text) where each key is the two-letter language code and the value is the translation. Languages: ${langList}`,
      messages: [{ role: 'user', content: text }],
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => res.status);
    throw new Error(`Anthropic ${res.status}: ${txt}`);
  }
  const data = await res.json();
  const raw = data.content?.[0]?.text || '{}';
  const clean = raw.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

// ── Puppeteer HLS discovery ───────────────────────────────────────
async function discoverHlsUrl() {
  if (state.hlsUrl) {
    log('info', `Using HLS URL from env/cache: ${state.hlsUrl}`);
    return state.hlsUrl;
  }
  log('info', 'Launching Puppeteer to discover HLS stream URL…');
  updateStatus('discovering');

  const browser = await puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
    ],
    headless: true,
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    // Intercept all network requests and watch for .m3u8
    let found = null;
    page.on('request', req => {
      const url = req.url();
      if (!found && (url.includes('.m3u8') || url.includes('manifest'))) {
        found = url;
        log('info', `Intercepted HLS URL: ${url}`);
      }
    });

    // Also watch XHR/fetch responses
    page.on('response', async res => {
      const url = res.url();
      const ct  = res.headers()['content-type'] || '';
      if (!found && (url.includes('.m3u8') || ct.includes('application/vnd.apple.mpegurl') || ct.includes('application/x-mpegurl'))) {
        found = url;
        log('info', `Found HLS URL in response: ${url}`);
      }
    });

    log('info', `Navigating to ${STREAM_PAGE}…`);
    await page.goto(STREAM_PAGE, { waitUntil: 'networkidle2', timeout: 45_000 });

    // Give the player extra time to initialise
    if (!found) {
      log('info', 'Page loaded, waiting up to 15s for stream initialisation…');
      await new Promise(resolve => setTimeout(resolve, 15_000));
    }

    // Try extracting from page source as fallback
    if (!found) {
      const content = await page.content();
      const match = content.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/);
      if (match) {
        found = match[0];
        log('info', `Extracted HLS URL from page source: ${found}`);
      }
    }

    if (!found) throw new Error('Could not find HLS stream URL on page');

    state.hlsUrl = found;
    return found;
  } finally {
    await browser.close();
  }
}

// ── ffmpeg → PCM pipeline ─────────────────────────────────────────
let ffmpegProc  = null;
let pcmBuffer   = Buffer.alloc(0);
let isProcessing = false;

async function processChunk(chunk) {
  if (!chunk || chunk.length === 0) return;
  const text = await transcribeChunk(chunk).catch(err => {
    log('error', `Deepgram error: ${err.message}`);
    state.errorCount++;
    return '';
  });

  if (!text) {
    log('info', 'Empty transcript — silent/noise chunk, skipping');
    return;
  }

  state.lastTranscript = text;
  state.lastChunkAt    = new Date().toISOString();
  state.chunkCount++;
  log('info', `Transcript [${state.chunkCount}]: ${text}`);

  const translations = await translateText(text).catch(err => {
    log('error', `Anthropic error: ${err.message}`);
    state.errorCount++;
    return {};
  });

  const entry = { ts: Date.now(), text, translations };
  state.translations.unshift(entry);
  if (state.translations.length > 20) state.translations.pop();

  broadcastSSE({ type: 'translation', ...entry });
  broadcastToViewers(entry);
}

function broadcastToViewers(entry) {
  const msg = JSON.stringify({ type: 'translation', ...entry });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

function startFfmpeg(hlsUrl) {
  if (ffmpegProc) {
    log('info', 'Stopping existing ffmpeg process');
    ffmpegProc.kill('SIGTERM');
    ffmpegProc = null;
  }

  log('info', `Starting ffmpeg on: ${hlsUrl}`);
  updateStatus('connecting');

  const proc = spawn('ffmpeg', [
    '-re',
    '-i',       hlsUrl,
    '-vn',                          // no video
    '-acodec',  'pcm_s16le',
    '-ar',      String(SAMPLE_RATE),
    '-ac',      String(CHANNELS),
    '-f',       's16le',            // raw PCM to stdout
    '-',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  ffmpegProc    = proc;
  state.ffmpegPid = proc.pid;
  pcmBuffer     = Buffer.alloc(0);

  proc.stdout.on('data', data => {
    if (state.status !== 'streaming') updateStatus('streaming');
    pcmBuffer = Buffer.concat([pcmBuffer, data]);

    // Drain complete chunks without awaiting (queue them)
    while (pcmBuffer.length >= CHUNK_BYTES) {
      const chunk = pcmBuffer.slice(0, CHUNK_BYTES);
      pcmBuffer   = pcmBuffer.slice(CHUNK_BYTES);
      if (!isProcessing) {
        isProcessing = true;
        processChunk(chunk).finally(() => { isProcessing = false; });
      }
    }
  });

  proc.stderr.on('data', d => {
    const line = d.toString().trim();
    // Only log meaningful ffmpeg lines (suppress verbose frame info)
    if (/error|warn|failed|cannot|invalid/i.test(line)) {
      log('warn', `ffmpeg: ${line.slice(0, 200)}`);
    }
  });

  proc.on('close', code => {
    state.ffmpegPid = null;
    if (code !== 0 && code !== null) {
      log('error', `ffmpeg exited with code ${code}, restarting in 10s…`);
      state.errorCount++;
      updateStatus('error');
      setTimeout(() => startFfmpeg(state.hlsUrl), 10_000);
    } else {
      log('info', 'ffmpeg process ended cleanly');
      updateStatus('idle');
    }
  });

  proc.on('error', err => {
    log('error', `ffmpeg spawn error: ${err.message}`);
    updateStatus('error');
  });
}

// ── Start the whole pipeline ──────────────────────────────────────
async function startPipeline() {
  try {
    const hlsUrl = await discoverHlsUrl();
    startFfmpeg(hlsUrl);
  } catch (err) {
    log('error', `Pipeline start failed: ${err.message}`);
    state.errorCount++;
    updateStatus('error');
    log('info', 'Retrying discovery in 30s…');
    setTimeout(startPipeline, 30_000);
  }
}

// ── Express app ───────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use(express.json());

// WebSocket upgrade tracking
wss.on('connection', (ws, req) => {
  state.clientCount++;
  log('info', `Viewer connected. Total: ${state.clientCount}`);
  broadcastSSE({ type: 'clients', count: state.clientCount });

  ws.send(JSON.stringify({
    type:  'init',
    langs: LANGUAGES,
    last:  state.translations.slice(0, 3),
  }));

  ws.on('close', () => {
    state.clientCount--;
    broadcastSSE({ type: 'clients', count: state.clientCount });
  });
});

// ── Admin SSE endpoint ────────────────────────────────────────────
app.get('/admin/events', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  // Send current state immediately
  res.write(`data: ${JSON.stringify({
    type: 'init',
    status:      state.status,
    hlsUrl:      state.hlsUrl,
    clientCount: state.clientCount,
    chunkCount:  state.chunkCount,
    errorCount:  state.errorCount,
    logs:        state.logs.slice(0, 50),
    translations: state.translations.slice(0, 5),
  })}\n\n`);

  state.sseClients.add(res);
  req.on('close', () => state.sseClients.delete(res));
});

// ── Admin REST endpoints ──────────────────────────────────────────
app.get('/admin/status', (req, res) => {
  res.json({
    status:      state.status,
    hlsUrl:      state.hlsUrl,
    ffmpegPid:   state.ffmpegPid,
    clientCount: state.clientCount,
    chunkCount:  state.chunkCount,
    errorCount:  state.errorCount,
    lastChunkAt: state.lastChunkAt,
    lastTranscript: state.lastTranscript,
  });
});

app.post('/admin/start', async (req, res) => {
  if (state.status === 'streaming' || state.status === 'connecting') {
    return res.json({ ok: false, msg: 'Already running' });
  }
  res.json({ ok: true, msg: 'Starting pipeline…' });
  startPipeline();
});

app.post('/admin/stop', (req, res) => {
  if (ffmpegProc) {
    ffmpegProc.kill('SIGTERM');
    ffmpegProc = null;
  }
  updateStatus('idle');
  res.json({ ok: true, msg: 'Pipeline stopped' });
});

app.post('/admin/rediscover', async (req, res) => {
  state.hlsUrl = HLS_URL_OVERRIDE || null; // clear cache
  res.json({ ok: true, msg: 'Re-discovering HLS URL…' });
  if (ffmpegProc) { ffmpegProc.kill('SIGTERM'); ffmpegProc = null; }
  startPipeline();
});

// ── Admin HTML page ───────────────────────────────────────────────
app.get('/admin', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>HS Translator — Admin</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f1117;color:#e2e8f0;min-height:100vh}
  header{background:#1a1d2e;border-bottom:1px solid #2d3148;padding:16px 24px;display:flex;align-items:center;gap:12px}
  header h1{font-size:18px;font-weight:600;color:#fff}
  header .tag{font-size:11px;background:#6366f1;color:#fff;padding:2px 8px;border-radius:4px}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:24px;max-width:1200px}
  @media(max-width:768px){.grid{grid-template-columns:1fr}}
  .card{background:#1a1d2e;border:1px solid #2d3148;border-radius:10px;padding:20px}
  .card h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;margin-bottom:14px}
  .status-badge{display:inline-flex;align-items:center;gap:6px;padding:4px 12px;border-radius:20px;font-size:13px;font-weight:500}
  .s-idle{background:#1e293b;color:#94a3b8}
  .s-discovering,.s-connecting{background:#312e1a;color:#fbbf24}
  .s-streaming{background:#0f2e1e;color:#34d399}
  .s-error{background:#2e1014;color:#f87171}
  .dot{width:7px;height:7px;border-radius:50%;background:currentColor}
  .dot.pulse{animation:pulse 1.4s infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
  .stat-row{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #1e2340;font-size:14px}
  .stat-row:last-child{border:none}
  .stat-val{color:#fff;font-weight:500;font-variant-numeric:tabular-nums}
  .url-box{font-size:12px;color:#7c83a0;word-break:break-all;margin-top:8px;padding:8px;background:#0f1117;border-radius:6px;min-height:28px}
  .btn{padding:8px 16px;border:none;border-radius:6px;font-size:13px;font-weight:500;cursor:pointer;transition:opacity .15s}
  .btn:hover{opacity:.8}
  .btn-green{background:#059669;color:#fff}
  .btn-red{background:#dc2626;color:#fff}
  .btn-blue{background:#2563eb;color:#fff}
  .btn-row{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}
  .log-list{list-style:none;height:260px;overflow-y:auto;font-size:12px;font-family:monospace}
  .log-list li{padding:3px 0;border-bottom:1px solid #1a1d2e;display:flex;gap:8px;line-height:1.5}
  .log-list li .ts{color:#4a5568;white-space:nowrap;flex-shrink:0}
  .log-list .info{color:#93c5fd}
  .log-list .warn{color:#fcd34d}
  .log-list .error{color:#fca5a5}
  .trans-list{list-style:none;max-height:300px;overflow-y:auto}
  .trans-item{padding:10px 0;border-bottom:1px solid #1e2340}
  .trans-item .orig{font-size:14px;color:#e2e8f0;margin-bottom:6px}
  .trans-item .langs{display:flex;flex-wrap:wrap;gap:6px}
  .trans-item .lang-pill{font-size:11px;background:#1e2340;border-radius:4px;padding:2px 6px;color:#94a3b8}
  .trans-item .lang-pill strong{color:#c4b5fd}
  .last-tx{font-size:13px;color:#d1d5db;padding:10px;background:#0f1117;border-radius:6px;min-height:44px;line-height:1.6}
  .full-width{grid-column:1/-1}
</style>
</head>
<body>
<header>
  <h1>HS Translator</h1>
  <span class="tag">Admin</span>
  <span id="status-badge" class="status-badge s-idle"><span class="dot"></span> idle</span>
</header>

<div class="grid">
  <div class="card">
    <h2>Stream</h2>
    <div class="stat-row"><span>Viewers</span><span class="stat-val" id="clients">0</span></div>
    <div class="stat-row"><span>Chunks processed</span><span class="stat-val" id="chunks">0</span></div>
    <div class="stat-row"><span>Errors</span><span class="stat-val" id="errors">0</span></div>
    <div class="stat-row"><span>Last chunk</span><span class="stat-val" id="last-chunk">—</span></div>
    <div style="margin-top:10px;font-size:12px;color:#64748b">HLS URL</div>
    <div class="url-box" id="hls-url">—</div>
    <div class="btn-row">
      <button class="btn btn-green" onclick="api('start')">▶ Start</button>
      <button class="btn btn-red"   onclick="api('stop')">■ Stop</button>
      <button class="btn btn-blue"  onclick="api('rediscover')">⟳ Re-discover</button>
    </div>
  </div>

  <div class="card">
    <h2>Last transcript</h2>
    <div class="last-tx" id="last-tx">Waiting for audio…</div>
  </div>

  <div class="card full-width">
    <h2>Recent translations</h2>
    <ul class="trans-list" id="trans-list"><li style="color:#4a5568;font-size:13px;padding:8px 0">No translations yet</li></ul>
  </div>

  <div class="card full-width">
    <h2>Log</h2>
    <ul class="log-list" id="log-list"></ul>
  </div>
</div>

<script>
const badge   = document.getElementById('status-badge');
const hlsEl   = document.getElementById('hls-url');
const clientEl = document.getElementById('clients');
const chunkEl  = document.getElementById('chunks');
const errEl    = document.getElementById('errors');
const lastChEl = document.getElementById('last-chunk');
const lastTxEl = document.getElementById('last-tx');
const transList = document.getElementById('trans-list');
const logList   = document.getElementById('log-list');

const STATUS_CLASS = {
  idle:'s-idle', discovering:'s-discovering', connecting:'s-connecting',
  streaming:'s-streaming', error:'s-error'
};

function setStatus(s) {
  badge.className = 'status-badge ' + (STATUS_CLASS[s] || 's-idle');
  badge.innerHTML = '<span class="dot' + (s==='streaming'?' pulse':'') + '"></span> ' + s;
}

function renderLog(entry) {
  const li = document.createElement('li');
  const t = entry.t ? entry.t.slice(11,19) : '';
  li.innerHTML = '<span class="ts">' + t + '</span><span class="' + (entry.level||'info') + '">' + escH(entry.msg) + '</span>';
  logList.insertBefore(li, logList.firstChild);
  while (logList.children.length > 100) logList.removeChild(logList.lastChild);
}

function renderTranslation(entry) {
  if (transList.children.length === 1 && transList.children[0].tagName === 'LI' && transList.children[0].style.color) {
    transList.innerHTML = '';
  }
  const li = document.createElement('li');
  li.className = 'trans-item';
  const pills = Object.entries(entry.translations || {}).slice(0, 8)
    .map(([k,v]) => '<span class="lang-pill"><strong>' + k + '</strong> ' + escH(v.slice(0,40)) + '</span>')
    .join('');
  li.innerHTML = '<div class="orig">' + escH(entry.text) + '</div><div class="langs">' + pills + '</div>';
  transList.insertBefore(li, transList.firstChild);
  while (transList.children.length > 10) transList.removeChild(transList.lastChild);
  lastTxEl.textContent = entry.text;
}

function escH(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function api(action) {
  fetch('/admin/' + action, { method: 'POST' })
    .then(r => r.json()).then(d => console.log(d));
}

// SSE connection
const es = new EventSource('/admin/events');
es.onmessage = e => {
  const d = JSON.parse(e.data);
  if (d.type === 'init') {
    setStatus(d.status);
    hlsEl.textContent = d.hlsUrl || '—';
    clientEl.textContent = d.clientCount;
    chunkEl.textContent  = d.chunkCount;
    errEl.textContent    = d.errorCount;
    (d.logs || []).reverse().forEach(renderLog);
    (d.translations || []).reverse().forEach(renderTranslation);
  } else if (d.type === 'status') {
    setStatus(d.status);
    if (d.hlsUrl) hlsEl.textContent = d.hlsUrl;
  } else if (d.type === 'log') {
    renderLog(d);
  } else if (d.type === 'translation') {
    chunkEl.textContent = parseInt(chunkEl.textContent||0) + 1;
    lastChEl.textContent = new Date().toLocaleTimeString();
    renderTranslation(d);
  } else if (d.type === 'clients') {
    clientEl.textContent = d.count;
  }
};
es.onerror = () => console.warn('SSE connection dropped, will reconnect…');
</script>
</body>
</html>`);
});

// ── Health check ──────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ ok: true, status: state.status, clients: state.clientCount });
});

// ── Viewer embed snippet ──────────────────────────────────────────
app.get('/embed.js', (req, res) => {
  const host = `wss://${req.headers.host}`;
  res.setHeader('Content-Type', 'application/javascript');
  res.send(`
(function(){
  var LANGS=${JSON.stringify(LANGUAGES)};
  var ws=null;var sel='en';
  function connect(){
    ws=new WebSocket('${host}');
    ws.onopen=function(){console.log('[HS Translator] connected')};
    ws.onmessage=function(e){
      var d=JSON.parse(e.data);
      if(d.type==='translation'){
        var t=d.translations[sel]||d.text;
        var el=document.getElementById('hs-translation');
        if(el) el.textContent=t;
        document.dispatchEvent(new CustomEvent('hs-translation',{detail:{text:t,lang:sel,all:d}}));
      }
    };
    ws.onclose=function(){setTimeout(connect,5000)};
  }
  connect();
  window.HSTranslator={setLang:function(l){sel=l},langs:LANGS};
})();
  `);
});

// ── Start server ──────────────────────────────────────────────────
server.listen(PORT, () => {
  log('info', `Server listening on port ${PORT}`);
  log('info', `Admin UI: http://localhost:${PORT}/admin`);
  // Auto-start pipeline
  startPipeline();
});

process.on('SIGTERM', () => {
  log('info', 'SIGTERM received, shutting down');
  if (ffmpegProc) ffmpegProc.kill('SIGTERM');
  server.close(() => process.exit(0));
});
