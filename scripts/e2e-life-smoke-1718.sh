#!/usr/bin/env bash
# #1718: e2e smoke of /api/life/* routes on a DISPOSABLE mongo:7 (never prod mongo-health).
set -euo pipefail
cd "$(dirname "$0")/.."
NAME="e2e-mongo-1718-$$"
PORT=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])')
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker run -d --name "$NAME" -p 127.0.0.1:${PORT}:27017 mongo:7 >/dev/null
for i in $(seq 1 30); do
  docker exec "$NAME" mongosh --quiet --eval 'db.runCommand({ping:1}).ok' 2>/dev/null | grep -q 1 && break
  sleep 1
done
E2E_MONGO_URL="mongodb://127.0.0.1:${PORT}" node scripts/e2e-life-smoke-1718.js
