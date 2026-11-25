const NAMES = ['Lead', 'Tenor', 'Voice 3', 'Voice 4'];
const ctx = new (window.AudioContext || window.webkitAudioContext)();
const tracks = NAMES.map(() => ({ buffer: null, gain: 1, muted: false, nudge: 0 }));

// One permanent volume control per track, so volume and mute work live
const trackGain = NAMES.map(() => {
  const g = ctx.createGain();
  g.connect(ctx.destination);
  return g;
});

let sources = [];
let recorder = null;
let stream = null;
let isRecording = false;
let lastMixSaved = true;

// Playback position tracking
let playing = false;
let startedAt = 0;   // audio clock time when playback started
let startedPos = 0;  // song position (seconds) at that moment
let pausedPos = 0;   // where we are when paused
let seeking = false;
let restartTimer = null;
let lastRestart = 0;
let pendingPos = null;

const statusEl = document.getElementById('status');
const micSelect = document.getElementById('micSelect');
const outSelect = document.getElementById('outSelect');
const seek = document.getElementById('seek');
const curTime = document.getElementById('curTime');
const durTime = document.getElementById('durTime');
const playPauseBtn = document.getElementById('playPause');

function say(t) { statusEl.textContent = t; }

// ---------- Microphone and output pickers ----------
async function loadDevices() {
  try {
    // A quick permission request is needed before device names show up
    const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
    tmp.getTracks().forEach(t => t.stop());
  } catch (e) {
    say('Allow microphone access to see your mics.');
  }
  const devices = await navigator.mediaDevices.enumerateDevices();
  const prevMic = micSelect.value;
  micSelect.innerHTML = '';
  devices.filter(d => d.kind === 'audioinput').forEach((d, n) => {
    const o = document.createElement('option');
    o.value = d.deviceId;
    o.textContent = d.label || ('Microphone ' + (n + 1));
    micSelect.appendChild(o);
  });
  if (prevMic) micSelect.value = prevMic;

  const prevOut = outSelect.value;
  outSelect.innerHTML = `<option value='default'>Default (earbuds if connected)</option>`;
  devices.filter(d => d.kind === 'audiooutput').forEach((d, n) => {
    const o = document.createElement('option');
    o.value = d.deviceId;
    o.textContent = d.label || ('Speaker ' + (n + 1));
    outSelect.appendChild(o);
  });
  if (prevOut) outSelect.value = prevOut;
}
document.getElementById('micRefresh').onclick = loadDevices;
if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
  navigator.mediaDevices.addEventListener('devicechange', loadDevices);
}
loadDevices();

async function applyOutput() {
  if (ctx.setSinkId && outSelect.value) {
    try { await ctx.setSinkId(outSelect.value === 'default' ? '' : outSelect.value); }
    catch (e) { /* not supported here, playback just uses the default */ }
  }
}
outSelect.onchange = applyOutput;

// ---------- Volume and mute (live) ----------
function applyGain(i) {
  const t = tracks[i];
  trackGain[i].gain.setTargetAtTime(t.muted ? 0 : t.gain, ctx.currentTime, 0.01);
}

// ---------- Timing nudge (live) ----------
function setNudge(i, ms) {
  ms = Math.max(-2000, Math.min(2000, Math.round(ms)));
  tracks[i].nudge = ms;
  document.getElementById('nudge' + i).value = ms;
  document.getElementById('nudgeLabel' + i).textContent = ms;
  lastMixSaved = false;
  scheduleRestart();
}

// ---------- Build the track UI ----------
const container = document.getElementById('tracks');
NAMES.forEach((name, i) => {
  const div = document.createElement('div');
  div.className = 'track';
  div.innerHTML = `
    <h3>${name}</h3>
    <button class='rec' id='rec${i}'>Record</button>
    <button id='mute${i}'>Mute</button>
    <label>Volume
      <input type='range' id='vol${i}' min='0' max='150' value='100'>
    </label>
    <label>Timing nudge: <span id='nudgeLabel${i}'>0</span> ms <small>(left = earlier, right = later)</small>
      <input type='range' id='nudge${i}' min='-2000' max='2000' step='1' value='0'>
    </label>
    <div class='nudgerow'>
      <button class='nb' data-ms='-10'>-10</button>
      <button class='nb' data-ms='-1'>-1</button>
      <button class='nb' data-ms='1'>+1</button>
      <button class='nb' data-ms='10'>+10</button>
      <button class='nb' data-ms='reset'>Reset</button>
    </div>`;
  container.appendChild(div);

  document.getElementById('rec' + i).onclick = () => toggleRecord(i);

  document.getElementById('mute' + i).onclick = (e) => {
    tracks[i].muted = !tracks[i].muted;
    e.target.textContent = tracks[i].muted ? 'Unmute' : 'Mute';
    e.target.classList.toggle('on', tracks[i].muted);
    applyGain(i);
  };

  document.getElementById('vol' + i).oninput = (e) => {
    tracks[i].gain = e.target.value / 100;
    applyGain(i);
  };

  document.getElementById('nudge' + i).oninput = (e) => setNudge(i, Number(e.target.value));
  div.querySelectorAll('.nb').forEach(b => {
    b.onclick = () => {
      if (b.dataset.ms === 'reset') setNudge(i, 0);
      else setNudge(i, tracks[i].nudge + Number(b.dataset.ms));
    };
  });
});

const offsetInput = document.getElementById('offset');
offsetInput.oninput = () => {
  document.getElementById('offsetLabel').textContent = offsetInput.value;
};

// ---------- Playback engine ----------
function totalDuration() {
  let d = 0;
  tracks.forEach(t => {
    if (t.buffer) d = Math.max(d, t.nudge / 1000 + t.buffer.duration);
  });
  return d;
}

function currentPos() {
  if (!playing) return pausedPos;
  return Math.max(startedPos, startedPos + (ctx.currentTime - startedAt));
}

function fmt(s) {
  s = Math.max(0, s);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return m + ':' + r.toFixed(1).padStart(4, '0');
}

function stopSources() {
  sources.forEach(s => { try { s.stop(); } catch (e) {} });
  sources = [];
}

// Start playing from a spot in the song. Each track begins where its nudge says.
function playFrom(pos, upTo) {
  stopSources();
  const when = ctx.currentTime + 0.05;
  for (let i = 0; i < upTo; i++) {
    const t = tracks[i];
    if (!t.buffer) continue;
    const into = pos - t.nudge / 1000;   // how far into this recording we should be
    let delay = 0;
    let offset = into;
    if (into < 0) { delay = -into; offset = 0; }
    if (offset >= t.buffer.duration) continue;
    const src = ctx.createBufferSource();
    src.buffer = t.buffer;
    src.connect(trackGain[i]);
    src.start(when + delay, offset);
    sources.push(src);
  }
  playing = true;
  startedAt = when;
  startedPos = pos;
  playPauseBtn.textContent = 'Pause';
}

function pausePlayback() {
  if (playing) pausedPos = currentPos();
  stopSources();
  playing = false;
  playPauseBtn.textContent = 'Play';
}

// Restart playback from the same spot (or a new one) so changes are heard right away.
// Limited to a few restarts per second so dragging a slider stays smooth.
function scheduleRestart(pos) {
  if (!playing || isRecording) return;
  pendingPos = (pos === undefined) ? null : pos;
  clearTimeout(restartTimer);
  const wait = Math.max(0, 120 - (performance.now() - lastRestart));
  restartTimer = setTimeout(() => {
    lastRestart = performance.now();
    if (!playing || isRecording) return;
    playFrom(pendingPos === null ? currentPos() : pendingPos, tracks.length);
  }, wait);
}

// ---------- Seek bar ----------
function updateSeekUI(pos) {
  const dur = totalDuration();
  durTime.textContent = fmt(dur);
  curTime.textContent = fmt(pos);
  if (!seeking) {
    seek.value = dur > 0 ? Math.min(1000, Math.round(pos / dur * 1000)) : 0;
  }
}

function tick() {
  const dur = totalDuration();
  let pos = currentPos();
  if (playing && !isRecording && dur > 0 && pos >= dur) {
    pausePlayback();
    pausedPos = 0;
    pos = 0;
  }
  updateSeekUI(pos);
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

function startSeek() { seeking = true; }
function endSeek() { setTimeout(() => { seeking = false; }, 100); }
seek.addEventListener('pointerdown', startSeek);
seek.addEventListener('touchstart', startSeek, { passive: true });
seek.addEventListener('pointerup', endSeek);
seek.addEventListener('pointercancel', endSeek);
seek.addEventListener('touchend', endSeek);

seek.addEventListener('input', () => {
  if (isRecording) return;
  const pos = totalDuration() * seek.value / 1000;
  curTime.textContent = fmt(pos);
  if (playing) scheduleRestart(pos);
  else pausedPos = pos;
});

seek.addEventListener('change', () => {
  if (isRecording) return;
  const pos = totalDuration() * seek.value / 1000;
  clearTimeout(restartTimer);
  if (playing) {
    lastRestart = performance.now();
    playFrom(pos, tracks.length);
  } else {
    pausedPos = pos;
  }
});

// ---------- Play, pause, stop ----------
playPauseBtn.onclick = async () => {
  if (isRecording) return;
  await ctx.resume();
  await applyOutput();
  if (playing) { pausePlayback(); return; }
  if (!tracks.some(t => t.buffer)) { say('Record something first.'); return; }
  let pos = pausedPos;
  if (pos >= totalDuration()) pos = 0;
  playFrom(pos, tracks.length);
};

document.getElementById('stopAll').onclick = () => {
  if (isRecording) return;
  pausePlayback();
  pausedPos = 0;
  updateSeekUI(0);
};

// ---------- Recording ----------
async function toggleRecord(i) {
  const btn = document.getElementById('rec' + i);
  if (recorder && recorder.state === 'recording') {
    recorder.stop();
    return;
  }
  await ctx.resume();
  await applyOutput();
  try {
    const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    if (micSelect.value) audio.deviceId = { exact: micSelect.value };
    stream = await navigator.mediaDevices.getUserMedia({ audio });
  } catch (e) {
    say('Could not open that microphone. Try another one from the list.');
    return;
  }
  pausePlayback();
  isRecording = true;
  const chunks = [];
  recorder = new MediaRecorder(stream);
  recorder.ondataavailable = (e) => chunks.push(e.data);
  recorder.onstop = async () => {
    isRecording = false;
    pausePlayback();
    stream.getTracks().forEach(t => t.stop());
    try {
      const blob = new Blob(chunks);
      const arr = await blob.arrayBuffer();
      let buf = await ctx.decodeAudioData(arr);
      // Trim the sync offset off the start to line up with earlier tracks
      const trim = Number(offsetInput.value) / 1000;
      if (trim > 0 && trim < buf.duration) {
        const start = Math.floor(trim * buf.sampleRate);
        const out = ctx.createBuffer(buf.numberOfChannels, buf.length - start, buf.sampleRate);
        for (let c = 0; c < buf.numberOfChannels; c++) {
          out.copyToChannel(buf.getChannelData(c).subarray(start), c);
        }
        buf = out;
      }
      tracks[i].buffer = buf;
    } catch (e) {
      say('Something went wrong with that take. Try recording it again.');
      btn.textContent = tracks[i].buffer ? 'Re-record' : 'Record';
      return;
    }
    tracks[i].nudge = 0;
    document.getElementById('nudge' + i).value = 0;
    document.getElementById('nudgeLabel' + i).textContent = 0;
    btn.textContent = 'Re-record';
    lastMixSaved = false;
    pausedPos = 0;
    updateSeekUI(0);
    say(NAMES[i] + ' recorded. Tap Play, then use its timing nudge while it plays.');
  };
  playFrom(0, i);
  recorder.start();
  btn.textContent = 'Stop';
  say('Recording ' + NAMES[i] + '...');
}

// ---------- Mixing ----------
async function buildMixBlob() {
  const active = tracks.filter(t => t.buffer && !t.muted);
  if (!active.length) return null;
  const rate = ctx.sampleRate;
  const end = Math.max(...active.map(t => t.nudge / 1000 + t.buffer.duration));
  const len = Math.max(1, Math.ceil(end * rate));
  const off = new OfflineAudioContext(1, len, rate);
  active.forEach(t => {
    const s = off.createBufferSource();
    s.buffer = t.buffer;
    const g = off.createGain();
    g.gain.value = t.gain / Math.sqrt(active.length);
    s.connect(g).connect(off.destination);
    const shift = t.nudge / 1000;
    if (shift >= 0) {
      s.start(shift);
    } else {
      s.start(0, Math.min(-shift, t.buffer.duration - 0.001));
    }
  });
  const rendered = await off.startRendering();
  return toWav(rendered);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

document.getElementById('mixBtn').onclick = async () => {
  const wav = await buildMixBlob();
  if (!wav) { say('Record something first.'); return; }
  const link = document.getElementById('download');
  link.href = URL.createObjectURL(wav);
  link.download = 'my-mix.wav';
  link.textContent = 'Download my-mix.wav';
  link.style.display = 'block';
  say('Mix ready.');
};

// ---------- Save and start new ----------
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
         '_' + p(d.getHours()) + p(d.getMinutes());
}

document.getElementById('saveBtn').onclick = async () => {
  const wav = await buildMixBlob();
  if (!wav) { say('Nothing to save yet. Record something first.'); return; }
  downloadBlob(wav, 'song-' + stamp() + '.wav');
  lastMixSaved = true;
  say('Saved to your Downloads folder.');
};

document.getElementById('newBtn').onclick = async () => {
  if (isRecording) { say('Stop recording first.'); return; }
  const hasAudio = tracks.some(t => t.buffer);
  if (hasAudio && !lastMixSaved) {
    const save = confirm('You have audio that has not been saved. Tap OK to save it first, or Cancel to choose what to do next.');
    if (save) {
      const wav = await buildMixBlob();
      if (wav) { downloadBlob(wav, 'song-' + stamp() + '.wav'); lastMixSaved = true; }
    } else if (!confirm('Start a new song WITHOUT saving? The current tracks will be erased.')) {
      return;
    }
  }
  pausePlayback();
  pausedPos = 0;
  tracks.forEach((t, i) => {
    t.buffer = null; t.gain = 1; t.muted = false; t.nudge = 0;
    applyGain(i);
    document.getElementById('rec' + i).textContent = 'Record';
    const m = document.getElementById('mute' + i);
    m.textContent = 'Mute';
    m.classList.remove('on');
    document.getElementById('vol' + i).value = 100;
    document.getElementById('nudge' + i).value = 0;
    document.getElementById('nudgeLabel' + i).textContent = 0;
  });
  document.getElementById('download').style.display = 'none';
  lastMixSaved = true;
  updateSeekUI(0);
  say('New song ready. Tap Record on Lead to begin.');
};

function toWav(buffer) {
  const data = buffer.getChannelData(0);
  const view = new DataView(new ArrayBuffer(44 + data.length * 2));
  const w = (o, s) => [...s].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); view.setUint32(4, 36 + data.length * 2, true);
  w(8, 'WAVEfmt '); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  w(36, 'data'); view.setUint32(40, data.length * 2, true);
  for (let i = 0; i < data.length; i++) {
    const s = Math.max(-1, Math.min(1, data[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([view], { type: 'audio/wav' });
  }
