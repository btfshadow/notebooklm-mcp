#!/bin/bash
# Docker entrypoint for NotebookLM MCP Server
# Starts VNC services (for visual auth) and Node.js HTTP server
set -e
echo "==========================================="
echo "  NotebookLM MCP Server - Docker"
echo "==========================================="
echo ""
# Check if VNC should be started (default: yes in Docker)
ENABLE_VNC="${ENABLE_VNC:-true}"
if [ "$ENABLE_VNC" = "true" ]; then
    echo "[Entrypoint] Starting VNC services..."
    source /app/scripts/start-vnc.sh
    echo ""
    echo "[Entrypoint] VNC ready at: http://<host>:${NOVNC_PORT:-6080}/vnc.html"
    echo ""
else
    echo "[Entrypoint] VNC disabled (ENABLE_VNC=false)"
fi
# Render injecte automatiquement PORT, on l'utilise en priorité
export HTTP_PORT=${PORT:-${HTTP_PORT:-3000}}

# A published port is useless if the server only listens on loopback, so a
# container binds every interface — which, per GHSA-p69m-c5rf-g2c3, requires a
# token. Fail here with a usable message rather than inside Node.
export HTTP_HOST=${HTTP_HOST:-0.0.0.0}
if [ -z "${NOTEBOOKLM_API_KEY}" ]; then
    echo "[Entrypoint] ERROR: NOTEBOOKLM_API_KEY is not set."
    echo "[Entrypoint] The container binds ${HTTP_HOST}, so every route would be open."
    echo "[Entrypoint] Generate one:  openssl rand -hex 32"
    echo "[Entrypoint] Then pass it:  -e NOTEBOOKLM_API_KEY=<secret>"
    exit 1
fi
echo "[Entrypoint] Starting Node.js HTTP server on port ${HTTP_PORT}..."
echo ""
# Start the Node.js server (foreground)
exec node dist/http-wrapper.js
