"""Conservative garbage collection for self-hosted Open SWE Docker sandboxes."""

from __future__ import annotations

import argparse
import json
import os
import time
from dataclasses import asdict, dataclass
from datetime import datetime

from openswe_ext.docker_sandbox import (
    _LABEL,
    _LAST_USED_PATH,
    DockerSandboxError,
    _assert_owned_container,
    _delete_docker_sandbox_unlocked,
    _docker,
    sandbox_operation_lock,
)

_DEFAULT_IDLE_SECONDS = 24 * 60 * 60


@dataclass(slots=True)
class GarbageCollectionResult:
    scanned: int = 0
    deleted: int = 0
    skipped_recent: int = 0
    skipped_active: int = 0
    skipped_locked: int = 0
    errors: int = 0


def _owned_container_ids() -> list[str]:
    result = _docker(
        "container",
        "ls",
        "-a",
        "--filter",
        f"label={_LABEL}=true",
        "--format",
        "{{.Names}}",
        check=False,
    )
    if result.returncode != 0:
        raise DockerSandboxError("cannot list provider-owned Docker sandboxes")
    return [line.strip() for line in result.stdout.decode().splitlines() if line.strip()]


def _parse_timestamp(raw: str) -> float:
    return datetime.fromisoformat(raw.strip()).timestamp()


def _container_state(container_id: str) -> tuple[bool, float]:
    result = _docker(
        "container",
        "inspect",
        "--format",
        "{{.State.Running}}|{{.Created}}|{{.State.FinishedAt}}",
        container_id,
        check=False,
    )
    if result.returncode != 0:
        raise DockerSandboxError(f"cannot inspect sandbox {container_id}")
    running_raw, created_raw, finished_raw = result.stdout.decode().strip().split("|", 2)
    running = running_raw == "true"
    created = _parse_timestamp(created_raw)
    finished = _parse_timestamp(finished_raw)
    # Docker's zero time means the container has never stopped.
    last_state_change = max(created, finished)
    return running, last_state_change


def _last_used(container_id: str, *, running: bool, fallback: float) -> float:
    if not running:
        return fallback
    result = _docker(
        "exec",
        container_id,
        "stat",
        "-c",
        "%Y",
        _LAST_USED_PATH,
        check=False,
    )
    if result.returncode != 0:
        return fallback
    try:
        return float(result.stdout.decode().strip())
    except ValueError:
        return fallback


def _has_active_exec(container_id: str, *, running: bool) -> bool:
    if not running:
        return False
    result = _docker("top", container_id, check=False)
    if result.returncode != 0:
        # Fail closed: an uninspectable running container is never garbage-collected.
        return True
    lines = [line for line in result.stdout.decode(errors="replace").splitlines() if line.strip()]
    # The provider image has exactly two steady-state processes: docker-init and
    # `sleep infinity`. Any extra process is an agent/background command.
    return len(lines) > 3


def collect_docker_sandboxes(
    *,
    idle_seconds: int,
    now: float | None = None,
    dry_run: bool = False,
    container_ids: list[str] | None = None,
) -> GarbageCollectionResult:
    if idle_seconds <= 0:
        raise ValueError("idle_seconds must be positive")
    current = time.time() if now is None else now
    result = GarbageCollectionResult()

    candidates = _owned_container_ids() if container_ids is None else container_ids
    for container_id in candidates:
        result.scanned += 1
        try:
            _assert_owned_container(container_id)
            with sandbox_operation_lock(
                container_id, exclusive=True, blocking=False
            ) as acquired:
                if not acquired:
                    result.skipped_locked += 1
                    continue
                running, fallback = _container_state(container_id)
                if _has_active_exec(container_id, running=running):
                    result.skipped_active += 1
                    continue
                last_used = _last_used(container_id, running=running, fallback=fallback)
                if current - last_used < idle_seconds:
                    result.skipped_recent += 1
                    continue

                # Recheck after all observations while the provider-wide exclusive
                # lock still prevents new foreground tool calls from starting.
                if _has_active_exec(container_id, running=running):
                    result.skipped_active += 1
                    continue
                if _last_used(container_id, running=running, fallback=fallback) != last_used:
                    result.skipped_recent += 1
                    continue
                if not dry_run:
                    _delete_docker_sandbox_unlocked(container_id)
                result.deleted += 1
        except DockerSandboxError:
            result.errors += 1
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--idle-seconds",
        type=int,
        default=int(os.environ.get("OPEN_SWE_DOCKER_IDLE_TTL_SECONDS", _DEFAULT_IDLE_SECONDS)),
    )
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--sandbox-id", action="append", dest="sandbox_ids")
    args = parser.parse_args()
    result = collect_docker_sandboxes(
        idle_seconds=args.idle_seconds,
        dry_run=args.dry_run,
        container_ids=args.sandbox_ids,
    )
    print(json.dumps(asdict(result), sort_keys=True))
    return 1 if result.errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
