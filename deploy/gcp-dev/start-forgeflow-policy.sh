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

for required in "$auth_file" "$broker_secret" "$projects_file"; do
  [[ -r "$required" ]] || { echo "missing required ForgeFlow Policy file: $required" >&2; exit 2; }
done

export OPEN_SWE_LOCAL_AUTH_TOKEN="$(<"$auth_file")"
export OPEN_SWE_LOCAL_PROJECTS_FILE="$projects_file"
export OPEN_SWE_LOCAL_WORKTREES_DIR="$state_dir/worktrees"
export OPEN_SWE_LOCAL_ARTIFACTS_DIR="$state_dir/artifacts"
export OPEN_SWE_OPENAI_OAUTH_BROKER_URL="http://127.0.0.1:${broker_port}/token"
export OPEN_SWE_OPENAI_OAUTH_BROKER_TOKEN="$(<"$broker_secret")"
export LANGSMITH_TRACING="${LANGSMITH_TRACING:-false}"
export LLM_FALLBACK_MODEL_ID="${LLM_FALLBACK_MODEL_ID:-openai:gpt-5.6-sol}"
export SANDBOX_TYPE="${SANDBOX_TYPE:-local}"
export LOCAL_SANDBOX_ROOT_DIR="${LOCAL_SANDBOX_ROOT_DIR:-$state_dir/reviewer-sandbox}"

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
exec "$HOME/.local/bin/uv" run langgraph dev \
  --no-browser \
  --no-reload \
  --host 127.0.0.1 \
  --port "$port" \
  --n-jobs-per-worker 10 \
  --config langgraph.json
