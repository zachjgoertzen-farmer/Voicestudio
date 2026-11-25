const NAMES = ['Lead', 'Tenor', 'Voice 3', 'Voice 4'];
const ctx = new (window.AudioContext || window.webkitAudioContext)();
const tracks = NAMES.map(() => ({ buffer: null, gain: 1, muted: false, nudge: 0 }));
let playing = [];
let recorder = null;
let stream = null;
let previewTimer = null;
const statusEl = document.getElementById('status');

function say(t) { statusEl.textContent = t; }

// Build the track UI
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
    // After you stop moving it, replay everything so you can hear the change
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

// Start every track at a shared moment, shifted by its own nudge.
// If a nudge is negative, the track starts partway into its audio instead.
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

async function toggleRecord(i) {
  const btn = document.getElementById('rec' + i);
  if (recorder && recorder.state === 'recording') {
    recorder.stop();
    return;
  }
  await ctx.resume();
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    });
  } catch (e) {
    say('Microphone permission denied.');
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
    say(NAMES[i] + ' recorded. Use its timing nudge if it sounds off.');
  };
  startPlayback(i);
  recorder.start();
  btn.textContent = 'Stop';
  say('Recording ' + NAMES[i] + '...');
}

document.getElementById('playAll').onclick = () => startPlayback(tracks.length);
document.getElementById('stopAll').onclick = stopPlayback;

// Mix everything down to one WAV file, using each track's nudge
document.getElementById('mixBtn').onclick = async () => {
  const active = tracks.filter(t => t.buffer && !t.muted);
  if (!active.length) { say('Record something first.'); return; }
  const rate = ctx.sampleRate;
  const maxShift = Math.max(0, ...active.map(t => t.nudge / 1000));
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
  const wav = toWav(rendered);
  const link = document.getElementById('download');
  link.href = URL.createObjectURL(wav);
  link.download = 'my-mix.wav';
  link.textContent = 'Download my-mix.wav';
  link.style.display = 'block';
  say('Mix ready.');
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
