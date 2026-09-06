#!/usr/bin/env bash
set -euo pipefail

repo_root="${FORGEFLOW_ROOT:-/home/dev/projects/forgeflow}"
config_file="${FORGEFLOW_CONFIG_FILE:-/etc/forgeflow/forgeflow.env}"
openhands_env="${FORGEFLOW_OPENHANDS_ENV_FILE:-/etc/forgeflow/openhands.env}"
image="${OPENHANDS_SOURCE_IMAGE:-forgeflow-openhands-agent-server:1.39.1-source}"
[[ $EUID -eq 0 ]] || exec sudo -n "$0" "$@"

for tool in node npm docker systemctl curl setfacl realpath apparmor_parser; do
  command -v "$tool" >/dev/null || { echo "missing tool: $tool" >&2; exit 1; }
done

install -d -o root -g root -m 0750 /etc/forgeflow /var/lib/forgeflow /var/lib/forgeflow/backups
# OpenHands itself runs as uid/gid 10001 and owns only its mutable state/workspace roots.
install -d -o 10001 -g 10001 -m 0750 /var/lib/forgeflow/openhands
install -d -o 10001 -g 10001 -m 0751 /var/lib/forgeflow/workspaces
install -d -o 10001 -g 10001 -m 0751 /var/lib/forgeflow/workspaces/forgeflow /var/lib/forgeflow/workspaces/forgeflow/executions
if [[ ! -f "$config_file" ]]; then install -o root -g root -m 0600 "$repo_root/deploy/forgeflow.env.example" "$config_file"; fi
if [[ ! -f "$openhands_env" ]]; then install -o root -g root -m 0600 "$repo_root/deploy/openhands.env.example" "$openhands_env"; fi
chmod 0600 "$config_file" "$openhands_env"

required_nonempty() {
  local key="$1" message="$2"
  grep -Eq "^${key}=.+$" "$config_file" || { echo "$message" >&2; exit 2; }
}
required_nonempty FORGEFLOW_AUTOMATION_PROJECTS 'configure FORGEFLOW_AUTOMATION_PROJECTS first'
required_nonempty FORGEFLOW_REPOSITORY_WRITE_PATHS 'configure FORGEFLOW_REPOSITORY_WRITE_PATHS first'
required_nonempty FORGEFLOW_OPENHANDS_TOKEN 'configure FORGEFLOW_OPENHANDS_TOKEN first'
grep -Eq '^FORGEFLOW_LITELLM_BASE_URL=https?://.+$' "$config_file" || { echo 'configure FORGEFLOW_LITELLM_BASE_URL first' >&2; exit 2; }
required_nonempty FORGEFLOW_LITELLM_API_KEY 'configure FORGEFLOW_LITELLM_API_KEY first'

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

install -d -o root -g root -m 0755 /etc/systemd/system/forgeflow.service.d
repo_dropin=/etc/systemd/system/forgeflow.service.d/repositories.conf
{
  echo '[Service]'
  for item in "${write_paths[@]}"; do
    [[ "$item" = /* ]] || { echo "repository write path must be absolute" >&2; exit 2; }
    canonical="$(realpath -e -- "$item")"
    [[ -d "$canonical/.git" || -f "$canonical/.git" ]] || { echo "repository write path is not a Git repository: $canonical" >&2; exit 2; }
    admitted=false
    for root in "${canonical_allowed[@]}"; do
      if [[ "$canonical" == "$root"/* ]]; then admitted=true; break; fi
    done
    [[ "$admitted" == true ]] || { echo "repository write path is outside allowed roots: $canonical" >&2; exit 2; }
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
install -o root -g root -m 0755 "$repo_root/scripts/prune-host-cache.sh" /usr/local/libexec/forgeflow-prune-host-cache.sh
install -o root -g root -m 0755 "$repo_root/scripts/run-antigravity-unit.mjs" /usr/local/libexec/forgeflow-antigravity-unit.mjs
systemctl daemon-reload

if ! docker image inspect "$image" >/dev/null 2>&1; then
  OPENHANDS_SOURCE_IMAGE="$image" "$repo_root/scripts/build-openhands-source.sh"
fi
OPENHANDS_SOURCE_IMAGE="$image" \
FORGEFLOW_OPENHANDS_ENV_FILE="$openhands_env" \
FORGEFLOW_OPENHANDS_TOOLS_DIR="$repo_root/openhands_tools" \
  docker compose -f "$repo_root/deploy/openhands/docker-compose.yml" up -d --remove-orphans --wait --wait-timeout 120
dsh_seed="$(awk -F= '$1=="FORGEFLOW_DSH_SEED_DIR"{sub(/^[^=]*=/,""); print; exit}' "$config_file")"
FORGEFLOW_OPENHANDS_CONTAINER=forgeflow-openhands FORGEFLOW_DSH_SEED_DIR="$dsh_seed" \
  "$repo_root/scripts/install-openhands-tooling.sh"

systemctl enable --now forgeflow.service forgeflow-host-cache.timer
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
