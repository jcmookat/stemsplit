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

let selectedFile = null;
let pollHandle = null;
const activeWaveforms = [];

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
  stems.forEach((stem) => {
    const url = `/api/download/${jobId}/${stem}`;

    const item = document.createElement("div");
    item.className = "stem-item";

    const header = document.createElement("div");
    header.className = "stem-item-header";

    const name = document.createElement("span");
    name.className = "stem-name";
    name.textContent = stem;

    const link = document.createElement("a");
    link.className = "stem-download";
    link.href = url;
    link.download = stem === "original" ? "" : `${stem}.wav`;
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
    stemListEl.appendChild(item);

    setupWaveform(canvas, audio, url);
  });
  resultsEl.hidden = false;
}

async function setupWaveform(canvas, audio, url) {
  const ctx2d = canvas.getContext("2d");
  let peaks = null;

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

  activeWaveforms.push(() => render(audio.duration ? audio.currentTime / audio.duration : 0));

  audio.addEventListener("timeupdate", () => {
    render(audio.duration ? audio.currentTime / audio.duration : 0);
  });

  canvas.addEventListener("click", (e) => {
    if (!audio.duration) return;
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
    audio.currentTime = ratio * audio.duration;
    audio.play();
  });

  window.addEventListener("resize", () => render(audio.duration ? audio.currentTime / audio.duration : 0));
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
}

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = false;
}
