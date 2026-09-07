# Configuration

ForgeFlow separates checked-in defaults from host-specific credentials and project authorization. The repository should remain safe to clone publicly: secrets and enabled production projects belong in operator-managed configuration, not in Git.

## Configuration locations

The hardened Linux deployment uses these defaults:

- ForgeFlow environment/configuration: `/etc/forgeflow`
- durable state: `/var/lib/forgeflow`
- control plane: `127.0.0.1:8420`
- OpenHands Agent Server: `127.0.0.1:18420`
- managed worktrees: below the ForgeFlow state root

Start from [`deploy/forgeflow.env.example`](../deploy/forgeflow.env.example) and [`deploy/openhands.env.example`](../deploy/openhands.env.example). Do not commit populated copies.

## Project authorization

Literal-worktree execution is available only to explicitly authorized project keys and canonical repository paths. ForgeFlow verifies repository identity and the required Git mount before Plan activation and revalidates linkage during execution/finalization.

Do not broaden a repository allowlist merely to bypass an activation failure. Treat repository identity, mount, ACL, or Git-linkage failures as safety failures that need to be diagnosed.

## Execution resources

A resource binding combines:

- provider/resource identity;
- model family;
- capability (`IMPLEMENTATION` or `REASONING`);
- agent backend/transport;
- tier/order/health;
- runtime admission state.

Selection is controller-owned and becomes immutable for an Execution. Provider/model fallback should happen through the resource directory and retry lineage rather than an agent silently switching models inside a mutable session.

## OpenHands execution plane

ForgeFlow builds a version-pinned OpenHands Software Agent SDK source image. The current deployment pin is defined in [`scripts/build-openhands-source.sh`](../scripts/build-openhands-source.sh), including both the tag and expected commit.

The Agent Server is an execution plane, not the durable state authority. ForgeFlow remains responsible for Plan/Execution state, writer ownership, exact-revision review, cleanup barriers, integration, and release acceptance.

## Provider-native workers

Provider-native Antigravity workers run outside the OpenHands container under a hardened systemd unit and mount sandbox. Their success/status is still not authoritative acceptance: ForgeFlow verifies workspace progress, Git provenance, completion evidence, review lineage, and cleanup before advancing the lifecycle.

## Secrets

Credentials must be supplied through operator-controlled files/environment with restrictive permissions. Do not log or persist:

- API keys or bearer tokens;
- auth/session files;
- SSH private keys;
- raw authorization headers;
- provider response bodies that may contain sensitive content.

## Self-improvement controls

Discovery, AI diagnosis, adoption, low-risk auto-adoption, self-change, self-promotion, and autonomous self-promotion are distinct controls. They default off unless explicitly configured otherwise. Enabling one must not implicitly enable the others.
