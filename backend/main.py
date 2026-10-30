import mimetypes
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
import zipfile
from pathlib import Path
from typing import Optional

import torch
from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.background import BackgroundTask

RANGE_HEADER_RE = re.compile(r"bytes=(\d*)-(\d*)")
STREAM_CHUNK_SIZE = 1024 * 1024

BASE_DIR = Path(__file__).resolve().parent
FRONTEND_DIR = BASE_DIR.parent / "frontend"
STORAGE_DIR = BASE_DIR / "storage"
UPLOADS_DIR = STORAGE_DIR / "uploads"
OUTPUTS_DIR = STORAGE_DIR / "outputs"
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)

MODEL_NAME = "htdemucs_6s"
STEMS = ["vocals", "drums", "bass", "guitar", "piano", "other"]
ORIGINAL_STEM = "original"

RETENTION_HOURS = float(os.environ.get("STEMSPLIT_RETENTION_HOURS", "24"))
CLEANUP_INTERVAL_SECONDS = 3600

app = FastAPI(title="StemSplit")

jobs: dict[str, dict] = {}
jobs_lock = threading.Lock()


def cleanup_old_jobs() -> None:
    cutoff = time.time() - RETENTION_HOURS * 3600
    model_dir = OUTPUTS_DIR / MODEL_NAME
    if not model_dir.exists():
        return
    for job_dir in model_dir.iterdir():
        try:
            if job_dir.is_dir() and job_dir.stat().st_mtime < cutoff:
                shutil.rmtree(job_dir, ignore_errors=True)
        except OSError:
            continue


def cleanup_loop() -> None:
    while True:
        cleanup_old_jobs()
        time.sleep(CLEANUP_INTERVAL_SECONDS)


@app.on_event("startup")
def start_cleanup_loop() -> None:
    threading.Thread(target=cleanup_loop, daemon=True).start()


class JobStatus(BaseModel):
    job_id: str
    status: str
    stems: list[str] = []
    error: Optional[str] = None


def pick_device() -> str:
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def run_separation(job_id: str, input_path: Path) -> None:
    with jobs_lock:
        jobs[job_id]["status"] = "processing"
    try:
        cmd = [
            "demucs",
            "-n", MODEL_NAME,
            "-d", pick_device(),
            "-o", str(OUTPUTS_DIR),
            str(input_path),
        ]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            raise RuntimeError(result.stderr[-2000:] or "demucs failed")

        out_dir = OUTPUTS_DIR / MODEL_NAME / input_path.stem
        original_dest = out_dir / f"{ORIGINAL_STEM}{input_path.suffix}"
        shutil.move(str(input_path), str(original_dest))

        with jobs_lock:
            jobs[job_id]["status"] = "done"
    except Exception as exc:
        with jobs_lock:
            jobs[job_id]["status"] = "error"
            jobs[job_id]["error"] = str(exc)
        input_path.unlink(missing_ok=True)


@app.post("/api/split", response_model=JobStatus)
async def split(file: UploadFile = File(...)) -> JobStatus:
    job_id = uuid.uuid4().hex
    ext = Path(file.filename or "").suffix or ".wav"
    input_path = UPLOADS_DIR / f"{job_id}{ext}"

    with input_path.open("wb") as dest:
        shutil.copyfileobj(file.file, dest)

    with jobs_lock:
        jobs[job_id] = {
            "status": "pending",
            "input_stem": input_path.stem,
            "error": None,
        }

    thread = threading.Thread(target=run_separation, args=(job_id, input_path), daemon=True)
    thread.start()

    return JobStatus(job_id=job_id, status="pending")


@app.get("/api/status/{job_id}", response_model=JobStatus)
async def status(job_id: str) -> JobStatus:
    with jobs_lock:
        job = jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "job not found")

    stems: list[str] = []
    if job["status"] == "done":
        out_dir = OUTPUTS_DIR / MODEL_NAME / job["input_stem"]
        if out_dir.exists():
            if any(out_dir.glob(f"{ORIGINAL_STEM}.*")):
                stems.append(ORIGINAL_STEM)
            stems += [s for s in STEMS if (out_dir / f"{s}.wav").exists()]

    return JobStatus(job_id=job_id, status=job["status"], stems=stems, error=job.get("error"))


@app.get("/api/download/{job_id}/{stem}")
async def download(job_id: str, stem: str, request: Request):
    with jobs_lock:
        job = jobs.get(job_id)
    if job is None or job["status"] != "done":
        raise HTTPException(404, "job not ready")

    out_dir = OUTPUTS_DIR / MODEL_NAME / job["input_stem"]

    if stem == ORIGINAL_STEM:
        matches = list(out_dir.glob(f"{ORIGINAL_STEM}.*"))
        if not matches:
            raise HTTPException(404, "original not found")
        out_file = matches[0]
        media_type = mimetypes.guess_type(out_file.name)[0] or "application/octet-stream"
        filename = out_file.name
    elif stem in STEMS:
        out_file = out_dir / f"{stem}.wav"
        if not out_file.exists():
            raise HTTPException(404, "stem not found")
        media_type = "audio/wav"
        filename = f"{stem}.wav"
    else:
        raise HTTPException(400, "invalid stem name")

    file_size = out_file.stat().st_size
    range_header = request.headers.get("range")

    if range_header:
        match = RANGE_HEADER_RE.match(range_header)
        if not match:
            raise HTTPException(416, "invalid range header")

        start_str, end_str = match.groups()
        start = int(start_str) if start_str else 0
        end = int(end_str) if end_str else file_size - 1
        end = min(end, file_size - 1)

        if start > end or start >= file_size:
            raise HTTPException(
                416, "range not satisfiable", headers={"Content-Range": f"bytes */{file_size}"}
            )

        def iterfile(start: int, end: int):
            with open(out_file, "rb") as f:
                f.seek(start)
                remaining = end - start + 1
                while remaining > 0:
                    chunk = f.read(min(STREAM_CHUNK_SIZE, remaining))
                    if not chunk:
                        break
                    remaining -= len(chunk)
                    yield chunk

        headers = {
            "Content-Range": f"bytes {start}-{end}/{file_size}",
            "Accept-Ranges": "bytes",
            "Content-Length": str(end - start + 1),
            "Content-Disposition": f'inline; filename="{filename}"',
        }
        return StreamingResponse(iterfile(start, end), status_code=206, media_type=media_type, headers=headers)

    return FileResponse(
        out_file,
        filename=filename,
        media_type=media_type,
        content_disposition_type="inline",
        headers={"Accept-Ranges": "bytes"},
    )


def build_zip(out_dir: Path, tmp_path: Path) -> None:
    with zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_STORED) as zf:
        for f in sorted(out_dir.iterdir()):
            if f.is_file():
                zf.write(f, arcname=f.name)


@app.get("/api/download-all/{job_id}")
async def download_all(job_id: str):
    with jobs_lock:
        job = jobs.get(job_id)
    if job is None or job["status"] != "done":
        raise HTTPException(404, "job not ready")

    out_dir = OUTPUTS_DIR / MODEL_NAME / job["input_stem"]
    if not out_dir.exists() or not any(out_dir.iterdir()):
        raise HTTPException(404, "no files found")

    tmp = tempfile.NamedTemporaryFile(suffix=".zip", delete=False)
    tmp_path = Path(tmp.name)
    tmp.close()

    await run_in_threadpool(build_zip, out_dir, tmp_path)

    return FileResponse(
        tmp_path,
        filename="stems.zip",
        media_type="application/zip",
        background=BackgroundTask(tmp_path.unlink, missing_ok=True),
    )


app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
