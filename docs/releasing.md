# Releasing KubeLynx

A release is a git tag. Pushing `vX.Y.Z` runs [`.github/workflows/release.yml`](../.github/workflows/release.yml), which publishes three things with the same version:

| Artifact | Where |
| --- | --- |
| Container image, linux/amd64 + linux/arm64 | `ghcr.io/rafaelpissolatto/kubelynx:X.Y.Z` (also `:X.Y` and `:latest` for stable releases) |
| Helm chart (OCI) | `oci://ghcr.io/rafaelpissolatto/charts/kubelynx`, version `X.Y.Z` |
| GitHub Release | `vX.Y.Z`, with generated notes and `kubelynx-X.Y.Z.tgz` attached |

The chart's `version` and `appVersion` come from the tag when it's packaged. The values in `charts/kubelynx/Chart.yaml` are placeholders, so don't bump them.

## Steps

1. Make sure the commit you're releasing is on `main` and its `ci` run is green. The release workflow doesn't re-run CI.
2. Tag and push:

   ```sh
   git switch main && git pull
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin vX.Y.Z
   ```

3. Watch the run: `gh run watch $(gh run list --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId')`. The jobs run in order, `image` → `chart-publish` → `github-release`, so a chart is never published without its image.
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

- **`image` or `chart-publish` failed:** re-run the failed job from the Actions UI. Pushing the same image or chart version again just replaces it, and later jobs run once it succeeds.
- **`github-release` failed after creating the Release:** `gh release create` refuses to create a Release that already exists. Either delete the Release (`gh release delete vX.Y.Z`, keeping the tag) and re-run the job, or attach the chart yourself: `gh release upload vX.Y.Z kubelynx-X.Y.Z.tgz`.
- **The tagged commit was wrong:** don't move the tag. Once an image or chart version is published, users may already have pulled it, so a different image under the same version is worse than a gap. Fix `main` and release the next patch version.
