#!/usr/bin/env bash
set -Eeuo pipefail

root="${FORGEFLOW_POLICY_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
config_dir="${FORGEFLOW_POLICY_CONFIG_DIR:-$HOME/.config/forgeflow-policy}"
state_dir="${FORGEFLOW_POLICY_STATE_DIR:-$HOME/.local/share/forgeflow-policy}"
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
port="${FORGEFLOW_POLICY_PORT:-58810}"
broker_port="${OPEN_SWE_CODEX_BROKER_PORT:-58811}"
projects_source="${FORGEFLOW_POLICY_PROJECTS_SOURCE:-}"
routes_source="${FORGEFLOW_POLICY_ROUTES_SOURCE:-}"

for tool in git openssl systemctl curl python3 docker sudo; do
  command -v "$tool" >/dev/null || { echo "missing tool: $tool" >&2; exit 2; }
done
previous_root="$(systemctl --user show forgeflow-policy.service -p WorkingDirectory --value 2>/dev/null || true)"
policy_was_active=false
if systemctl --user is-active --quiet forgeflow-policy.service; then
  policy_was_active=true
fi
[[ -x "$HOME/.local/bin/uv" ]] || { echo "uv is required at $HOME/.local/bin/uv" >&2; exit 2; }
[[ -r "$HOME/.codex/auth.json" ]] || { echo "Codex auth is required at ~/.codex/auth.json" >&2; exit 2; }
linger="$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || true)"
[[ "$linger" == yes ]] || {
  echo "systemd user lingering must be enabled for $USER before installing ForgeFlow Policy" >&2
  exit 2
}

mkdir -p "$config_dir" "$state_dir" "$state_dir/worktrees" "$state_dir/artifacts" \
  "$state_dir/reviewer-sandbox" "$state_dir/external-agent-workspaces" "$unit_dir"
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

if [[ -n "$routes_source" ]]; then
  [[ -r "$routes_source" ]] || { echo "routes source is not readable: $routes_source" >&2; exit 2; }
  python3 -m json.tool "$routes_source" >/dev/null
  install -m 0600 "$routes_source" "$config_dir/routes.json"
elif [[ ! -f "$config_dir/routes.json" ]]; then
  install -m 0600 "$root/deploy/gcp-dev/routes.default.json" "$config_dir/routes.json"
fi
python3 -m json.tool "$config_dir/routes.json" >/dev/null

cd "$root"
"$HOME/.local/bin/uv" sync --locked --python 3.14
"$HOME/.local/bin/uv" run python -m forgeflow.routing validate "$config_dir/routes.json" >/dev/null
"$HOME/.local/bin/uv" run pytest -q
"$HOME/.local/bin/uv" run ruff check forgeflow openswe_ext tests
"$root/deploy/gcp-dev/setup-docker-sandbox.sh"

# LangGraph local-dev persists to .langgraph_api relative to its working directory.
# Stop the writer before migrating/linking that state so changing code roots does
# not create a second checkpoint universe. Any failure until the replacement
# policy process is started again restores a previously-active service.
policy_restore_pending=false
restore_policy_on_error() {
  local status=$?
  trap - ERR
  if [[ "$policy_restore_pending" == true && "$policy_was_active" == true ]]; then
    systemctl --user start forgeflow-policy.service || true
  fi
  exit "$status"
}
trap restore_policy_on_error ERR
if [[ "$policy_was_active" == true ]]; then
  policy_restore_pending=true
  systemctl --user stop forgeflow-policy.service
  if systemctl --user is-active --quiet forgeflow-policy.service; then
    echo "forgeflow-policy.service is still active; refusing LangGraph state migration" >&2
    systemctl --user start forgeflow-policy.service || true
    policy_restore_pending=false
    trap - ERR
    exit 1
  fi
fi
migration_args=(--root "$root" --state-dir "$state_dir")
if [[ -n "$previous_root" && -d "$previous_root" ]]; then
  migration_args+=(--previous-root "$previous_root")
fi
if ! python3 "$root/deploy/gcp-dev/migrate_langgraph_state.py" "${migration_args[@]}"; then
  if [[ "$policy_was_active" == true ]]; then
    systemctl --user start forgeflow-policy.service || true
  fi
  exit 1
fi

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
render_unit "$root/deploy/gcp-dev/forgeflow-openswe-sandbox-gc.service.in" "$unit_dir/forgeflow-openswe-sandbox-gc.service"
render_unit "$root/deploy/gcp-dev/forgeflow-openswe-sandbox-gc.timer.in" "$unit_dir/forgeflow-openswe-sandbox-gc.timer"

systemctl --user daemon-reload
systemctl --user enable open-swe-codex-broker.service
systemctl --user restart open-swe-codex-broker.service
systemctl --user enable --now forgeflow-openswe-sandbox-gc.timer
systemctl --user enable forgeflow-policy.service
systemctl --user restart forgeflow-policy.service
policy_restore_pending=false
trap - ERR

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
expected={"agent","reviewer","analyzer","chat","scheduler","external_agent","forgeflow"}
items=json.loads(os.environ["ASSISTANTS_JSON"])
actual={item.get("graph_id") for item in items}
missing=sorted(expected-actual)
if missing:
    raise SystemExit(f"missing graph ids: {missing}")
print("graphs=", ",".join(sorted(expected)))
PY

echo "ForgeFlow Policy service healthy on 127.0.0.1:$port"
