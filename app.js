const NAMES = ['Lead', 'Tenor', 'Voice 3', 'Voice 4'];
const ctx = new (window.AudioContext || window.webkitAudioContext)();
const tracks = NAMES.map(() => ({ buffer: null, gain: 1, muted: false, nudge: 0 }));
let playing = [];
let recorder = null;
let stream = null;
let previewTimer = null;
let lastMixSaved = true;
const statusEl = document.getElementById('status');
const micSelect = document.getElementById('micSelect');
const outSelect = document.getElementById('outSelect');

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

  // Output choice only works in browsers that support it (Chrome on Android does)
  const prevOut = outSelect.value;
  outSelect.innerHTML = '<option value="default">Default (earbuds if connected)</option>';
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

// ---------- Build the track UI ----------
const container = document.getElementById('tracks');
NAMES.forEach((name, i) => {
  const div = document.createElement('div');
  div.className = 'track';
  div.innerHTML = `
    <h3>${name}</h3>
    <button class="rec" id="rec${i}">Record</button>
    <button id="mute${i}">Mute</button>
    <label>Volume
      <input type="range" id="vol${i}" min="0" max="150" value="100">
    </label>
    <label>Timing nudge: <span id="nudgeLabel${i}">0</span> ms
      <input type="range" id="nudge${i}" min="-300" max="300" value="0">
    </label>
    <button id="nudgeMinus${i}">- 5 ms</button>
    <button id="nudgePlus${i}">+ 5 ms</button>
    <button id="nudgeZero${i}">Reset</button>`;
  container.appendChild(div);
  document.getElementById('rec' + i).onclick = () => toggleRecord(i);
  document.getElementById('mute' + i).onclick = (e) => {
    tracks[i].muted = !tracks[i].muted;
    e.target.textContent = tracks[i].muted ? 'Unmute' : 'Mute';
  };
  document.getElementById('vol' + i).oninput = (e) => {
    tracks[i].gain = e.target.value / 100;
  };

  // Per-track timing nudge. Negative = play earlier, positive = play later.
  const slider = document.getElementById('nudge' + i);
  const label = document.getElementById('nudgeLabel' + i);
  function setNudge(ms) {
    ms = Math.max(-300, Math.min(300, ms));
    tracks[i].nudge = ms;
    slider.value = ms;
    label.textContent = ms;
    lastMixSaved = false;
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      if (!recorder || recorder.state !== 'recording') startPlayback(tracks.length);
    }, 400);
  }
  slider.oninput = (e) => setNudge(Number(e.target.value));
  document.getElementById('nudgeMinus' + i).onclick = () => setNudge(tracks[i].nudge - 5);
  document.getElementById('nudgePlus' + i).onclick = () => setNudge(tracks[i].nudge + 5);
  document.getElementById('nudgeZero' + i).onclick = () => setNudge(0);
});

const offsetInput = document.getElementById('offset');
offsetInput.oninput = () => {
  document.getElementById('offsetLabel').textContent = offsetInput.value;
};

// ---------- Playback ----------
function startPlayback(upTo) {
  stopPlayback();
  const when = ctx.currentTime + 0.15;
  for (let i = 0; i < upTo; i++) {
    const t = tracks[i];
    if (!t.buffer || t.muted) continue;
    const src = ctx.createBufferSource();
    src.buffer = t.buffer;
    const g = ctx.createGain();
    g.gain.value = t.gain;
    src.connect(g).connect(ctx.destination);
    const shift = t.nudge / 1000;
    if (shift >= 0) {
      src.start(when + shift);
    } else {
      src.start(when, Math.min(-shift, t.buffer.duration - 0.001));
    }
    playing.push(src);
  }
  return when;
}

function stopPlayback() {
  playing.forEach(s => { try { s.stop(); } catch (e) {} });
  playing = [];
}

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
  const chunks = [];
  recorder = new MediaRecorder(stream);
  recorder.ondataavailable = (e) => chunks.push(e.data);
  recorder.onstop = async () => {
    stopPlayback();
    stream.getTracks().forEach(t => t.stop());
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
    tracks[i].nudge = 0;
    document.getElementById('nudge' + i).value = 0;
    document.getElementById('nudgeLabel' + i).textContent = 0;
    btn.textContent = 'Re-record';
    btn.classList.add('rec');
    lastMixSaved = false;
    say(NAMES[i] + ' recorded. Use its timing nudge if it sounds off.');
  };
  startPlayback(i);
  recorder.start();
  btn.textContent = 'Stop';
  say('Recording ' + NAMES[i] + '...');
}

document.getElementById('playAll').onclick = () => startPlayback(tracks.length);
document.getElementById('stopAll').onclick = stopPlayback;

// ---------- Mixing ----------
async function buildMixBlob() {
  const active = tracks.filter(t => t.buffer && !t.muted);
  if (!active.length) return null;
  const rate = ctx.sampleRate;
  const len = Math.ceil(
    Math.max(...active.map(t => t.buffer.length + Math.max(0, t.nudge / 1000) * rate))
  );
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
  stopPlayback();
  tracks.forEach((t, i) => {
    t.buffer = null; t.gain = 1; t.muted = false; t.nudge = 0;
    document.getElementById('rec' + i).textContent = 'Record';
    document.getElementById('mute' + i).textContent = 'Mute';
    document.getElementById('vol' + i).value = 100;
    document.getElementById('nudge' + i).value = 0;
    document.getElementById('nudgeLabel' + i).textContent = 0;
  });
  document.getElementById('download').style.display = 'none';
  lastMixSaved = true;
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
