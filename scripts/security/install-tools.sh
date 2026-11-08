#!/usr/bin/env bash
# Installs the pinned security scanners into $BIN_DIR (default: .bin/scan).
# Used by .github/workflows/{security,ci,release}.yml and `make scan`.
#
# Each binary is checked against its release's checksum file, and the
# checksum file is checked against the SHA-256 pinned below. To bump a tool,
# change its version, download the new checksum file and pin its sha256sum.
# govulncheck is installed with `go install`, which the Go checksum database
# verifies. Semgrep runs from a digest-pinned container image instead (see
# the Makefile and security.yml).
#
# Usage: scripts/security/install-tools.sh [tool...]   (default: all)
set -euo pipefail

GITLEAKS_VERSION=8.30.1
GITLEAKS_SUMS_SHA256=061476c21adaf5441516f96f185c1a4706a83cd6329b9b38762271b3d4a52fae
OSV_SCANNER_VERSION=2.7.0
OSV_SCANNER_SUMS_SHA256=95d69019bcfe0586eb8f07aad4c56e2f734ee969e8e3e209591f259a1bfde88c
TRIVY_VERSION=0.76.1
TRIVY_SUMS_SHA256=885debc41b570179e81af560e5f393a66be29b9ff8c52915674f3eb2304c535d
GOSEC_VERSION=2.30.0
GOSEC_SUMS_SHA256=b46f155b99a7d9634ed5724325f75123483acb22bd12c0ecb4da9f72d9a99073
ACTIONLINT_VERSION=1.7.12
ACTIONLINT_SUMS_SHA256=433028cf0ba3c42163ea1a668dedce30fcdbe84fe912b1a5e288c006eab8a4f5
GOVULNCHECK_VERSION=1.9.0

BIN_DIR=${BIN_DIR:-.bin/scan}
mkdir -p "$BIN_DIR"
BIN_DIR=$(cd "$BIN_DIR" && pwd)

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) echo "unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=amd64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) echo "unsupported arch: $(uname -m)" >&2; exit 1 ;;
esac

sha256() {
  if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | awk '{print $1}'
}

# fetch REPO TAG ASSET SUMS_FILE SUMS_SHA256 -> downloads ASSET into $tmp, verified
fetch() {
  local repo=$1 tag=$2 asset=$3 sums=$4 sums_sha=$5 base want
  base="https://github.com/$repo/releases/download/$tag"
  curl -fsSL --retry 3 -o "$tmp/$sums" "$base/$sums"
  if [[ "$(sha256 "$tmp/$sums")" != "$sums_sha" ]]; then
    echo "checksum file $sums does not match its pinned sha256" >&2; exit 1
  fi
  curl -fsSL --retry 3 -o "$tmp/$asset" "$base/$asset"
  want=$(awk -v a="$asset" '$2 == a || $2 == "*"a {print $1}' "$tmp/$sums")
  if [[ -z "$want" || "$(sha256 "$tmp/$asset")" != "$want" ]]; then
    echo "$asset does not match $sums" >&2; exit 1
  fi
}

# Skip a tool whose pinned version is already installed.
installed() { [[ -x "$BIN_DIR/$1" && -f "$BIN_DIR/.$1-$2" ]]; }
mark() { rm -f "$BIN_DIR/.$1-"*; touch "$BIN_DIR/.$1-$2"; }

install_gitleaks() {
  local v=$GITLEAKS_VERSION a=$arch; installed gitleaks $v && return
  [[ $a == amd64 ]] && a=x64
  fetch gitleaks/gitleaks "v$v" "gitleaks_${v}_${os}_${a}.tar.gz" "gitleaks_${v}_checksums.txt" $GITLEAKS_SUMS_SHA256
  tar -xzf "$tmp/gitleaks_${v}_${os}_${a}.tar.gz" -C "$BIN_DIR" gitleaks
  mark gitleaks $v
}

install_osv-scanner() {
  local v=$OSV_SCANNER_VERSION; installed osv-scanner $v && return
  fetch google/osv-scanner "v$v" "osv-scanner_${os}_${arch}" osv-scanner_SHA256SUMS $OSV_SCANNER_SUMS_SHA256
  install -m 0755 "$tmp/osv-scanner_${os}_${arch}" "$BIN_DIR/osv-scanner"
  mark osv-scanner $v
}

install_trivy() {
  local v=$TRIVY_VERSION o a; installed trivy $v && return
  [[ $os == linux ]] && o=Linux || o=macOS
  [[ $arch == amd64 ]] && a=64bit || a=ARM64
  fetch aquasecurity/trivy "v$v" "trivy_${v}_${o}-${a}.tar.gz" "trivy_${v}_checksums.txt" $TRIVY_SUMS_SHA256
  tar -xzf "$tmp/trivy_${v}_${o}-${a}.tar.gz" -C "$BIN_DIR" trivy
  mark trivy $v
}

install_gosec() {
  local v=$GOSEC_VERSION; installed gosec $v && return
  fetch securego/gosec "v$v" "gosec_${v}_${os}_${arch}.tar.gz" "gosec_${v}_checksums.txt" $GOSEC_SUMS_SHA256
  tar -xzf "$tmp/gosec_${v}_${os}_${arch}.tar.gz" -C "$BIN_DIR" gosec
  mark gosec $v
}

install_actionlint() {
  local v=$ACTIONLINT_VERSION; installed actionlint $v && return
  fetch rhysd/actionlint "v$v" "actionlint_${v}_${os}_${arch}.tar.gz" "actionlint_${v}_checksums.txt" $ACTIONLINT_SUMS_SHA256
  tar -xzf "$tmp/actionlint_${v}_${os}_${arch}.tar.gz" -C "$BIN_DIR" actionlint
  mark actionlint $v
}

install_govulncheck() {
  local v=$GOVULNCHECK_VERSION; installed govulncheck $v && return
  GOBIN="$BIN_DIR" go install "golang.org/x/vuln/cmd/govulncheck@v$v"
  mark govulncheck $v
}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

tools=("$@")
[[ ${#tools[@]} -gt 0 ]] || tools=(gitleaks osv-scanner trivy gosec actionlint govulncheck)
for t in "${tools[@]}"; do
  "install_$t"
  echo "installed $t -> $BIN_DIR/$t"
done
