{{- define "urumi.labels" -}}
app.kubernetes.io/part-of: urumi
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}

{{- define "urumi.storeUrl" -}}
http://{{ .Values.store.host }}.{{ .Values.baseDomain }}{{ if ne (int .Values.publicPort) 80 }}:{{ .Values.publicPort }}{{ end }}
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
