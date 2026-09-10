#!/usr/bin/env bash
set -euo pipefail

image="${OPEN_SWE_DOCKER_IMAGE:-forgeflow/openswe-sandbox:bookworm-node24}"
root="${FORGEFLOW_POLICY_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
libexec="/usr/local/libexec/forgeflow-openswe-sandbox-network"
unit="/etc/systemd/system/forgeflow-openswe-sandbox-network.service"

for tool in docker sudo systemctl; do
  command -v "$tool" >/dev/null || { echo "missing tool: $tool" >&2; exit 2; }
done

docker build -f "$root/deploy/gcp-dev/Dockerfile.openswe-sandbox" -t "$image" "$root"

sudo -n install -D -m 0755 "$root/deploy/gcp-dev/ensure-docker-sandbox-network.sh" "$libexec"
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
sed "s|@LIBEXEC@|$libexec|g" \
  "$root/deploy/gcp-dev/forgeflow-openswe-sandbox-network.service.in" >"$tmp"
sudo -n install -m 0644 "$tmp" "$unit"
sudo -n systemctl daemon-reload
sudo -n systemctl enable --now forgeflow-openswe-sandbox-network.service

echo "docker_sandbox_image=$image"
echo "docker_sandbox_firewall_unit=forgeflow-openswe-sandbox-network.service"
