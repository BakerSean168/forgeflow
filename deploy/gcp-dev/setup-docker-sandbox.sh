#!/usr/bin/env bash
set -euo pipefail

network="${OPEN_SWE_DOCKER_NETWORK:-openswe-sandbox}"
subnet="${OPEN_SWE_DOCKER_SUBNET:-172.31.250.0/24}"
bridge="${OPEN_SWE_DOCKER_BRIDGE:-br-openswe-sbx}"
image="${OPEN_SWE_DOCKER_IMAGE:-forgeflow/openswe-sandbox:bookworm-node24}"
root="${FORGEFLOW_POLICY_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

if ! docker network inspect "$network" >/dev/null 2>&1; then
  docker network create \
    --driver bridge \
    --subnet "$subnet" \
    --opt "com.docker.network.bridge.name=$bridge" \
    --label dev.open-swe.sandbox-network=true \
    "$network" >/dev/null
fi

# Scope egress hardening to only the Open SWE sandbox subnet. Existing project
# Docker networks are untouched. Docker's embedded DNS at 127.0.0.11 stays usable.
block_destinations=(
  169.254.169.254/32
  10.0.0.0/8
  172.16.0.0/12
  192.168.0.0/16
  100.64.0.0/10
)
for destination in "${block_destinations[@]}"; do
  if ! sudo -n iptables -C DOCKER-USER -s "$subnet" -d "$destination" -j REJECT 2>/dev/null; then
    sudo -n iptables -I DOCKER-USER 1 -s "$subnet" -d "$destination" -j REJECT
  fi
done

docker build -f "$root/deploy/gcp-dev/Dockerfile.openswe-sandbox" -t "$image" "$root"
echo "docker_sandbox_network=$network"
echo "docker_sandbox_subnet=$subnet"
echo "docker_sandbox_image=$image"
