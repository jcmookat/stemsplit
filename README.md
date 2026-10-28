# StemSplit

Upload a song in the browser and split it into separate stems using [Demucs](https://github.com/facebookresearch/demucs) (`htdemucs_6s` model):

- vocals
- drums
- bass
- guitar
- piano
- other *(synths, pads, and anything else not covered by the stems above — Demucs has no dedicated "synth" stem)*

## Prerequisites

- Python 3.10+
- [ffmpeg](https://ffmpeg.org/) — `brew install ffmpeg`

## Run

```bash
./run.sh
```

Or on macOS, double-click **StemSplit.command** in Finder — it runs the same thing and opens your browser automatically once the server is ready.

`run.sh` creates a virtualenv in `backend/.venv`, installs dependencies (including PyTorch and Demucs — first install will download several hundred MB), and starts the server at **http://localhost:8000**.

Open that URL, drop in an audio file, and click "Split stems". The first split also downloads the Demucs model weights (~500MB), so it will be slower than later runs.

See [USAGE.md](USAGE.md) for a full walkthrough, the API reference, and troubleshooting.

## Notes

- Separation runs on GPU automatically if available (CUDA, or Apple Silicon via MPS); otherwise it falls back to CPU, which is noticeably slower — a 3-4 minute song can take several minutes to process.
- Uploaded files and generated stems are stored under `backend/storage/` (gitignored). Job folders are automatically deleted after 24 hours (configurable via the `STEMSPLIT_RETENTION_HOURS` env var); checked hourly while the server is running.
- Only one separation job runs at a time per server process.
