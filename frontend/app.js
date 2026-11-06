const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("file-input");
const fileNameEl = document.getElementById("file-name");
const splitButton = document.getElementById("split-button");
const statusEl = document.getElementById("status");
const statusText = document.getElementById("status-text");
const errorEl = document.getElementById("error");
const resultsEl = document.getElementById("results");
const stemListEl = document.getElementById("stem-list");
const themeToggle = document.getElementById("theme-toggle");
const downloadAllLink = document.getElementById("download-all");

let selectedFile = null;
let pollHandle = null;
const activeWaveforms = [];

const ORIGINAL_STEM = "original";
const DEMUCS_SAMPLE_RATE = 44100;
const mixerPlayers = [];
let mixerPlaying = false;
let mixerPlayButton = null;
let mixerTimeEl = null;
let mixerExportButton = null;
let mixerDriftInterval = null;

const THEME_STORAGE_KEY = "stemsplit-theme";
let waveformPlayedColor = "#6c8cff";
let waveformTrackColor = "#3a3f4b";

function updateWaveformColors() {
  const styles = getComputedStyle(document.documentElement);
  waveformPlayedColor = styles.getPropertyValue("--accent").trim() || waveformPlayedColor;
  waveformTrackColor = styles.getPropertyValue("--waveform-track").trim() || waveformTrackColor;
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  themeToggle.textContent = theme === "dark" ? "Light" : "Dark";
  updateWaveformColors();
  activeWaveforms.forEach((redraw) => redraw());
}

function getCurrentTheme() {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

themeToggle.addEventListener("click", () => {
  const next = getCurrentTheme() === "dark" ? "light" : "dark";
  try {
    localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch (err) {
    // ignore storage failures (e.g. private browsing)
  }
  applyTheme(next);
});

applyTheme(getCurrentTheme());

function setFile(file) {
  selectedFile = file;
  fileNameEl.textContent = file ? file.name : "";
  splitButton.disabled = !file;
  resultsEl.hidden = true;
  errorEl.hidden = true;
}

["dragenter", "dragover"].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.add("dragover");
  })
);

["dragleave", "drop"].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
  })
);

dropzone.addEventListener("drop", (e) => {
  const file = e.dataTransfer.files[0];
  if (file) setFile(file);
});

fileInput.addEventListener("change", () => {
  if (fileInput.files[0]) setFile(fileInput.files[0]);
});

splitButton.addEventListener("click", startSplit);

async function startSplit() {
  if (!selectedFile) return;

  splitButton.disabled = true;
  resultsEl.hidden = true;
  errorEl.hidden = true;
  statusEl.hidden = false;
  statusText.textContent = "Uploading…";

  const formData = new FormData();
  formData.append("file", selectedFile);

  try {
    const res = await fetch("/api/split", { method: "POST", body: formData });
    if (!res.ok) throw new Error(`Upload failed (${res.status})`);
    const job = await res.json();
    statusText.textContent = "Separating stems… this can take a few minutes.";
    pollStatus(job.job_id);
  } catch (err) {
    statusEl.hidden = true;
    splitButton.disabled = false;
    showError(err.message);
  }
}

function pollStatus(jobId) {
  clearInterval(pollHandle);
  pollHandle = setInterval(async () => {
    try {
      const res = await fetch(`/api/status/${jobId}`);
      if (!res.ok) throw new Error(`Status check failed (${res.status})`);
      const job = await res.json();

      if (job.status === "done") {
        clearInterval(pollHandle);
        statusEl.hidden = true;
        splitButton.disabled = false;
        showResults(jobId, job.stems);
      } else if (job.status === "error") {
        clearInterval(pollHandle);
        statusEl.hidden = true;
        splitButton.disabled = false;
        showError(job.error || "Separation failed.");
      }
    } catch (err) {
      clearInterval(pollHandle);
      statusEl.hidden = true;
      splitButton.disabled = false;
      showError(err.message);
    }
  }, 3000);
}

const WAVEFORM_BARS = 300;
let audioCtx = null;

function getAudioContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return audioCtx;
}

function showResults(jobId, stems) {
  stemListEl.innerHTML = "";
  activeWaveforms.length = 0;
  mixerPlayers.length = 0;
  stopDriftCorrection();
  mixerPlaying = false;

  const hasOriginal = stems.includes(ORIGINAL_STEM);
  const mixStems = stems.filter((s) => s !== ORIGINAL_STEM);

  if (hasOriginal) {
    stemListEl.appendChild(buildOriginalItem(jobId));
  }

  if (mixStems.length) {
    stemListEl.appendChild(buildMixerTransport());
    mixStems.forEach((stem) => stemListEl.appendChild(buildMixerItem(jobId, stem)));
    wireMixerTimekeeper();
    startDriftCorrection();
  }

  downloadAllLink.href = `/api/download-all/${jobId}`;
  resultsEl.hidden = false;
}

function buildOriginalItem(jobId) {
  const url = `/api/download/${jobId}/${ORIGINAL_STEM}`;

  const item = document.createElement("div");
  item.className = "stem-item";

  const header = document.createElement("div");
  header.className = "stem-item-header";

  const name = document.createElement("span");
  name.className = "stem-name";
  name.textContent = ORIGINAL_STEM;

  const link = document.createElement("a");
  link.className = "stem-download";
  link.href = url;
  link.download = "";
  link.textContent = "Download";

  header.appendChild(name);
  header.appendChild(link);

  const canvas = document.createElement("canvas");
  canvas.className = "waveform";

  const audio = document.createElement("audio");
  audio.controls = true;
  audio.preload = "metadata";
  audio.src = url;

  item.appendChild(header);
  item.appendChild(canvas);
  item.appendChild(audio);

  setupWaveform(canvas, audio, url, {
    seek: (ratio) => {
      if (audio.duration) audio.currentTime = ratio * audio.duration;
    },
    isPlaying: () => !audio.paused,
    play: () => audio.play(),
  });

  return item;
}

function buildMixerTransport() {
  const bar = document.createElement("div");
  bar.className = "mixer-transport";

  mixerPlayButton = document.createElement("button");
  mixerPlayButton.type = "button";
  mixerPlayButton.className = "mixer-play-btn";
  mixerPlayButton.textContent = "Play";
  mixerPlayButton.addEventListener("click", toggleMixerPlayback);

  mixerTimeEl = document.createElement("span");
  mixerTimeEl.className = "mixer-time";
  mixerTimeEl.textContent = "0:00 / 0:00";

  mixerExportButton = document.createElement("button");
  mixerExportButton.type = "button";
  mixerExportButton.className = "mixer-export-btn";
  mixerExportButton.textContent = "Export Mix";
  mixerExportButton.addEventListener("click", exportMix);

  const label = document.createElement("span");
  label.className = "mixer-label";
  label.textContent = "Mix";

  bar.appendChild(mixerPlayButton);
  bar.appendChild(mixerTimeEl);
  bar.appendChild(mixerExportButton);
  bar.appendChild(label);

  return bar;
}

function buildMixerItem(jobId, stem) {
  const url = `/api/download/${jobId}/${stem}`;

  const item = document.createElement("div");
  item.className = "stem-item mixer-item";

  const header = document.createElement("div");
  header.className = "stem-item-header";

  const name = document.createElement("span");
  name.className = "stem-name";
  name.textContent = stem;

  const link = document.createElement("a");
  link.className = "stem-download";
  link.href = url;
  link.download = `${stem}.wav`;
  link.textContent = "Download";

  header.appendChild(name);
  header.appendChild(link);

  const canvas = document.createElement("canvas");
  canvas.className = "waveform";

  const audio = document.createElement("audio");
  audio.preload = "metadata";
  audio.src = url;
  audio.hidden = true;

  const controls = document.createElement("div");
  controls.className = "mixer-controls";

  const muteBtn = document.createElement("button");
  muteBtn.type = "button";
  muteBtn.className = "mixer-btn mute-btn";
  muteBtn.textContent = "Mute";

  const soloBtn = document.createElement("button");
  soloBtn.type = "button";
  soloBtn.className = "mixer-btn solo-btn";
  soloBtn.textContent = "Solo";

  const volume = document.createElement("input");
  volume.type = "range";
  volume.className = "volume-slider";
  volume.min = "0";
  volume.max = "100";
  volume.value = "100";

  controls.appendChild(muteBtn);
  controls.appendChild(soloBtn);
  controls.appendChild(volume);

  item.appendChild(header);
  item.appendChild(canvas);
  item.appendChild(controls);
  item.appendChild(audio);

  const player = { stem, audio, muted: false, solo: false };
  mixerPlayers.push(player);

  muteBtn.addEventListener("click", () => {
    player.muted = !player.muted;
    muteBtn.classList.toggle("active", player.muted);
    updateMuteStates();
  });

  soloBtn.addEventListener("click", () => {
    player.solo = !player.solo;
    soloBtn.classList.toggle("active", player.solo);
    updateMuteStates();
  });

  volume.addEventListener("input", () => {
    audio.volume = Number(volume.value) / 100;
  });

  setupWaveform(canvas, audio, url, {
    seek: (ratio) => seekAll(ratio),
    isPlaying: () => mixerPlaying,
    play: () => playAll(),
  });

  return item;
}

function updateMuteStates() {
  const anySolo = mixerPlayers.some((p) => p.solo);
  mixerPlayers.forEach((p) => {
    p.audio.muted = anySolo ? !p.solo : p.muted;
  });
}

function playAll() {
  if (!mixerPlayers.length) return;
  const reference = mixerPlayers[0].audio.currentTime;
  mixerPlayers.forEach((p) => {
    p.audio.currentTime = reference;
    p.audio.play();
  });
  mixerPlaying = true;
  if (mixerPlayButton) mixerPlayButton.textContent = "Pause";
}

function pauseAll() {
  mixerPlayers.forEach((p) => p.audio.pause());
  mixerPlaying = false;
  if (mixerPlayButton) mixerPlayButton.textContent = "Play";
}

function toggleMixerPlayback() {
  if (mixerPlaying) {
    pauseAll();
  } else {
    playAll();
  }
}

function seekAll(ratio) {
  mixerPlayers.forEach((p) => {
    if (p.audio.duration) p.audio.currentTime = ratio * p.audio.duration;
  });
}

async function exportMix() {
  if (!mixerPlayers.length || !mixerExportButton) return;

  const originalLabel = mixerExportButton.textContent;
  mixerExportButton.disabled = true;
  mixerExportButton.textContent = "Rendering…";

  try {
    const anySolo = mixerPlayers.some((p) => p.solo);
    const sources = [];
    // Decode at Demucs' native output rate so the mixdown doesn't get silently
    // resampled to the browser's hardware audio rate (e.g. 48kHz) and stays
    // sample-faithful to the original 44.1kHz/16-bit stem files.
    const decodeCtx = new OfflineAudioContext(2, 1, DEMUCS_SAMPLE_RATE);

    for (const p of mixerPlayers) {
      const audible = anySolo ? p.solo : !p.muted;
      const gain = audible ? p.audio.volume : 0;
      if (gain <= 0) continue;
      const res = await fetch(p.audio.src);
      const arrayBuffer = await res.arrayBuffer();
      const buffer = await decodeCtx.decodeAudioData(arrayBuffer);
      sources.push({ buffer, gain });
    }

    if (!sources.length) {
      showError("Nothing to export — unmute or un-solo at least one stem.");
      return;
    }

    const numberOfChannels = Math.max(...sources.map((s) => s.buffer.numberOfChannels));
    const sampleRate = DEMUCS_SAMPLE_RATE;
    const length = Math.max(...sources.map((s) => s.buffer.length));

    const offlineCtx = new OfflineAudioContext(numberOfChannels, length, sampleRate);
    sources.forEach(({ buffer, gain }) => {
      const src = offlineCtx.createBufferSource();
      src.buffer = buffer;
      const gainNode = offlineCtx.createGain();
      gainNode.gain.value = gain;
      src.connect(gainNode).connect(offlineCtx.destination);
      src.start(0);
    });

    const rendered = await offlineCtx.startRendering();

    let peak = 0;
    for (let c = 0; c < rendered.numberOfChannels; c++) {
      const data = rendered.getChannelData(c);
      for (let i = 0; i < data.length; i++) {
        const abs = Math.abs(data[i]);
        if (abs > peak) peak = abs;
      }
    }
    const normalizeFactor = peak > 1 ? 1 / peak : 1;

    const blob = encodeWavPCM16(rendered, normalizeFactor);
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "custom-mix.wav";
    link.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    showError(`Export failed: ${err.message}`);
  } finally {
    mixerExportButton.disabled = false;
    mixerExportButton.textContent = originalLabel;
  }
}

function encodeWavPCM16(audioBuffer, normalizeFactor) {
  const numChannels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const numFrames = audioBuffer.length;
  const blockAlign = numChannels * 2;
  const dataSize = numFrames * blockAlign;

  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeString = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  const channelData = [];
  for (let c = 0; c < numChannels; c++) channelData.push(audioBuffer.getChannelData(c));

  let offset = 44;
  for (let i = 0; i < numFrames; i++) {
    for (let c = 0; c < numChannels; c++) {
      const sample = Math.max(-1, Math.min(1, channelData[c][i] * normalizeFactor));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }

  return new Blob([buffer], { type: "audio/wav" });
}

function wireMixerTimekeeper() {
  if (!mixerPlayers.length) return;
  const timekeeper = mixerPlayers[0].audio;

  timekeeper.addEventListener("timeupdate", () => {
    if (mixerTimeEl) {
      mixerTimeEl.textContent = `${formatTime(timekeeper.currentTime)} / ${formatTime(timekeeper.duration)}`;
    }
  });

  timekeeper.addEventListener("ended", () => {
    mixerPlaying = false;
    if (mixerPlayButton) mixerPlayButton.textContent = "Play";
  });
}

function startDriftCorrection() {
  stopDriftCorrection();
  mixerDriftInterval = setInterval(() => {
    if (!mixerPlaying || mixerPlayers.length < 2) return;
    const reference = mixerPlayers[0].audio.currentTime;
    mixerPlayers.slice(1).forEach((p) => {
      if (Math.abs(p.audio.currentTime - reference) > 0.15) {
        p.audio.currentTime = reference;
      }
    });
  }, 1000);
}

function stopDriftCorrection() {
  if (mixerDriftInterval) {
    clearInterval(mixerDriftInterval);
    mixerDriftInterval = null;
  }
}

function formatTime(seconds) {
  if (!isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0");
  return `${m}:${s}`;
}

async function setupWaveform(canvas, audio, url, controls) {
  const ctx2d = canvas.getContext("2d");
  let peaks = null;
  let isDragging = false;
  let wasPlayingAtDragStart = false;

  const currentProgress = () => (audio.duration ? audio.currentTime / audio.duration : 0);

  const render = (progress) => {
    if (!peaks) return;
    drawWaveform(canvas, ctx2d, peaks, progress);
  };

  try {
    const res = await fetch(url);
    const arrayBuffer = await res.arrayBuffer();
    const audioBuffer = await getAudioContext().decodeAudioData(arrayBuffer);
    peaks = computePeaks(audioBuffer, WAVEFORM_BARS);
    render(0);
  } catch (err) {
    // Waveform is a visual extra; fall back silently to the plain <audio> element.
    return;
  }

  activeWaveforms.push(() => render(currentProgress()));

  audio.addEventListener("timeupdate", () => {
    if (!isDragging) render(currentProgress());
  });

  function ratioFromEvent(e) {
    const rect = canvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    return Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1);
  }

  function handleSeek(e) {
    const ratio = ratioFromEvent(e);
    controls.seek(ratio);
    render(ratio);
  }

  canvas.addEventListener("mousedown", (e) => {
    isDragging = true;
    wasPlayingAtDragStart = controls.isPlaying();
    canvas.classList.add("dragging");
    handleSeek(e);
  });

  window.addEventListener("mousemove", (e) => {
    if (!isDragging) return;
    handleSeek(e);
  });

  window.addEventListener("mouseup", () => {
    if (!isDragging) return;
    isDragging = false;
    canvas.classList.remove("dragging");
    if (!wasPlayingAtDragStart) controls.play();
  });

  canvas.addEventListener(
    "touchstart",
    (e) => {
      isDragging = true;
      wasPlayingAtDragStart = controls.isPlaying();
      handleSeek(e);
    },
    { passive: true }
  );

  canvas.addEventListener(
    "touchmove",
    (e) => {
      if (!isDragging) return;
      handleSeek(e);
    },
    { passive: true }
  );

  canvas.addEventListener("touchend", () => {
    if (!isDragging) return;
    isDragging = false;
    if (!wasPlayingAtDragStart) controls.play();
  });

  window.addEventListener("resize", () => render(currentProgress()));
}

function computePeaks(audioBuffer, numBars) {
  const channels = [];
  for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
    channels.push(audioBuffer.getChannelData(c));
  }
  const length = channels[0].length;
  const samplesPerBar = Math.max(1, Math.floor(length / numBars));
  const peaks = new Float32Array(numBars);

  for (let i = 0; i < numBars; i++) {
    const start = i * samplesPerBar;
    const end = Math.min(start + samplesPerBar, length);
    let max = 0;
    for (let j = start; j < end; j++) {
      for (let c = 0; c < channels.length; c++) {
        const v = Math.abs(channels[c][j]);
        if (v > max) max = v;
      }
    }
    peaks[i] = max;
  }

  return peaks;
}

function drawWaveform(canvas, ctx2d, peaks, progress) {
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (width === 0 || height === 0) return;

  if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
    canvas.width = width * dpr;
    canvas.height = height * dpr;
  }
  ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx2d.clearRect(0, 0, width, height);

  const barCount = peaks.length;
  const barWidth = width / barCount;
  const gap = Math.max(1, barWidth * 0.25);
  const playedBars = Math.floor(progress * barCount);

  for (let i = 0; i < barCount; i++) {
    const barHeight = Math.max(2, peaks[i] * height);
    const x = i * barWidth;
    const y = (height - barHeight) / 2;
    ctx2d.fillStyle = i < playedBars ? waveformPlayedColor : waveformTrackColor;
    ctx2d.fillRect(x, y, barWidth - gap, barHeight);
  }

  const playheadX = Math.min(Math.max(progress, 0), 1) * width;
  ctx2d.fillStyle = waveformPlayedColor;
  ctx2d.fillRect(playheadX - 1, 0, 2, height);
  ctx2d.beginPath();
  ctx2d.arc(playheadX, 4, 4, 0, Math.PI * 2);
  ctx2d.fill();
}

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = false;
}
