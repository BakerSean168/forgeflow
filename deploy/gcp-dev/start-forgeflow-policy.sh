#!/usr/bin/env bash
set -euo pipefail

root="${FORGEFLOW_POLICY_ROOT:?FORGEFLOW_POLICY_ROOT is required}"
config_dir="${FORGEFLOW_POLICY_CONFIG_DIR:-$HOME/.config/forgeflow-policy}"
state_dir="${FORGEFLOW_POLICY_STATE_DIR:-$HOME/.local/share/forgeflow-policy}"
port="${FORGEFLOW_POLICY_PORT:-58810}"
broker_port="${OPEN_SWE_CODEX_BROKER_PORT:-58811}"

auth_file="$config_dir/local-auth.secret"
broker_secret="$state_dir/codex-broker.secret"
projects_file="$config_dir/projects.json"
github_env="$config_dir/github-app.env"
litellm_glm53_key="$config_dir/litellm-glm53.key"
routes_file="$config_dir/routes.json"
attempt_ledger_file="$state_dir/attempt-ledger.jsonl"
langgraph_state_dir="$state_dir/langgraph"
langgraph_root_link="$root/.langgraph_api"

for required in "$auth_file" "$broker_secret" "$projects_file" "$litellm_glm53_key" "$routes_file"; do
  [[ -r "$required" ]] || { echo "missing required ForgeFlow Policy file: $required" >&2; exit 2; }
done
expected_langgraph_state="$(readlink -f "$langgraph_state_dir" 2>/dev/null || true)"
resolved_langgraph_state="$(readlink -f "$langgraph_root_link" 2>/dev/null || true)"
[[ -n "$expected_langgraph_state" && -d "$expected_langgraph_state" && "$resolved_langgraph_state" == "$expected_langgraph_state" ]] || {
  echo "LangGraph state link must resolve to $expected_langgraph_state" >&2
  exit 2
}

export OPEN_SWE_LOCAL_AUTH_TOKEN="$(<"$auth_file")"
export OPEN_SWE_LOCAL_PROJECTS_FILE="$projects_file"
export OPEN_SWE_LOCAL_WORKTREES_DIR="$state_dir/worktrees"
export OPEN_SWE_LOCAL_ARTIFACTS_DIR="$state_dir/artifacts"
export FORGEFLOW_ROUTE_CONFIG_FILE="$routes_file"
export FORGEFLOW_ATTEMPT_LEDGER_FILE="$attempt_ledger_file"
export OPEN_SWE_OPENAI_OAUTH_BROKER_URL="http://127.0.0.1:${broker_port}/token"
export OPEN_SWE_OPENAI_OAUTH_BROKER_TOKEN="$(<"$broker_secret")"

# GCP Dev keeps both control and execution self-hosted. The default execution
# boundary is the Open SWE Docker provider; upstream remote providers remain
# available only when explicitly configured in the service environment.
export LANGSMITH_TRACING="${LANGSMITH_TRACING:-false}"
# ForgeFlow implementation/repair uses the Open SWE-supported Fireworks GLM 5.3
# identity, but points that provider at the private Tailnet LiteLLM gateway.
# The scoped virtual key can call only the GLM alias; the upstream provider key
# remains on Oracle2. Role-specific fallback is installed by openswe_ext.model_policy.
export FIREWORKS_API_BASE="${FORGEFLOW_LITELLM_BASE_URL:-https://oracle.taile92a8e.ts.net:10446}"
export FIREWORKS_API_KEY="$(<"$litellm_glm53_key")"
unset LLM_FALLBACK_MODEL_ID

# External-agent routing is a production availability fallback. Open SWE remains
# the priority-10 implementation route; Antigravity is priority 20. CodeBuddy is a
# guarded priority-30 route and stays scheduler-disabled until its account credential
# and DeepSeek V4.1 Flash canary have passed. Each external agent owns only one bounded
# ACP turn inside the ForgeFlow Docker/workspace/evidence boundary.
export FORGEFLOW_ANTIGRAVITY_ACP_ENABLED="${FORGEFLOW_ANTIGRAVITY_ACP_ENABLED:-true}"
export FORGEFLOW_AUTOMATIC_ROUTE_FALLBACK_ENABLED="${FORGEFLOW_AUTOMATIC_ROUTE_FALLBACK_ENABLED:-true}"
export FORGEFLOW_ANTIGRAVITY_ACP_PROJECTS="${FORGEFLOW_ANTIGRAVITY_ACP_PROJECTS:-}"
export FORGEFLOW_EXTERNAL_AGENT_WORKSPACE_ROOT="${FORGEFLOW_EXTERNAL_AGENT_WORKSPACE_ROOT:-$HOME/.local/share/forgeflow-policy/external-agent-workspaces}"
export FORGEFLOW_ANTIGRAVITY_BIN="${FORGEFLOW_ANTIGRAVITY_BIN:-$HOME/.local/bin/agy}"
export FORGEFLOW_ANTIGRAVITY_MODEL="${FORGEFLOW_ANTIGRAVITY_MODEL:-gemini-3.8-flash-high}"
export FORGEFLOW_ANTIGRAVITY_EFFORT="${FORGEFLOW_ANTIGRAVITY_EFFORT:-high}"
export FORGEFLOW_ANTIGRAVITY_MODE="${FORGEFLOW_ANTIGRAVITY_MODE:-accept-edits}"
export FORGEFLOW_ANTIGRAVITY_PRINT_TIMEOUT="${FORGEFLOW_ANTIGRAVITY_PRINT_TIMEOUT:-20m}"
export FORGEFLOW_EXTERNAL_AGENT_OUTER_SANDBOX="${FORGEFLOW_EXTERNAL_AGENT_OUTER_SANDBOX:-docker}"
export FORGEFLOW_ANTIGRAVITY_AUTH_STATE_DIR="${FORGEFLOW_ANTIGRAVITY_AUTH_STATE_DIR:-$HOME/.gemini/antigravity-cli}"
export FORGEFLOW_CODEBUDDY_ACP_ENABLED="${FORGEFLOW_CODEBUDDY_ACP_ENABLED:-true}"
export FORGEFLOW_CODEBUDDY_ACP_PROJECTS="${FORGEFLOW_CODEBUDDY_ACP_PROJECTS:-}"
export FORGEFLOW_CODEBUDDY_BIN="${FORGEFLOW_CODEBUDDY_BIN:-$HOME/.local/bin/codebuddy}"
export FORGEFLOW_CODEBUDDY_MODEL="${FORGEFLOW_CODEBUDDY_MODEL:-deepseek-v4-flash}"
export FORGEFLOW_CODEBUDDY_INTERNET_ENVIRONMENT="${FORGEFLOW_CODEBUDDY_INTERNET_ENVIRONMENT:-internal}"
export FORGEFLOW_CODEBUDDY_AUTH_TOKEN_FILE="${FORGEFLOW_CODEBUDDY_AUTH_TOKEN_FILE:-$config_dir/codebuddy-auth.token}"
export FORGEFLOW_CODEBUDDY_API_KEY_FILE="${FORGEFLOW_CODEBUDDY_API_KEY_FILE:-$config_dir/codebuddy-api.key}"
export FORGEFLOW_EXTERNAL_AGENT_DOCKER_IMAGE="${FORGEFLOW_EXTERNAL_AGENT_DOCKER_IMAGE:-forgeflow/openswe-sandbox:bookworm-node24}"
export SANDBOX_TYPE="${SANDBOX_TYPE:-docker}"

# Full official Reviewer requires a separate Open SWE GitHub App. Loading this
# file is optional for graph health but mandatory for real reviewer acceptance.
if [[ -r "$github_env" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "$github_env"
  set +a
fi

# Prefer the already-authenticated Codex/ChatGPT OAuth path over a stray API key.
unset OPENAI_API_KEY OPENAI_BASE_URL

cd "$root"
"$HOME/.local/bin/uv" run python -m forgeflow.routing validate "$routes_file" >/dev/null
exec "$HOME/.local/bin/uv" run langgraph dev \
  --no-browser \
  --no-reload \
  --host 127.0.0.1 \
  --port "$port" \
  --n-jobs-per-worker 10 \
  --config langgraph.json
