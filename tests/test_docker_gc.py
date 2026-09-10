from __future__ import annotations

from contextlib import contextmanager

import pytest

from openswe_ext import docker_gc
from openswe_ext.docker_gc import collect_docker_sandboxes
from openswe_ext.docker_sandbox import create_docker_sandbox_sync, sandbox_operation_lock


def test_shared_tool_lock_blocks_nonblocking_gc_lock(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("XDG_RUNTIME_DIR", str(tmp_path))
    with sandbox_operation_lock("openswe-sbx-test", exclusive=False) as foreground:
        assert foreground is True
        with sandbox_operation_lock(
            "openswe-sbx-test", exclusive=True, blocking=False
        ) as collector:
            assert collector is False


def test_missing_gc_deleted_sandbox_is_reported_as_gone(tmp_path, monkeypatch) -> None:
    from agent.sandboxes.providers.registry import SandboxGoneError

    from openswe_ext import docker_sandbox

    monkeypatch.setenv("XDG_RUNTIME_DIR", str(tmp_path))
    monkeypatch.setattr(docker_sandbox, "_container_exists", lambda _sid: False)
    with pytest.raises(SandboxGoneError):
        create_docker_sandbox_sync("openswe-sbx-gone")


def test_gc_deletes_only_unlocked_inactive_expired_sandboxes(monkeypatch) -> None:
    monkeypatch.setattr(
        docker_gc,
        "_owned_container_ids",
        lambda: ["old", "recent", "active", "locked"],
    )

    @contextmanager
    def fake_lock(container_id: str, *, exclusive: bool, blocking: bool = True):
        assert exclusive is True
        assert blocking is False
        yield container_id != "locked"

    monkeypatch.setattr(docker_gc, "sandbox_operation_lock", fake_lock)
    monkeypatch.setattr(docker_gc, "_assert_owned_container", lambda _sid: None)
    monkeypatch.setattr(docker_gc, "_container_state", lambda _sid: (True, 0.0))
    monkeypatch.setattr(
        docker_gc,
        "_last_used",
        lambda sid, **_kwargs: 950.0 if sid == "recent" else 0.0,
    )
    monkeypatch.setattr(
        docker_gc,
        "_has_active_exec",
        lambda sid, **_kwargs: sid == "active",
    )
    deleted: list[str] = []
    monkeypatch.setattr(docker_gc, "_delete_docker_sandbox_unlocked", deleted.append)

    result = collect_docker_sandboxes(idle_seconds=100, now=1000.0)
    assert deleted == ["old"]
    assert result.scanned == 4
    assert result.deleted == 1
    assert result.skipped_recent == 1
    assert result.skipped_active == 1
    assert result.skipped_locked == 1
    assert result.errors == 0


def test_gc_dry_run_reports_candidate_without_deleting(monkeypatch) -> None:
    monkeypatch.setattr(docker_gc, "_owned_container_ids", lambda: ["old"])

    @contextmanager
    def fake_lock(*_args, **_kwargs):
        yield True

    monkeypatch.setattr(docker_gc, "sandbox_operation_lock", fake_lock)
    monkeypatch.setattr(docker_gc, "_assert_owned_container", lambda _sid: None)
    monkeypatch.setattr(docker_gc, "_container_state", lambda _sid: (False, 0.0))
    monkeypatch.setattr(docker_gc, "_has_active_exec", lambda *_args, **_kwargs: False)
    monkeypatch.setattr(docker_gc, "_last_used", lambda *_args, **_kwargs: 0.0)
    deleted: list[str] = []
    monkeypatch.setattr(docker_gc, "_delete_docker_sandbox_unlocked", deleted.append)

    result = collect_docker_sandboxes(idle_seconds=100, now=1000.0, dry_run=True)
    assert result.deleted == 1
    assert deleted == []
