#!/usr/bin/env bash
set -euo pipefail

repo_root="${FORGEFLOW_ROOT:-/home/dev/projects/forgeflow}"
release_ref="${FORGEFLOW_RELEASE_REF:-refs/forgeflow/release-approved}"
release_lock="${FORGEFLOW_RELEASE_LOCK:-/tmp/forgeflow-release.lock}"
candidate="${1:-}"

[[ -n "$candidate" ]] || { echo "usage: $0 <exact-commit-sha>" >&2; exit 2; }
[[ "$release_ref" == refs/forgeflow/* ]] || { echo "release ref must stay below refs/forgeflow" >&2; exit 1; }
exec 9>"$release_lock"
flock -n 9 || { echo "another ForgeFlow release is active" >&2; exit 1; }
sha="$(git -C "$repo_root" rev-parse "${candidate}^{commit}")"
git -C "$repo_root" cat-file -e "${sha}^{commit}"
old="$(git -C "$repo_root" rev-parse --verify "${release_ref}^{commit}" 2>/dev/null || true)"
if [[ -n "$old" ]] && ! git -C "$repo_root" merge-base --is-ancestor "$old" "$sha"; then
  echo "release approval must fast-forward" >&2
  exit 1
fi
git -C "$repo_root" update-ref -m "ForgeFlow release approval" "$release_ref" "$sha" "${old:-0000000000000000000000000000000000000000}"
printf 'release_ref=%s\nsource_sha=%s\n' "$release_ref" "$sha"
