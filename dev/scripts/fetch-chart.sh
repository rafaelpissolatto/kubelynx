#!/usr/bin/env bash
# Downloads a Helm chart package into $CHART_DIR (the Makefile sets
# dev/.cache/charts) and prints its path:
#
#   CHART_DIR=dir dev/scripts/fetch-chart.sh <repo-url> <chart> <version>
#
# Helm can install from the repos directly, but its fixed HTTP timeout kept
# expiring on big chart downloads here. curl with retries gets through, so:
# look the chart up in the repo's index.yaml, download it with retries, check
# it against the index's SHA-256 digest, and keep it. A chart already in
# $CHART_DIR is reused without touching the network, and survives
# `make clean`.
set -euo pipefail

REPO="${1:?usage: $0 <repo-url> <chart> <version>}"
NAME="${2:?usage: $0 <repo-url> <chart> <version>}"
VERSION="${3:?usage: $0 <repo-url> <chart> <version>}"
DIR="${CHART_DIR:-charts}"
OUT="$DIR/$NAME-$VERSION.tgz"

CURL=(curl -sSfL --retry 6 --retry-all-errors --retry-delay 3 --connect-timeout 20 --max-time 300)

if [[ -s "$OUT" ]] && tar -tzf "$OUT" >/dev/null 2>&1; then
  echo "$OUT"
  exit 0
fi

mkdir -p "$DIR"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "Fetching $NAME $VERSION from ${REPO%/}/index.yaml..." >&2
"${CURL[@]}" -o "$TMP/index.yaml" "${REPO%/}/index.yaml"

# Find this version's entry: its download URL and SHA-256 digest. Parsed with
# plain Python, since the index's layout is regular and no YAML module is
# guaranteed to be installed.
read -r URL DIGEST < <(python3 - "$TMP/index.yaml" "$NAME" "$VERSION" <<'EOF'
import re, sys
text = open(sys.argv[1]).read()
name, version = sys.argv[2], sys.argv[3]
# Each chart version is a list item under entries.<name>, indented by 2.
for block in re.split(r"\n  - ", text):
    url = re.search(r"\n\s*- (\S+/" + re.escape(f"{name}-{version}.tgz") + r")\s*\n", "\n" + block + "\n")
    if not url:
        continue
    digest = re.search(r"\n\s*digest: ([0-9a-f]{64})", "\n" + block)
    print(url.group(1), digest.group(1) if digest else "-")
    break
EOF
) || true  # no match: read hits EOF and fails; reported below
if [[ -z "${URL:-}" ]]; then
  echo "error: $NAME $VERSION not found in ${REPO%/}/index.yaml" >&2
  exit 1
fi
# Some repos list relative URLs.
[[ "$URL" == http* ]] || URL="${REPO%/}/$URL"

echo "Downloading $URL" >&2
"${CURL[@]}" -o "$TMP/chart.tgz" "$URL"

if [[ "$DIGEST" != "-" ]]; then
  echo "$DIGEST  $TMP/chart.tgz" | sha256sum -c --quiet - >&2 || {
    echo "error: SHA-256 mismatch for $NAME $VERSION" >&2
    exit 1
  }
else
  echo "warning: no digest in the index for $NAME $VERSION; not verified" >&2
fi

mv "$TMP/chart.tgz" "$OUT"
echo "$OUT"
