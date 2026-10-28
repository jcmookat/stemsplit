#!/usr/bin/env bash
cd "$(dirname "$0")"

(
  for i in $(seq 1 120); do
    if curl -s -o /dev/null "http://localhost:8000/"; then
      open "http://localhost:8000"
      break
    fi
    sleep 1
  done
) &

./run.sh
