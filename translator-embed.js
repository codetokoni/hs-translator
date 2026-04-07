(function () {
  'use strict';

  const WS_URL = 'wss://robust-manifestation.up.railway.app'; // ← your Railway URL

  const LANG_NAMES = {
    es:"🇪🇸 Spanish", fr:"🇫🇷 French",   zh:"🇨🇳 Chinese",    ar:"🇸🇦 Arabic",
    hi:"🇮🇳 Hindi",    pt:"🇧🇷 Portuguese",ru:"🇷🇺 Russian",    de:"🇩🇪 German",
    sw:"🇰🇪 Swahili",  yo:"🇳🇬 Yoruba",   ha:"🇳🇬 Hausa",      id:"🇮🇩 Indonesian",
    it:"🇮🇹 Italian",  ko:"🇰🇷 Korean",    ja:"🇯🇵 Japanese",   tr:"🇹🇷 Turkish"
  };

  document.head.insertAdjacentHTML('beforeend', `<style>
    #hstv-fab{position:fixed;bottom:24px;right:24px;z-index:999999;background:linear-gradient(135deg,#7c3aed,#2563eb);color:#fff;border:none;border-radius:50px;padding:12px 22px;font-size:14px;font-weight:700;cursor:pointer;box-shadow:0 4px 24px rgba(124,58,237,.5);display:flex;align-items:center;gap:8px;font-family:'Segoe UI',sans-serif;transition:transform .2s}
    #hstv-fab:hover{transform:scale(1.05)}
    #hstv-live-dot{width:9px;height:9px;border-radius:50%;background:#ef4444;display:none;animation:hstvblink 1s infinite}
    #hstv-live-dot.on{display:inline-block}
    @keyframes hstvblink{0%,100%{opacity:1}50%{opacity:.3}}
    #hstv-panel{position:fixed;bottom:80px;right:24px;z-index:999999;width:420px;max-height:78vh;display:none;flex-direction:column;background:rgba(8,8,24,.97);border:1px solid rgba(124,58,237,.35);border-radius:20px;font-family:'Segoe UI',sans-serif;color:#fff;box-shadow:0 16px 56px rgba(0,0,0,.8);overflow:hidden}
    #hstv-panel.open{display:flex}
    @media(max-width:500px){#hstv-panel{width:calc(100vw - 24px);right:12px;bottom:72px}#hstv-fab{right:12px;bottom:12px}}
    .hstv-head{padding:14px 18px;background:rgba(124,58,237,.18);border-bottom:1px solid rgba(255,255,255,.07);display:flex;align-items:center;justify-content:space-between}
    .hstv-title{font-weight:700;font-size:15px;display:flex;align-items:center;gap:10px}
    .hstv-badge{font-size:10px;padding:2px 8px;border-radius:20px;font-weight:700;display:none}
    .hstv-badge.live{display:inline-block;background:rgba(239,68,68,.2);color:#fca5a5;border:1px solid rgba(239,68,68,.4)}
    .hstv-badge.wait{display:inline-block;background:rgba(255,255,255,.08);color:rgba(255,255,255,.4);border:1px solid rgba(255,255,255,.12)}
    #hstv-close{width:30px;height:30px;border-radius:50%;border:none;background:rgba(255,255,255,.1);color:#fff;cursor:pointer;font-size:15px}
    #hstv-bar{padding:8px 16px;font-size:11px;border-bottom:1px solid rgba(255,255,255,.06);color:rgba(255,255,255,.35)}
    #hstv-tx{padding:10px 16px;font-size:12px;color:rgba(255,255,255,.55);border-bottom:1px solid rgba(255,255,255,.06);min-height:36px;max-height:64px;overflow:hidden;line-height:1.7}
    #hstv-tx .int{color:rgba(255,255,255,.25);font-style:italic}
    #hstv-grid{overflow-y:auto;padding:12px;display:grid;grid-template-columns:1fr 1fr;gap:8px;flex:1}
    .hstv-card{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.07);border-radius:11px;padding:11px;animation:hstvin .35s ease}
    @keyframes hstvin{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}
    .hstv-lang{font-size:11px;font-weight:700;color:#c4b5fd;margin-bottom:5px}
    .hstv-text{font-size:12px;color:rgba(255,255,255,.85);line-height:1.65}
    .hstv-foot{padding:8px 14px;border-top:1px solid rgba(255,255,255,.06);display:flex;justify-content:space-between;align-items:center}
    .hstv-finfo{font-size:11px;color:rgba(255,255,255,.25)}
    .hstv-copy{background:none;border:none;color:rgba(255,255,255,.35);font-size:11px;cursor:pointer;font-family:inherit}
    .hstv-copy:hover{color:#a78bfa}
    #hstv-dl-panel{display:none;padding:12px 14px;border-top:1px solid rgba(255,255,255,.06);background:rgba(0,0,0,.3)}
    #hstv-empty{grid-column:1/-1;padding:32px 16px;text-align:center;color:rgba(255,255,255,.2);font-size:13px;line-height:2}
  </style>`);

  document.body.insertAdjacentHTML('beforeend', `
    <button id="hstv-fab" onclick="hstvToggle()">
      🌐 <span id="hstv-fabtxt">Live Translations</span>
      <span id="hstv-live-dot"></span>
    </button>
    <div id="hstv-panel">
      <div class="hstv-head">
        <div class="hstv-title">
          🌐 Live Translations
          <span class="hstv-badge wait" id="hstv-badge">Connecting...</span>
        </div>
        <button id="hstv-close" onclick="hstvToggle()">✕</button>
      </div>
      <div id="hstv-bar">⏳ Connecting to translation server...</div>
      <div id="hstv-tx"><span style="color:rgba(255,255,255,.2);font-style:italic">Live transcript will appear here...</span></div>
      <div id="hstv-grid">
        <div id="hstv-empty">🌍<br>Translations appear here automatically<br>when the live program is broadcasting</div>
      </div>
      <div class="hstv-foot">
        <span class="hstv-finfo" id="hstv-info"></span>
        <div style="display:flex;gap:8px">
          <button class="hstv-copy" onclick="hstvCopy()">📋 Copy</button>
          <button class="hstv-copy" id="hstv-dl-btn" onclick="hstvDownload()" style="display:none">⬇ Download</button>
        </div>
      </div>
      <div id="hstv-dl-panel">
        <div style="font-size:11px;color:rgba(255,255,255,.4);margin-bottom:8px">📥 Download current session:</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px" id="hstv-dl-links"></div>
      </div>
    </div>
  `);

  window.hstvToggle = () => document.getElementById('hstv-panel').classList.toggle('open');

  window.hstvCopy = () => {
    if (!window._hstvLast) return;
    const text = Object.entries(window._hstvLast).map(([c,t]) => `${LANG_NAMES[c]||c}:\n${t}`).join('\n\n');
    navigator.clipboard?.writeText(text);
  };

  window.hstvDownload = () => {
    const panel = document.getElementById('hstv-dl-panel');
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    if (panel.style.display === 'block') loadDownloadLinks();
  };

  function loadDownloadLinks() {
    const base = WS_URL.replace('wss://','https://').replace('ws://','http://');
    fetch(`${base}/current-session`)
      .then(r => r.json())
      .then(data => {
        if (!data.active) {
          document.getElementById('hstv-dl-links').innerHTML = '<span style="color:rgba(255,255,255,.3);font-size:11px">No active session</span>';
          return;
        }
        const links = [
          { url: data.downloads.json, label: '📄 JSON' },
          { url: data.downloads.csv,  label: '📊 CSV'  },
          { url: data.downloads.srt,  label: '🎬 SRT'  },
          { url: data.downloads.txt,  label: '📝 TXT'  },
        ];
        document.getElementById('hstv-dl-links').innerHTML = links.map(l =>
          `<a href="${base}${l.url}" download style="background:rgba(124,58,237,.25);color:#c4b5fd;border:1px solid rgba(124,58,237,.4);border-radius:8px;padding:5px 12px;font-size:11px;text-decoration:none;font-weight:600">${l.label}</a>`
        ).join('');
      }).catch(() => {
        document.getElementById('hstv-dl-links').innerHTML = '<span style="color:#fca5a5;font-size:11px">Could not load downloads</span>';
      });
  }

  function renderTranslations(obj) {
    window._hstvLast = obj;
    const grid = document.getElementById('hstv-grid');
    grid.innerHTML = '';
    const keys = Object.keys(obj);
    document.getElementById('hstv-info').textContent = `${keys.length} languages`;
    keys.forEach(code => {
      const d = document.createElement('div');
      d.className = 'hstv-card';
      d.innerHTML = `<div class="hstv-lang">${LANG_NAMES[code]||code}</div><div class="hstv-text">${obj[code]}</div>`;
      grid.appendChild(d);
    });
    document.getElementById('hstv-dl-btn').style.display = 'inline';
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
      if (msg.type === 'status')      { setLive(msg.live); }
    };
    ws.onclose = () => {
      setLive(false);
      document.getElementById('hstv-bar').textContent = '🔄 Reconnecting...';
      setTimeout(connect, 3000);
    };
  }

  connect();
})();