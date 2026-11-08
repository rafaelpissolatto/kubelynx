# Security scanning

CI scans the source, the dependencies, the git history and the built image. Each scanner is a pass/fail gate. CI runs the same `make` targets you can run locally, so a local run gives the same result as CI.

## What runs, and when

| Area | Scanner | Fails on | Workflow / job | Make target | Suppressions |
| --- | --- | --- | --- | --- | --- |
| Go dependencies and stdlib | [govulncheck](https://go.dev/doc/security/vuln/) | any vulnerability reachable from kubelynx's call graph | `security` / `govulncheck` | `scan-govulncheck` | none, see [below](#govulncheck) |
| npm + Go dependencies | [osv-scanner](https://google.github.io/osv-scanner/) on `web/package-lock.json` and `go.mod` | HIGH/CRITICAL (CVSS ≥ 7.0) with a fixed version | `security` / `dependencies` | `scan-deps` | `osv-scanner.toml` |
| SAST, Go | [gosec](https://github.com/securego/gosec) | any finding | `security` / `sast` | `scan-gosec` | `// #nosec G<rule> -- reason` |
| SAST, Go + TS/React + Dockerfile | [semgrep](https://semgrep.dev) (`p/golang`, `p/typescript`, `p/javascript`, `p/react`, `p/dockerfile`) | any blocking finding | `security` / `sast` | `scan-sast` | `// nosemgrep: <rule-id> -- reason` |
| Secrets | [gitleaks](https://github.com/gitleaks/gitleaks) | any unallowlisted secret | `security` / `secrets` | `scan-secrets` | `.gitleaks.toml` |
| Container image | [Trivy](https://trivy.dev) | HIGH/CRITICAL with a fix available | `ci` / `docker`; `release` / `image` | `scan-image` | `.trivyignore.yaml` |
| Suppression policy | `scripts/security/check-suppressions.py` | a suppression with no reason, or an expired one | `security` / `suppressions` | `scan-suppressions` | n/a |
| SAST, Go + TS (CodeQL) | [CodeQL](https://codeql.github.com) | n/a, results go to the Security tab | `security` / `codeql` | n/a | GitHub UI |

The `security` workflow runs on every pull request, on push to `main`, weekly (Monday 06:17 UTC, so new CVEs in unchanged code still get found) and by hand (`gh workflow run security.yml`). On a pull request gitleaks scans only the PR's commits. Every other run scans the full history.

Image scanning runs where the image is built:

- **`ci.yml` `docker`** builds the linux/amd64 image, loads it as `kubelynx:ci` and scans it.
- **`release.yml` `image`** goes build → scan → push. It builds linux/amd64 locally, scans it, and only then builds and pushes the multi-arch image, reusing the builder cache. If the scan fails, nothing is pushed, and `chart-publish` and `github-release` don't run. The arm64 image can only be scanned after the push (it is scanned by digest). A failure there still stops the chart and the GitHub Release.

Unfixed vulnerabilities and anything below the threshold are still listed in the job log and in the reports, but they don't fail the build.

### Reports

Every job uploads its reports (SARIF, plus osv-scanner JSON) as a workflow artifact named `scan-<job>`, e.g. `scan-sast` or `scan-image`. To fetch them: `gh run download <run-id> -n scan-sast`. Locally they go to `scan-reports/`.

### Required status checks

Ask the repo admin to mark these checks as required on `main`: `suppressions`, `govulncheck`, `dependencies`, `sast`, `secrets` (from `security`) and `docker` (from `ci`). Once CodeQL is on (see below), add `codeql (go, autobuild)` and `codeql (javascript-typescript, none)`.

## Security tab and CodeQL

Both are **off**. One repo variable turns them on:

```sh
gh variable set SECURITY_TAB_UPLOAD --body true
```

With `SECURITY_TAB_UPLOAD=true`:

- every scan job also uploads its SARIF to **Security → Code scanning**, each under its own category (`govulncheck`, `osv-scanner`, `gosec`, `semgrep`, `gitleaks`, `trivy-image`, `trivy-image-release`)
- the `codeql` job runs for `go` and `javascript-typescript`

Nothing else changes. The gates and the artifacts stay as they are.

**Set it only after the repo can use code scanning.** The repo is private and owned by a personal account. GitHub supports code scanning and SARIF upload on public repos, and on private repos owned by an organization on GitHub Team or Enterprise Cloud with a [GitHub Code Security](https://docs.github.com/en/get-started/learning-about-github/about-github-advanced-security) license. Until then, `upload-sarif` fails with "Code scanning is not enabled for this repository". The [CodeQL terms](https://github.com/github/codeql-cli-binaries/blob/main/LICENSE.md) also forbid running CodeQL on non-open-source code (e.g. a private repo) without that paid license, even without uploading the results. So the SAST gate is gosec + semgrep, which need neither. Once the variable is on, CodeQL adds coverage alongside them.

## Triaging a finding

1. Open the failed job's log. Each scanner prints the finding, the affected package or file, and the fixed version if there is one. The full report is in the `scan-<job>` artifact.
2. **Fix it if you can.** Most findings are fixed by bumping a dependency:
   - Go stdlib: bump the `go` line in `go.mod` **and** `golang:X.Y.Z-alpine` in the `Dockerfile` together.
   - Go module: `go get example.com/mod@vX.Y.Z && go mod tidy`.
   - npm: `cd web && npm update <pkg>` (or `npm install <pkg>@<fixed>`). For a transitive dependency, add an `overrides` entry in `web/package.json`.
   - Distroless base: rebuilding picks up the latest `gcr.io/distroless/static-debian12:nonroot`. If it is still vulnerable, wait for an upstream rebuild and suppress until then.
3. Re-run the scanner locally (`make scan-…`) to confirm.
4. Suppress only if the finding is a false positive, can't be reached, or has no fix yet. Follow the rules below.

## Suppressing a false positive

Rules for every suppression:

- **It needs a reason.** Say why the finding doesn't apply, or why it can't be fixed yet. "False positive" alone is not a reason.
- **It needs an expiry, where the tool supports one** (Trivy, osv-scanner). Use at most ~90 days. After that date the finding comes back and fails the build until someone re-triages it.
- **Keep it narrow.** Suppress one ID, rule or line, not a whole package, directory or rule set.
- **It gets reviewed like code.** The suppression goes in the same PR as the change that needs it, and the reviewer checks the reason, not just the syntax.

The `suppressions` job (`make scan-suppressions`) fails on a missing reason, a missing or passed expiry, or a `#nosec` without a rule ID and reason.

### Trivy: `.trivyignore.yaml`

```yaml
vulnerabilities:
  - id: CVE-2026-12345
    paths:            # optional, narrows it to one target in the image
      - "kubelynx"
    statement: >-
      Only reachable through HTTP/2 server push, which kubelynx never enables.
      Upstream fix lands in golang.org/x/net v0.63.
    expired_at: 2027-01-31
```

`statement` and `expired_at` are required. Trivy stops honoring an entry after `expired_at`.

### osv-scanner: `osv-scanner.toml`

```toml
[[IgnoredVulns]]
id = "GHSA-xxxx-xxxx-xxxx"
ignoreUntil = 2027-01-31
reason = "Dev-server only (vite); never shipped in web/dist. No fixed release yet."
```

`reason` and `ignoreUntil` are required.

### govulncheck

govulncheck only reports code that can actually be reached, so its findings are rarely false positives, and it has no ignore file. Fix the finding by upgrading. If no fix exists yet, open an issue and make the decision explicit in the PR. Don't work around the gate.

### gosec: inline `#nosec`

```go
data, err := os.ReadFile(path) // #nosec G304 -- operator-supplied config file path
```

Name the rule (`G304`) and give a reason after `--`. A bare `#nosec` fails the `suppressions` job.

### semgrep: inline `nosemgrep`

```ts
el.innerHTML = trusted; // nosemgrep: <rule-id> -- static, build-time string
```

Always name the rule ID. It's in the job log and in `semgrep.sarif`.

### gitleaks: `.gitleaks.toml`

For a single line, add an inline `gitleaks:allow` comment. For fixtures, add a narrow allowlist with a `description`:

```toml
[[allowlists]]
description = "Dummy bearer token used by internal/promclient tests"
paths = ['''^internal/promclient/testdata/token$''']
regexes = ['''not-a-real-token-[0-9]+''']
```

**If a real secret was committed, an allowlist is the wrong fix.** Rotate the secret first. Removing it from history comes second.

## Running the scanners locally

```sh
make scan-tools    # install the pinned scanners into .bin/scan (checksum-verified)
make scan          # suppressions, govulncheck, osv-scanner, gosec, semgrep, gitleaks
make image scan-image          # build kubelynx:dev and scan it with Trivy
make lint-workflows            # actionlint on .github/workflows
make scan-secrets GITLEAKS_LOG_OPTS=origin/main..HEAD   # only your branch's commits
```

`scan-sast` runs semgrep from a digest-pinned container image, so it needs Docker. The rest download pinned binaries (linux or macOS, amd64 or arm64) and need Go and `jq`. Versions and checksums live in `scripts/security/install-tools.sh`.

To bump a scanner, change its version in `scripts/security/install-tools.sh` and pin the SHA-256 of the new release's checksum file. For semgrep, update `SEMGREP_IMAGE` in the `Makefile` (`docker buildx imagetools inspect semgrep/semgrep:<version>` prints the digest). Prefer releases that are at least two weeks old.

## Supply chain of the published image

Release images carry BuildKit attestations: an SPDX SBOM and SLSA provenance (`mode=max`). To inspect them:

```sh
docker buildx imagetools inspect ghcr.io/rafaelpissolatto/kubelynx:X.Y.Z --format '{{ json .SBOM }}'
docker buildx imagetools inspect ghcr.io/rafaelpissolatto/kubelynx:X.Y.Z --format '{{ json .Provenance }}'
```

Image and chart signing (cosign) is not set up yet. Keyless signing writes the repo identity to the public Rekor transparency log, so it waits on the public-vs-private decision.
