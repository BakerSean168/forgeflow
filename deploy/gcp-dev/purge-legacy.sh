#!/usr/bin/env bash
set -euo pipefail

[[ "${FORGEFLOW_POLICY_CONFIRM_PURGE:-}" == "YES" ]] || {
  echo 'Refusing destructive purge: set FORGEFLOW_POLICY_CONFIRM_PURGE=YES' >&2
  exit 2
}

# The replacement must already be healthy before the old topology is removed.
systemctl --user is-active --quiet forgeflow-policy.service || {
  echo 'forgeflow-policy.service is not active; refusing legacy purge' >&2
  exit 2
}

sudo -n systemctl disable --now forgeflow.service forgeflow-host-cache.timer forgeflow-self-promote.path || true
sudo -n systemctl stop forgeflow-host-cache.service forgeflow-self-promote.service || true
while read -r unit _; do
  [[ -n "$unit" ]] || continue
  sudo -n systemctl stop "$unit" || true
done < <(systemctl list-units 'forgeflow-antigravity@*.service' --all --no-legend 2>/dev/null || true)

if docker ps -a --format '{{.Names}}' | grep -Fxq 'forgeflow-openhands'; then
  docker rm -f forgeflow-openhands >/dev/null
fi
if docker image inspect forgeflow-openhands-agent-server:1.39.1-source >/dev/null 2>&1; then
  docker image rm forgeflow-openhands-agent-server:1.39.1-source >/dev/null || true
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
sudo -n rm -f /usr/local/libexec/forgeflow-*
sudo -n rm -f /etc/forgeflow/forgeflow.env /etc/forgeflow/openhands.env
sudo -n systemctl daemon-reload

# Do not delete /etc/forgeflow/litellm.env: it may be shared by LiteLLM outside ForgeFlow.
echo 'Legacy ForgeFlow Node/OpenHands/Antigravity state purged.'
