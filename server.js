const { createClient, LiveTranscriptionEvents } = require("@deepgram/sdk");
const Anthropic  = require("@anthropic-ai/sdk");
const { spawn }  = require("child_process");
const WebSocket  = require("ws");
const express    = require("express");
const http       = require("http");
const https      = require("https");
const cors       = require("cors");
const fs         = require("fs");
const path       = require("path");

const DEEPGRAM_KEY  = process.env.DEEPGRAM_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const PORT          = process.env.PORT || 3000;
const RECORDINGS_DIR = "./recordings";

let CURRENT_HLS_URL  = process.env.HLS_URL || null;
let ffmpegProcess    = null;
let dgConnection     = null;
let pipelineRunning  = false;
let restartTimer     = null;

const TARGET_LANGUAGES = {
  es:"Spanish", fr:"French",  zh:"Chinese",    ar:"Arabic",
  hi:"Hindi",   pt:"Portuguese", ru:"Russian", de:"German",
  sw:"Swahili", yo:"Yoruba",  ha:"Hausa",      id:"Indonesian",
  it:"Italian", ko:"Korean",  ja:"Japanese",   tr:"Turkish"
};

if (!DEEPGRAM_KEY || !ANTHROPIC_KEY) {
  console.error("❌ Missing env vars: DEEPGRAM_KEY, ANTHROPIC_KEY");
  process.exit(1);
}
if (!fs.existsSync(RECORDINGS_DIR)) fs.mkdirSync(RECORDINGS_DIR);

const deepgram  = createClient(DEEPGRAM_KEY);
const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });
const app       = express();
const server    = http.createServer(app);
const wss       = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());
app.use("/recordings", express.static(RECORDINGS_DIR));

// ── HLS Auto-Discovery ────────────────────────────────────────
// Tries multiple methods to find the live HLS URL automatically

function httpsGet(url, options = {}) {
  return new Promise((resolve) => {
    const urlObj = new URL(url);
    const reqOptions = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        ...options.headers
      },
      timeout: 15000
    };
    const req = https.request(reqOptions, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(httpsGet(res.headers.location, options));
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

function extractM3U8(html) {
  if (!html) return null;
  // Patterns to find m3u8 URLs in page source
  const patterns = [
    /["'](https?:\/\/[^"']+\.m3u8[^"']*?)["']/g,
    /source\s*[:=]\s*["'](https?:\/\/[^"']+\.m3u8[^"']*?)["']/g,
    /file\s*[:=]\s*["'](https?:\/\/[^"']+\.m3u8[^"']*?)["']/g,
    /src\s*[:=]\s*["'](https?:\/\/[^"']+\.m3u8[^"']*?)["']/g,
    /url\s*[:=]\s*["'](https?:\/\/[^"']+\.m3u8[^"']*?)["']/g,
    /(https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*)/g,
  ];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    const match = pattern.exec(html);
    if (match) {
      const url = (match[1] || match[0]).trim();
      if (url.startsWith('http')) return url;
    }
  }
  return null;
}

async function discoverHLSUrl() {
  console.log("🔍 Discovering HLS URL from healingstreams.tv...");

  // Method 1: Direct page scrape
  const pages = [
    'https://healingstreams.tv/live',
    'https://www.healingstreams.tv/live',
    'https://healingstreams.tv/watch-live',
  ];

  for (const pageUrl of pages) {
    const res = await httpsGet(pageUrl);
    if (res?.body) {
      const url = extractM3U8(res.body);
      if (url) {
        console.log(`✅ Found HLS URL via page scrape: ${url}`);
        return url;
      }
      // Look for JS config files referenced in the page
      const jsMatches = res.body.match(/["'](\/[^"']+\.js[^"']*?)["']/g) || [];
      for (const jsMatch of jsMatches.slice(0, 5)) {
        const jsPath = jsMatch.replace(/["']/g, '');
        if (jsPath.includes('player') || jsPath.includes('live') || jsPath.includes('stream')) {
          const jsRes = await httpsGet(`https://healingstreams.tv${jsPath}`);
          if (jsRes?.body) {
            const jsUrl = extractM3U8(jsRes.body);
            if (jsUrl) {
              console.log(`✅ Found HLS URL in JS file: ${jsUrl}`);
              return jsUrl;
            }
          }
        }
      }
    }
  }

  // Method 2: Try common stream endpoints
  const streamEndpoints = [
    'https://healingstreams.tv/api/stream',
    'https://healingstreams.tv/api/live',
    'https://healingstreams.tv/stream.m3u8',
    'https://live.healingstreams.tv/stream.m3u8',
  ];

  for (const endpoint of streamEndpoints) {
    const res = await httpsGet(endpoint);
    if (res?.status === 200) {
      if (res.body.includes('#EXTM3U') || res.body.includes('.m3u8')) {
        console.log(`✅ Found HLS endpoint: ${endpoint}`);
        return endpoint;
      }
    }
  }

  // Method 3: Fall back to current known URL
  if (CURRENT_HLS_URL) {
    console.log("⚠️ Using cached HLS URL");
    return CURRENT_HLS_URL;
  }

  console.log("❌ Could not auto-discover HLS URL");
  return null;
}

async function validateHLSUrl(url) {
  if (!url) return false;
  try {
    const res = await httpsGet(url);
    return res?.status === 200 && (res.body.includes('#EXTM3U') || res.body.includes('EXTINF'));
  } catch { return false; }
}

async function getValidHLSUrl() {
  // First validate current URL
  if (CURRENT_HLS_URL) {
    const valid = await validateHLSUrl(CURRENT_HLS_URL);
    if (valid) {
      console.log("✅ Current HLS URL is valid");
      return CURRENT_HLS_URL;
    }
    console.log("⚠️ Current HLS URL expired — discovering new one...");
  }
  // Discover new URL
  const newUrl = await discoverHLSUrl();
  if (newUrl) {
    CURRENT_HLS_URL = newUrl;
    broadcast({ type: "hls_updated", url: newUrl });
  }
  return newUrl;
}

// Auto-refresh every 15 minutes
setInterval(async () => {
  console.log("🔄 Scheduled HLS URL refresh...");
  const valid = await validateHLSUrl(CURRENT_HLS_URL);
  if (!valid) {
    console.log("🔄 HLS URL invalid — refreshing...");
    const newUrl = await discoverHLSUrl();
    if (newUrl && newUrl !== CURRENT_HLS_URL) {
      CURRENT_HLS_URL = newUrl;
      console.log("✅ HLS URL refreshed:", newUrl);
      restartFFmpeg();
    }
  }
}, 15 * 60 * 1000);

// ── ffmpeg management ─────────────────────────────────────────
function stopFFmpeg() {
  if (ffmpegProcess) {
    try { ffmpegProcess.kill('SIGTERM'); } catch(e) {}
    ffmpegProcess = null;
  }
}

function restartFFmpeg() {
  stopFFmpeg();
  if (dgConnection) {
    setTimeout(() => startFFmpeg(dgConnection), 2000);
  }
}

// ── Session Recording ─────────────────────────────────────────
let currentSession = null;

function startSession() {
  const now = new Date();
  const sessionId = `session_${now.toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
  currentSession = {
    id: sessionId, startTime: now.toISOString(), endTime: null,
    segments: [], srtIndex: 1,
    paths: {
      json: path.join(RECORDINGS_DIR, `${sessionId}.json`),
      csv:  path.join(RECORDINGS_DIR, `${sessionId}.csv`),
      srt:  path.join(RECORDINGS_DIR, `${sessionId}.srt`),
      txt:  path.join(RECORDINGS_DIR, `${sessionId}_transcript.txt`)
    }
  };
  const langHeaders = Object.keys(TARGET_LANGUAGES).map(c => `"${TARGET_LANGUAGES[c]}"`).join(",");
  fs.writeFileSync(currentSession.paths.csv, `"#","Timestamp","Duration","English Transcript",${langHeaders}\n`);
  fs.writeFileSync(currentSession.paths.srt, "");
  fs.writeFileSync(currentSession.paths.txt, `Healing Streams Live Transcript\nSession: ${sessionId}\nStarted: ${now.toLocaleString()}\n${"=".repeat(60)}\n\n`);
  console.log(`📼 Recording started: ${sessionId}`);
}

function recordSegment(transcript, translations, startTime, endTime) {
  if (!currentSession) return;
  const seg = {
    index: currentSession.segments.length + 1,
    timestamp: startTime.toISOString(),
    startTime: startTime.toISOString(),
    endTime: endTime.toISOString(),
    durationSeconds: ((endTime - startTime) / 1000).toFixed(1),
    transcript, translations
  };
  currentSession.segments.push(seg);
  fs.writeFileSync(currentSession.paths.json, JSON.stringify({
    session: currentSession.id, startTime: currentSession.startTime,
    totalSegments: currentSession.segments.length,
    languages: Object.keys(TARGET_LANGUAGES), segments: currentSession.segments
  }, null, 2));
  const langValues = Object.keys(TARGET_LANGUAGES).map(c => `"${(translations[c]||"").replace(/"/g,'""')}"`).join(",");
  fs.appendFileSync(currentSession.paths.csv, `${seg.index},"${seg.timestamp}","${seg.durationSeconds}s","${transcript.replace(/"/g,'""')}",${langValues}\n`);
  const srtStart = formatSRTTime(startTime), srtEnd = formatSRTTime(endTime);
  fs.appendFileSync(currentSession.paths.srt, `${currentSession.srtIndex}\n${srtStart} --> ${srtEnd}\n${transcript}\n\n`);
  currentSession.srtIndex++;
  fs.appendFileSync(currentSession.paths.txt, `[${startTime.toLocaleTimeString()}]\n${transcript}\n\n`);
  console.log(`📝 Segment #${seg.index}: "${transcript.substring(0,50)}..."`);
}

function formatSRTTime(d) {
  return `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}:${String(d.getSeconds()).padStart(2,"0")},${String(d.getMilliseconds()).padStart(3,"0")}`;
}

function endSession() {
  if (!currentSession) return;
  currentSession.endTime = new Date().toISOString();
  fs.writeFileSync(currentSession.paths.json, JSON.stringify({
    session: currentSession.id, startTime: currentSession.startTime,
    endTime: currentSession.endTime,
    totalSegments: currentSession.segments.length,
    languages: Object.keys(TARGET_LANGUAGES), segments: currentSession.segments
  }, null, 2));
  console.log(`📼 Session ended: ${currentSession.segments.length} segments`);
  currentSession = null;
}

// ── Viewers ───────────────────────────────────────────────────
const viewers = new Set();
wss.on("connection", (ws) => {
  viewers.add(ws);
  console.log(`👁 Viewer connected. Total: ${viewers.size}`);
  if (global.latestTranslation) ws.send(JSON.stringify({ type:"translation", ...global.latestTranslation }));
  ws.send(JSON.stringify({ type:"status", live: global.isLive || false }));
  ws.on("close", () => viewers.delete(ws));
});

function broadcast(data) {
  const msg = JSON.stringify(data);
  viewers.forEach(v => { if (v.readyState === WebSocket.OPEN) v.send(msg); });
}

// ── Translation ───────────────────────────────────────────────
let pendingText = "", translationTimer = null, segmentStartTime = null;

async function translateText(text, startTime) {
  const langStr = Object.entries(TARGET_LANGUAGES).map(([c,n]) => `${n} (${c})`).join(", ");
  const msg = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514", max_tokens: 2000,
    messages:[{role:"user", content:`You are a live ministry translation engine for a Christian healing program. Translate the following spoken English text into: ${langStr}.\n\nMaintain the spiritual tone and meaning. Respond ONLY with a valid JSON object where keys are language codes and values are translations. No markdown, no preamble.\n\nText: "${text.replace(/"/g,'\\"')}"`}]
  });
  const raw = msg.content[0].text.replace(/```json|```/g,"").trim();
  const translations = JSON.parse(raw);
  recordSegment(text, translations, startTime || new Date(), new Date());
  return translations;
}

function scheduleTranslation(transcript) {
  if (!segmentStartTime) segmentStartTime = new Date();
  pendingText += " " + transcript;
  clearTimeout(translationTimer);
  translationTimer = setTimeout(async () => {
    const text = pendingText.trim(), startTime = segmentStartTime;
    pendingText = ""; segmentStartTime = null;
    if (!text) return;
    try {
      const translations = await translateText(text, startTime);
      const payload = { translations, transcript: text };
      global.latestTranslation = payload;
      broadcast({ type:"translation", ...payload });
      console.log(`✅ Translated: "${text.substring(0,50)}..."`);
    } catch(e) { console.error("Translation error:", e.message); }
  }, 2500);
}

// ── Pipeline ──────────────────────────────────────────────────
async function startPipeline() {
  if (pipelineRunning) {
    console.log("⚠️ Pipeline already running — restarting ffmpeg only");
    restartFFmpeg();
    return;
  }
  pipelineRunning = true;
  console.log("🎙 Starting pipeline...");
  global.isLive = false;
  startSession();

  // Close existing connection
  if (dgConnection) { try { dgConnection.finish(); } catch(e) {} dgConnection = null; }

  dgConnection = deepgram.listen.live({
    model:"nova-2", language:"en-US",
    smart_format:true, interim_results:true, utterance_end_ms:2000
  });

  dgConnection.on(LiveTranscriptionEvents.Open, async () => {
    console.log("✅ Deepgram connected");
    const hlsUrl = await getValidHLSUrl();
    if (hlsUrl) {
      global.isLive = true;
      broadcast({ type:"status", live:true });
      startFFmpeg(dgConnection, hlsUrl);
    } else {
      console.log("⚠️ No HLS URL — will retry every 30s");
      const retryInterval = setInterval(async () => {
        const url = await getValidHLSUrl();
        if (url) {
          clearInterval(retryInterval);
          global.isLive = true;
          broadcast({ type:"status", live:true });
          startFFmpeg(dgConnection, url);
        }
      }, 30000);
    }
  });

  dgConnection.on(LiveTranscriptionEvents.Transcript, (data) => {
    const alt = data.channel?.alternatives?.[0];
    if (!alt?.transcript) return;
    broadcast({ type:"transcript", text:alt.transcript, isFinal:data.is_final });
    if (data.is_final && alt.transcript.trim().split(" ").length >= 5) scheduleTranslation(alt.transcript);
  });

  dgConnection.on(LiveTranscriptionEvents.Close, () => {
    console.log("🔄 Deepgram closed — restarting in 5s...");
    pipelineRunning = false;
    global.isLive = false;
    endSession();
    broadcast({ type:"status", live:false });
    clearTimeout(restartTimer);
    restartTimer = setTimeout(startPipeline, 5000);
  });

  dgConnection.on(LiveTranscriptionEvents.Error, (e) => {
    console.error("Deepgram error:", e.message || e);
  });
}

function startFFmpeg(dg, hlsUrl) {
  stopFFmpeg();
  console.log(`🎬 Starting ffmpeg: ${hlsUrl}`);

  const proc = spawn("ffmpeg", [
    "-i", hlsUrl, "-vn",
    "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
    "-f", "s16le", "-bufsize", "64k", "-loglevel", "error", "pipe:1"
  ]);

  ffmpegProcess = proc;

  proc.stdout.on("data", chunk => {
    if (dg?.getReadyState() === 1) dg.send(chunk);
  });

  proc.stderr.on("data", d => {
    const m = d.toString().trim();
    if (m) console.error("ffmpeg:", m);
  });

  proc.on("close", async (code) => {
    if (ffmpegProcess !== proc) return; // Already replaced
    console.log(`🔄 ffmpeg exited (${code}) — getting new HLS URL...`);
    global.isLive = false;
    broadcast({ type:"status", live:false });
    ffmpegProcess = null;

    // Get fresh URL and restart
    const newUrl = await getValidHLSUrl();
    if (newUrl) {
      console.log(`🔄 Restarting with: ${newUrl}`);
      global.isLive = true;
      broadcast({ type:"status", live:true });
      setTimeout(() => startFFmpeg(dg, newUrl), 3000);
    } else {
      // Keep retrying every 30s
      const retryInterval = setInterval(async () => {
        const url = await getValidHLSUrl();
        if (url) {
          clearInterval(retryInterval);
          global.isLive = true;
          broadcast({ type:"status", live:true });
          startFFmpeg(dg, url);
        }
      }, 30000);
    }
  });

  proc.on("error", (err) => {
    console.error("ffmpeg spawn error:", err.message);
    ffmpegProcess = null;
  });
}

// ── API ───────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({
  status:"running", live: global.isLive||false,
  viewers: viewers.size, recording: !!currentSession,
  segments: currentSession?.segments.length||0,
  hlsUrl: CURRENT_HLS_URL || "not set"
}));

// Admin page
app.get("/update-hls", (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>HLS URL Manager</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Segoe UI',sans-serif;background:#0a0a1a;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
    .box{background:rgba(255,255,255,.05);border:1px solid rgba(124,58,237,.4);border-radius:20px;padding:32px;width:100%;max-width:520px}
    h2{color:#a78bfa;margin-bottom:6px;font-size:20px}
    .sub{color:rgba(255,255,255,.4);font-size:13px;margin-bottom:24px}
    label{font-size:12px;color:rgba(255,255,255,.5);display:block;margin-bottom:6px}
    input{width:100%;background:rgba(0,0,0,.4);border:1px solid rgba(124,58,237,.4);color:#fff;border-radius:10px;padding:12px 14px;font-size:13px;margin-bottom:12px;outline:none;transition:border .2s}
    input:focus{border-color:#a78bfa}
    .btn{width:100%;background:linear-gradient(135deg,#7c3aed,#2563eb);color:#fff;border:none;border-radius:10px;padding:14px;font-size:15px;font-weight:700;cursor:pointer;transition:opacity .2s}
    .btn:hover{opacity:.9}
    .btn2{width:100%;background:rgba(255,255,255,.07);color:rgba(255,255,255,.6);border:1px solid rgba(255,255,255,.15);border-radius:10px;padding:12px;font-size:13px;font-weight:600;cursor:pointer;margin-top:10px}
    #msg{margin-top:14px;padding:12px;border-radius:10px;display:none;font-size:13px;text-align:center}
    .ok{background:rgba(74,222,128,.12);color:#4ade80;border:1px solid rgba(74,222,128,.25)}
    .err{background:rgba(239,68,68,.12);color:#fca5a5;border:1px solid rgba(239,68,68,.25)}
    .status-box{margin-top:20px;padding:14px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:10px}
    .status-row{display:flex;justify-content:space-between;align-items:center;font-size:12px;padding:4px 0}
    .status-label{color:rgba(255,255,255,.4)}
    .status-val{font-weight:600}
    .live{color:#4ade80} .offline{color:#fca5a5}
    .instructions{margin-top:20px;padding:14px;background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.2);border-radius:10px;font-size:12px;color:rgba(255,255,255,.6);line-height:1.8}
    .instructions strong{color:#f59e0b}
  </style>
</head>
<body>
<div class="box">
  <h2>🎙 HLS Stream Manager</h2>
  <p class="sub">Healing Streams Live Translation Server</p>

  <label>Stream URL (.m3u8)</label>
  <input type="text" id="url" placeholder="https://...chunks.m3u8" />
  <button class="btn" onclick="updateHLS()">⚡ Update & Restart Stream</button>
  <button class="btn2" onclick="autoDiscover()">🔍 Auto-Discover URL</button>
  <div id="msg"></div>

  <div class="status-box">
    <div class="status-row"><span class="status-label">Server</span><span class="status-val" id="s-status">Loading...</span></div>
    <div class="status-row"><span class="status-label">Stream</span><span class="status-val" id="s-live">—</span></div>
    <div class="status-row"><span class="status-label">Viewers</span><span class="status-val" id="s-viewers">—</span></div>
    <div class="status-row"><span class="status-label">Segments</span><span class="status-val" id="s-segs">—</span></div>
    <div class="status-row"><span class="status-label">HLS URL</span><span class="status-val" id="s-hls" style="font-size:10px;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">—</span></div>
  </div>

  <div class="instructions">
    <strong>How to get the m3u8 URL:</strong><br>
    1. Open healingstreams.tv/live in Chrome<br>
    2. Press F12 → Network tab → type m3u8<br>
    3. Refresh page and play the stream<br>
    4. Click any chunks.m3u8 → copy Request URL<br>
    5. Paste above and click Update
  </div>
</div>
<script>
  async function updateHLS() {
    const url = document.getElementById('url').value.trim();
    if (!url) { showMsg('Please paste a URL first', false); return; }
    showMsg('Updating...', true);
    try {
      const r = await fetch('/update-hls', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({url})
      });
      const d = await r.json();
      if (d.success) { showMsg('✅ Stream updated and restarting!', true); loadStatus(); }
      else showMsg('❌ ' + (d.error||'Update failed'), false);
    } catch(e) { showMsg('❌ ' + e.message, false); }
  }

  async function autoDiscover() {
    showMsg('🔍 Auto-discovering URL...', true);
    try {
      const r = await fetch('/discover-hls');
      const d = await r.json();
      if (d.url) {
        document.getElementById('url').value = d.url;
        showMsg('✅ URL found! Click Update to apply.', true);
      } else showMsg('❌ Could not auto-discover. Please paste manually.', false);
    } catch(e) { showMsg('❌ ' + e.message, false); }
  }

  function showMsg(text, ok) {
    const msg = document.getElementById('msg');
    msg.textContent = text; msg.className = ok ? 'ok' : 'err'; msg.style.display = 'block';
  }

  async function loadStatus() {
    try {
      const r = await fetch('/'); const d = await r.json();
      document.getElementById('s-status').textContent = '🟢 Running';
      document.getElementById('s-live').innerHTML = d.live ? '<span class="live">🟢 LIVE</span>' : '<span class="offline">🔴 Offline</span>';
      document.getElementById('s-viewers').textContent = d.viewers + ' connected';
      document.getElementById('s-segs').textContent = d.segments + ' translated';
      document.getElementById('s-hls').textContent = d.hlsUrl || 'Not set';
      document.getElementById('s-hls').title = d.hlsUrl || '';
    } catch(e) { document.getElementById('s-status').textContent = '🔴 Error'; }
  }

  loadStatus();
  setInterval(loadStatus, 8000);
</script>
</body>
</html>`);
});

// Update HLS URL AND restart ffmpeg immediately
app.post("/update-hls", (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error:"url required" });
  CURRENT_HLS_URL = url;
  console.log(`📡 HLS URL updated: ${url}`);
  res.json({ success:true, url });
  // Restart ffmpeg with new URL immediately
  setTimeout(() => {
    console.log("🔄 Restarting ffmpeg with new URL...");
    if (dgConnection) startFFmpeg(dgConnection, url);
    global.isLive = true;
    broadcast({ type:"status", live:true });
  }, 500);
});

// Trigger auto-discovery
app.get("/discover-hls", async (req, res) => {
  const url = await discoverHLSUrl();
  res.json({ url: url || null });
});

app.get("/recordings-list", (req, res) => {
  const files = fs.readdirSync(RECORDINGS_DIR);
  const sessions = {};
  files.forEach(f => {
    const base = f.replace(/\.(json|csv|srt|txt)$/, "").replace(/_transcript$/, "");
    if (!sessions[base]) sessions[base] = { name:base, files:[] };
    sessions[base].files.push({ name:f, url:`/recordings/${f}` });
  });
  res.json(Object.values(sessions));
});

app.get("/current-session", (req, res) => {
  if (!currentSession) return res.json({ active:false });
  res.json({
    active:true, id:currentSession.id,
    startTime:currentSession.startTime,
    segments:currentSession.segments.length,
    downloads:{
      json:`/recordings/${currentSession.id}.json`,
      csv: `/recordings/${currentSession.id}.csv`,
      srt: `/recordings/${currentSession.id}.srt`,
      txt: `/recordings/${currentSession.id}_transcript.txt`
    }
  });
});

app.get("/embed.js", (req, res) => {
  res.setHeader("Content-Type","application/javascript");
  res.sendFile(path.join(__dirname,"translator-embed.js"));
});

server.listen(PORT, () => {
  console.log(`\n🌐 Healing Streams Translation Server — Port ${PORT}\n`);
  startPipeline();
});
