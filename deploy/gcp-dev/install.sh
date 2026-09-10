#!/usr/bin/env bash
set -euo pipefail

root="${FORGEFLOW_POLICY_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
config_dir="${FORGEFLOW_POLICY_CONFIG_DIR:-$HOME/.config/forgeflow-policy}"
state_dir="${FORGEFLOW_POLICY_STATE_DIR:-$HOME/.local/share/forgeflow-policy}"
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
port="${FORGEFLOW_POLICY_PORT:-58810}"
broker_port="${OPEN_SWE_CODEX_BROKER_PORT:-58811}"
projects_source="${FORGEFLOW_POLICY_PROJECTS_SOURCE:-}"

for tool in git openssl systemctl curl python3 docker sudo; do
  command -v "$tool" >/dev/null || { echo "missing tool: $tool" >&2; exit 2; }
done
[[ -x "$HOME/.local/bin/uv" ]] || { echo "uv is required at $HOME/.local/bin/uv" >&2; exit 2; }
[[ -r "$HOME/.codex/auth.json" ]] || { echo "Codex auth is required at ~/.codex/auth.json" >&2; exit 2; }
linger="$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || true)"
[[ "$linger" == yes ]] || {
  echo "systemd user lingering must be enabled for $USER before installing ForgeFlow Policy" >&2
  exit 2
}

mkdir -p "$config_dir" "$state_dir" "$state_dir/worktrees" "$state_dir/artifacts" \
  "$state_dir/reviewer-sandbox" "$unit_dir"
chmod 700 "$config_dir" "$state_dir"

create_secret() {
  local path="$1"
  if [[ ! -s "$path" ]]; then
    umask 077
    openssl rand -base64 48 | tr -d '\n' >"$path"
  fi
  chmod 600 "$path"
}
create_secret "$config_dir/local-auth.secret"
create_secret "$state_dir/codex-broker.secret"

if [[ -n "$projects_source" ]]; then
  [[ -r "$projects_source" ]] || { echo "projects source is not readable: $projects_source" >&2; exit 2; }
  python3 -m json.tool "$projects_source" >/dev/null
  install -m 0600 "$projects_source" "$config_dir/projects.json"
elif [[ ! -f "$config_dir/projects.json" ]]; then
  printf '[]\n' >"$config_dir/projects.json"
  chmod 600 "$config_dir/projects.json"
fi
python3 -m json.tool "$config_dir/projects.json" >/dev/null

cd "$root"
"$HOME/.local/bin/uv" sync --locked --python 3.14
"$HOME/.local/bin/uv" run pytest -q
"$HOME/.local/bin/uv" run ruff check forgeflow openswe_ext tests
"$root/deploy/gcp-dev/setup-docker-sandbox.sh"

render_unit() {
  local source="$1" target="$2"
  sed \
    -e "s|@ROOT@|$root|g" \
    -e "s|@CONFIG_DIR@|$config_dir|g" \
    -e "s|@STATE_DIR@|$state_dir|g" \
    -e "s|@PORT@|$port|g" \
    -e "s|@BROKER_PORT@|$broker_port|g" \
    "$source" >"$target.tmp"
  mv "$target.tmp" "$target"
  chmod 600 "$target"
}
render_unit "$root/deploy/gcp-dev/open-swe-codex-broker.service.in" "$unit_dir/open-swe-codex-broker.service"
render_unit "$root/deploy/gcp-dev/forgeflow-policy.service.in" "$unit_dir/forgeflow-policy.service"

systemctl --user daemon-reload
systemctl --user enable --now open-swe-codex-broker.service
systemctl --user enable forgeflow-policy.service
systemctl --user restart forgeflow-policy.service

auth="$(<"$config_dir/local-auth.secret")"
ready=false
for _ in $(seq 1 90); do
  if curl -fsS -H "Authorization: Bearer $auth" "http://127.0.0.1:$port/ok" >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
[[ "$ready" == true ]] || {
  systemctl --user status forgeflow-policy.service --no-pager -l >&2 || true
  exit 1
}

payload="$(curl -fsS -X POST -H "Authorization: Bearer $auth" -H 'content-type: application/json' \
  "http://127.0.0.1:$port/assistants/search" -d '{"limit":20}')"
ASSISTANTS_JSON="$payload" python3 - <<'PY'
import json, os
expected={"agent","reviewer","analyzer","chat","scheduler","forgeflow"}
items=json.loads(os.environ["ASSISTANTS_JSON"])
actual={item.get("graph_id") for item in items}
missing=sorted(expected-actual)
if missing:
    raise SystemExit(f"missing graph ids: {missing}")
print("graphs=", ",".join(sorted(expected)))
PY

echo "ForgeFlow Policy service healthy on 127.0.0.1:$port"
