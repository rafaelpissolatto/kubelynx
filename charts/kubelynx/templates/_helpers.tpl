{{- define "kubelynx.name" -}}
{{- .Chart.Name | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Release-qualified name; collapses to the release name when it already
contains the chart name (e.g. `helm install kubelynx ...` → "kubelynx").
*/}}
{{- define "kubelynx.fullname" -}}
{{- if contains .Chart.Name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{- define "kubelynx.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "kubelynx.selectorLabels" -}}
app.kubernetes.io/name: {{ include "kubelynx.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "kubelynx.labels" -}}
helm.sh/chart: {{ include "kubelynx.chart" . }}
{{ include "kubelynx.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
JSON for a port-list file. Args: [values-dict, allowed-keys, values-path].
Every key must hold a list; entries are stringified because the binary's JSON
structs want strings ("8081") and YAML would otherwise hand them numbers.
Unknown keys fail the render: the binary silently ignores them, so a typo
would leave the built-in defaults in place.
*/}}
{{- define "kubelynx.portsJSON" -}}
{{- $cfg := index . 0 }}
{{- $allowed := index . 1 }}
{{- $path := index . 2 }}
{{- $out := dict }}
{{- range $key, $ports := $cfg }}
{{- if not (has $key $allowed) }}
{{- fail (printf "%s: unknown key %q; allowed keys: %s" $path $key (join ", " $allowed)) }}
{{- end }}
{{- if not (kindIs "slice" $ports) }}
{{- fail (printf "%s.%s must be a list of ports" $path $key) }}
{{- end }}
{{- $list := list }}
{{- range $ports }}
{{- $list = append $list (toString .) }}
{{- end }}
{{- $_ := set $out $key $list }}
{{- end }}
{{- toJson $out }}
{{- end }}

{{- define "kubelynx.tcpPortAllowlistJSON" -}}
{{- include "kubelynx.portsJSON" (list .Values.cardinality.tcpPortAllowlist (list "tcp") "cardinality.tcpPortAllowlist") }}
{{- end }}

{{- define "kubelynx.protocolPortsJSON" -}}
{{- include "kubelynx.portsJSON" (list .Values.protocol.ports (list "http" "grpc") "protocol.ports") }}
{{- end }}
