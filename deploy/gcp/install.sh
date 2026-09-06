#!/usr/bin/env bash
set -euo pipefail
repo_root="${FORGEFLOW_ROOT:-/home/dev/projects/forgeflow}"
[[ $EUID -eq 0 ]] || exec sudo -n "$0" "$@"
for tool in node npm docker systemctl curl setfacl; do command -v "$tool" >/dev/null || { echo "missing tool: $tool" >&2; exit 1; }; done
install -d -o root -g root -m 0750 /etc/forgeflow /var/lib/forgeflow /var/lib/forgeflow/backups /var/lib/forgeflow/openhands
install -d -o root -g root -m 0711 /var/lib/forgeflow/workspaces /var/lib/forgeflow/workspaces/forgeflow /var/lib/forgeflow/workspaces/forgeflow/executions
if [[ ! -f /etc/forgeflow/forgeflow.env ]]; then install -o root -g root -m 0600 "$repo_root/deploy/forgeflow.env.example" /etc/forgeflow/forgeflow.env; fi
if [[ ! -f /etc/forgeflow/openhands.env ]]; then install -o root -g root -m 0600 "$repo_root/deploy/openhands.env.example" /etc/forgeflow/openhands.env; fi
chmod 0600 /etc/forgeflow/forgeflow.env /etc/forgeflow/openhands.env
# Fail closed until the operator explicitly chooses project and runtime credentials.
grep -Eq '^FORGEFLOW_AUTOMATION_PROJECTS=.+$' /etc/forgeflow/forgeflow.env || { echo 'configure FORGEFLOW_AUTOMATION_PROJECTS first' >&2; exit 2; }
grep -Eq '^FORGEFLOW_OPENHANDS_TOKEN=.+$' /etc/forgeflow/forgeflow.env || { echo 'configure FORGEFLOW_OPENHANDS_TOKEN first' >&2; exit 2; }
grep -Eq '^FORGEFLOW_LITELLM_BASE_URL=https?://.+$' /etc/forgeflow/forgeflow.env || { echo 'configure FORGEFLOW_LITELLM_BASE_URL first' >&2; exit 2; }
grep -Eq '^FORGEFLOW_LITELLM_API_KEY=.+$' /etc/forgeflow/forgeflow.env || { echo 'configure FORGEFLOW_LITELLM_API_KEY first' >&2; exit 2; }
install -o root -g root -m 0644 "$repo_root/deploy/gcp/forgeflow.service" /etc/systemd/system/forgeflow.service
install -o root -g root -m 0644 "$repo_root/deploy/gcp/forgeflow-host-cache.service" /etc/systemd/system/forgeflow-host-cache.service
install -o root -g root -m 0644 "$repo_root/deploy/gcp/forgeflow-host-cache.timer" /etc/systemd/system/forgeflow-host-cache.timer
install -o root -g root -m 0644 "$repo_root/deploy/gcp/forgeflow-antigravity@.service" /etc/systemd/system/forgeflow-antigravity@.service
install -o root -g root -m 0755 "$repo_root/scripts/prune-host-cache.sh" /usr/local/libexec/forgeflow-prune-host-cache.sh
install -o root -g root -m 0755 "$repo_root/scripts/run-antigravity-unit.mjs" /usr/local/libexec/forgeflow-antigravity-unit.mjs
systemctl daemon-reload
docker compose -f "$repo_root/deploy/openhands/docker-compose.yml" up -d --remove-orphans --wait --wait-timeout 120
systemctl enable --now forgeflow.service forgeflow-host-cache.timer
for _ in $(seq 1 45); do curl -fsS http://127.0.0.1:8420/api/health >/dev/null && exit 0; sleep 1; done
echo 'ForgeFlow did not become healthy' >&2
exit 1
