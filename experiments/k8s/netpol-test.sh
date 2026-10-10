#!/usr/bin/env bash
# E7 NetworkPolicy probe matrix. Prints OK/BLOCKED per path. Usage: k8s/netpol-test.sh
probe() { # <from-pod-selector> <url> <label>
  local pod; pod=$(kubectl -n exp get pod -l "$1" -o name | head -1)
  local r; r=$(kubectl -n exp exec "$pod" -- node -e "fetch('$2',{signal:AbortSignal.timeout(3000)}).then(r=>console.log('OK '+r.status)).catch(e=>console.log('BLOCKED '+(e.cause?.code||e.name)))" 2>&1 | tail -1)
  printf '  %-44s %s\n' "$3" "$r"
}
probe role=rogue   http://demo-upstream.exp.svc.cluster.local:8080/healthz "rogue   -> demo-upstream (expect BLOCKED)"
probe role=rogue   http://spike-gateway.exp.svc.cluster.local/healthz      "rogue   -> spike-gateway (expect BLOCKED)"
probe app=spike-gateway http://demo-upstream.exp.svc.cluster.local:8080/healthz "gateway -> demo-upstream (expect OK)"
probe app=spike-gateway http://ship-upstream.exp.svc.cluster.local:8080/healthz "gateway -> ship-upstream (expect OK)"
printf '  %-44s %s\n' "host -> Traefik -> spike-gateway (expect OK)" "$(curl -s -o /dev/null -w 'HTTP %{http_code}' --max-time 5 http://gw.127.0.0.1.nip.io:8080/healthz)"
