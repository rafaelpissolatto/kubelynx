#!/usr/bin/env bash
# Scans web/package-lock.json and go.mod with osv-scanner and fails only on
# HIGH/CRITICAL (CVSS >= 7.0) vulnerabilities that have a fixed version.
# osv-scanner itself fails on any finding at all, so its exit code is not the
# gate; the JSON report is filtered here instead. Everything it finds still
# goes into the SARIF report. Suppressions: osv-scanner.toml.
#
# Go advisories (GO-*) usually carry no CVSS score, so they rarely trip this
# gate; govulncheck is the Go gate.
#
# Usage: scripts/security/osv-gate.sh [report-dir]   (needs osv-scanner, jq)
set -euo pipefail

out=${1:-scan-reports}
mkdir -p "$out"
args=(scan source --config osv-scanner.toml --lockfile web/package-lock.json --lockfile go.mod)

# Exit 1 means "vulnerabilities found"; anything above that is a real error.
rc=0; osv-scanner "${args[@]}" --format sarif --output-file "$out/osv-scanner.sarif" || rc=$?
(( rc <= 1 )) || exit "$rc"
rc=0; osv-scanner "${args[@]}" --format json --output-file "$out/osv-scanner.json" || rc=$?
(( rc <= 1 )) || exit "$rc"
osv-scanner "${args[@]}" --format table || true

blocking=$(jq -r '
  [ .results[]?.packages[]? as $p
    | $p.groups[]? as $g
    | select(($g.max_severity | tonumber? // 0) >= 7.0)
    | select([ $p.vulnerabilities[]?
               | select(.id as $id | $g.ids | index($id))
               | .affected[]? | select(.package.name == $p.package.name)
               | .ranges[]?.events[]? | has("fixed") ] | any)
    | "\($p.package.ecosystem) \($p.package.name)@\($p.package.version): \($g.ids | join(", ")) (CVSS \($g.max_severity))"
  ] | unique | .[]' "$out/osv-scanner.json")

if [[ -n "$blocking" ]]; then
  echo
  echo "Blocking: HIGH/CRITICAL vulnerabilities with a fix available:"
  echo "$blocking"
  echo "Upgrade the package, or suppress with a reason and expiry in osv-scanner.toml (docs/security-scanning.md)."
  exit 1
fi
echo "osv-scanner gate: no HIGH/CRITICAL fixable vulnerabilities."
