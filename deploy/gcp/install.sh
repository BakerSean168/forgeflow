#!/usr/bin/env bash
set -euo pipefail

repo_root="${FORGEFLOW_ROOT:-/home/dev/projects/forgeflow}"
config_file="${FORGEFLOW_CONFIG_FILE:-/etc/forgeflow/forgeflow.env}"
openhands_env="${FORGEFLOW_OPENHANDS_ENV_FILE:-/etc/forgeflow/openhands.env}"
image="${OPENHANDS_SOURCE_IMAGE:-forgeflow-openhands-agent-server:1.39.1-source}"
[[ $EUID -eq 0 ]] || exec sudo -n "$0" "$@"

for tool in node npm git docker systemctl curl setfacl realpath apparmor_parser; do
  command -v "$tool" >/dev/null || { echo "missing tool: $tool" >&2; exit 1; }
done

install -d -o root -g root -m 0750 /etc/forgeflow
# Workers need execute-only traversal to their workspace subtree; state contents remain non-listable.
install -d -o root -g root -m 0711 /var/lib/forgeflow
install -d -o root -g root -m 0750 /var/lib/forgeflow/backups
# OpenHands itself runs as uid/gid 10001 and owns only its mutable state/workspace roots.
install -d -o 10001 -g 10001 -m 0750 /var/lib/forgeflow/openhands
install -d -o 10001 -g 10001 -m 0751 /var/lib/forgeflow/workspaces
install -d -o 10001 -g 10001 -m 0751 /var/lib/forgeflow/workspaces/forgeflow /var/lib/forgeflow/workspaces/forgeflow/executions
if [[ ! -f "$config_file" ]]; then install -o root -g root -m 0600 "$repo_root/deploy/forgeflow.env.example" "$config_file"; fi
if [[ ! -f "$openhands_env" ]]; then install -o root -g root -m 0600 "$repo_root/deploy/openhands.env.example" "$openhands_env"; fi
chmod 0600 "$config_file" "$openhands_env"
[[ ! -f /var/lib/forgeflow/forgeflow.sqlite ]] || chmod 0600 /var/lib/forgeflow/forgeflow.sqlite

required_nonempty() {
  local key="$1" message="$2"
  grep -Eq "^${key}=.+$" "$config_file" || { echo "$message" >&2; exit 2; }
}
required_nonempty FORGEFLOW_AUTOMATION_PROJECTS 'configure FORGEFLOW_AUTOMATION_PROJECTS first'
required_nonempty FORGEFLOW_REPOSITORY_WRITE_PATHS 'configure FORGEFLOW_REPOSITORY_WRITE_PATHS first'
required_nonempty FORGEFLOW_OPENHANDS_TOKEN 'configure FORGEFLOW_OPENHANDS_TOKEN first'
grep -Eq '^FORGEFLOW_LITELLM_BASE_URL=https?://.+$' "$config_file" || { echo 'configure FORGEFLOW_LITELLM_BASE_URL first' >&2; exit 2; }
required_nonempty FORGEFLOW_LITELLM_API_KEY 'configure FORGEFLOW_LITELLM_API_KEY first'

admin_base="$(awk -F= '$1=="FORGEFLOW_LITELLM_ADMIN_BASE_URL"{sub(/^[^=]*=/,""); print; exit}' "$config_file")"
[[ -n "$admin_base" ]] || admin_base="$(awk -F= '$1=="FORGEFLOW_LITELLM_BASE_URL"{sub(/^[^=]*=/,""); print; exit}' "$config_file")"
admin_base="${admin_base%/}"
admin_base="${admin_base%/v1}"
admin_env="$(awk -F= '$1=="FORGEFLOW_LITELLM_ADMIN_ENV_FILE"{sub(/^[^=]*=/,""); print; exit}' "$config_file")"
admin_key_name="$(awk -F= '$1=="FORGEFLOW_LITELLM_ADMIN_KEY_NAME"{sub(/^[^=]*=/,""); print; exit}' "$config_file")"
[[ -n "$admin_env" ]] || admin_env=/etc/forgeflow/litellm.env
[[ -n "$admin_key_name" ]] || admin_key_name=LITELLM_MASTER_KEY
[[ -r "$admin_env" ]] || { echo 'LiteLLM admin credential file is not readable' >&2; exit 2; }
admin_key="$(awk -F= -v key="$admin_key_name" '$1==key{sub(/^[^=]*=/,""); print; exit}' "$admin_env")"
[[ -n "$admin_key" ]] || { echo 'LiteLLM admin key is missing' >&2; exit 2; }
admin_status="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 -H "Authorization: Bearer $admin_key" "$admin_base/model/info" || true)"
[[ "$admin_status" =~ ^2[0-9][0-9]$ ]] || { echo "LiteLLM admin API preflight failed: /model/info HTTP $admin_status" >&2; exit 2; }
unset admin_key

allowed_raw="$(awk -F= '$1=="FORGEFLOW_ALLOWED_REPOSITORY_ROOTS"{sub(/^[^=]*=/,""); print; exit}' "$config_file")"
writes_raw="$(awk -F= '$1=="FORGEFLOW_REPOSITORY_WRITE_PATHS"{sub(/^[^=]*=/,""); print; exit}' "$config_file")"
[[ -n "$allowed_raw" && -n "$writes_raw" ]] || { echo 'repository root/write policy missing' >&2; exit 2; }
IFS=',' read -r -a allowed_roots <<<"$allowed_raw"
IFS=',' read -r -a write_paths <<<"$writes_raw"
canonical_allowed=()
for item in "${allowed_roots[@]}"; do
  [[ "$item" = /* ]] || { echo "allowed repository root must be absolute" >&2; exit 2; }
  canonical_allowed+=("$(realpath -e -- "$item")")
done
canonical_writes=()
for item in "${write_paths[@]}"; do
  [[ "$item" = /* ]] || { echo "repository write path must be absolute" >&2; exit 2; }
  canonical="$(realpath -e -- "$item")"
  [[ -d "$canonical/.git" || -f "$canonical/.git" ]] || { echo "repository write path is not a Git repository: $canonical" >&2; exit 2; }
  admitted=false
  for root in "${canonical_allowed[@]}"; do
    if [[ "$canonical" == "$root"/* ]]; then admitted=true; break; fi
  done
  [[ "$admitted" == true ]] || { echo "repository write path is outside allowed roots: $canonical" >&2; exit 2; }
  canonical_writes+=("$canonical")
done

install -d -o root -g root -m 0755 /etc/systemd/system/forgeflow.service.d
repo_dropin=/etc/systemd/system/forgeflow.service.d/repositories.conf
{
  echo '[Service]'
  for canonical in "${canonical_writes[@]}"; do
    printf 'ReadWritePaths=%s\n' "$canonical"
  done
} >"$repo_dropin.tmp"
install -o root -g root -m 0644 "$repo_dropin.tmp" "$repo_dropin"
rm -f "$repo_dropin.tmp"

install -o root -g root -m 0644 "$repo_root/deploy/openhands/forgeflow-openhands-codex.apparmor" /etc/apparmor.d/forgeflow-openhands-codex
apparmor_parser -r /etc/apparmor.d/forgeflow-openhands-codex

install -o root -g root -m 0644 "$repo_root/deploy/gcp/forgeflow.service" /etc/systemd/system/forgeflow.service
install -o root -g root -m 0644 "$repo_root/deploy/gcp/forgeflow-host-cache.service" /etc/systemd/system/forgeflow-host-cache.service
install -o root -g root -m 0644 "$repo_root/deploy/gcp/forgeflow-host-cache.timer" /etc/systemd/system/forgeflow-host-cache.timer
install -o root -g root -m 0644 "$repo_root/deploy/gcp/forgeflow-antigravity@.service" /etc/systemd/system/forgeflow-antigravity@.service
install -o root -g root -m 0644 "$repo_root/deploy/gcp/forgeflow-self-promote.service" /etc/systemd/system/forgeflow-self-promote.service
install -o root -g root -m 0644 "$repo_root/deploy/gcp/forgeflow-self-promote.path" /etc/systemd/system/forgeflow-self-promote.path
install -o root -g root -m 0755 "$repo_root/scripts/prune-host-cache.sh" /usr/local/libexec/forgeflow-prune-host-cache.sh
install -o root -g root -m 0755 "$repo_root/scripts/run-antigravity-unit.mjs" /usr/local/libexec/forgeflow-antigravity-unit.mjs
install -o root -g root -m 0755 "$repo_root/scripts/run-antigravity-sandbox.sh" /usr/local/libexec/forgeflow-antigravity-sandbox.sh
install -o root -g root -m 0755 "$repo_root/scripts/artifact-digest.sh" /usr/local/libexec/forgeflow-artifact-digest.sh
install -o root -g root -m 0755 "$repo_root/scripts/self-promote-gcp.sh" /usr/local/libexec/forgeflow-self-promote.sh
systemctl daemon-reload

if ! docker image inspect "$image" >/dev/null 2>&1; then
  OPENHANDS_SOURCE_IMAGE="$image" "$repo_root/scripts/build-openhands-source.sh"
fi

literal_enabled="$(awk -F= '$1=="FORGEFLOW_LITERAL_WORKTREES_ENABLED"{sub(/^[^=]*=/,""); print; exit}' "$config_file")"
literal_projects="$(awk -F= '$1=="FORGEFLOW_LITERAL_WORKTREE_PROJECTS"{sub(/^[^=]*=/,""); print; exit}' "$config_file")"
literal_repositories="$(awk -F= '$1=="FORGEFLOW_LITERAL_WORKTREE_REPOSITORIES"{sub(/^[^=]*=/,""); print; exit}' "$config_file")"
literal_override=/etc/forgeflow/openhands-literal-worktrees.override.yml
compose_args=(-f "$repo_root/deploy/openhands/docker-compose.yml")
if [[ "$literal_enabled" == true ]]; then
  [[ -n "$literal_projects" ]] || { echo 'literal worktrees require FORGEFLOW_LITERAL_WORKTREE_PROJECTS' >&2; exit 2; }
  [[ -n "$literal_repositories" ]] || { echo 'literal worktrees require FORGEFLOW_LITERAL_WORKTREE_REPOSITORIES' >&2; exit 2; }
  IFS=',' read -r -a literal_repo_items <<<"$literal_repositories"
  common_dirs=()
  for item in "${literal_repo_items[@]}"; do
    [[ "$item" = /* ]] || { echo 'literal worktree repository must be absolute' >&2; exit 2; }
    canonical="$(realpath -e -- "$item")"
    admitted=false
    for writable in "${canonical_writes[@]}"; do
      if [[ "$canonical" == "$writable" ]]; then admitted=true; break; fi
    done
    [[ "$admitted" == true ]] || { echo "literal worktree repository is not an authorized write path: $canonical" >&2; exit 2; }
    toplevel="$(git -C "$canonical" rev-parse --show-toplevel)"
    [[ "$(realpath -e -- "$toplevel")" == "$canonical" ]] || { echo "literal worktree repository is not a canonical Git root: $canonical" >&2; exit 2; }
    common_raw="$(git -C "$canonical" rev-parse --git-common-dir)"
    if [[ "$common_raw" = /* ]]; then
      common="$(realpath -e -- "$common_raw")"
    else
      common="$(realpath -e -- "$canonical/$common_raw")"
    fi
    [[ -d "$common" && "$(basename -- "$common")" == .git ]] || { echo "literal worktree Git common directory is unsafe: $common" >&2; exit 2; }
    [[ "$common" != *:* && "$common" != *"'"* && "$common" != *$'\n'* && "$common" != *$'\r'* ]] || { echo "literal worktree Git common directory contains unsupported characters" >&2; exit 2; }
    duplicate=false
    for existing in "${common_dirs[@]:-}"; do
      if [[ "$existing" == "$common" ]]; then duplicate=true; break; fi
    done
    [[ "$duplicate" == true ]] || common_dirs+=("$common")
  done
  {
    echo 'services:'
    echo '  agent-server:'
    echo '    volumes:'
    for common in "${common_dirs[@]}"; do
      printf "      - '%s:%s:rw'\n" "$common" "$common"
    done
  } >"$literal_override.tmp"
  install -o root -g root -m 0644 "$literal_override.tmp" "$literal_override"
  rm -f "$literal_override.tmp"
  compose_args+=(-f "$literal_override")

  # A configured source repository may itself be a linked Git worktree. In that
  # topology its .git file points at a common directory outside the source
  # worktree root. ProtectHome=read-only would otherwise make that shared Git
  # metadata read-only even though the source worktree itself is admitted via
  # FORGEFLOW_REPOSITORY_WRITE_PATHS. Grant only the exact, already-validated
  # common directories required by literal-worktree projects.
  literal_git_dropin=/etc/systemd/system/forgeflow.service.d/literal-git-common-dirs.conf
  {
    echo '[Service]'
    for common in "${common_dirs[@]}"; do
      printf 'ReadWritePaths=%s\n' "$common"
    done
  } >"$literal_git_dropin.tmp"
  install -o root -g root -m 0644 "$literal_git_dropin.tmp" "$literal_git_dropin"
  rm -f "$literal_git_dropin.tmp"
else
  rm -f "$literal_override" "$literal_override.tmp"
  rm -f /etc/systemd/system/forgeflow.service.d/literal-git-common-dirs.conf \
    /etc/systemd/system/forgeflow.service.d/literal-git-common-dirs.conf.tmp
fi

# The literal Git common-dir drop-in is generated after the base unit files, so
# reload once more before the service is restarted below.
systemctl daemon-reload

OPENHANDS_SOURCE_IMAGE="$image" \
FORGEFLOW_OPENHANDS_ENV_FILE="$openhands_env" \
FORGEFLOW_OPENHANDS_TOOLS_DIR="$repo_root/openhands_tools" \
  docker compose "${compose_args[@]}" up -d --remove-orphans --wait --wait-timeout 120
dsh_seed="$(awk -F= '$1=="FORGEFLOW_DSH_SEED_DIR"{sub(/^[^=]*=/,""); print; exit}' "$config_file")"
FORGEFLOW_OPENHANDS_CONTAINER=forgeflow-openhands FORGEFLOW_DSH_SEED_DIR="$dsh_seed" \
  "$repo_root/scripts/install-openhands-tooling.sh"

systemctl enable forgeflow.service forgeflow-host-cache.timer forgeflow-self-promote.path
systemctl restart forgeflow.service
systemctl restart forgeflow-host-cache.timer
systemctl restart forgeflow-self-promote.path
for _ in $(seq 1 45); do
  if payload="$(curl -fsS http://127.0.0.1:8420/api/health 2>/dev/null)"; then
    HEALTH_JSON="$payload" node - <<'NODE'
const h = JSON.parse(process.env.HEALTH_JSON ?? '{}');
if (h.status !== 'ok' || h.service !== 'forgeflow-control-plane' || h.apiVersion !== 1) process.exit(1);
NODE
    exit 0
  fi
  sleep 1
done
echo 'ForgeFlow did not become healthy' >&2
exit 1
