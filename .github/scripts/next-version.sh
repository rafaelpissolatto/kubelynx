#!/usr/bin/env bash
# Prints the next release tag (vX.Y.Z) for HEAD, derived from Conventional
# Commit subjects since the last stable tag. Prints nothing when there is
# nothing releasable. Usage: next-version.sh [auto|patch|minor|major]
#
#   feat!: / fix!: / "BREAKING CHANGE" in body  -> major (minor while 0.x)
#   feat:                                       -> minor
#   docs: chore: ci: test: style: build:        -> no release on their own
#   anything else (fix:, perf:, refactor:, untyped subjects) -> patch
set -euo pipefail

force="${1:-auto}"

last=$(git describe --tags --abbrev=0 --match 'v[0-9]*.[0-9]*.[0-9]*' --exclude '*-*' HEAD 2>/dev/null || true)
if [[ -n "$last" ]]; then
  range="$last..HEAD"
else
  last="v0.0.0"
  range="HEAD"
fi

IFS=. read -r major minor patch <<<"${last#v}"

bump=none
case "$force" in
  major|minor|patch) bump="$force" ;;
  auto)
    rank() { case "$1" in major) echo 3 ;; minor) echo 2 ;; patch) echo 1 ;; *) echo 0 ;; esac; }
    raise() { (( $(rank "$1") > $(rank "$bump") )) && bump="$1" || true; }
    # %x1e separates commits so multi-line bodies stay intact.
    while IFS= read -r -d $'\x1e' commit; do
      commit="${commit#$'\n'}"
      [[ -z "$commit" ]] && continue
      subject="${commit%%$'\n'*}"
      if [[ "$subject" =~ ^[a-zA-Z]+(\([^\)]*\))?!: ]] || grep -qE '^BREAKING[ -]CHANGE:' <<<"$commit"; then
        raise major
      elif [[ "$subject" =~ ^feat(\([^\)]*\))?: ]]; then
        raise minor
      elif [[ "$subject" =~ ^(docs|chore|ci|test|style|build)(\([^\)]*\))?: ]]; then
        :
      else
        raise patch
      fi
    done < <(git log --no-merges --format='%B%x1e' "$range")
    ;;
  *) echo "unknown bump '$force' (want auto|patch|minor|major)" >&2; exit 2 ;;
esac

# Pre-1.0: a breaking change bumps minor, per SemVer's 0.x convention.
if [[ "$bump" == major && "$major" == 0 && "$force" == auto ]]; then
  bump=minor
fi

case "$bump" in
  major) echo "v$((major + 1)).0.0" ;;
  minor) echo "v$major.$((minor + 1)).0" ;;
  patch) echo "v$major.$minor.$((patch + 1))" ;;
  none)  : ;;
esac
