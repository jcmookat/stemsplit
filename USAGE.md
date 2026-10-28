# Using StemSplit

A walkthrough for running the app and splitting a song into stems, plus the API reference and common issues.

## 1. One-time setup

**Prerequisites:**
- Python 3.10+ (the repo was tested with 3.11)
- [ffmpeg](https://ffmpeg.org/) — on macOS: `brew install ffmpeg`

**Install & start:**

```bash
cd stemsplit
./run.sh
```

Or on macOS, double-click **StemSplit.command** in Finder instead — it runs `run.sh` for you and automatically opens your browser once the server is ready, so you don't need a terminal.

`run.sh` creates a virtualenv in `backend/.venv` and installs everything in `backend/requirements.txt` (FastAPI, PyTorch, Demucs, soundfile). The first run downloads PyTorch + Demucs (several hundred MB), so it can take a few minutes. Subsequent runs reuse the existing virtualenv and are fast.

Once you see:

```
Uvicorn running on http://0.0.0.0:8000
```

open **http://localhost:8000** in your browser.

## 2. Splitting a song

1. Drag an audio file onto the dashed drop zone, or click **Choose file** and pick one. Most common formats work (mp3, wav, m4a, flac, …) since Demucs decodes via ffmpeg.
2. Click **Split stems**.
3. The page uploads the file, then shows a spinner while separation runs in the background — a typical 3–4 minute song takes a few minutes on CPU, faster with a GPU or Apple Silicon (MPS). Don't close the tab; it polls automatically every 3 seconds.
4. **The very first split ever run** also downloads the Demucs model weights (~500MB) before processing starts — this only happens once.
5. When done, you'll see the **original** uploaded track followed by one row per stem: **vocals, drums, bass, guitar, piano, other**. Each has an inline audio player to preview it and a **Download** link to save the file.

There's no "synth" stem — Demucs doesn't separate one out, so synths/pads end up grouped into **other** along with anything else not covered by the five named stems.

If something goes wrong, the error message from the backend is shown directly on the page.

## 3. Where files go

- While uploading/processing: `backend/storage/uploads/<job-id>.<ext>`.
- Once a split finishes: `backend/storage/outputs/htdemucs_6s/<job-id>/`, containing `original.<ext>` (your uploaded file) plus `vocals.wav`, `drums.wav`, `bass.wav`, `guitar.wav`, `piano.wav`, `other.wav`.

Job folders older than 24 hours are deleted automatically (checked once an hour while the server runs). Set the `STEMSPLIT_RETENTION_HOURS` environment variable before starting the server to change that window, e.g. `STEMSPLIT_RETENTION_HOURS=1 ./run.sh` to keep things for only an hour, or a large number to effectively disable cleanup.

## 4. API reference

The frontend is just a client of these endpoints — useful if you want to script splits instead of using the browser.

### `POST /api/split`
Upload a file, starts a background separation job.

```bash
curl -F "file=@song.mp3" http://localhost:8000/api/split
```
```json
{"job_id": "8df9168344674e09b03468577587bada", "status": "pending", "stems": [], "error": null}
```

### `GET /api/status/{job_id}`
Poll job state: `pending` → `processing` → `done` or `error`.

```bash
curl http://localhost:8000/api/status/8df9168344674e09b03468577587bada
```
```json
{"job_id": "...", "status": "done", "stems": ["original", "vocals", "drums", "bass", "guitar", "piano", "other"], "error": null}
```

### `GET /api/download/{job_id}/{stem}`
Download one file (`stem` is one of `original`, `vocals`, `drums`, `bass`, `guitar`, `piano`, `other`). `original` keeps your uploaded file's original format/extension; the rest are `.wav`. Returns 404 until the job is `done`.

```bash
curl -o vocals.wav http://localhost:8000/api/download/8df9168344674e09b03468577587bada/vocals
```

## 5. Troubleshooting

| Symptom | Fix |
|---|---|
| `demucs: command not found` or import errors on startup | Re-run `./run.sh` so dependencies install into `backend/.venv`; make sure you're not using a different Python/shell than the one `run.sh` set up. |
| Job fails immediately with an ffmpeg-related error | Install ffmpeg: `brew install ffmpeg` (macOS) or your distro's package manager, then restart the server. |
| Error mentions `Couldn't find appropriate backend` when saving stems | `soundfile` isn't installed — run `pip install -r backend/requirements.txt` again inside the venv. |
| First split is very slow | Expected — it's downloading the ~500MB model on top of doing the separation. Later splits are much faster. |
| Separation takes minutes even on short clips | Normal on CPU. Check the server logs for `-d cuda` / `-d mps` / `-d cpu` — GPU/MPS is picked automatically if available. |
| Upload succeeds but status never leaves `processing` | Check the terminal running `./run.sh` for a Python traceback; the job's `error` field will also populate once it fails. |

## 6. Stopping the server

`Ctrl+C` in the terminal running `./run.sh`.
