from pathlib import Path

import pytest

from forgeflow.external_agents.execution import (
    ExternalAgentExecutionRequest,
    ExternalAgentRouteRejected,
)
from openswe_ext.codebuddy_execution import (
    CodeBuddyExternalAgentExecution,
    build_codebuddy_docker_args,
)
from openswe_ext.external_agent_docker import (
    BOOTSTRAP_MOUNT,
    CONTAINER_EXECUTABLE,
    CONTAINER_HOME,
    CONTAINER_WORKSPACE,
)


def _request(workspace: Path) -> ExternalAgentExecutionRequest:
    return ExternalAgentExecutionRequest(
        owner="o",
        repo="r",
        workspace=workspace,
        objective="make one bounded change",
        operation_key="codebuddy:1",
        phase="IMPLEMENT",
        test_command=("git", "diff", "--check"),
    )


def _binary(tmp_path: Path) -> Path:
    binary = tmp_path / "codebuddy"
    binary.write_bytes(b"binary")
    binary.chmod(0o700)
    return binary


def _auth_dir(tmp_path: Path) -> Path:
    auth = tmp_path / "auth"
    auth.mkdir()
    (auth / "Tencent-Cloud.coding-copilot.info").write_text("{}\n", encoding="utf-8")
    return auth


def test_codebuddy_docker_contract_seals_official_auth_and_uses_native_acp(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    binary = _binary(tmp_path)
    auth = _auth_dir(tmp_path)

    args = build_codebuddy_docker_args(
        workspace=workspace,
        executable=binary,
        auth_state_dir=auth,
        container_name="forgeflow-codebuddy-test",
        model="deepseek-v4.1-flash",
        image="sandbox:test",
        uid=1234,
        gid=1234,
    )
    joined = " ".join(args)
    assert args[:5] == ("run", "--rm", "-i", "--name", "forgeflow-codebuddy-test")
    assert "--read-only" in args
    assert "--cap-drop ALL" in joined
    assert "no-new-privileges:true" in args
    assert "--user 1234:1234" in joined
    assert f"dst={CONTAINER_WORKSPACE}" in joined
    assert f"dst={CONTAINER_EXECUTABLE},readonly" in joined
    assert f"dst={BOOTSTRAP_MOUNT},readonly" in joined
    assert f"{CONTAINER_HOME}:rw,nosuid,nodev" in joined
    assert "/tmp:rw,exec,nosuid,nodev" in joined
    assert "Tencent-Cloud.coding-copilot.info" in joined
    assert "CODEBUDDY_IS_SANDBOX=1" in args
    assert "CODEBUDDY_DISABLE_AUTO_MEMORY=1" in args
    assert "CODEBUDDY_AUTH_TOKEN" not in args
    assert "CODEBUDDY_API_KEY" not in args
    assert "--acp" in args
    assert "--model" in args
    assert "deepseek-v4.1-flash" in args
    assert "--permission-mode" in args
    assert "bypassPermissions" in args
    assert "--setting-sources" in args
    assert "user" in args
    assert "--no-session-persistence" in args
    assert "/var/run/docker.sock" not in joined


def test_codebuddy_execution_requires_official_auth_but_not_secret_env(tmp_path: Path) -> None:
    root = tmp_path / "root"
    workspace = root / "work"
    workspace.mkdir(parents=True)
    binary = _binary(tmp_path)

    with pytest.raises(ExternalAgentRouteRejected, match="OFFICIAL_AUTH_REQUIRED"):
        CodeBuddyExternalAgentExecution(
            env={
                "HOME": str(tmp_path),
                "PATH": "/usr/bin:/bin",
                "FORGEFLOW_CODEBUDDY_BIN": str(binary),
                "FORGEFLOW_EXTERNAL_AGENT_WORKSPACE_ROOT": str(root),
                "FORGEFLOW_EXTERNAL_AGENT_OUTER_SANDBOX": "docker",
            },
            allowed_projects=frozenset({"o/r"}),
        )

    auth = _auth_dir(tmp_path)
    route = CodeBuddyExternalAgentExecution(
        env={
            "HOME": str(tmp_path),
            "PATH": "/usr/bin:/bin",
            "FORGEFLOW_CODEBUDDY_BIN": str(binary),
            "FORGEFLOW_CODEBUDDY_AUTH_STATE_DIR": str(auth),
            "FORGEFLOW_CODEBUDDY_ACP_ENABLED": "false",
            "FORGEFLOW_EXTERNAL_AGENT_WORKSPACE_ROOT": str(root),
            "FORGEFLOW_EXTERNAL_AGENT_OUTER_SANDBOX": "docker",
        },
        allowed_projects=frozenset({"o/r"}),
    )
    assert route._model == "deepseek-v4.1-flash"
    assert "CODEBUDDY_AUTH_TOKEN" not in route._agent_env
    assert "CODEBUDDY_API_KEY" not in route._agent_env
    with pytest.raises(ExternalAgentRouteRejected, match="ROUTE_DISABLED"):
        route._gate.validate(_request(workspace))


def test_codebuddy_requires_outer_docker(tmp_path: Path) -> None:
    binary = _binary(tmp_path)
    auth = _auth_dir(tmp_path)
    with pytest.raises(ExternalAgentRouteRejected, match="OUTER_SANDBOX_REQUIRED"):
        CodeBuddyExternalAgentExecution(
            env={
                "HOME": str(tmp_path),
                "FORGEFLOW_CODEBUDDY_BIN": str(binary),
                "FORGEFLOW_CODEBUDDY_AUTH_STATE_DIR": str(auth),
                "FORGEFLOW_EXTERNAL_AGENT_OUTER_SANDBOX": "host",
            }
        )
