(function () {
  'use strict';

  const WS_URL = 'wss://robust-manifestation-production-f1ea.up.railway.app';

  const LANG_NAMES = {
    es:"🇪🇸 Spanish", fr:"🇫🇷 French",   zh:"🇨🇳 Chinese",    ar:"🇸🇦 Arabic",
    hi:"🇮🇳 Hindi",    pt:"🇧🇷 Portuguese",ru:"🇷🇺 Russian",    de:"🇩🇪 German",
    sw:"🇰🇪 Swahili",  yo:"🇳🇬 Yoruba",   ha:"🇳🇬 Hausa",      id:"🇮🇩 Indonesian",
    it:"🇮🇹 Italian",  ko:"🇰🇷 Korean",    ja:"🇯🇵 Japanese",   tr:"🇹🇷 Turkish"
  };

  // Language codes for speech synthesis
  const LANG_SPEECH = {
    es:"es-ES", fr:"fr-FR", zh:"zh-CN", ar:"ar-SA",
    hi:"hi-IN", pt:"pt-BR", ru:"ru-RU", de:"de-DE",
    sw:"sw-KE", yo:"yo-NG", ha:"ha-NG", id:"id-ID",
    it:"it-IT", ko:"ko-KR", ja:"ja-JP", tr:"tr-TR"
  };

  let selectedAudioLang = null;
  let audioEnabled = false;
  let speechQueue = [];
  let isSpeaking = false;

  // ── Styles ────────────────────────────────────────────────────
  document.head.insertAdjacentHTML('beforeend', `<style>
    #hstv-fab{position:fixed;bottom:24px;right:24px;z-index:999999;background:linear-gradient(135deg,#7c3aed,#2563eb);color:#fff;border:none;border-radius:50px;padding:12px 22px;font-size:14px;font-weight:700;cursor:pointer;box-shadow:0 4px 24px rgba(124,58,237,.5);display:flex;align-items:center;gap:8px;font-family:'Segoe UI',sans-serif;transition:transform .2s}
    #hstv-fab:hover{transform:scale(1.05)}
    #hstv-live-dot{width:9px;height:9px;border-radius:50%;background:#ef4444;display:none;animation:hstvblink 1s infinite}
    #hstv-live-dot.on{display:inline-block}
    @keyframes hstvblink{0%,100%{opacity:1}50%{opacity:.3}}
    #hstv-panel{position:fixed;bottom:80px;right:24px;z-index:999999;width:420px;max-height:82vh;display:none;flex-direction:column;background:rgba(8,8,24,.97);border:1px solid rgba(124,58,237,.35);border-radius:20px;font-family:'Segoe UI',sans-serif;color:#fff;box-shadow:0 16px 56px rgba(0,0,0,.8);overflow:hidden}
    #hstv-panel.open{display:flex}
    @media(max-width:500px){#hstv-panel{width:calc(100vw - 24px);right:12px;bottom:72px}#hstv-fab{right:12px;bottom:12px}}
    .hstv-head{padding:14px 18px;background:rgba(124,58,237,.18);border-bottom:1px solid rgba(255,255,255,.07);display:flex;align-items:center;justify-content:space-between}
    .hstv-title{font-weight:700;font-size:15px;display:flex;align-items:center;gap:10px}
    .hstv-badge{font-size:10px;padding:2px 8px;border-radius:20px;font-weight:700;display:none}
    .hstv-badge.live{display:inline-block;background:rgba(239,68,68,.2);color:#fca5a5;border:1px solid rgba(239,68,68,.4)}
    .hstv-badge.wait{display:inline-block;background:rgba(255,255,255,.08);color:rgba(255,255,255,.4);border:1px solid rgba(255,255,255,.12)}
    #hstv-close{width:30px;height:30px;border-radius:50%;border:none;background:rgba(255,255,255,.1);color:#fff;cursor:pointer;font-size:15px}
    #hstv-bar{padding:8px 16px;font-size:11px;border-bottom:1px solid rgba(255,255,255,.06);color:rgba(255,255,255,.35)}

    /* Audio Section */
    #hstv-audio-section{padding:12px 16px;background:rgba(124,58,237,.1);border-bottom:1px solid rgba(255,255,255,.07)}
    .hstv-audio-title{font-size:11px;font-weight:700;color:#c4b5fd;margin-bottom:8px;display:flex;align-items:center;gap:6px}
    #hstv-audio-toggle{background:rgba(124,58,237,.3);border:1px solid rgba(124,58,237,.5);color:#e9d5ff;border-radius:20px;padding:4px 14px;font-size:12px;cursor:pointer;font-family:inherit;transition:all .2s}
    #hstv-audio-toggle.on{background:linear-gradient(135deg,#7c3aed,#2563eb);border-color:transparent;color:#fff}
    #hstv-lang-select{display:none;margin-top:8px}
    #hstv-lang-select.show{display:block}
    #hstv-lang-select select{width:100%;background:rgba(0,0,0,.4);border:1px solid rgba(124,58,237,.4);color:#fff;border-radius:8px;padding:7px 10px;font-size:13px;cursor:pointer;outline:none}
    #hstv-lang-select select option{background:#1a1a2e;color:#fff}
    #hstv-speaking-indicator{display:none;align-items:center;gap:6px;margin-top:6px;font-size:11px;color:#4ade80}
    #hstv-speaking-indicator.on{display:flex}
    .hstv-wave{display:flex;gap:2px;align-items:center}
    .hstv-wave span{width:3px;border-radius:2px;background:#4ade80;animation:hstvwave 0.8s infinite}
    .hstv-wave span:nth-child(1){height:8px;animation-delay:0s}
    .hstv-wave span:nth-child(2){height:14px;animation-delay:.15s}
    .hstv-wave span:nth-child(3){height:10px;animation-delay:.3s}
    .hstv-wave span:nth-child(4){height:6px;animation-delay:.45s}
    @keyframes hstvwave{0%,100%{transform:scaleY(1)}50%{transform:scaleY(1.8)}}
    #hstv-vol-row{display:none;align-items:center;gap:8px;margin-top:6px}
    #hstv-vol-row.show{display:flex}
    #hstv-vol-row label{font-size:11px;color:rgba(255,255,255,.4);white-space:nowrap}
    #hstv-volume{flex:1;accent-color:#7c3aed;cursor:pointer}
    #hstv-speed-row{display:none;align-items:center;gap:8px;margin-top:4px}
    #hstv-speed-row.show{display:flex}
    #hstv-speed-row label{font-size:11px;color:rgba(255,255,255,.4);white-space:nowrap}
    #hstv-speed{flex:1;accent-color:#7c3aed;cursor:pointer}

    #hstv-tx{padding:10px 16px;font-size:12px;color:rgba(255,255,255,.55);border-bottom:1px solid rgba(255,255,255,.06);min-height:36px;max-height:60px;overflow:hidden;line-height:1.7}
    #hstv-tx .int{color:rgba(255,255,255,.25);font-style:italic}
    #hstv-grid{overflow-y:auto;padding:12px;display:grid;grid-template-columns:1fr 1fr;gap:8px;flex:1}
    .hstv-card{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.07);border-radius:11px;padding:11px;animation:hstvin .35s ease;cursor:pointer;transition:all .2s}
    .hstv-card:hover{background:rgba(124,58,237,.15);border-color:rgba(124,58,237,.4)}
    .hstv-card.audio-selected{background:rgba(124,58,237,.25);border-color:rgba(124,58,237,.7);box-shadow:0 0 12px rgba(124,58,237,.3)}
    @keyframes hstvin{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}
    .hstv-lang{font-size:11px;font-weight:700;color:#c4b5fd;margin-bottom:5px;display:flex;align-items:center;justify-content:space-between}
    .hstv-lang-speaker{font-size:13px;opacity:.5}
    .hstv-lang-speaker.active{opacity:1}
    .hstv-text{font-size:12px;color:rgba(255,255,255,.85);line-height:1.65}
    .hstv-foot{padding:8px 14px;border-top:1px solid rgba(255,255,255,.06);display:flex;justify-content:space-between;align-items:center}
    .hstv-finfo{font-size:11px;color:rgba(255,255,255,.25)}
    .hstv-copy{background:none;border:none;color:rgba(255,255,255,.35);font-size:11px;cursor:pointer;font-family:inherit}
    .hstv-copy:hover{color:#a78bfa}
    #hstv-empty{grid-column:1/-1;padding:32px 16px;text-align:center;color:rgba(255,255,255,.2);font-size:13px;line-height:2}
  </style>`);

  // ── UI ────────────────────────────────────────────────────────
  document.body.insertAdjacentHTML('beforeend', `
    <button id="hstv-fab" onclick="hstvToggle()">
      🌐 <span id="hstv-fabtxt">Live Translations</span>
      <span id="hstv-live-dot"></span>
    </button>
    <div id="hstv-panel">
      <div class="hstv-head">
        <div class="hstv-title">🌐 Live Translations <span class="hstv-badge wait" id="hstv-badge">Connecting...</span></div>
        <button id="hstv-close" onclick="hstvToggle()">✕</button>
      </div>
      <div id="hstv-bar">⏳ Connecting to translation server...</div>

      <!-- Audio Section -->
      <div id="hstv-audio-section">
        <div class="hstv-audio-title">
          🔊 Listen in your language
          <button id="hstv-audio-toggle" onclick="hstvToggleAudio()">Enable Audio</button>
        </div>
        <div id="hstv-lang-select">
          <select id="hstv-lang-picker" onchange="hstvSetLang(this.value)">
            <option value="">— Select your language —</option>
            ${Object.entries(LANG_NAMES).map(([c,n]) => `<option value="${c}">${n}</option>`).join('')}
          </select>
        </div>
        <div id="hstv-speaking-indicator">
          <div class="hstv-wave"><span></span><span></span><span></span><span></span></div>
          <span id="hstv-speaking-lang">Speaking...</span>
        </div>
        <div id="hstv-vol-row">
          <label>🔉 Vol</label>
          <input type="range" id="hstv-volume" min="0" max="1" step="0.1" value="1">
        </div>
        <div id="hstv-speed-row">
          <label>⚡ Speed</label>
          <input type="range" id="hstv-speed" min="0.5" max="1.5" step="0.1" value="1">
        </div>
      </div>

      <div id="hstv-tx"><span style="color:rgba(255,255,255,.2);font-style:italic">Live transcript will appear here...</span></div>
      <div id="hstv-grid"><div id="hstv-empty">🌍<br>Translations appear here automatically<br>when the live program is broadcasting</div></div>
      <div class="hstv-foot">
        <span class="hstv-finfo" id="hstv-info"></span>
        <button class="hstv-copy" onclick="hstvCopy()">📋 Copy</button>
      </div>
    </div>
  `);

  // ── Global Functions ──────────────────────────────────────────
  window.hstvToggle = () => document.getElementById('hstv-panel').classList.toggle('open');

  window.hstvToggleAudio = () => {
    audioEnabled = !audioEnabled;
    const btn = document.getElementById('hstv-audio-toggle');
    const langSel = document.getElementById('hstv-lang-select');
    const volRow = document.getElementById('hstv-vol-row');
    const speedRow = document.getElementById('hstv-speed-row');
    if (audioEnabled) {
      btn.textContent = '🔊 Audio ON'; btn.classList.add('on');
      langSel.classList.add('show');
      volRow.classList.add('show');
      speedRow.classList.add('show');
    } else {
      btn.textContent = 'Enable Audio'; btn.classList.remove('on');
      langSel.classList.remove('show');
      volRow.classList.remove('show');
      speedRow.classList.remove('show');
      window.speechSynthesis?.cancel();
      document.getElementById('hstv-speaking-indicator').classList.remove('on');
      selectedAudioLang = null;
      document.querySelectorAll('.hstv-card').forEach(c => c.classList.remove('audio-selected'));
    }
  };

  window.hstvSetLang = (code) => {
    selectedAudioLang = code || null;
    document.querySelectorAll('.hstv-card').forEach(c => c.classList.remove('audio-selected'));
    if (code) {
      const card = document.getElementById(`hstv-card-${code}`);
      if (card) card.classList.add('audio-selected');
    }
  };

  window.hstvCopy = () => {
    if (!window._hstvLast) return;
    const text = Object.entries(window._hstvLast).map(([c,t]) => `${LANG_NAMES[c]||c}:\n${t}`).join('\n\n');
    navigator.clipboard?.writeText(text);
  };

  // ── Text-to-Speech ────────────────────────────────────────────
  function speakText(text, langCode) {
    if (!audioEnabled || !selectedAudioLang || selectedAudioLang !== langCode) return;
    if (!window.speechSynthesis) return;

    const speechLang = LANG_SPEECH[langCode] || langCode;
    const volume = parseFloat(document.getElementById('hstv-volume')?.value || 1);
    const rate   = parseFloat(document.getElementById('hstv-speed')?.value || 1);

    speechQueue.push({ text, speechLang, volume, rate, langCode });
    if (!isSpeaking) processQueue();
  }

  function processQueue() {
    if (speechQueue.length === 0) {
      isSpeaking = false;
      document.getElementById('hstv-speaking-indicator').classList.remove('on');
      return;
    }
    isSpeaking = true;
    const { text, speechLang, volume, rate, langCode } = speechQueue.shift();
    const utt = new SpeechSynthesisUtterance(text);
    utt.lang = speechLang;
    utt.volume = volume;
    utt.rate = rate;

    // Try to find a matching voice
    const voices = window.speechSynthesis.getVoices();
    const match = voices.find(v => v.lang.startsWith(speechLang.split('-')[0]));
    if (match) utt.voice = match;

    const indicator = document.getElementById('hstv-speaking-indicator');
    const speakingLang = document.getElementById('hstv-speaking-lang');
    indicator.classList.add('on');
    if (speakingLang) speakingLang.textContent = `Speaking ${LANG_NAMES[langCode] || langCode}...`;

    utt.onend = () => processQueue();
    utt.onerror = () => processQueue();
    window.speechSynthesis.speak(utt);
  }

  // ── Translations ──────────────────────────────────────────────
  function renderTranslations(obj) {
    window._hstvLast = obj;
    const grid = document.getElementById('hstv-grid');
    grid.innerHTML = '';
    const keys = Object.keys(obj);
    document.getElementById('hstv-info').textContent = `${keys.length} languages`;
    keys.forEach(code => {
      const isSelected = selectedAudioLang === code;
      const d = document.createElement('div');
      d.className = 'hstv-card' + (isSelected ? ' audio-selected' : '');
      d.id = `hstv-card-${code}`;
      d.onclick = () => {
        if (audioEnabled) {
          document.getElementById('hstv-lang-picker').value = code;
          hstvSetLang(code);
        }
      };
      d.innerHTML = `
        <div class="hstv-lang">
          ${LANG_NAMES[code]||code}
          <span class="hstv-lang-speaker ${isSelected && audioEnabled ? 'active' : ''}">🔊</span>
        </div>
        <div class="hstv-text">${obj[code]}</div>
      `;
      grid.appendChild(d);

      // Speak if this is the selected language
      if (obj[code]) speakText(obj[code], code);
    });
  }

  function setLive(live) {
    const badge = document.getElementById('hstv-badge');
    const dot   = document.getElementById('hstv-live-dot');
    const bar   = document.getElementById('hstv-bar');
    if (live) {
      badge.className = 'hstv-badge live'; badge.textContent = '● LIVE';
      dot.classList.add('on');
      bar.textContent = '● LIVE — Translations updating in real time';
      bar.style.color = '#4ade80';
    } else {
      badge.className = 'hstv-badge wait'; badge.textContent = 'Offline';
      dot.classList.remove('on');
      bar.textContent = '📡 Connected — waiting for live program...';
      bar.style.color = 'rgba(255,255,255,.35)';
    }
  }

  let finalText = '';

  function connect() {
    const ws = new WebSocket(`${WS_URL}/?role=viewer`);
    ws.onopen = () => {
      document.getElementById('hstv-bar').textContent = '✅ Connected — waiting for program...';
      document.getElementById('hstv-bar').style.color = 'rgba(74,222,128,.7)';
      document.getElementById('hstv-badge').textContent = 'Connected';
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'transcript') {
        const tx = document.getElementById('hstv-tx');
        if (msg.isFinal) {
          finalText = (finalText + ' ' + msg.text).split(' ').slice(-40).join(' ');
          tx.textContent = finalText;
        } else {
          tx.innerHTML = finalText + ` <span class="int">${msg.text}</span>`;
        }
      }
      if (msg.type === 'translation') { renderTranslations(msg.translations); setLive(true); }
      if (msg.type === 'status') { setLive(msg.live); }
    };
    ws.onclose = () => {
      setLive(false);
      document.getElementById('hstv-bar').textContent = '🔄 Reconnecting...';
      setTimeout(connect, 3000);
    };
  }

  // Load voices when available
  window.speechSynthesis?.addEventListener('voiceschanged', () => {
    window.speechSynthesis.getVoices();
  });

  connect();
})();
