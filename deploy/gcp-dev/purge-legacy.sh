#!/usr/bin/env bash
set -euo pipefail

[[ "${FORGEFLOW_POLICY_CONFIRM_PURGE:-}" == "YES" ]] || {
  echo 'Refusing destructive purge: set FORGEFLOW_POLICY_CONFIRM_PURGE=YES' >&2
  exit 2
}

root="${FORGEFLOW_POLICY_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
config_dir="${FORGEFLOW_POLICY_CONFIG_DIR:-$HOME/.config/forgeflow-policy}"
state_dir="${FORGEFLOW_POLICY_STATE_DIR:-$HOME/.local/share/forgeflow-policy}"
port="${FORGEFLOW_POLICY_PORT:-58810}"
broker_port="${OPEN_SWE_CODEX_BROKER_PORT:-58811}"
auth_file="$config_dir/local-auth.secret"
broker_secret="$state_dir/codex-broker.secret"

replacement_preflight() {
  systemctl --user is-active --quiet forgeflow-policy.service || {
    echo 'forgeflow-policy.service is not active; refusing legacy purge' >&2
    return 1
  }
  systemctl --user is-active --quiet open-swe-codex-broker.service || {
    echo 'open-swe-codex-broker.service is not active; refusing legacy purge' >&2
    return 1
  }
  [[ -r "$auth_file" && -r "$broker_secret" ]] || {
    echo 'replacement auth/broker secret file is unavailable' >&2
    return 1
  }

  expected_fragment="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/forgeflow-policy.service"
  fragment="$(systemctl --user show forgeflow-policy.service -p FragmentPath --value)"
  [[ "$fragment" == "$expected_fragment" ]] || {
    echo "unexpected forgeflow-policy.service fragment: $fragment" >&2
    return 1
  }
  execstart="$(systemctl --user show forgeflow-policy.service -p ExecStart --value)"
  [[ "$execstart" == *"$root/deploy/gcp-dev/start-forgeflow-policy.sh"* ]] || {
    echo 'forgeflow-policy.service is not running the expected replacement checkout' >&2
    return 1
  }

  auth="$(<"$auth_file")"
  curl -fsS --max-time 10 -H "Authorization: Bearer $auth" \
    "http://127.0.0.1:$port/ok" >/dev/null
  assistants="$(curl -fsS --max-time 10 -X POST \
    -H "Authorization: Bearer $auth" -H 'content-type: application/json' \
    "http://127.0.0.1:$port/assistants/search" -d '{"limit":20}')"
  ASSISTANTS_JSON="$assistants" python3 - <<'PY'
import json, os
required={"agent","reviewer","analyzer","chat","scheduler","external_agent","forgeflow"}
actual={item.get("graph_id") for item in json.loads(os.environ["ASSISTANTS_JSON"])}
missing=required-actual
if missing:
    raise SystemExit(f"replacement is missing graphs: {sorted(missing)}")
PY

  broker_token="$(<"$broker_secret")"
  code="$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer $broker_token" "http://127.0.0.1:$broker_port/token")"
  [[ "$code" == 200 ]] || {
    echo "replacement Codex broker health failed: HTTP $code" >&2
    return 1
  }
}

unit_load_state() {
  systemctl show "$1" -p LoadState --value 2>/dev/null || printf 'not-found\n'
}

stop_legacy_unit() {
  local unit="$1" load
  load="$(unit_load_state "$unit")"
  [[ "$load" == not-found ]] && return 0
  sudo -n systemctl stop "$unit"
  if systemctl is-active --quiet "$unit"; then
    echo "legacy unit is still active after stop: $unit" >&2
    return 1
  fi
  if systemctl is-enabled --quiet "$unit" 2>/dev/null; then
    sudo -n systemctl disable "$unit"
  fi
}

replacement_preflight

legacy_units=(
  forgeflow.service
  forgeflow-host-cache.timer
  forgeflow-host-cache.service
  forgeflow-self-promote.path
  forgeflow-self-promote.service
)
for unit in "${legacy_units[@]}"; do
  stop_legacy_unit "$unit"
done
while read -r unit _; do
  [[ -n "$unit" ]] || continue
  stop_legacy_unit "$unit"
done < <(systemctl list-units 'forgeflow-antigravity@*.service' --all --plain --no-legend 2>/dev/null || true)

# No destructive deletion is permitted until every known legacy service is quiescent.
for unit in "${legacy_units[@]}"; do
  systemctl is-active --quiet "$unit" 2>/dev/null && {
    echo "legacy unit remained active: $unit" >&2
    exit 1
  }
done
while read -r unit _; do
  [[ -n "$unit" ]] || continue
  systemctl is-active --quiet "$unit" && {
    echo "legacy Antigravity unit remained active: $unit" >&2
    exit 1
  }
done < <(systemctl list-units 'forgeflow-antigravity@*.service' --all --plain --no-legend 2>/dev/null || true)

if docker ps -a --format '{{.Names}}' | grep -Fxq 'forgeflow-openhands'; then
  docker rm -f forgeflow-openhands >/dev/null
fi
if docker image inspect forgeflow-openhands-agent-server:1.39.1-source >/dev/null 2>&1; then
  docker image rm forgeflow-openhands-agent-server:1.39.1-source >/dev/null
fi

sudo -n rm -rf /var/lib/forgeflow
sudo -n rm -f \
  /etc/systemd/system/forgeflow.service \
  /etc/systemd/system/forgeflow-antigravity@.service \
  /etc/systemd/system/forgeflow-host-cache.service \
  /etc/systemd/system/forgeflow-host-cache.timer \
  /etc/systemd/system/forgeflow-self-promote.service \
  /etc/systemd/system/forgeflow-self-promote.path
sudo -n rm -rf /etc/systemd/system/forgeflow.service.d

legacy_libexec=(
  /usr/local/libexec/forgeflow-antigravity-git-provenance.mjs
  /usr/local/libexec/forgeflow-antigravity-sandbox.sh
  /usr/local/libexec/forgeflow-antigravity-unit.mjs
  /usr/local/libexec/forgeflow-artifact-digest.sh
  /usr/local/libexec/forgeflow-prune-host-cache.sh
  /usr/local/libexec/forgeflow-self-promote.sh
)
sudo -n rm -f "${legacy_libexec[@]}"

apparmor_profile=/etc/apparmor.d/forgeflow-openhands-codex
if [[ -f "$apparmor_profile" ]]; then
  if sudo -n grep -q '^forgeflow-openhands-codex ' /sys/kernel/security/apparmor/profiles 2>/dev/null; then
    sudo -n apparmor_parser -R "$apparmor_profile"
  fi
  sudo -n rm -f "$apparmor_profile"
fi

sudo -n rm -f \
  /etc/forgeflow/forgeflow.env \
  /etc/forgeflow/openhands.env \
  /etc/forgeflow/openhands-literal-worktrees.override.yml
sudo -n systemctl daemon-reload
sudo -n systemctl reset-failed 'forgeflow-antigravity@*.service' 2>/dev/null || true

# /etc/forgeflow/litellm.env is deliberately preserved; LiteLLM may own it independently.
echo 'Legacy ForgeFlow Node/OpenHands/Antigravity state purged after replacement verification.'
