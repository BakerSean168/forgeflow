#!/usr/bin/env bash
set -euo pipefail

network="${OPEN_SWE_DOCKER_NETWORK:-openswe-sandbox}"
subnet="${OPEN_SWE_DOCKER_SUBNET:-172.31.250.0/24}"
bridge="${OPEN_SWE_DOCKER_BRIDGE:-br-openswe-sbx}"

command -v docker >/dev/null || { echo "docker is required" >&2; exit 2; }
command -v iptables >/dev/null || { echo "iptables is required" >&2; exit 2; }
docker info >/dev/null 2>&1 || { echo "docker daemon is unavailable" >&2; exit 2; }

if ! docker network inspect "$network" >/dev/null 2>&1; then
  docker network create \
    --driver bridge \
    --subnet "$subnet" \
    --opt "com.docker.network.bridge.name=$bridge" \
    --label dev.open-swe.sandbox-network=true \
    "$network" >/dev/null
fi

actual_subnet="$(docker network inspect -f '{{(index .IPAM.Config 0).Subnet}}' "$network")"
[[ "$actual_subnet" == "$subnet" ]] || {
  echo "sandbox network subnet mismatch: expected $subnet, got $actual_subnet" >&2
  exit 2
}

iptables_cmd=(iptables)
if (( EUID != 0 )); then
  command -v sudo >/dev/null || { echo "sudo is required for sandbox firewall rules" >&2; exit 2; }
  iptables_cmd=(sudo -n iptables)
fi

# Remove rules emitted by earlier ForgeFlow Docker-sandbox revisions before
# converging on the current declarative destination set. Keep this scoped to
# the dedicated source subnet so unrelated Docker policy is untouched.
obsolete_destinations=(169.254.169.254/32)
for destination in "${obsolete_destinations[@]}"; do
  while "${iptables_cmd[@]}" -C DOCKER-USER -s "$subnet" -d "$destination" -j REJECT 2>/dev/null; do
    "${iptables_cmd[@]}" -D DOCKER-USER -s "$subnet" -d "$destination" -j REJECT
  done
done

block_destinations=(
  169.254.0.0/16
  10.0.0.0/8
  172.16.0.0/12
  192.168.0.0/16
  100.64.0.0/10
)
for destination in "${block_destinations[@]}"; do
  if ! "${iptables_cmd[@]}" -C DOCKER-USER -s "$subnet" -d "$destination" -j REJECT 2>/dev/null; then
    "${iptables_cmd[@]}" -I DOCKER-USER 1 -s "$subnet" -d "$destination" -j REJECT
  fi
done

echo "docker_sandbox_network=$network"
echo "docker_sandbox_subnet=$subnet"
