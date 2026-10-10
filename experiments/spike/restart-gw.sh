#!/usr/bin/env bash
# Restart only the gateway with extra env (KEY=VAL ...). Upstreams keep running.
cd "$(dirname "$0")/.."
spike/killport.sh 7801
export UPSTREAMS=${UPSTREAMS:-'[{"slug":"demo","url":"http://127.0.0.1:7802/mcp"},{"slug":"shipping","url":"http://127.0.0.1:7803/mcp","headers":{"Authorization":"Bearer s3cret"}}]'}
(env "$@" fnm exec --using=24.21.0 node spike/gateway.mjs > out/gw.log 2>&1 &)
for i in $(seq 1 40); do curl -sf localhost:7801/healthz >/dev/null && break; sleep 0.25; done; sleep 0.5
