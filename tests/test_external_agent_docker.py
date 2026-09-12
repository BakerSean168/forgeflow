from pathlib import Path

from openswe_ext.external_agent_docker import (
    BOOTSTRAP_MOUNT,
    CONTAINER_EXECUTABLE,
    CONTAINER_HOME,
    CONTAINER_WORKSPACE,
    build_bootstrap_unmount_args,
    build_container_create_args,
)


def test_docker_external_agent_contract_is_fail_closed(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    bootstrap = tmp_path / "bootstrap"
    executable = tmp_path / "agent"
    workspace.mkdir()
    bootstrap.mkdir()
    executable.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    executable.chmod(0o700)

    args = build_container_create_args(
        name="forgeflow-test-agent",
        workspace=workspace,
        executable=executable,
        bootstrap_dir=bootstrap,
        uid=1234,
        gid=1234,
    )
    joined = " ".join(args)
    assert "--read-only" in args
    assert "--cap-drop ALL" in joined
    assert "no-new-privileges:true" in args
    assert "--user 1234:1234" in joined
    assert f"dst={CONTAINER_WORKSPACE}" in joined
    assert f"dst={CONTAINER_EXECUTABLE},readonly" in joined
    assert f"dst={BOOTSTRAP_MOUNT},readonly" in joined
    assert f"{CONTAINER_HOME}:rw,nosuid,nodev" in joined
    assert "/var/run/docker.sock" not in joined
    assert str(Path.home()) not in joined


def test_bootstrap_mount_is_distinct_from_agent_home_and_workspace() -> None:
    assert BOOTSTRAP_MOUNT != CONTAINER_HOME
    assert BOOTSTRAP_MOUNT != CONTAINER_WORKSPACE
    assert CONTAINER_HOME != CONTAINER_WORKSPACE


def test_broad_antigravity_approval_is_scoped_to_outer_docker_only() -> None:
    source = Path("openswe_ext/antigravity_acp.py").read_text(encoding="utf-8")
    docker_branch = source.index('if self._outer_sandbox == "docker":')
    dangerous = source.index('args.append("--dangerously-skip-permissions")')
    host_spawn = source.index("process = await asyncio.create_subprocess_exec", dangerous)
    assert docker_branch < dangerous < host_spawn
    assert source.count("--dangerously-skip-permissions") == 1


def test_bootstrap_unmount_uses_ephemeral_privileged_helper_not_host_sudo() -> None:
    args = build_bootstrap_unmount_args(pid=4242, image="sandbox:test")
    joined = " ".join(args)
    assert args[:3] == ["docker", "run", "--rm"]
    assert "--privileged" in args
    assert "--user 0" in joined
    assert "--pid host" in joined
    assert "--network none" in joined
    assert "--read-only" in args
    assert "/usr/bin/nsenter" in args
    assert "-t 4242 -m" in joined
    assert "--root=/proc/4242/root" in args
    assert "/usr/bin/umount" in args
    assert BOOTSTRAP_MOUNT in args
    source = Path("openswe_ext/external_agent_docker.py").read_text(encoding="utf-8")
    assert "sudo" not in source
