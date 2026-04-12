const { createClient, LiveTranscriptionEvents } = require("@deepgram/sdk");
const Anthropic = require("@anthropic-ai/sdk");
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

// HLS_URL can be set via env or auto-detected
let CURRENT_HLS_URL = process.env.HLS_URL || null;

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

// ── Auto-detect HLS URL ───────────────────────────────────────
async function fetchHLSUrl() {
  return new Promise((resolve) => {
    const options = {
      hostname: 'healingstreams.tv',
      path: '/live',
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      timeout: 10000
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        // Look for m3u8 URL patterns in the page
        const patterns = [
          /https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/g,
          /src["']?\s*[:=]\s*["']([^"']+\.m3u8[^"']*)/g,
          /file["']?\s*[:=]\s*["']([^"']+\.m3u8[^"']*)/g,
          /hls["']?\s*[:=]\s*["']([^"']+\.m3u8[^"']*)/g,
        ];

        for (const pattern of patterns) {
          const matches = data.match(pattern);
          if (matches && matches.length > 0) {
            const url = matches[0].replace(/["']/g, '').trim();
            console.log(`🔍 Auto-detected HLS URL: ${url}`);
            resolve(url);
            return;
          }
        }
        resolve(null);
      });
    });

    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

async function getHLSUrl() {
  // First try auto-detect
  const detected = await fetchHLSUrl();
  if (detected) {
    CURRENT_HLS_URL = detected;
    return detected;
  }
  // Fall back to env variable
  if (CURRENT_HLS_URL) return CURRENT_HLS_URL;
  return null;
}

// Auto-refresh HLS URL every 20 minutes
setInterval(async () => {
  console.log("🔄 Auto-refreshing HLS URL...");
  const newUrl = await fetchHLSUrl();
  if (newUrl && newUrl !== CURRENT_HLS_URL) {
    console.log(`✅ HLS URL updated: ${newUrl}`);
    CURRENT_HLS_URL = newUrl;
  }
}, 20 * 60 * 1000);

// ── Session Recording ─────────────────────────────────────────
let currentSession = null;

function startSession() {
  const now = new Date();
  const dateStr = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const sessionId = `session_${dateStr}`;
  currentSession = {
    id: sessionId,
    startTime: now.toISOString(),
    endTime: null,
    segments: [],
    srtIndex: 1,
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
  const segment = {
    index: currentSession.segments.length + 1,
    timestamp: startTime.toISOString(),
    startTime: startTime.toISOString(),
    endTime: endTime.toISOString(),
    durationSeconds: ((endTime - startTime) / 1000).toFixed(1),
    transcript, translations
  };
  currentSession.segments.push(segment);
  fs.writeFileSync(currentSession.paths.json, JSON.stringify({
    session: currentSession.id,
    startTime: currentSession.startTime,
    totalSegments: currentSession.segments.length,
    languages: Object.keys(TARGET_LANGUAGES),
    segments: currentSession.segments
  }, null, 2));
  const langValues = Object.keys(TARGET_LANGUAGES).map(c => `"${(translations[c] || "").replace(/"/g, '""')}"`).join(",");
  fs.appendFileSync(currentSession.paths.csv, `${segment.index},"${segment.timestamp}","${segment.durationSeconds}s","${transcript.replace(/"/g, '""')}",${langValues}\n`);
  const srtStart = formatSRTTime(startTime);
  const srtEnd   = formatSRTTime(endTime);
  fs.appendFileSync(currentSession.paths.srt, `${currentSession.srtIndex}\n${srtStart} --> ${srtEnd}\n${transcript}\n\n`);
  currentSession.srtIndex++;
  fs.appendFileSync(currentSession.paths.txt, `[${startTime.toLocaleTimeString()}]\n${transcript}\n\n`);
  console.log(`📝 Recorded segment #${segment.index}`);
}

function formatSRTTime(date) {
  return `${String(date.getHours()).padStart(2,"0")}:${String(date.getMinutes()).padStart(2,"0")}:${String(date.getSeconds()).padStart(2,"0")},${String(date.getMilliseconds()).padStart(3,"0")}`;
}

function endSession() {
  if (!currentSession) return;
  currentSession.endTime = new Date().toISOString();
  fs.writeFileSync(currentSession.paths.json, JSON.stringify({
    session: currentSession.id,
    startTime: currentSession.startTime,
    endTime: currentSession.endTime,
    totalSegments: currentSession.segments.length,
    languages: Object.keys(TARGET_LANGUAGES),
    segments: currentSession.segments
  }, null, 2));
  console.log(`📼 Session ended. ${currentSession.segments.length} segments recorded.`);
  currentSession = null;
}

// ── Viewers ───────────────────────────────────────────────────
const viewers = new Set();

wss.on("connection", (ws) => {
  viewers.add(ws);
  console.log(`👁 Viewer connected. Total: ${viewers.size}`);
  if (global.latestTranslation) ws.send(JSON.stringify({ type: "translation", ...global.latestTranslation }));
  ws.send(JSON.stringify({ type: "status", live: global.isLive || false }));
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
    messages: [{ role: "user", content: `You are a live ministry translation engine for a Christian healing program. Translate the following spoken English text into: ${langStr}.\n\nMaintain the spiritual tone and meaning. Respond ONLY with a valid JSON object where keys are language codes and values are translations. No markdown, no preamble.\n\nText: "${text.replace(/"/g, '\\"')}"` }]
  });
  const raw = msg.content[0].text.replace(/```json|```/g, "").trim();
  const translations = JSON.parse(raw);
  recordSegment(text, translations, startTime || new Date(), new Date());
  return translations;
}

function scheduleTranslation(transcript) {
  if (!segmentStartTime) segmentStartTime = new Date();
  pendingText += " " + transcript;
  clearTimeout(translationTimer);
  translationTimer = setTimeout(async () => {
    const text = pendingText.trim();
    const startTime = segmentStartTime;
    pendingText = ""; segmentStartTime = null;
    if (!text) return;
    try {
      const translations = await translateText(text, startTime);
      const payload = { translations, transcript: text };
      global.latestTranslation = payload;
      broadcast({ type: "translation", ...payload });
      console.log(`✅ Translated into ${Object.keys(translations).length} languages`);
    } catch(e) { console.error("Translation error:", e.message); }
  }, 2500);
}

// ── Pipeline ──────────────────────────────────────────────────
async function startPipeline() {
  console.log("🎙 Starting pipeline...");
  global.isLive = false;
  startSession();

  const dgConnection = deepgram.listen.live({
    model: "nova-2", language: "en-US",
    smart_format: true, interim_results: true, utterance_end_ms: 2000
  });

  dgConnection.on(LiveTranscriptionEvents.Open, async () => {
    console.log("✅ Deepgram connected");

    // Try to get HLS URL
    const hlsUrl = await getHLSUrl();
    if (hlsUrl) {
      global.isLive = true;
      broadcast({ type: "status", live: true });
      startFFmpeg(dgConnection, hlsUrl);
    } else {
      console.log("⚠️ No HLS URL available — retrying in 60 seconds");
      setTimeout(async () => {
        const url = await getHLSUrl();
        if (url) {
          global.isLive = true;
          broadcast({ type: "status", live: true });
          startFFmpeg(dgConnection, url);
        }
      }, 60000);
    }
  });

  dgConnection.on(LiveTranscriptionEvents.Transcript, (data) => {
    const alt = data.channel?.alternatives?.[0];
    if (!alt?.transcript) return;
    broadcast({ type: "transcript", text: alt.transcript, isFinal: data.is_final });
    if (data.is_final && alt.transcript.trim().split(" ").length >= 5) scheduleTranslation(alt.transcript);
  });

  dgConnection.on(LiveTranscriptionEvents.Close, () => {
    global.isLive = false;
    endSession();
    broadcast({ type: "status", live: false });
    setTimeout(startPipeline, 5000);
  });

  dgConnection.on(LiveTranscriptionEvents.Error, (e) => console.error("Deepgram error:", e));
}

function startFFmpeg(dgConnection, hlsUrl) {
  console.log(`🎬 Starting ffmpeg: ${hlsUrl}`);
  const ffmpeg = spawn("ffmpeg", [
    "-i", hlsUrl, "-vn",
    "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
    "-f", "s16le", "-bufsize", "64k", "-loglevel", "error", "pipe:1"
  ]);

  ffmpeg.stdout.on("data", chunk => { if (dgConnection.getReadyState() === 1) dgConnection.send(chunk); });

  ffmpeg.on("close", async (code) => {
    console.log(`🔄 ffmpeg closed (${code}) — refreshing HLS URL...`);
    // Auto-get new URL on ffmpeg close
    const newUrl = await getHLSUrl();
    if (newUrl) {
      setTimeout(() => startFFmpeg(dgConnection, newUrl), 3000);
    } else {
      setTimeout(() => startFFmpeg(dgConnection, hlsUrl), 5000);
    }
  });

  ffmpeg.on("error", async (err) => {
    console.error("ffmpeg error:", err.message);
    const newUrl = await getHLSUrl();
    setTimeout(() => startFFmpeg(dgConnection, newUrl || hlsUrl), 5000);
  });
}

// ── API ───────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({
  status: "running", live: global.isLive || false,
  viewers: viewers.size, recording: !!currentSession,
  segments: currentSession?.segments.length || 0,
  hlsUrl: CURRENT_HLS_URL ? "configured" : "not set"
}));

// Manual HLS URL update endpoint
app.post("/update-hls", (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "url required" });
  CURRENT_HLS_URL = url;
  console.log(`📡 HLS URL manually updated: ${url}`);
  res.json({ success: true, url });
});

app.get("/recordings-list", (req, res) => {
  const files = fs.readdirSync(RECORDINGS_DIR);
  const sessions = {};
  files.forEach(f => {
    const base = f.replace(/\.(json|csv|srt|txt)$/, "").replace(/_transcript$/, "");
    if (!sessions[base]) sessions[base] = { name: base, files: [] };
    sessions[base].files.push({ name: f, url: `/recordings/${f}` });
  });
  res.json(Object.values(sessions));
});

app.get("/current-session", (req, res) => {
  if (!currentSession) return res.json({ active: false });
  res.json({
    active: true, id: currentSession.id,
    startTime: currentSession.startTime,
    segments: currentSession.segments.length,
    downloads: {
      json: `/recordings/${currentSession.id}.json`,
      csv:  `/recordings/${currentSession.id}.csv`,
      srt:  `/recordings/${currentSession.id}.srt`,
      txt:  `/recordings/${currentSession.id}_transcript.txt`
    }
  });
});

app.get("/embed.js", (req, res) => {
  res.setHeader("Content-Type", "application/javascript");
  res.sendFile(path.join(__dirname, "translator-embed.js"));
});

server.listen(PORT, () => {
  console.log(`\n🌐 Healing Streams Translation Server running on port ${PORT}\n`);
  startPipeline();
});
