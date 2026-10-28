#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/backend"

if [ ! -d .venv ]; then
  PYBIN="$(command -v python3.11 || command -v python3.12 || command -v python3.10 || command -v python3)"
  "$PYBIN" -m venv .venv
fi

source .venv/bin/activate
pip install -q --upgrade pip
pip install -q -r requirements.txt

exec uvicorn main:app --host 0.0.0.0 --port 8000
