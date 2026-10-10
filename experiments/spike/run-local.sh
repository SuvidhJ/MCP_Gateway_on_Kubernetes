#!/usr/bin/env bash
# Start the local spike stack: two upstreams + gateway with public upstreams. Usage: spike/run-local.sh [extra env assignments...]
cd "$(dirname "$0")/.." && mkdir -p out
N="fnm exec --using=24.21.0 node"
pkill -f "spike/(upstream|gateway).mjs" 2>/dev/null; taskkill //F //IM node.exe //FI "WINDOWTITLE eq spike*" >/dev/null 2>&1
(PORT=7802 NAME=demo $N spike/upstream.mjs > out/up-demo.log 2>&1 &)
(PORT=7803 NAME=shipping TOKEN=s3cret $N spike/upstream.mjs > out/up-ship.log 2>&1 &)
sleep 1.5
export UPSTREAMS=${UPSTREAMS:-'[{"slug":"demo","url":"http://127.0.0.1:7802/mcp"},{"slug":"shipping","url":"http://127.0.0.1:7803/mcp","headers":{"Authorization":"Bearer s3cret"}},{"slug":"deepwiki","url":"https://mcp.deepwiki.com/mcp"},{"slug":"mslearn","url":"https://learn.microsoft.com/api/mcp"},{"slug":"cfdocs","url":"https://docs.mcp.cloudflare.com/mcp"}]'}
(env "$@" $N spike/gateway.mjs > out/gw.log 2>&1 &)
for i in $(seq 1 40); do curl -sf localhost:7801/healthz >/dev/null && break; sleep 0.5; done
