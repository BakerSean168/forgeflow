#!/usr/bin/env bash
set -euo pipefail

repo="${1:-}"
[[ "$repo" == */* ]] || { echo 'usage: check-github-app.sh OWNER/REPO' >&2; exit 2; }
root="${FORGEFLOW_POLICY_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
config_dir="${FORGEFLOW_POLICY_CONFIG_DIR:-$HOME/.config/forgeflow-policy}"
env_file="$config_dir/github-app.env"
[[ -r "$env_file" ]] || {
  printf '{"status":"CONFIG_MISSING","repository":"%s","installation_id":null}\n' "$repo"
  exit 2
}
set -a
# shellcheck disable=SC1090
. "$env_file"
set +a
cd "$root"
exec "$HOME/.local/bin/uv" run python -m forgeflow.preflight github "$repo"
