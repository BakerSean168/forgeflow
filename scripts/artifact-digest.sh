#!/usr/bin/env bash
set -euo pipefail

root="${1:-}"
[[ -n "$root" ]] || { echo "usage: $0 <artifact-directory>" >&2; exit 2; }
root="$(realpath -e -- "$root")"
[[ -d "$root" ]] || { echo "artifact directory is not a directory: $root" >&2; exit 2; }

cd -- "$root"
find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | awk '{print $1}'
