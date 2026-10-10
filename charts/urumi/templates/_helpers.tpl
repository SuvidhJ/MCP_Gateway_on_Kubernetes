{{- define "urumi.labels" -}}
app.kubernetes.io/part-of: urumi
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}

{{/* Public URL of a host under baseDomain: http(s)://<host>.<baseDomain>[:port] (no port for 80/443). */}}
{{- define "urumi.publicUrl" -}}
{{ ternary "https" "http" .root.Values.tls.enabled }}://{{ .host }}.{{ .root.Values.baseDomain }}{{ if not (has (int .root.Values.publicPort) (list 80 443)) }}:{{ .root.Values.publicPort }}{{ end }}
{{- end -}}

{{- define "urumi.storeUrl" -}}
{{ include "urumi.publicUrl" (dict "root" . "host" .Values.store.host) }}
{{- end -}}

{{/* Reuse a generated secret value across upgrades: read the live Secret, else use the generated value. */}}
{{- define "urumi.secretValue" -}}
{{- $s := lookup "v1" "Secret" .ns .name -}}
{{- if and $s $s.data (hasKey $s.data .key) -}}
{{- index $s.data .key | b64dec -}}
{{- else -}}
{{- .gen -}}
{{- end -}}
{{- end -}}

{{/* WordPress container env, shared by the Deployment and the bootstrap Job. */}}
{{- define "urumi.wpEnv" -}}
- { name: WORDPRESS_DB_HOST, value: "mariadb:3306" }
- { name: WORDPRESS_DB_NAME, valueFrom: { secretKeyRef: { name: store-db, key: database } } }
- { name: WORDPRESS_DB_USER, valueFrom: { secretKeyRef: { name: store-db, key: user } } }
- { name: WORDPRESS_DB_PASSWORD, valueFrom: { secretKeyRef: { name: store-db, key: password } } }
{{- range $k := list "AUTH_KEY" "SECURE_AUTH_KEY" "LOGGED_IN_KEY" "NONCE_KEY" "AUTH_SALT" "SECURE_AUTH_SALT" "LOGGED_IN_SALT" "NONCE_SALT" }}
- { name: WORDPRESS_{{ $k }}, valueFrom: { secretKeyRef: { name: store-app, key: {{ $k }} } } }
{{- end }}
- name: WORDPRESS_CONFIG_EXTRA
  value: |
    define('WP_HOME', '{{ include "urumi.storeUrl" . }}');
    define('WP_SITEURL', '{{ include "urumi.storeUrl" . }}');
    define('DISALLOW_FILE_MODS', true);
    define('WP_MEMORY_LIMIT', '256M');
    define('WP_ENVIRONMENT_TYPE', 'production');
{{- end -}}
