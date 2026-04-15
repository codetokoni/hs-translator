/**
 * Healing Streams Live Translation Server — Final Version
 * Auto-discovers HLS URL via Puppeteer
 * Proper ffmpeg headers for CDN access
 */

const { createClient, LiveTranscriptionEvents } = require("@deepgram/sdk");
const Anthropic  = require("@anthropic-ai/sdk");
const { spawn }  = require("child_process");
const WebSocket  = require("ws");
const express    = require("express");
const http       = require("http");
const cors       = require("cors");
const fs         = require("fs");
const path       = require("path");
const puppeteer  = require("puppeteer");

const DEEPGRAM_KEY  = process.env.DEEPGRAM_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const PORT          = process.env.PORT || 3000;
const STREAM_PAGE   = process.env.STREAM_URL || "https://healingstreams.tv/live";
const RECORDINGS_DIR = "./recordings";

if (!DEEPGRAM_KEY || !ANTHROPIC_KEY) {
  console.error("❌ Missing: DEEPGRAM_KEY, ANTHROPIC_KEY");
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

// ── State ─────────────────────────────────────────────────────
let currentHLSUrl = process.env.HLS_URL || null;
let ffmpegProcess = null;
let dgConnection  = null;
let isDiscovering = false;

const TARGET_LANGUAGES = {
  es:"Spanish", fr:"French",  zh:"Chinese",    ar:"Arabic",
  hi:"Hindi",   pt:"Portuguese", ru:"Russian", de:"German",
  sw:"Swahili", yo:"Yoruba",  ha:"Hausa",      id:"Indonesian",
  it:"Italian", ko:"Korean",  ja:"Japanese",   tr:"Turkish"
};

// ── Puppeteer HLS Discovery ───────────────────────────────────
// Store cookies captured by Puppeteer
let capturedCookies = "";
let capturedUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36";

async function discoverHLSWithPuppeteer() {
  if (isDiscovering) return currentHLSUrl;
  isDiscovering = true;
  console.log("🌐 Opening healingstreams.tv with Puppeteer...");
  let browser = null;
  try {
    browser = await puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox", "--disable-setuid-sandbox",
        "--disable-dev-shm-usage", "--disable-gpu",
        "--no-first-run", "--no-zygote",
        "--single-process", "--disable-extensions"
      ]
    });
    const page = await browser.newPage();

    // Set a real browser user agent
    await page.setUserAgent(capturedUserAgent);

    let foundUrl = null;
    let foundHeaders = {};

    await page.setRequestInterception(true);
    page.on("request", req => {
      const url = req.url();
      if (url.includes(".m3u8") && !foundUrl) {
        foundUrl = url;
        foundHeaders = req.headers();
        console.log(`✅ Puppeteer found HLS URL: ${url}`);
      }
      req.continue();
    });

    page.on("response", async res => {
      const url = res.url();
      if (url.includes(".m3u8") && !foundUrl) {
        foundUrl = url;
        console.log(`✅ Puppeteer response HLS: ${url}`);
      }
    });

    // Navigate to live page
    await page.goto(STREAM_PAGE, { waitUntil: "networkidle2", timeout: 30000 });

    // Wait for stream to start
    if (!foundUrl) await new Promise(r => setTimeout(r, 15000));

    // Try clicking video element
    if (!foundUrl) {
      try {
        await page.click("video");
        await new Promise(r => setTimeout(r, 8000));
      } catch(e) {}
    }

    // Capture cookies from the browser session
    const cookies = await page.cookies();
    if (cookies.length > 0) {
      capturedCookies = cookies.map(c => `${c.name}=${c.value}`).join("; ");
      console.log(`🍪 Captured ${cookies.length} cookies for CDN auth`);
    }

    // Get user agent
    capturedUserAgent = await page.evaluate(() => navigator.userAgent);

    await browser.close(); browser = null;

    if (foundUrl) {
      currentHLSUrl = foundUrl;
      console.log(`✅ HLS URL ready with CDN cookies`);
    }
    return foundUrl;
  } catch(e) {
    console.error("Puppeteer error:", e.message);
    if (browser) { try { await browser.close(); } catch(e2) {} }
    return currentHLSUrl;
  } finally { isDiscovering = false; }
}

// Auto-refresh every 20 minutes
setInterval(async () => {
  console.log("🔄 Auto-refreshing HLS URL...");
  const newUrl = await discoverHLSWithPuppeteer();
  if (newUrl && newUrl !== currentHLSUrl) {
    currentHLSUrl = newUrl;
    console.log("✅ New HLS URL — restarting ffmpeg");
    restartFFmpeg();
  }
}, 20 * 60 * 1000);

// ── ffmpeg ────────────────────────────────────────────────────
function stopFFmpeg() {
  if (ffmpegProcess) {
    try { ffmpegProcess.kill("SIGTERM"); } catch(e) {}
    ffmpegProcess = null;
  }
}

function restartFFmpeg() {
  stopFFmpeg();
  if (dgConnection && currentHLSUrl) {
    setTimeout(() => startFFmpeg(dgConnection, currentHLSUrl), 2000);
  }
}

function startFFmpeg(dg, hlsUrl) {
  stopFFmpeg();
  if (!hlsUrl) { console.error("❌ No HLS URL"); return; }
  console.log(`🎬 ffmpeg starting: ${hlsUrl.substring(0, 80)}...`);

  // Build headers including captured cookies
  let headersStr = `Referer: https://healingstreams.tv/\r\nOrigin: https://healingstreams.tv`;
  if (capturedCookies) {
    headersStr += `\r\nCookie: ${capturedCookies}`;
    console.log("🍪 Using captured cookies for CDN auth");
  }

  const proc = spawn("ffmpeg", [
    "-user_agent", capturedUserAgent,
    "-headers", headersStr,
    "-reconnect", "1",
    "-reconnect_streamed", "1",
    "-reconnect_delay_max", "2",
    "-live_start_index", "-3",
    "-timeout", "10000000",
    "-i", hlsUrl,
    "-vn",
    "-acodec", "pcm_s16le",
    "-ar", "16000",
    "-ac", "1",
    "-f", "s16le",
    "-bufsize", "64k",
    "-loglevel", "warning",
    "pipe:1"
  ]);

  ffmpegProcess = proc;

  proc.stdout.on("data", chunk => {
    if (dg?.getReadyState() === 1) dg.send(chunk);
  });

  proc.stderr.on("data", d => {
    const m = d.toString().trim();
    if (m) console.log("ffmpeg:", m);
  });

  proc.on("close", async code => {
    if (ffmpegProcess !== proc) return;
    console.log(`🔄 ffmpeg closed (${code}) — getting fresh URL...`);
    ffmpegProcess = null;
    global.isLive = false;
    broadcast({ type: "status", live: false });

    // Try Puppeteer first, fall back to same URL
    const newUrl = await discoverHLSWithPuppeteer();
    const urlToUse = newUrl || currentHLSUrl;
    if (urlToUse) {
      global.isLive = true;
      broadcast({ type: "status", live: true });
      setTimeout(() => startFFmpeg(dg, urlToUse), 3000);
    } else {
      const retry = setInterval(async () => {
        const url = await discoverHLSWithPuppeteer();
        if (url) {
          clearInterval(retry);
          global.isLive = true;
          broadcast({ type: "status", live: true });
          startFFmpeg(dg, url);
        }
      }, 30000);
    }
  });

  proc.on("error", async err => {
    console.error("ffmpeg spawn error:", err.message);
    ffmpegProcess = null;
    // If ffmpeg not found, log clearly
    if (err.code === "ENOENT") {
      console.error("❌ ffmpeg not installed! Check Dockerfile.");
    }
  });
}

// ── Session Recording ─────────────────────────────────────────
let currentSession = null;

function startSession() {
  const now = new Date();
  const id = `session_${now.toISOString().replace(/[:.]/g,"-").slice(0,19)}`;
  currentSession = {
    id, startTime: now.toISOString(), endTime: null,
    segments: [], srtIndex: 1,
    paths: {
      json: path.join(RECORDINGS_DIR, `${id}.json`),
      csv:  path.join(RECORDINGS_DIR, `${id}.csv`),
      srt:  path.join(RECORDINGS_DIR, `${id}.srt`),
      txt:  path.join(RECORDINGS_DIR, `${id}_transcript.txt`)
    }
  };
  const hdr = Object.keys(TARGET_LANGUAGES).map(c=>`"${TARGET_LANGUAGES[c]}"`).join(",");
  fs.writeFileSync(currentSession.paths.csv, `"#","Timestamp","Duration","English",${hdr}\n`);
  fs.writeFileSync(currentSession.paths.srt, "");
  fs.writeFileSync(currentSession.paths.txt,
    `Healing Streams Transcript\nSession: ${id}\nStarted: ${now.toLocaleString()}\n${"=".repeat(60)}\n\n`);
  console.log(`📼 Session started: ${id}`);
}

function recordSegment(transcript, translations, t0, t1) {
  if (!currentSession) return;
  const seg = {
    index: currentSession.segments.length + 1,
    timestamp: t0.toISOString(), startTime: t0.toISOString(),
    endTime: t1.toISOString(),
    durationSeconds: ((t1 - t0)/1000).toFixed(1),
    transcript, translations
  };
  currentSession.segments.push(seg);
  fs.writeFileSync(currentSession.paths.json, JSON.stringify({
    session: currentSession.id, startTime: currentSession.startTime,
    totalSegments: currentSession.segments.length,
    languages: Object.keys(TARGET_LANGUAGES),
    segments: currentSession.segments
  }, null, 2));
  const vals = Object.keys(TARGET_LANGUAGES).map(c=>`"${(translations[c]||"").replace(/"/g,'""')}"`).join(",");
  fs.appendFileSync(currentSession.paths.csv,
    `${seg.index},"${seg.timestamp}","${seg.durationSeconds}s","${transcript.replace(/"/g,'""')}",${vals}\n`);
  const s0 = fmtSRT(t0), s1 = fmtSRT(t1);
  fs.appendFileSync(currentSession.paths.srt,
    `${currentSession.srtIndex}\n${s0} --> ${s1}\n${transcript}\n\n`);
  currentSession.srtIndex++;
  fs.appendFileSync(currentSession.paths.txt, `[${t0.toLocaleTimeString()}]\n${transcript}\n\n`);
  console.log(`📝 Segment #${seg.index}: "${transcript.substring(0,60)}"`);
}

function fmtSRT(d) {
  return `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}:${String(d.getSeconds()).padStart(2,"0")},${String(d.getMilliseconds()).padStart(3,"0")}`;
}

function endSession() {
  if (!currentSession) return;
  currentSession.endTime = new Date().toISOString();
  fs.writeFileSync(currentSession.paths.json, JSON.stringify({
    session: currentSession.id, startTime: currentSession.startTime,
    endTime: currentSession.endTime,
    totalSegments: currentSession.segments.length,
    languages: Object.keys(TARGET_LANGUAGES),
    segments: currentSession.segments
  }, null, 2));
  console.log(`📼 Session ended: ${currentSession.segments.length} segments`);
  currentSession = null;
}

// ── Viewers ───────────────────────────────────────────────────
const viewers = new Set();
wss.on("connection", ws => {
  viewers.add(ws);
  console.log(`👁 Viewer connected. Total: ${viewers.size}`);
  if (global.latestTranslation) ws.send(JSON.stringify({ type:"translation", ...global.latestTranslation }));
  ws.send(JSON.stringify({ type:"status", live: global.isLive||false }));
  ws.on("close", () => viewers.delete(ws));
});

function broadcast(data) {
  const msg = JSON.stringify(data);
  viewers.forEach(v => { if (v.readyState === WebSocket.OPEN) v.send(msg); });
}

// ── Translation ───────────────────────────────────────────────
let pendingText = "", translationTimer = null, segmentStart = null;

async function translateText(text, t0) {
  const langStr = Object.entries(TARGET_LANGUAGES).map(([c,n])=>`${n} (${c})`).join(", ");
  const msg = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514", max_tokens: 2000,
    messages: [{ role: "user", content:
      `You are a live ministry translation engine for a Christian healing program.
Translate the following spoken English into: ${langStr}.
Maintain spiritual tone. Respond ONLY with valid JSON. Keys = language codes, values = translations. No markdown.
Text: "${text.replace(/"/g,'\\"')}"` }]
  });
  const raw = msg.content[0].text.replace(/```json|```/g,"").trim();
  const translations = JSON.parse(raw);
  recordSegment(text, translations, t0, new Date());
  return translations;
}

function scheduleTranslation(transcript) {
  if (!segmentStart) segmentStart = new Date();
  pendingText += " " + transcript;
  clearTimeout(translationTimer);
  translationTimer = setTimeout(async () => {
    const text = pendingText.trim(), t0 = segmentStart;
    pendingText = ""; segmentStart = null;
    if (!text) return;
    try {
      const translations = await translateText(text, t0);
      const payload = { translations, transcript: text };
      global.latestTranslation = payload;
      broadcast({ type:"translation", ...payload });
      console.log(`✅ Translated ${Object.keys(translations).length} languages`);
    } catch(e) { console.error("Translation error:", e.message); }
  }, 2500);
}

// ── Pipeline ──────────────────────────────────────────────────
async function startPipeline() {
  console.log("🚀 Starting pipeline...");
  global.isLive = false;
  startSession();
  if (dgConnection) { try { dgConnection.finish(); } catch(e) {} }

  dgConnection = deepgram.listen.live({
    model:"nova-2", language:"en-US",
    smart_format:true, interim_results:true,
    utterance_end_ms:2000,
    endpointing:300,
    vad_events:true,
    keepalive:true
});

dgConnection.on(LiveTranscriptionEvents.Open, async () => {
    console.log("✅ Deepgram connected");

    // Keepalive to prevent timeout during silence/music
    const keepAlive = setInterval(() => {
      try {
        if (dgConnection?.getReadyState() === 1) {
          dgConnection.keepAlive();
        } else { clearInterval(keepAlive); }
      } catch(e) { clearInterval(keepAlive); }
    }, 8000);

    let hlsUrl = currentHLSUrl;
    if (!hlsUrl) hlsUrl = await discoverHLSWithPuppeteer();
    if (hlsUrl) {
      global.isLive = true;
      broadcast({ type:"status", live:true });
      startFFmpeg(dgConnection, hlsUrl);
    } else {
      console.log("⚠️ No HLS URL — retrying in 60s");
      setTimeout(async () => {
        const url = await discoverHLSWithPuppeteer();
        if (url) { global.isLive = true; broadcast({ type:"status", live:true }); startFFmpeg(dgConnection, url); }
      }, 60000);
    }
  });

  dgConnection.on(LiveTranscriptionEvents.Transcript, data => {
    const alt = data.channel?.alternatives?.[0];
    if (!alt?.transcript) return;
    broadcast({ type:"transcript", text:alt.transcript, isFinal:data.is_final });
    if (data.is_final && alt.transcript.trim().split(" ").length >= 5) scheduleTranslation(alt.transcript);
  });

  dgConnection.on(LiveTranscriptionEvents.Close, () => {
    console.log("🔄 Deepgram closed — restarting in 5s...");
    global.isLive = false;
    endSession();
    broadcast({ type:"status", live:false });
    setTimeout(startPipeline, 5000);
  });

  dgConnection.on(LiveTranscriptionEvents.Error, e => console.error("Deepgram:", e.message||e));
}

// ── API ───────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({
  status:"running", live: global.isLive||false,
  viewers: viewers.size, recording: !!currentSession,
  segments: currentSession?.segments.length||0,
  hlsUrl: currentHLSUrl ? currentHLSUrl.substring(0,80)+"..." : "discovering..."
}));

app.post("/update-hls", (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error:"url required" });
  currentHLSUrl = url;
  res.json({ success:true });
  console.log("📡 Manual HLS update — restarting ffmpeg");
  setTimeout(() => {
    if (dgConnection) { global.isLive = true; broadcast({ type:"status", live:true }); startFFmpeg(dgConnection, url); }
  }, 500);
});

app.get("/discover-hls", async (req, res) => {
  const url = await discoverHLSWithPuppeteer();
  if (url && dgConnection) { global.isLive = true; broadcast({ type:"status", live:true }); startFFmpeg(dgConnection, url); }
  res.json({ url: url||null, live: global.isLive||false });
});

app.get("/admin", (req, res) => {
  res.send(`<!DOCTYPE html>
<html><head>
<title>HS Translator Admin</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',sans-serif;background:#0a0a1a;color:#fff;padding:24px;min-height:100vh}
h1{color:#a78bfa;font-size:20px;margin-bottom:4px}
.sub{color:rgba(255,255,255,.4);font-size:13px;margin-bottom:24px}
.card{background:rgba(255,255,255,.05);border:1px solid rgba(124,58,237,.3);border-radius:14px;padding:20px;margin-bottom:16px}
.card h3{font-size:13px;color:#c4b5fd;margin-bottom:12px}
input{width:100%;background:rgba(0,0,0,.4);border:1px solid rgba(124,58,237,.4);color:#fff;border-radius:8px;padding:10px 12px;font-size:13px;margin-bottom:10px;outline:none}
.btn{width:100%;background:linear-gradient(135deg,#7c3aed,#2563eb);color:#fff;border:none;border-radius:8px;padding:12px;font-size:14px;font-weight:700;cursor:pointer;margin-bottom:8px}
.btn2{width:100%;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.15);color:rgba(255,255,255,.7);border-radius:8px;padding:10px;font-size:13px;cursor:pointer}
.status{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.stat{background:rgba(0,0,0,.3);border-radius:8px;padding:12px;text-align:center}
.stat-val{font-size:22px;font-weight:700;color:#a78bfa}
.stat-lbl{font-size:10px;color:rgba(255,255,255,.4);margin-top:2px}
.live-badge{display:inline-block;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:700}
.live-on{background:rgba(74,222,128,.15);color:#4ade80;border:1px solid rgba(74,222,128,.3)}
.live-off{background:rgba(239,68,68,.15);color:#fca5a5;border:1px solid rgba(239,68,68,.3)}
#msg{padding:10px;border-radius:8px;margin-top:8px;display:none;font-size:13px;text-align:center}
.ok{background:rgba(74,222,128,.12);color:#4ade80;border:1px solid rgba(74,222,128,.25)}
.err{background:rgba(239,68,68,.12);color:#fca5a5;border:1px solid rgba(239,68,68,.25)}
.hls-url{word-break:break-all;font-size:11px;color:rgba(255,255,255,.4);margin-top:8px;padding:8px;background:rgba(0,0,0,.3);border-radius:6px}
</style></head>
<body>
<h1>🎙 Healing Streams Translator</h1>
<p class="sub">Admin Dashboard</p>
<div class="card">
  <h3>📊 Server Status</h3>
  <div class="status">
    <div class="stat"><div class="stat-val" id="sv">—</div><div class="stat-lbl">Viewers</div></div>
    <div class="stat"><div class="stat-val" id="ss">—</div><div class="stat-lbl">Segments</div></div>
  </div>
  <div style="text-align:center;margin-top:10px"><span class="live-badge live-off" id="sl">Loading...</span></div>
  <div class="hls-url" id="sh">—</div>
</div>
<div class="card">
  <h3>🔍 Auto-Discover HLS URL</h3>
  <p style="font-size:12px;color:rgba(255,255,255,.4);margin-bottom:12px">Opens healingstreams.tv and finds the stream URL automatically</p>
  <button class="btn" onclick="discover()">🔍 Auto-Discover & Go Live</button>
</div>
<div class="card">
  <h3>📋 Manual Update</h3>
  <input type="text" id="url" placeholder="https://...chunks.m3u8">
  <button class="btn" onclick="update()">⚡ Update & Go Live</button>
  <div id="msg"></div>
</div>
<div class="card">
  <h3>📥 Recordings</h3>
  <button class="btn2" onclick="window.open('/recordings-list','_blank')">View All Recordings</button>
</div>
<script>
async function discover(){showMsg('🔍 Opening healingstreams.tv... (30 sec)',true);try{const r=await fetch('/discover-hls');const d=await r.json();if(d.url){document.getElementById('url').value=d.url;showMsg('✅ Found & applied!',true);loadStatus();}else showMsg('❌ Not found. Try manual.',false);}catch(e){showMsg('❌ '+e.message,false);}}
async function update(){const url=document.getElementById('url').value.trim();if(!url){showMsg('Paste URL first',false);return;}try{const r=await fetch('/update-hls',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url})});const d=await r.json();if(d.success){showMsg('✅ Updated! Restarting...',true);loadStatus();}else showMsg('❌ Failed',false);}catch(e){showMsg('❌ '+e.message,false);}}
function showMsg(t,ok){const m=document.getElementById('msg');m.textContent=t;m.className=ok?'ok':'err';m.style.display='block';}
async function loadStatus(){try{const d=await(await fetch('/')).json();document.getElementById('sv').textContent=d.viewers;document.getElementById('ss').textContent=d.segments;const sl=document.getElementById('sl');sl.textContent=d.live?'● LIVE':'○ Offline';sl.className='live-badge '+(d.live?'live-on':'live-off');document.getElementById('sh').textContent=d.hlsUrl||'Not configured';}catch(e){}}
loadStatus();setInterval(loadStatus,5000);
</script>
</body></html>`);
});

app.get("/update-hls", (req, res) => res.redirect("/admin"));

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
      csv:`/recordings/${currentSession.id}.csv`,
      srt:`/recordings/${currentSession.id}.srt`,
      txt:`/recordings/${currentSession.id}_transcript.txt`
    }
  });
});

app.get("/embed.js", (req, res) => {
  res.setHeader("Content-Type","application/javascript");
  res.sendFile(path.join(__dirname,"translator-embed.js"));
});

server.listen(PORT, () => {
  console.log(`\n🌐 Healing Streams Translation Server — Port ${PORT}`);
  console.log(`📺 Stream: ${STREAM_PAGE}\n`);
  startPipeline();
});
