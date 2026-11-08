# Releasing KubeLynx

A release is a git tag `vX.Y.Z`. Tags are created automatically on merge to `main` (see [Automatic releases](#automatic-releases)), and [`.github/workflows/release.yml`](../.github/workflows/release.yml) then publishes three things with the same version:

| Artifact | Where |
| --- | --- |
| Container image, linux/amd64 + linux/arm64 | `ghcr.io/rafaelpissolatto/kubelynx:X.Y.Z` (also `:X.Y` and `:latest` for stable releases) |
| Helm chart (OCI) | `oci://ghcr.io/rafaelpissolatto/charts/kubelynx`, version `X.Y.Z` |
| GitHub Release | `vX.Y.Z`, with generated notes and `kubelynx-X.Y.Z.tgz` attached |

The chart's `version` and `appVersion` come from the tag when it's packaged. The values in `charts/kubelynx/Chart.yaml` are placeholders, so don't bump them.

## Automatic releases

[`.github/workflows/auto-release.yml`](../.github/workflows/auto-release.yml) runs after every green `ci` run on a push to `main`. It reads the [Conventional Commit](https://www.conventionalcommits.org/) subjects since the last stable tag ([`.github/scripts/next-version.sh`](../.github/scripts/next-version.sh)), pushes the next tag, and calls `release.yml` to publish it.

| Commits since the last tag | Bump |
| --- | --- |
| `type!:` subject or a `BREAKING CHANGE:` footer | major (minor while the version is `0.x`) |
| `feat:` | minor |
| `fix:`, `perf:`, `refactor:`, or a subject with no type | patch |
| only `docs:`, `chore:`, `ci:`, `test:`, `style:`, `build:` | no release |

The highest bump wins, and merge commits are ignored. With squash merges, the PR title is the commit subject, so give PRs Conventional Commit titles.

To force a bump (e.g. to release a docs-only change, or to cut `1.0.0`), run the workflow by hand: Actions → auto-release → Run workflow, choosing `patch`, `minor` or `major`. From a shell: `gh workflow run auto-release.yml -f bump=minor`.

Preview the next version locally with `.github/scripts/next-version.sh`.

A tag pushed by the workflow's `GITHUB_TOKEN` doesn't trigger other workflows, so `auto-release.yml` calls `release.yml` directly (`workflow_call`) instead of relying on the tag push.

## Manual releases

Pushing a tag yourself still runs `release.yml`. You only need this for pre-releases (see below).

1. Make sure the commit you're releasing is on `main` and its `ci` run is green. The release workflow doesn't re-run CI.
2. Tag and push:

   ```sh
   git switch main && git pull
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin vX.Y.Z
   ```

3. Watch the run: `gh run watch $(gh run list --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId')`. (An automatic release runs under `auto-release.yml` instead.) The jobs run in order, `image` → `chart-publish` → `github-release`, so a chart is never published without its image.
4. **First release only:** GHCR creates new packages as private. Open GitHub → your profile → Packages, then for both `kubelynx` and `charts/kubelynx`:
   - Package settings → Change visibility → **Public**.
   - Under "Manage Actions access", confirm `rafaelpissolatto/kubelynx` has **Write** access, so later releases can push.
5. Verify from a shell that isn't logged in to GHCR (`docker logout ghcr.io; helm registry logout ghcr.io`):

   ```sh
   docker manifest inspect ghcr.io/rafaelpissolatto/kubelynx:X.Y.Z   # lists amd64 and arm64
   # stable releases only: latest must be the same image as X.Y.Z
   docker buildx imagetools inspect ghcr.io/rafaelpissolatto/kubelynx:X.Y.Z --format '{{.Manifest.Digest}}'
   docker buildx imagetools inspect ghcr.io/rafaelpissolatto/kubelynx:latest --format '{{.Manifest.Digest}}'
   helm show chart oci://ghcr.io/rafaelpissolatto/charts/kubelynx --version X.Y.Z   # version/appVersion X.Y.Z
   gh release view vX.Y.Z   # kubelynx-X.Y.Z.tgz attached
   ```

## Pre-releases

Tag with a SemVer pre-release suffix, e.g. `v0.2.0-rc.1`. The image gets only the exact tag (`0.2.0-rc.1`), so `latest` and `0.2` don't move, and the GitHub Release is marked as a pre-release.

## If a release fails halfway

- **An automatic release failed:** use "Re-run failed jobs", not "Re-run all jobs". A full re-run sees the commit already tagged and skips publishing. If you can't re-run the jobs, publish the existing tag by deleting and re-pushing it from your shell (`git push origin :refs/tags/vX.Y.Z && git push origin vX.Y.Z`), which runs `release.yml` through its tag trigger.
- **`image` or `chart-publish` failed:** re-run the failed job from the Actions UI. Pushing the same image or chart version again just replaces it, and later jobs run once it succeeds.
- **`github-release` failed after creating the Release:** `gh release create` refuses to create a Release that already exists. Either delete the Release (`gh release delete vX.Y.Z`, keeping the tag) and re-run the job, or attach the chart yourself: `gh release upload vX.Y.Z kubelynx-X.Y.Z.tgz`.
- **The tagged commit was wrong:** don't move the tag. Once an image or chart version is published, users may already have pulled it, so a different image under the same version is worse than a gap. Fix `main` and release the next patch version.
