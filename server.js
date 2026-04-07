const { createClient, LiveTranscriptionEvents } = require("@deepgram/sdk");
const Anthropic = require("@anthropic-ai/sdk");
const { spawn }  = require("child_process");
const WebSocket  = require("ws");
const express    = require("express");
const http       = require("http");
const cors       = require("cors");
const fs         = require("fs");
const path       = require("path");

const HLS_URL       = process.env.HLS_URL;
const DEEPGRAM_KEY  = process.env.DEEPGRAM_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const PORT          = process.env.PORT || 3000;
const RECORDINGS_DIR = "./recordings";

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
    transcript,
    translations
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
  const ms = date.getMilliseconds();
  const s  = date.getSeconds();
  const m  = date.getMinutes();
  const h  = date.getHours();
  return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")},${String(ms).padStart(3,"0")}`;
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
  ws.on("close", () => { viewers.delete(ws); });
});

function broadcast(data) {
  const msg = JSON.stringify(data);
  viewers.forEach(v => { if (v.readyState === WebSocket.OPEN) v.send(msg); });
}

// ── Translation ───────────────────────────────────────────────
let pendingText = "";
let translationTimer = null;
let segmentStartTime = null;

async function translateText(text, startTime) {
  const langStr = Object.entries(TARGET_LANGUAGES).map(([c,n]) => `${n} (${c})`).join(", ");
  const msg = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2000,
    messages: [{
      role: "user",
      content: `You are a live ministry translation engine for a Christian healing program. Translate the following spoken English text into: ${langStr}.\n\nMaintain the spiritual tone and meaning. Respond ONLY with a valid JSON object where keys are language codes and values are translations. No markdown, no preamble.\n\nText: "${text.replace(/"/g, '\\"')}"`
    }]
  });
  const raw = msg.content[0].text.replace(/```json|```/g, "").trim();
  const translations = JSON.parse(raw);
  const endTime = new Date();
  recordSegment(text, translations, startTime || new Date(), endTime);
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

  dgConnection.on(LiveTranscriptionEvents.Open, () => {
    console.log("✅ Deepgram connected");
    global.isLive = true;
    broadcast({ type: "status", live: true });
    if (HLS_URL) {
      startFFmpeg(dgConnection);
    } else {
      console.log("⚠️  No HLS_URL set — waiting for HLS URL to be configured");
    }
  });

  dgConnection.on(LiveTranscriptionEvents.Transcript, (data) => {
    const alt = data.channel?.alternatives?.[0];
    if (!alt?.transcript) return;
    broadcast({ type: "transcript", text: alt.transcript, isFinal: data.is_final });
    if (data.is_final && alt.transcript.trim().split(" ").length >= 5) {
      scheduleTranslation(alt.transcript);
    }
  });

  dgConnection.on(LiveTranscriptionEvents.Close, () => {
    global.isLive = false;
    endSession();
    broadcast({ type: "status", live: false });
    setTimeout(startPipeline, 5000);
  });

  dgConnection.on(LiveTranscriptionEvents.Error, (e) => console.error("Deepgram error:", e));
}

function startFFmpeg(dgConnection) {
  console.log(`🎬 Starting ffmpeg with: ${HLS_URL}`);
  const ffmpeg = spawn("ffmpeg", [
    "-re", "-i", HLS_URL, "-vn",
    "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
    "-f", "s16le", "-loglevel", "warning", "pipe:1"
  ]);
  ffmpeg.stdout.on("data", chunk => { if (dgConnection.getReadyState() === 1) dgConnection.send(chunk); });
  ffmpeg.stderr.on("data", d => { const m = d.toString(); if (m.includes("error")) console.error("ffmpeg:", m.trim()); });
  ffmpeg.on("close", () => setTimeout(() => startFFmpeg(dgConnection), 3000));
}

// ── API ───────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({
  status: "running", live: global.isLive || false,
  viewers: viewers.size, recording: !!currentSession,
  segments: currentSession?.segments.length || 0
}));

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