# Self-hosted Open SWE sandbox

ForgeFlow Policy V1 keeps both the control plane and the default execution
plane on GCP Dev. Model-controlled commands never run through Open SWE's
`SANDBOX_TYPE=local` backend because that shares the service Unix principal and
host filesystem. The default is the thin Open SWE runtime extension
`SANDBOX_TYPE=docker`.

## Ownership

ForgeFlow policy does not create containers, mount workspaces, run Docker
commands, or store sandbox lifecycle state. `openswe_ext.docker_sandbox` is an
Open SWE `SandboxBackendProtocol` provider and LangGraph/Open SWE own the
sandbox id carried by each thread.

The provider creates one persistent Docker container and named workspace volume
per Open SWE sandbox id. Reconnects reuse them; they are not recreated for each
tool call.

## Default isolation

The GCP Dev image and network are installed by:

```bash
deploy/gcp-dev/setup-docker-sandbox.sh
```

The default container is bounded to 2 vCPU, 8 GiB RAM, and 1024 PIDs. It runs as
UID/GID 1000 with a read-only root filesystem, Docker's default seccomp and
AppArmor profiles, all Linux capabilities dropped, and `no-new-privileges`.
The Docker socket, host home, Codex credentials, SSH keys, and GitHub App
private key are never mounted.

`/tmp` and `/home/sandbox` are tmpfs. High-volume language/package caches live
under the thread-scoped workspace volume at `/workspace/.open-swe-cache`, so
pnpm/npm/uv/Go/Cargo caches survive reconnects without filling the small HOME
tmpfs.

## Network boundary

`forgeflow-openswe-sandbox-network.service` owns the dedicated
`openswe-sandbox` bridge and `DOCKER-USER` rules. It is a root oneshot unit with
`PartOf=docker.service`, so Docker daemon restarts re-apply the egress boundary.
The sandbox can reach public package/GitHub endpoints but is rejected from:

- link-local `169.254.0.0/16` including GCP metadata;
- RFC1918 private networks;
- Tailscale CGNAT `100.64.0.0/10`.

The rules apply only to the dedicated sandbox subnet and do not alter project
Docker networks.

## GitHub credentials

The GitHub App private key stays on the host control plane. Each sandbox gets
only short-lived installation tokens stored in container tmpfs:

- a read token for the primary repository plus repositories explicitly listed
  in `sandbox_read_repositories` in Open SWE's existing `projects.json`;
- a separate `contents:write` token only for ForgeFlow implementation/repair
  runs and only for the primary repository.

A token-free Git credential helper on the sandbox workspace chooses the write
token only for the primary Git URL; private dependency repositories always use
the read token. Reviewer runs never receive the write token. `gh` receives the
read token, while review publication stays on the host through the GitHub App.

Example project entry:

```json
{
  "repo": "BakerSean168/digital-biome",
  "cwd": "/home/dev/projects/digital-biome",
  "ci_required": true,
  "required_checks": ["Type Check"],
  "sandbox_read_repositories": ["BakerSean168/thought-forest"]
}
```

## Remote provider escape hatch

Pinned Open SWE still supports LangSmith, Daytona, Runloop, E2B, and Modal.
They can be selected explicitly through `SANDBOX_TYPE` and their upstream
credentials, but ForgeFlow no longer maintains a separate LangSmith onboarding
UI or `sandbox.env` compatibility layer. The GCP Dev default and tested path is
local Docker isolation.
