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


def test_codebuddy_docker_contract_is_read_only_bounded_and_uses_native_acp(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    binary = _binary(tmp_path)

    args = build_codebuddy_docker_args(
        workspace=workspace,
        executable=binary,
        model="deepseek-v4-flash",
        credential_name="CODEBUDDY_AUTH_TOKEN",
        image="sandbox:test",
        uid=1234,
        gid=1234,
    )
    joined = " ".join(args)
    assert args[:3] == ("run", "--rm", "-i")
    assert "--read-only" in args
    assert "--cap-drop ALL" in joined
    assert "no-new-privileges:true" in args
    assert "--user 1234:1234" in joined
    assert f"dst={CONTAINER_WORKSPACE}" in joined
    assert f"dst={CONTAINER_EXECUTABLE},readonly" in joined
    assert f"{CONTAINER_HOME}:rw,nosuid,nodev" in joined
    assert "CODEBUDDY_IS_SANDBOX=1" in args
    assert "CODEBUDDY_DISABLE_AUTO_MEMORY=1" in args
    assert "CODEBUDDY_AUTH_TOKEN" in args
    assert "--acp" in args
    assert "--model" in args
    assert "deepseek-v4-flash" in args
    assert "--permission-mode" in args
    assert "bypassPermissions" in args
    assert "--setting-sources" in args
    assert "user" in args
    assert "--no-session-persistence" in args
    assert "/var/run/docker.sock" not in joined


def test_codebuddy_execution_requires_explicit_enable_project_and_credential(tmp_path: Path) -> None:
    root = tmp_path / "root"
    workspace = root / "work"
    workspace.mkdir(parents=True)
    binary = _binary(tmp_path)

    with pytest.raises(ExternalAgentRouteRejected, match="CREDENTIAL_REQUIRED"):
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

    route = CodeBuddyExternalAgentExecution(
        env={
            "HOME": str(tmp_path),
            "PATH": "/usr/bin:/bin",
            "FORGEFLOW_CODEBUDDY_BIN": str(binary),
            "FORGEFLOW_CODEBUDDY_ACP_ENABLED": "false",
            "FORGEFLOW_EXTERNAL_AGENT_WORKSPACE_ROOT": str(root),
            "FORGEFLOW_EXTERNAL_AGENT_OUTER_SANDBOX": "docker",
            "CODEBUDDY_AUTH_TOKEN": "test-token",
        },
        allowed_projects=frozenset({"o/r"}),
    )
    with pytest.raises(ExternalAgentRouteRejected, match="ROUTE_DISABLED"):
        route._gate.validate(_request(workspace))


def test_codebuddy_execution_accepts_scoped_api_key_file_without_global_secret_env(tmp_path: Path) -> None:
    root = tmp_path / "root"
    workspace = root / "work"
    workspace.mkdir(parents=True)
    binary = _binary(tmp_path)
    key_file = tmp_path / "codebuddy-api.key"
    key_file.write_text("secret-key\n", encoding="utf-8")

    route = CodeBuddyExternalAgentExecution(
        env={
            "HOME": str(tmp_path),
            "PATH": "/usr/bin:/bin",
            "FORGEFLOW_CODEBUDDY_BIN": str(binary),
            "FORGEFLOW_CODEBUDDY_ACP_ENABLED": "true",
            "FORGEFLOW_CODEBUDDY_API_KEY_FILE": str(key_file),
            "FORGEFLOW_EXTERNAL_AGENT_WORKSPACE_ROOT": str(root),
            "FORGEFLOW_EXTERNAL_AGENT_OUTER_SANDBOX": "docker",
        },
        allowed_projects=frozenset({"o/r"}),
    )
    assert route._gate.validate(_request(workspace)) == workspace
    assert route._credential_name == "CODEBUDDY_API_KEY"
    assert route._agent_env["CODEBUDDY_API_KEY"] == "secret-key"
    assert "CODEBUDDY_AUTH_TOKEN" not in route._agent_env


def test_codebuddy_requires_outer_docker(tmp_path: Path) -> None:
    binary = _binary(tmp_path)
    with pytest.raises(ExternalAgentRouteRejected, match="OUTER_SANDBOX_REQUIRED"):
        CodeBuddyExternalAgentExecution(
            env={
                "HOME": str(tmp_path),
                "FORGEFLOW_CODEBUDDY_BIN": str(binary),
                "FORGEFLOW_EXTERNAL_AGENT_OUTER_SANDBOX": "host",
                "CODEBUDDY_AUTH_TOKEN": "test-token",
            }
        )
