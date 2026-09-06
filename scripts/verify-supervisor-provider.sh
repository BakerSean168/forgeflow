#!/usr/bin/env bash
set -euo pipefail

env_file="${FORGEFLOW_SUPERVISOR_ENV_FILE:-/etc/forgeflow/forgeflow.env}"
if [[ ! -r "$env_file" && $EUID -ne 0 ]]; then exec sudo -n "$0" "$@"; fi
if [[ ! -r "$env_file" ]]; then
  echo "provider env file missing: $env_file" >&2
  exit 1
fi
set -a
source "$env_file"
set +a
: "${FORGEFLOW_LITELLM_API_KEY:?FORGEFLOW_LITELLM_API_KEY is required}"
base_url="${FORGEFLOW_SUPERVISOR_BASE_URL:-${FORGEFLOW_V3_LITELLM_URL:-${FORGEFLOW_LITELLM_BASE_URL:-}}}"
: "${base_url:?FORGEFLOW_SUPERVISOR_BASE_URL, FORGEFLOW_V3_LITELLM_URL, or FORGEFLOW_LITELLM_BASE_URL is required}"
models="$(curl --fail-with-body --silent --show-error --max-time 5 -H "Authorization: Bearer $FORGEFLOW_LITELLM_API_KEY" "$base_url/v1/models")"
MODEL_JSON="$models" python3 - <<'PY'
import json, os, sys
payload = json.loads(os.environ["MODEL_JSON"])
models = [item.get("id") for item in payload.get("data", []) if item.get("id")]
if not models:
    raise SystemExit("provider returned no models")
print("provider reachable; models=" + ",".join(models))
PY
