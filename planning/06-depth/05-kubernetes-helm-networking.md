# 06·05 — Kubernetes, k3s/k3d, Traefik, NetworkPolicy, Helm 4 (verified versions and behaviours)

Written 2026-10-09. Versions are from GitHub releases and the k3s release channel today. Behaviours come from source
or primary docs; where a docs summary disagreed with source, source wins and the discrepancy is noted.

---

## 1. Versions to pin (today)

| Component | Version | Note |
|---|---|---|
| k3s | **v1.36.5+k3s1** (channel `stable`); `latest` = v1.37.1+k3s1 | embedded: Traefik **3.7.13** (chart 40.1.5), CoreDNS 1.14.7, local-path-provisioner 0.0.37, Flannel 0.28.4, metrics-server 0.9.0, kube-router network-policy controller, containerd 2.3.4, gateway-api CRDs 1.6.1 |
| k3d | **v5.9.0** (2026-06-02) | its default is **`v1.35.5-k3s1`** (`k3d version`, verified round 6; an earlier note said 1.32.5), so **pass `--image rancher/k3s:v1.36.5-k3s1`** to match the VPS |
| kind | v0.33.0 (default node v1.37.0) | NetworkPolicy still broken on WSL2 (kind#3789 open) |
| Traefik (upstream) | v3.7.14 (2026-10-06) | k3s bundles 3.7.13, which already has the CVE-2026-88878 fix (≥3.7.12) |
| Helm | **v4.3.0** (2026-09-09); v3.22.0 still released | Helm 3 bug fixes ended 2026-09-09 (doc 03) |
| cert-manager | v1.21.2 | — |

---

## 2. Local cluster on this Windows 11 + Docker Desktop machine

```powershell
k3d cluster create urumi `
  --image rancher/k3s:v1.36.5-k3s1 `
  -p "8080:80@loadbalancer" -p "8443:443@loadbalancer" `
  --k3s-arg "--kube-proxy-arg=conntrack-max-per-core=0@server:*" `
  --wait
k3d image import urumi/gateway:dev urumi/woo-mcp:dev urumi/wordpress:dev -c urumi   # no registry needed
```

Known traps (issues read today):
- **k3d#1661 (open):** on WSL2/Docker Desktop the `serverlb` container sometimes stays `Created`, with
  `/etc/confd/values.yaml` missing. Recovery: write the config back and `docker start k3d-<name>-serverlb`, or simply
  delete and re-create the cluster. A rootless Docker context makes it worse.
- **k3d#1513 (open):** after `k3d cluster stop` + `start`, the embedded kube-router network-policy controller wasn't
  enforcing (iptables rules missing). **Never trust NetworkPolicy after a restart. Re-create the cluster, and run the
  negative test (§4.4) as part of every demo check.**
- **k3d#1622:** `nf_conntrack_max: permission denied` on Windows/WSL2 without the `conntrack-max-per-core=0` kube-proxy
  arg (k3d FAQ).
- **kind#3789 (open):** kind's kindnet doesn't enforce NetworkPolicy on WSL2. That's why kind is the fallback (with
  Calico), not the default.
- Port 8080/8443 on the host: Windows `winnat` reserves dynamic port ranges.
  `netsh interface ipv4 show excludedportrange protocol=tcp` shows them; pick ports outside them (doc 05).

**Round 6 on this machine (07 §7):**
- serverlb came up fine (no #1661);
- `winnat` excludes only 28385, 28390, 50000–50059 and 50128;
- NetworkPolicy was enforced ~1.3 s after apply and **still enforced after `k3d cluster stop/start`** (#1513 didn't
  reproduce once). Keep the negative test anyway;
- **`*.localhost` doesn't resolve from Node** on Windows; `*.127.0.0.1.nip.io` / `*.localtest.me` do.

---

## 3. Traefik in k3s: what actually affects MCP streams

### 3.1 Responding timeouts (entry points). Defaults per the Traefik docs:

| Setting | Default | Doc text |
|---|---|---|
| `transport.respondingTimeouts.readTimeout` | **60s** | "maximum duration for reading the entire request, including the body" |
| `writeTimeout` | **0s** | "covers the time from the end of the request header read to the end of the response write" |
| `idleTimeout` | 180s | idle keep-alive connections |
| `lifeCycle.graceTimeOut` | 10s | on Traefik shutdown |

**Does the 60 s `readTimeout` cut an SSE response?** (doc 05 had this as [unverified]). From source:
- Traefik v3.7.14 `pkg/server/server_entrypoint_tcp.go` sets the read deadline once on the raw connection at accept
  time ("because when we're peeking the first byte to determine whether we are doing TLS") **and** as
  `http.Server.ReadTimeout`. Traefik is built with Go 1.26.
- Go `net/http/server.go` (`readRequest`): sets the read deadline to `t0 + ReadTimeout` while reading the request. Once
  the request body is consumed, `connReader.startBackgroundRead()` runs **`cr.rwc.SetReadDeadline(time.Time{})`**
  (clears the deadline) before the background read. Verified present in go1.24.0, go1.25.0, go1.26.0.
- Conclusion: `readTimeout` bounds **reading the request**. An MCP POST has a small JSON body that's read in
  milliseconds, after which the deadline is cleared. So **the default does not cut a long-lived SSE response**. It
  does break slow, large *uploads* (traefik#13503 and #11788 are about 60 s uploads). The only server-side Traefik
  setting that would cut a stream is a non-zero `writeTimeout` (default 0), plus `graceTimeOut` when Traefik itself
  restarts.
- What still cuts idle streams is **other hops**: Azure LB 4-min idle, NAT and home routers, client body-idle timeouts,
  ngrok and similar. The SDK's **15 s `: keepalive` comments** (06·02) cover all of these. E3 remains as a confirmation
  test (run a listen stream for >5 min through Traefik, locally and on the VPS), but the expected outcome is now "passes".
- **Round 6, measured (07 §4):** through k3s Traefik, 90 s silent tool calls passed in both eras; a listen stream
  with 15 s keep-alives survived 400 s idle and received a push. Without keep-alives the stream died at ~300 s. The
  cause was **the client: Node `fetch` (undici) has a 300 s `bodyTimeout`**. With `bodyTimeout: 0` the same stream
  survived 340 s through Traefik. Traefik cut nothing.

### 3.2 Streaming and headers
- Traefik proxies via Go's `httputil.ReverseProxy`. Responses with `Content-Type: text/event-stream` are flushed
  **immediately**; for other responses the default `flushInterval` is 100 ms. No response buffering unless the
  `buffering` middleware is added.
- Compression middleware isn't enabled by k3s. If enabled, keep `text/event-stream` in its excluded types.
- **Forwarded headers:** `forwardedHeaders.trustedIPs` has no default and `insecure: false`. So Traefik **doesn't trust**
  a client's `X-Forwarded-*` and sets its own from the real connection. Source:
  `pkg/middlewares/forwardedheaders/forwarded_header.go` (v3.7.14),
  `if !x.insecure && !x.isTrustedIP(r.RemoteAddr) { DeleteXForwardedHeaders(r.Header) }` then `x.rewrite(r)`. Consequence for WordPress (06·04 §1.2): an
  external caller can't fake `X-Forwarded-Proto: https` through the Ingress; only in-cluster callers that reach the
  WordPress Service directly can, which NetworkPolicy restricts.

### 3.3 Customising the bundled Traefik
k3s installs Traefik through `HelmChart` objects in `kube-system` (`traefik-crd`, `traefik`). Override with a
`HelmChartConfig` named `traefik`, e.g.:
```yaml
apiVersion: helm.cattle.io/v1
kind: HelmChartConfig
metadata: { name: traefik, namespace: kube-system }
spec:
  valuesContent: |-
    ports:
      websecure:
        transport:
          respondingTimeouts: { readTimeout: 120s, writeTimeout: 0s, idleTimeout: 300s }
```
(Only needed if E3 disproves §3.1, or for larger uploads.) k3s 1.36 note: the Traefik chart moved to v40, and the
ingress-nginx compatibility provider was renamed `kubernetesIngressNGINX`. Irrelevant if we use plain Ingress with
`ingressClassName: traefik`.

---

## 4. NetworkPolicy, as enforced by k3s's embedded kube-router

### 4.1 Semantics (Kubernetes)
- A pod is isolated for a direction once **any** policy selecting it lists that direction in `policyTypes`. Allowed
  traffic is the union of all matching rules; there are no deny rules.
- In a `from`/`to` item, `namespaceSelector` + `podSelector` **in the same element** mean AND. As separate list
  elements they mean OR.
- Egress default-deny blocks DNS unless you allow UDP/TCP 53 to `kube-system` pods labelled `k8s-app: kube-dns`.

### 4.2 k3s specifics found today
- **Startup race:** a pod can start before its policy is programmed and briefly connect where it shouldn't
  (k3s#13432, closed as "expected upstream behaviour"; k3s#14711 open asks for kube-router `--netpol-default-deny`).
  Helm creates NetworkPolicy objects **3rd in its install order** (`PriorityClass, Namespace, NetworkPolicy, …`,
  `pkg/release/v1/util/kind_sorter.go`), before workloads, but programming is asynchronous. Fine for our threat model;
  mention it in the threat model as a known window.
- **k3s#14776 (opened 2026-10-09, open):** on multi-node clusters, rules combining `namespaceSelector` + `podSelector`
  in one item were enforced on only one node. Single-node is unaffected. Prefer same-namespace `podSelector`-only rules.
- **k3d#1513:** not enforced after a cluster restart (§2).
- Probes: kubelet probes kept working under default-deny on current versions (k3s#10030 was a dual-stack bug, fixed
  in 1.28.9/1.29.4).

### 4.3 The policy set our design needs (sketch)

| Policy | Selects | Allows |
|---|---|---|
| default-deny | all pods in our namespace | nothing (Ingress + Egress) |
| allow-dns | all pods | egress UDP/TCP 53 → kube-dns |
| woo-mcp-ingress | `woo-mcp` | ingress from `gateway` pods only, port 8080 (M-WM-4) |
| woo-mcp-egress | `woo-mcp` | egress to `wordpress` pods port 80 only |
| wordpress-ingress | `wordpress` | ingress from Traefik (kube-system) on 80 and from `woo-mcp` on 80 |
| mariadb-ingress | `mariadb` | from `wordpress` (and the bootstrap Job) on 3306 |
| gateway-ingress | `gateway` | from Traefik on 8080, from `chat`/`dashboard` backends |
| gateway-egress | `gateway` | to `woo-mcp`, the in-cluster upstream, postgres, and the internet on 443 (external upstreams) |
| postgres-ingress | `postgres` | from `gateway` (and the dashboard API) |

Traefik lives in `kube-system`. Selecting it needs `namespaceSelector: {matchLabels: {kubernetes.io/metadata.name:
kube-system}}` AND `podSelector: {matchLabels: {app.kubernetes.io/name: traefik}}`. That's the combined form from
#14776, fine single-node.

### 4.4 The negative test (must be scripted)
```bash
kubectl run np-probe --rm -it --restart=Never --image=curlimages/curl -n urumi -- \
  curl -sS -m 3 http://woo-mcp:8080/mcp   # expect timeout/failure: the probe pod isn't the gateway
kubectl exec deploy/gateway -n urumi -- wget -qO- -T 3 http://woo-mcp:8080/healthz   # expect success
```

---

## 5. Helm 4 behaviours that change how we write and run the chart

| Topic | Helm 4 behaviour (docs) | Our use |
|---|---|---|
| Apply method | **server-side apply by default for new installs**; upgrades/rollbacks follow the previous release's method (`--server-side auto`); `--force-conflicts` | expect SSA field-manager conflicts if someone `kubectl edit`s; don't mix |
| Waiting | `--wait` default is **`hookOnly`**; `--wait` alone = **`watcher`** (kstatus); `legacy` available; `--wait-for-jobs`; `--timeout` default 5m | `helm upgrade --install --wait --wait-for-jobs --timeout 10m` |
| Atomic | `--atomic` → **`--rollback-on-failure`** (implies `--wait=watcher`); `--force` → `--force-replace` | use `--rollback-on-failure` in the deploy script |
| Dry run | `--dry-run=none\|client\|server` | `lookup` only returns data with `--dry-run=server` (empty under `helm template` / client) |
| History | `--history-max` default 10 | `helm history`, `helm rollback <rev>` (doesn't roll back data) |
| Values schema | `values.schema.json` enforced; `--skip-schema-validation` exists | ship a schema that refuses unsafe values (e.g. `replicaCount > 1` with SQLite, empty secrets in prod) |
| Post-renderers | plugin name only (no executable path) | not needed |
| Charts | apiVersion v2 charts work; chart v3 experimental (`HELM_EXPERIMENTAL_CHART_V3=1`) | stay on v2 |

**Measured in round 6 (07 §15, Helm 4.3.0 on k3s 1.36.5):**
- With `--wait` (= `watcher`, also implied by `--rollback-on-failure`), **post-install hooks start as soon as the
  manifests are applied**, not after workloads are Ready. `--wait=legacy` did wait for readiness first.
- A brand-new hook pod was refused by NetworkPolicy for its first ~1 s. **Every hook/Job must retry its
  dependencies.**
- `lookup`-generated secrets stayed identical across upgrade and rollback; `--dry-run=server` shows the live value.
- A failed upgrade rolled back to the previous revision. A failed **first install** with `--rollback-on-failure` is
  **uninstalled**, so drop that flag while debugging a new chart.

Jobs are immutable (pod template), so a bootstrap Job must be either a hook
(`helm.sh/hook: post-install,post-upgrade`, `helm.sh/hook-delete-policy: before-hook-creation,hook-succeeded`) or named
per revision (`{{ .Release.Name }}-bootstrap-{{ .Release.Revision }}`). The previous cycle used per-revision names (doc 05).

Secret generation pattern (unchanged in Helm 4):
`{{- $s := (lookup "v1" "Secret" .Release.Namespace "x") }}{{ if $s }}{{ index $s.data "k" }}{{ else }}{{ randAlphaNum 40 | b64enc }}{{ end }}`.
It keeps values stable across upgrades; prod can use `existingSecret` instead.

---

## 6. Pod lifecycle details

- **`preStop: sleep`**:
  - `PodLifecycleSleepAction` was alpha in 1.29, **beta (on by default) in 1.30**, and **GA in 1.34**. So
    `lifecycle: {preStop: {sleep: {seconds: 5}}}` works on k3d's default 1.32 and on 1.36.
  - Zero-second sleeps were GA in 1.34.
  - Correction to doc 03/05, which said "GA in 1.32". The raw `kubernetes/website` feature-gate files are the source;
    a docs-page summary got this wrong.
- **Graceful shutdown sequence (gateway):**
  1. Pod marked terminating → EndpointSlice update → Traefik stops routing *new* requests (asynchronous, hence the
     preStop sleep).
  2. SIGTERM → stop accepting → `handler.close()` sends graceful `subscriptions/listen` results (06·02) → wait for
     in-flight calls up to a deadline → exit.
  3. Set `terminationGracePeriodSeconds` ≥ preStop + drain (e.g. 30 s).
- **Sidecar containers** GA in 1.33 (if we ever want a log shipper).
- **Probes per component** (suggested):

  | Component | startup | readiness | liveness |
  |---|---|---|---|
  | gateway | — | `GET /readyz` (DB reachable + catalog loaded) | `GET /healthz` (event loop alive only; no deps) |
  | woo-mcp | — | `GET /readyz` (WooCommerce reachable with a 2 s budget) | `GET /healthz` |
  | wordpress | `tcpSocket :80` (initial copy of `/usr/src/wordpress` takes seconds) | `GET /wp-login.php` (PHP+DB) | `tcpSocket :80` |
  | mariadb | `healthcheck.sh --connect --innodb_initialized` | same | `healthcheck.sh --connect` |
  | postgres | — | `pg_isready -U $POSTGRES_USER` | same, with a higher failure threshold |

- **Resources:** WordPress prefork (06·04 §4) → cap `MaxRequestWorkers` and give the container ≥ 512 Mi with
  PHP `memory_limit=256M` and workers ≈ 4–6 for the demo. Node services ~128–256 Mi. MariaDB ~512 Mi
  (`innodb_buffer_pool_size` ~128M). Postgres ~256 Mi.

---

## 7. Secrets

- Kubernetes Secrets are base64. Protection is RBAC plus etcd/kine encryption.
  - k3s: **`--secrets-encryption`** (generates an AES-CBC key and the encryption config; provider default **`aescbc`**,
    or `--secrets-encryption-provider=secretbox`). It can't be switched on without a server restart.
  - `k3s secrets-encrypt` manages keys and re-encryption.
- Consume as files where the image supports it: the WordPress image supports `*_FILE` for every `WORDPRESS_*` (06·04);
  MariaDB supports `MARIADB_PASSWORD_FILE`; Postgres `POSTGRES_PASSWORD_FILE`.
- The gateway's upstream-credential encryption key and API-key HMAC pepper are Secrets mounted as files (doc 06·06).

---

## 8. The VPS (production-like) path, condensed

1. VM: Azure for Students credit (no card). One small Linux VM; open 22, 80, 443 only.
2. `curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION=v1.36.5+k3s1 sh -s - --secrets-encryption --write-kubeconfig-mode 600 --tls-san <vm-dns>`
3. DNS: a Student Pack domain or DuckDNS. **Not** `cloudapp.azure.com`, which shares Let's Encrypt limits (doc 05).
4. cert-manager v1.21 + `ClusterIssuer` (HTTP-01, `ingressClassName: traefik`). Staging issuer first, then prod.
5. `helm upgrade --install urumi ./chart -f values-prod.yaml --rollback-on-failure --wait-for-jobs --timeout 10m`.
6. Run the same DoD script (doc 05 E16) against the public hostname.

## Sources
- Releases: [k3s v1.36.5+k3s1](https://github.com/k3s-io/k3s/releases/tag/v1.36.5%2Bk3s1) · [k3d v5.9.0](https://github.com/k3d-io/k3d/releases/tag/v5.9.0) ·
  [kind v0.33.0](https://github.com/kubernetes-sigs/kind/releases/tag/v0.33.0) · [Traefik](https://github.com/traefik/traefik/releases) · [Helm](https://github.com/helm/helm/releases) · [k3s channels](https://update.k3s.io/v1-release/channels)
- k3s Traefik manifest: [manifests/traefik.yaml @ v1.36.5+k3s1](https://github.com/k3s-io/k3s/blob/v1.36.5%2Bk3s1/manifests/traefik.yaml); k3d default version: [version/version.go @ v5.9.0](https://github.com/k3d-io/k3d/blob/v5.9.0/version/version.go)
- Traefik source: [pkg/server/server_entrypoint_tcp.go @ v3.7.14](https://github.com/traefik/traefik/blob/v3.7.14/pkg/server/server_entrypoint_tcp.go) · docs: [EntryPoints reference](https://doc.traefik.io/traefik/reference/install-configuration/entrypoints/)
- Go: [net/http/server.go](https://github.com/golang/go/blob/master/src/net/http/server.go) (`startBackgroundRead`, `readRequest`), checked at go1.24.0/1.25.0/1.26.0 tags
- Issues: [traefik#13503](https://github.com/traefik/traefik/issues/13503) · [k3d#1661](https://github.com/k3d-io/k3d/issues/1661) · [k3d#1513](https://github.com/k3d-io/k3d/issues/1513) ·
  [k3d#1622](https://github.com/k3d-io/k3d/issues/1622) · [kind#3789](https://github.com/kubernetes-sigs/kind/issues/3789) · [k3s#13432](https://github.com/k3s-io/k3s/issues/13432) ·
  [k3s#14711](https://github.com/k3s-io/k3s/issues/14711) · [k3s#14776](https://github.com/k3s-io/k3s/issues/14776) · [k3s#10030](https://github.com/k3s-io/k3s/issues/10030)
- Helm: [helm upgrade flags](https://helm.sh/docs/helm/helm_upgrade/) · [Helm 4 overview](https://helm.sh/docs/overview/) · [kind_sorter.go @ v4.3.0](https://github.com/helm/helm/blob/v4.3.0/pkg/release/v1/util/kind_sorter.go)
- Kubernetes feature gates (raw): [PodLifecycleSleepAction.md](https://github.com/kubernetes/website/blob/main/content/en/docs/reference/command-line-tools-reference/feature-gates/PodLifecycleSleepAction.md), SidecarContainers.md
- [k3s secrets encryption](https://docs.k3s.io/security/secrets-encryption)
