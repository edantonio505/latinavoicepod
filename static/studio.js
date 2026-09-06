/* Latina Voice Studio — no framework, no build step, no CDN. */
'use strict';

// ─── state ──────────────────────────────────────────────────────────────────
const S = {
  cfg: null, ready: false, voices: [], selected: null,
  key: null, authRequired: false,
  pending: null,          // {blob, filename, analysis, grade}
  speaking: false,
};
const $ = (id) => document.getElementById(id);
const KEY_STORE = 'latina.key';

const PHRASES = [
  'Sí, con él.',
  'Buenas tardes, ¿hablo con el señor Benítez?',
  'Claro que sí, con mucho gusto le ayudo a programar su cita para el martes.',
];

// ─── toasts / banner ────────────────────────────────────────────────────────
function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 5200);
}
function banner(msg, bad) {
  const b = $('banner');
  if (!msg) { b.hidden = true; return; }
  b.hidden = false; b.textContent = msg;
  b.className = 'banner' + (bad ? ' bad' : '');
}

// ─── auth ───────────────────────────────────────────────────────────────────
function loadKey() {
  S.key = sessionStorage.getItem(KEY_STORE) || localStorage.getItem(KEY_STORE) || null;
  paintKey();
}
function paintKey() {
  const btn = $('keyBtn');
  btn.hidden = !S.authRequired;
  $('keyState').textContent = S.key ? 'key set' : 'no key';
}
function askKey(reason) {
  return new Promise((resolve) => {
    const dlg = $('keyDialog'), err = $('keyErr');
    err.hidden = !reason; err.textContent = reason || '';
    $('keyInput').value = '';
    dlg.showModal();
    dlg.onclose = () => {
      if (dlg.returnValue !== 'ok') return resolve(false);
      const k = $('keyInput').value.trim();
      if (!k) return resolve(false);
      S.key = k;
      ($('keyRemember').checked ? localStorage : sessionStorage).setItem(KEY_STORE, k);
      paintKey();
      resolve(true);
    };
  });
}

// ─── api: the single place fetch is called ──────────────────────────────────
async function api(path, opts = {}, retry = true) {
  const o = { ...opts, headers: { ...(opts.headers || {}) } };
  if (S.key) o.headers['Authorization'] = 'Bearer ' + S.key;
  let res;
  try {
    res = await fetch(path, o);
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    banner('Cannot reach the service. Is it still running?', true);
    throw new Error('unreachable');
  }
  if (res.status === 401 && retry) {
    S.key = null;
    sessionStorage.removeItem(KEY_STORE); localStorage.removeItem(KEY_STORE);
    paintKey();
    if (await askKey('That key was rejected.')) return api(path, opts, false);
    throw new Error('unauthorized');
  }
  return res;
}
async function apiJSON(path, opts) {
  const res = await api(path, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const d = body.detail;
    const msg = typeof d === 'string' ? d
      : d && d.reasons ? d.reasons.join('; ')
      : `HTTP ${res.status}`;
    const err = new Error(msg); err.status = res.status; err.body = body;
    throw err;
  }
  return body;
}

// ─── health ─────────────────────────────────────────────────────────────────
let healthTimer = null, loadStart = null;
async function pollHealth() {
  let h;
  try {
    h = await (await fetch('/health')).json();
    banner('');
  } catch {
    setPill('bad', 'unreachable');
    banner('Cannot reach the service.', true);
    return schedule(3000);
  }
  if (h.ok) {
    const first = !S.ready;
    S.ready = true;
    setPill('ok', `ready · ${(h.sample_rate / 1000).toFixed(0)} kHz`);
    if (first) {
      if (loadStart) toast(`Model ready in ${((Date.now() - loadStart) / 1000) | 0}s`, 'ok');
      await refreshVoices();
    }
    return schedule(15000);
  }
  S.ready = false;
  loadStart = loadStart || Date.now();
  const secs = ((Date.now() - loadStart) / 1000) | 0;
  setPill('load', `loading model… ${secs}s`);
  banner('VoxCPM2 is loading onto the GPU. With torch.compile enabled this takes '
       + 'around two to three minutes on a cold start.');
  renderSkeleton();
  schedule(2500);
}
function schedule(ms) { clearTimeout(healthTimer); healthTimer = setTimeout(pollHealth, ms); }
function setPill(kind, text) {
  $('healthPill').className = 'pill pill-' + kind;
  $('healthText').textContent = text;
}

// ─── voices ─────────────────────────────────────────────────────────────────
function renderSkeleton() {
  // Deliberately NOT the empty state: /voices really is empty while loading.
  $('voiceList').innerHTML = '<div class="skel"></div><div class="skel"></div>';
}
async function refreshVoices() {
  try {
    const d = await apiJSON('/api/studio/voices');
    S.voices = d.voices || [];
    if (!S.selected || !S.voices.some(v => v.id === S.selected)) {
      S.selected = (S.voices.find(v => v.is_default) || S.voices[0] || {}).id || null;
    }
    renderVoices();
  } catch (e) {
    if (e.message !== 'unauthorized') toast('Could not load voices: ' + e.message, 'bad');
  }
}
function renderVoices() {
  const box = $('voiceList');
  box.innerHTML = '';
  if (!S.voices.length) {
    box.innerHTML = '<p class="muted tiny">No voices yet. Add one below.</p>';
  }
  for (const v of S.voices) {
    const el = document.createElement('div');
    el.className = 'voice' + (v.id === S.selected ? ' sel' : '');
    const q = v.quality ? `<span class="tag ${v.quality}">${v.quality}</span>` : '';
    el.innerHTML = `
      <div class="voice-top">
        <span class="voice-name">${esc(v.id)}</span>
        <span class="voice-acts">
          <button class="iconbtn" data-a="play"  title="Preview clip">▶</button>
          <button class="iconbtn" data-a="check" title="Check quality">◎</button>
          <button class="iconbtn" data-a="del"   title="${v.is_default ? 'Default voice — protected' : 'Delete'}" ${v.is_default ? 'disabled' : ''}>🗑</button>
        </span>
      </div>
      <div class="voice-sub">
        ${v.is_default ? '<span class="tag lock">🔒 default</span>' : ''}${q}
        ${v.reference_text ? '<span class="tag">has transcript</span>' : ''}
      </div>`;
    el.onclick = (ev) => {
      const a = ev.target.dataset?.a;
      if (a === 'play') return previewVoice(v.id);
      if (a === 'check') return checkVoice(v.id);
      if (a === 'del') return deleteVoice(v);
      S.selected = v.id; renderVoices();
    };
    box.appendChild(el);
  }
  const sel = $('voiceSelect');
  sel.innerHTML = S.voices.map(v =>
    `<option value="${esc(v.id)}"${v.id === S.selected ? ' selected' : ''}>${esc(v.id)}</option>`).join('');
  $('speakBtn').disabled = !S.voices.length || !S.ready || S.speaking;
}
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let previewURL = null;
async function previewVoice(id) {
  try {
    const res = await api(`/api/voices/${encodeURIComponent(id)}/audio`);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    // Blob, not <audio src>: require_key is header-only.
    if (previewURL) URL.revokeObjectURL(previewURL);
    previewURL = URL.createObjectURL(await res.blob());
    new Audio(previewURL).play();
  } catch (e) { toast('Preview failed: ' + e.message, 'bad'); }
}
async function checkVoice(id) {
  toast('Analysing ' + id + '…');
  try {
    const d = await apiJSON(`/api/voices/${encodeURIComponent(id)}/analysis`);
    const v = S.voices.find(x => x.id === id); if (v) v.quality = d.grade;
    renderVoices();
    showAnalysis(d, `Quality report — ${id}`, false);
  } catch (e) { toast('Analysis failed: ' + e.message, 'bad'); }
}
async function deleteVoice(v) {
  const dlg = $('confirmDialog');
  $('confirmTitle').textContent = `Delete “${v.id}”?`;
  $('confirmBody').textContent =
    'The clip moves to voices/.trash/ and disappears from /voices, so anything using it will fall back to the default.';
  dlg.showModal();
  dlg.onclose = async () => {
    if (dlg.returnValue !== 'ok') return;
    try {
      await apiJSON(`/api/voices/${encodeURIComponent(v.id)}`, { method: 'DELETE' });
      toast(`Deleted ${v.id}`, 'ok');
      await refreshVoices();
    } catch (e) { toast('Delete failed: ' + e.message, 'bad'); }
  };
}

// ─── WAV helpers ────────────────────────────────────────────────────────────
function encodeWav(chunks, sr) {
  let n = 0; for (const c of chunks) n += c.length;
  const buf = new ArrayBuffer(44 + n * 2), dv = new DataView(buf);
  const put = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  put(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); put(8, 'WAVE');
  put(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true); dv.setUint32(24, sr, true);
  dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  put(36, 'data'); dv.setUint32(40, n * 2, true);
  let o = 44;
  for (const c of chunks) for (let i = 0; i < c.length; i++, o += 2) dv.setInt16(o, c[i], true);
  return new Blob([buf], { type: 'audio/wav' });
}
function b64ToPCM(b64) {
  const bin = atob(b64), bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const dv = new DataView(bytes.buffer), n = bytes.length >> 1, out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = dv.getInt16(i * 2, true);  // matches to_pcm16's '<i2'
  return out;
}

// ─── streaming player ───────────────────────────────────────────────────────
const Player = {
  ctx: null, master: null, anchor: null, sched: 0, sr: 48000,
  live: new Set(), lead: 0.08, underruns: 0, prebuf: [], started: false,

  async begin(sr) {
    this.sr = sr;
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC({ sampleRate: sr, latencyHint: 'interactive' });
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.master.gain.cancelScheduledValues(this.ctx.currentTime);
    this.master.gain.setValueAtTime(1, this.ctx.currentTime);
    this.anchor = null; this.sched = 0; this.underruns = 0;
    this.prebuf = []; this.started = false; this.live.clear();
  },

  // Prebuffer 2 chunks (or ~400 ms) before starting: RTF is 0.65 here but 1.59
  // on the GB10 in AGENTS.md, and above 1.0 immediate playback stutters.
  push(pcm) {
    if (!this.started) {
      this.prebuf.push(pcm);
      const total = this.prebuf.reduce((a, c) => a + c.length, 0);
      if (this.prebuf.length >= 2 || total / this.sr >= 0.4) {
        this.started = true;
        const q = this.prebuf; this.prebuf = [];
        for (const c of q) this._schedule(c);
      }
      return;
    }
    this._schedule(pcm);
  },

  _schedule(pcm) {
    const n = pcm.length, ctx = this.ctx;
    const buf = ctx.createBuffer(1, n, this.sr);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < n; i++) ch[i] = pcm[i] / 32768;

    if (this.anchor === null) {
      this.anchor = ctx.currentTime + this.lead;
      const f = Math.min(0.002 * this.sr, n);           // 2 ms fade-in
      for (let i = 0; i < f; i++) ch[i] *= i / f;
    }
    // Integer sample counter: chunk k+1 starts exactly where k ends.
    let when = this.anchor + this.sched / this.sr;
    if (when < ctx.currentTime + 0.005) {               // underrun -> re-anchor
      this.underruns++;
      this.lead = Math.min(this.lead * 1.6, 0.4);
      this.anchor = ctx.currentTime + this.lead - this.sched / this.sr;
      when = this.anchor + this.sched / this.sr;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf; src.connect(this.master);
    src.start(when);
    src.onended = () => this.live.delete(src);
    this.live.add(src);
    this.sched += n;
  },

  flush() {                                             // stream ended early
    if (!this.started && this.prebuf.length) {
      this.started = true;
      const q = this.prebuf; this.prebuf = [];
      for (const c of q) this._schedule(c);
    }
  },

  stop() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    try {
      this.master.gain.setTargetAtTime(0, t, 0.005);
      for (const s of this.live) { try { s.stop(t + 0.02); } catch {} }
    } catch {}
    this.live.clear(); this.prebuf = []; this.started = false;
  },

  elapsed() {
    if (!this.ctx || this.anchor === null) return 0;
    const lat = this.ctx.outputLatency || 0;
    return Math.max(0, Math.min(this.ctx.currentTime - lat - this.anchor, this.sched / this.sr));
  },
  total() { return this.sched / this.sr; },
};

// ─── speak ──────────────────────────────────────────────────────────────────
let abortCtl = null, lastChunks = null, lastSR = 48000, rafId = null;

async function speak() {
  const text = $('text').value.trim();
  if (!text) return toast('Type something to say first.');
  if (!S.ready) return toast('The model is still loading.');

  S.speaking = true;
  $('speakBtn').disabled = true; $('stopBtn').disabled = false;
  $('dlBtn').disabled = true; $('speakErr').hidden = true;
  $('voiceSelect').disabled = true;
  const chunks = []; let first = null, playAt = null, frames = 0;
  const t0 = performance.now();
  abortCtl = new AbortController();

  try {
    const res = await api('/speak', {
      method: 'POST', signal: abortCtl.signal,
      headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
      body: JSON.stringify({ text, voice: $('voiceSelect').value || undefined }),
    });
    if (res.status === 503) throw new Error('The model is still loading.');
    if (!res.ok) throw new Error('HTTP ' + res.status);

    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = '', done = false, serverMs = null;
    tick();

    while (!done) {
      const { value, done: fin } = await reader.read();
      if (fin) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.search(/\r?\n\r?\n/)) !== -1) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + (buf[i] === '\r' ? 4 : 2));
        if (!raw.startsWith('data:')) continue;
        let ev; try { ev = JSON.parse(raw.slice(5)); } catch { continue; }
        if (ev.error) throw new Error(ev.error);
        if (ev.chunk_b64) {
          if (first === null) {
            first = performance.now() - t0;
            lastSR = ev.sample_rate || 48000;
            await Player.begin(lastSR);
          }
          frames++;
          const pcm = b64ToPCM(ev.chunk_b64);
          chunks.push(pcm);
          Player.push(pcm);
          if (playAt === null && Player.started) playAt = performance.now() - t0;
        }
        if (ev.done || ev.end) { done = true; serverMs = ev.ms; }   // either is terminal
      }
    }
    Player.flush();
    if (playAt === null && Player.started) playAt = performance.now() - t0;

    if (!chunks.length) throw new Error('The stream ended without any audio.');
    lastChunks = chunks; $('dlBtn').disabled = false;

    const dur = chunks.reduce((a, c) => a + c.length, 0) / lastSR;
    const totalMs = serverMs ?? (performance.now() - t0);
    const rtf = (totalMs / 1000) / dur;
    $('stats').innerHTML =
      `first chunk <b>${first | 0} ms</b> · playback ${playAt | 0} ms · `
      + `${dur.toFixed(1)}s audio · RTF ${rtf.toFixed(2)} · ${frames} chunks`
      + (Player.underruns ? ` · <span style="color:var(--warn)">⚠ ${Player.underruns} underrun</span>` : '');

    // AGENTS.md's top deployment failure: something upstream buffering SSE.
    if (!done) {
      toast('Stream ended early — the connection dropped or a proxy closed it.', 'bad');
    } else if (first !== null && first >= 0.9 * totalMs && frames > 2) {
      banner('Every chunk arrived at once, so something in front of this service '
           + 'is buffering the stream (the RunPod HTTPS proxy does this). Playback '
           + 'works, but it is not realtime. An SSH tunnel avoids it.');
    }
  } catch (e) {
    if (e.name === 'AbortError') {
      $('stats').textContent = 'stopped (the server finishes the current utterance)';
    } else if (e.message !== 'unauthorized' && e.message !== 'unreachable') {
      $('speakErr').hidden = false;
      $('speakErr').textContent = e.message;
      if (chunks.length) { lastChunks = chunks; $('dlBtn').disabled = false; }
    }
  } finally {
    S.speaking = false; abortCtl = null;
    $('speakBtn').disabled = !S.ready; $('stopBtn').disabled = true;
    $('voiceSelect').disabled = false;
    cancelAnimationFrame(rafId);
    setTimeout(() => { $('progBar').style.width = '0'; }, 1200);
  }
}
function tick() {
  const t = Player.total();
  $('progBar').style.width = t ? Math.min(100, 100 * Player.elapsed() / t) + '%' : '0';
  rafId = requestAnimationFrame(tick);
}
function stopSpeak() {
  if (abortCtl) abortCtl.abort();
  Player.stop();
}
function download() {
  // Rebuilt from the chunks we already played. Calling /speak.wav again would
  // return DIFFERENT audio (generation is stochastic) and cost another GPU run.
  if (!lastChunks) return;
  const url = URL.createObjectURL(encodeWav(lastChunks, lastSR));
  const a = document.createElement('a');
  a.href = url; a.download = ($('voiceSelect').value || 'voice') + '.wav';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// ─── analysis view ──────────────────────────────────────────────────────────
function showView(which) {
  $('speakView').hidden = which !== 'speak';
  $('analyzeView').hidden = which !== 'analyze';
  $('recView').hidden = which !== 'rec';
}
function showAnalysis(d, title, commit) {
  const a = d.analysis, g = d.grade;
  $('analyzeTitle').textContent = title;
  const headline = {
    good: ['Good reference', 'This clip fills the band the model reads. It should clone well.'],
    fair: ['Usable, with caveats', 'This will clone, but the notes below will each cost you some quality.'],
    poor: ['Poor reference — this will clone badly',
           'The model can only reproduce what is in the reference. Fix the issues below or the '
           + 'voice will sound wrong no matter what settings you use.'],
  }[g];
  $('verdict').className = 'verdict ' + g;
  $('verdict').innerHTML = `<b>${headline[0]}</b>${headline[1]}`;

  drawSpectrum(a);
  drawWave(a.waveform || []);
  $('specNote').textContent =
    `99% of energy below ${Math.round(a.rolloff_99_hz)} Hz · model reads to ${a.model_band_hz / 1000} kHz`;

  $('checks').innerHTML = (d.checks || []).map(c => `
    <div class="chk ${c.level}">
      <div class="chk-head"><span>${esc(c.label)}</span><span class="muted">${esc(c.detail)}</span></div>
      <p><strong>Why:</strong> ${esc(c.why)}</p>
      <p><strong>Fix:</strong> ${esc(c.fix)}</p>
    </div>`).join('') || '<p class="muted tiny">No problems found.</p>';

  const m = [
    ['Duration', a.duration_s.toFixed(1) + ' s'],
    ['Source rate', (a.source_sample_rate || a.sample_rate) + ' Hz'],
    ['99% rolloff', Math.round(a.rolloff_99_hz) + ' Hz'],
    ['Above 4 kHz', a.energy_above_4k_pct.toFixed(2) + ' %'],
    ['SNR', a.snr_db.toFixed(0) + ' dB'],
    ['Peak', a.peak_dbfs.toFixed(1) + ' dBFS'],
    ['Clipped', a.clipped_pct.toFixed(2) + ' %'],
    ['Silence', a.silence_pct.toFixed(0) + ' %'],
  ];
  $('metrics').innerHTML = m.map(([k, v]) =>
    `<div class="metric"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('');

  $('commit').hidden = !commit;
  if (commit) {
    $('saveBtn').textContent = g === 'poor' ? 'Save anyway' : 'Save voice';
    $('saveBtn').className = g === 'poor' ? 'ghost' : 'primary';
    $('reRecBtn').hidden = g !== 'poor';
  }
  showView('analyze');
}
function drawSpectrum(a) {
  const c = $('spectrum'), sp = a.spectrum;
  if (!sp) return;
  const w = c.clientWidth || 600; c.width = w * devicePixelRatio; c.height = 120 * devicePixelRatio;
  const x = c.getContext('2d'); x.scale(devicePixelRatio, devicePixelRatio);
  const css = getComputedStyle(document.body);
  const H = 120, n = sp.db.length, bw = w / n;
  const nyq = (a.sample_rate || 24000) / 2;
  const fx = (f) => w * Math.log(Math.max(f, 80) / 80) / Math.log(nyq / 80);
  x.clearRect(0, 0, w, H);
  // dead zone above the rolloff
  const rx = fx(a.rolloff_99_hz);
  x.fillStyle = css.getPropertyValue('--line'); x.globalAlpha = .45;
  x.fillRect(rx, 0, w - rx, H); x.globalAlpha = 1;
  x.fillStyle = css.getPropertyValue('--accent');
  for (let i = 0; i < n; i++) {
    const h = Math.max(1, H * (sp.db[i] + 90) / 90);
    x.fillRect(i * bw, H - h, Math.max(1, bw - 1), h);
  }
  for (const [f, lab] of [[1000, '1k'], [4000, '4k'], [8000, '8k']]) {
    if (f > nyq) continue;
    const px = fx(f);
    x.strokeStyle = css.getPropertyValue('--muted'); x.globalAlpha = .5;
    x.beginPath(); x.moveTo(px, 0); x.lineTo(px, H); x.stroke(); x.globalAlpha = 1;
    x.fillStyle = css.getPropertyValue('--muted'); x.font = '10px sans-serif';
    x.fillText(lab, px + 3, 11);
  }
}
function drawWave(peaks) {
  const c = $('wave');
  const w = c.clientWidth || 600; c.width = w * devicePixelRatio; c.height = 70 * devicePixelRatio;
  const x = c.getContext('2d'); x.scale(devicePixelRatio, devicePixelRatio);
  const css = getComputedStyle(document.body), H = 70, mid = H / 2;
  x.clearRect(0, 0, w, H);
  x.strokeStyle = css.getPropertyValue('--accent'); x.lineWidth = 1;
  const step = w / Math.max(peaks.length, 1);
  x.beginPath();
  peaks.forEach((p, i) => { const h = p * mid; x.moveTo(i * step, mid - h); x.lineTo(i * step, mid + h); });
  x.stroke();
}

// ─── upload ─────────────────────────────────────────────────────────────────
async function handleFile(blob, filename) {
  S.pending = { blob, filename };
  $('voiceId').value = suggestId(filename);
  $('saveErr').hidden = true;
  toast('Analysing clip…');
  const fd = new FormData();
  fd.append('file', blob, filename);
  fd.append('normalize', $('normalize').checked ? 'true' : 'false');
  try {
    const d = await apiJSON('/api/voices/analyze', { method: 'POST', body: fd });
    S.pending.analysis = d;
    showAnalysis(d, 'Quality report — new clip', true);
  } catch (e) {
    if (e.message === 'unauthorized') return;
    toast('Could not analyse: ' + e.message, 'bad');
  }
}
function suggestId(fn) {
  return (fn || 'voice').replace(/\.[^.]+$/, '').toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_').replace(/[_-]{2,}/g, '_').replace(/^[_-]|[_-]$/g, '').slice(0, 48);
}
async function saveVoice() {
  if (!S.pending) return;
  const id = $('voiceId').value.trim();
  if (id.length < 2) { $('saveErr').hidden = false; $('saveErr').textContent = 'Voice id must be at least 2 characters.'; return; }
  const fd = new FormData();
  fd.append('file', S.pending.blob, S.pending.filename);
  fd.append('voice_id', id);
  fd.append('transcript', $('transcript').value);
  fd.append('normalize', $('normalize').checked ? 'true' : 'false');
  $('saveBtn').disabled = true;
  try {
    const d = await apiJSON('/api/voices/upload', { method: 'POST', body: fd });
    toast(`Saved “${d.id}”`, 'ok');
    S.pending = null; $('transcript').value = '';
    await refreshVoices();
    S.selected = d.id; renderVoices();
    showView('speak');
  } catch (e) {
    if (e.message === 'unauthorized') return;
    $('saveErr').hidden = false;
    $('saveErr').textContent = e.status === 409
      ? `A voice called “${id}” already exists — pick another id.` : e.message;
  } finally { $('saveBtn').disabled = false; }
}

// ─── recording ──────────────────────────────────────────────────────────────
const Rec = { stream: null, rec: null, ctx: null, timer: null, t0: 0, parts: [] };

async function startRec() {
  if (!window.isSecureContext) return;
  try {
    Rec.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        // These three are telephone-band DSP. Leaving them on is exactly how
        // you get the muffled, band-limited reference this tool warns about.
        echoCancellation: false, noiseSuppression: false, autoGainControl: false,
        sampleRate: 48000,
      },
    });
  } catch (e) {
    const msg = e.name === 'NotAllowedError'
      ? 'Microphone permission was denied. Allow it in your browser, or drag a file in instead.'
      : e.name === 'NotFoundError'
      ? 'No microphone found. Drag an audio file in instead.'
      : 'Could not open the microphone: ' + e.message;
    return toast(msg, 'bad');
  }
  const mime = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4']
    .find(m => MediaRecorder.isTypeSupported(m)) || '';
  Rec.parts = [];
  Rec.rec = new MediaRecorder(Rec.stream, mime ? { mimeType: mime, audioBitsPerSecond: 128000 } : undefined);
  Rec.rec.ondataavailable = e => e.data.size && Rec.parts.push(e.data);
  Rec.rec.onstop = finishRec;
  Rec.rec.start();
  Rec.t0 = Date.now();

  const AC = window.AudioContext || window.webkitAudioContext;
  Rec.ctx = new AC();
  const src = Rec.ctx.createMediaStreamSource(Rec.stream);
  const an = Rec.ctx.createAnalyser(); an.fftSize = 1024;
  src.connect(an);
  const data = new Float32Array(an.fftSize);
  Rec.timer = setInterval(() => {
    an.getFloatTimeDomainData(data);
    let peak = 0; for (const v of data) peak = Math.max(peak, Math.abs(v));
    const secs = (Date.now() - Rec.t0) / 1000;
    $('recTime').textContent = secs.toFixed(1) + ' s';
    $('meterFill').style.width = Math.min(100, peak * 140) + '%';
    $('meterFill').className = peak > 0.95 ? 'hot' : '';
    $('recHint').textContent = secs < 4 ? 'Keep going — aim for 4–15 seconds.'
      : secs <= 15 ? '✓ Good length. Stop when you finish the sentence.'
      : 'Getting long — over 30 s will be rejected.';
  }, 100);
  showView('rec');
}
function finishRec() {
  clearInterval(Rec.timer);
  Rec.stream?.getTracks().forEach(t => t.stop());
  Rec.ctx?.close();
  if (!Rec.parts.length) return showView('speak');
  const blob = new Blob(Rec.parts, { type: Rec.parts[0].type || 'audio/webm' });
  const ext = (blob.type.includes('ogg') ? 'ogg' : blob.type.includes('mp4') ? 'm4a' : 'webm');
  $('transcript').value =
    'Buenas tardes, le llamo de parte de la oficina para confirmar su cita del '
    + 'jueves a las tres de la tarde. ¿Le queda bien ese horario?';
  handleFile(blob, `recording.${ext}`);
}

// ─── boot ───────────────────────────────────────────────────────────────────
async function boot() {
  loadKey();
  try {
    S.cfg = await (await fetch('/api/studio')).json();
    S.authRequired = !!S.cfg.auth_required;
    paintKey();
    if (S.authRequired && !S.key) await askKey('');
  } catch {
    banner('Cannot reach the service.', true);
  }

  $('phraseChips').innerHTML = PHRASES.map((p, i) =>
    `<button class="chip" data-i="${i}" type="button">${esc(p.slice(0, 28))}${p.length > 28 ? '…' : ''}</button>`).join('');
  $('phraseChips').onclick = e => {
    const i = e.target.dataset?.i;
    if (i != null) { $('text').value = PHRASES[i]; countChars(); }
  };

  $('speakBtn').onclick = speak;
  $('stopBtn').onclick = stopSpeak;
  $('dlBtn').onclick = download;
  $('voiceSelect').onchange = e => { S.selected = e.target.value; renderVoices(); };
  $('text').oninput = countChars;
  $('backBtn').onclick = () => showView('speak');
  $('saveBtn').onclick = saveVoice;
  $('reRecBtn').onclick = startRec;
  $('addBtn').onclick = () => $('fileInput').click();
  $('pickBtn').onclick = () => $('fileInput').click();
  $('fileInput').onchange = e => { const f = e.target.files[0]; if (f) handleFile(f, f.name); e.target.value = ''; };
  $('recBtn').onclick = startRec;
  $('recStop').onclick = () => Rec.rec?.stop();
  $('recCancel').onclick = () => { Rec.parts = []; Rec.rec?.stop(); showView('speak'); };
  $('healthPill').onclick = () => pollHealth();
  $('keyBtn').onclick = () => askKey('').then(ok => ok && refreshVoices());

  // getUserMedia needs a secure context. Over plain http://<pod-ip>:8088 there
  // is no recording; over the HTTPS proxy recording works but SSE is buffered.
  // An SSH tunnel to localhost is the only setup where both work.
  if (!window.isSecureContext) {
    $('recBtn').disabled = true;
    $('recNote').hidden = false;
    $('recNote').textContent =
      'Recording needs HTTPS or localhost. Upload a file, or tunnel with '
      + '`ssh -L 8088:localhost:8088 …` and open http://localhost:8088/studio/';
  }

  const drop = $('drop');
  ['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => {
    e.preventDefault(); drop.classList.add('over');
  }));
  ['dragleave', 'drop'].forEach(t => drop.addEventListener(t, e => {
    e.preventDefault(); drop.classList.remove('over');
  }));
  drop.addEventListener('drop', e => {
    const f = e.dataTransfer.files[0]; if (f) handleFile(f, f.name);
  });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => e.preventDefault());

  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); speak(); }
    if (e.key === 'Escape' && S.speaking) stopSpeak();
  });

  renderSkeleton();
  pollHealth();
}
function countChars() {
  const n = $('text').value.length;
  $('charCount').textContent = `${n} / 4000`;
}
boot();
