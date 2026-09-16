from pathlib import Path

import pytest

from forgeflow.external_agents.execution import (
    ExternalAgentExecutionRequest,
    ExternalAgentRouteRejected,
)
from openswe_ext.codebuddy_execution import (
    CodeBuddyExternalAgentExecution,
    _acquire_codebuddy_capacity,
    _codebuddy_stop_failure_code,
    _seal_codebuddy_bootstrap_sync,
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
        memory_limit="4g",
        image="sandbox:test",
        uid=1234,
        gid=1234,
    )
    joined = " ".join(args)
    assert args[:5] == ("run", "--rm", "-i", "--name", "forgeflow-codebuddy-test")
    assert "--read-only" in args
    assert "--memory 4g" in joined
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
            "FORGEFLOW_CODEBUDDY_MEMORY_LIMIT": "4g",
        },
        allowed_projects=frozenset({"o/r"}),
    )
    assert route._model == "deepseek-v4.1-flash"
    assert route._memory_limit == "4g"
    assert "CODEBUDDY_AUTH_TOKEN" not in route._agent_env
    assert "CODEBUDDY_API_KEY" not in route._agent_env
    with pytest.raises(ExternalAgentRouteRejected, match="ROUTE_DISABLED"):
        route._gate.validate(_request(workspace))


def test_codebuddy_rejects_invalid_memory_limit(tmp_path: Path) -> None:
    binary = _binary(tmp_path)
    auth = _auth_dir(tmp_path)

    with pytest.raises(ExternalAgentRouteRejected, match="MEMORY_LIMIT_INVALID"):
        CodeBuddyExternalAgentExecution(
            env={
                "HOME": str(tmp_path),
                "FORGEFLOW_CODEBUDDY_BIN": str(binary),
                "FORGEFLOW_CODEBUDDY_AUTH_STATE_DIR": str(auth),
                "FORGEFLOW_EXTERNAL_AGENT_OUTER_SANDBOX": "docker",
                "FORGEFLOW_CODEBUDDY_MEMORY_LIMIT": "unlimited",
            }
        )


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


def test_codebuddy_blocking_path_checks_run_off_the_event_loop(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The async external graph must not resolve CodeBuddy paths on the event loop.

    Strict ``Path.resolve(strict=True)`` (``os.readlink``), ``os.access``, and
    official-auth discovery are all blocking. LangGraph's Blockbuster raises when
    they run inside the async node, so the adapter must build those paths in a
    worker thread instead.
    """

    import asyncio
    import json
    import threading

    import openswe_ext.codebuddy_execution as codebuddy
    import openswe_ext.external_agent_graph as graph
    from forgeflow.adapters.external_delivery import ExternalAgentPullRequestDelivery
    from forgeflow.external_agents.execution import ExternalAgentExecutionEvidence
    from forgeflow.projects import ExternalAgentProjectConfig
    from openswe_ext.external_agent_workspace import PreparedExternalWorkspace

    root = tmp_path / "workspaces"
    workspace = root / "run"
    source = tmp_path / "source"
    workspace.mkdir(parents=True)
    source.mkdir()
    # A symlinked binary makes resolve(strict=True) hit os.readlink, exactly the
    # call Blockbuster rejected before the adapter was built in a thread.
    real_binary = _binary(tmp_path)
    binary = tmp_path / "codebuddy-link"
    binary.symlink_to(real_binary)
    auth = _auth_dir(tmp_path)

    route_config = tmp_path / "routes.json"
    route_config.write_text(
        json.dumps(
            {
                "version": 1,
                "routes": [
                    {
                        "id": "buddy",
                        "role": "IMPLEMENT",
                        "priority": 30,
                        "runtime": "EXTERNAL_ACP",
                        "adapter": "codebuddy",
                        "target": "codebuddy-account",
                        "enabled": True,
                        "health": "READY",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    ledger = tmp_path / "attempts.jsonl"
    monkeypatch.setenv("FORGEFLOW_ROUTE_CONFIG_FILE", str(route_config))
    monkeypatch.setenv("FORGEFLOW_ATTEMPT_LEDGER_FILE", str(ledger))
    monkeypatch.setenv("FORGEFLOW_EXTERNAL_AGENT_WORKSPACE_ROOT", str(root))
    monkeypatch.setenv("FORGEFLOW_EXTERNAL_AGENT_OUTER_SANDBOX", "docker")
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("FORGEFLOW_CODEBUDDY_BIN", str(binary))
    monkeypatch.setenv("FORGEFLOW_CODEBUDDY_AUTH_STATE_DIR", str(auth))
    monkeypatch.setenv("FORGEFLOW_CODEBUDDY_ACP_ENABLED", "true")

    monkeypatch.setattr(
        graph,
        "load_external_agent_project_config",
        lambda owner, repo: ExternalAgentProjectConfig(source, ("true",)),
    )
    monkeypatch.setattr(
        graph,
        "prepare_external_workspace",
        lambda **kwargs: PreparedExternalWorkspace(workspace, "a" * 40),
    )
    monkeypatch.setattr(graph, "cleanup_external_workspace", lambda path: None)

    class FakeAcpAdapter:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

        async def execute(self, request):
            del request
            return ExternalAgentExecutionEvidence(
                runtime="codebuddy",
                model=None,
                source_revision="a" * 40,
                changed_files=("a.txt",),
                diff_sha256="d" * 64,
                test_command=("true",),
                test_exit_code=0,
                test_output_sha256="e" * 64,
                acp_session_id="session",
                external_conversation_id="conversation",
                agent_stop_reason="end_turn",
            )

    class FakeDelivery:
        async def deliver(self, **kwargs):
            del kwargs
            return ExternalAgentPullRequestDelivery(
                pr_url="https://github.com/o/r/pull/1",
                pr_number=1,
                branch="forgeflow/external-test",
                head_sha="b" * 40,
                base_ref="main",
            )

    monkeypatch.setattr(codebuddy, "AcpWorkspaceExecutionAdapter", FakeAcpAdapter)
    monkeypatch.setattr(graph, "GitHubExternalAgentDelivery", FakeDelivery)

    event_loop_thread = threading.get_ident()
    auth_threads: list[int] = []
    docker_threads: list[int] = []

    original_auth = codebuddy.resolve_codebuddy_auth_dir

    def recording_auth(values):
        auth_threads.append(threading.get_ident())
        return original_auth(values)

    original_docker_args = codebuddy.build_codebuddy_docker_args

    def recording_docker_args(**kwargs):
        docker_threads.append(threading.get_ident())
        return original_docker_args(**kwargs)

    monkeypatch.setattr(codebuddy, "resolve_codebuddy_auth_dir", recording_auth)
    monkeypatch.setattr(codebuddy, "build_codebuddy_docker_args", recording_docker_args)

    result = asyncio.run(
        graph.DefaultExternalAgentGraphServices().run(
            {
                "owner": "o",
                "repo": "r",
                "base_ref": "main",
                "objective": "implement x",
                "operation_key": "op:1",
                "route_id": "buddy",
                "phase": "IMPLEMENT",
            }
        )
    )

    assert result.external_status == "SUCCESS"
    assert result.failure_code is None
    # The constructor and the execute-time Docker setup were both exercised.
    assert auth_threads and all(thread != event_loop_thread for thread in auth_threads)
    assert docker_threads and all(thread != event_loop_thread for thread in docker_threads)


def test_codebuddy_refusal_classifies_rate_limit_without_persisting_response() -> None:
    from forgeflow.external_agents.acp import AcpExecutionResult

    result = AcpExecutionResult(
        stop_reason="refusal",
        text="",
        session_id="session",
        metadata={
            "codebuddy.ai/errorMessage": (
                '{"code":-32003,"message":"Quota exceeded: 429 usage limit reached",'
                '"data":{"statusCode":429,"category":"quota"}}'
            )
        },
    )

    assert _codebuddy_stop_failure_code(result) == "CODEBUDDY_RATE_LIMITED"


def test_codebuddy_non_quota_refusal_keeps_generic_stop_reason() -> None:
    from forgeflow.external_agents.acp import AcpExecutionResult

    result = AcpExecutionResult(
        stop_reason="refusal",
        text="I cannot perform that request.",
        session_id="session",
        metadata={},
    )

    assert _codebuddy_stop_failure_code(result) is None


def test_codebuddy_bootstrap_reports_process_exit_instead_of_seal_policy_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import subprocess

    import openswe_ext.codebuddy_execution as codebuddy

    monkeypatch.setattr(
        codebuddy.subprocess,
        "run",
        lambda *args, **kwargs: subprocess.CompletedProcess(args[0], 1, stdout="", stderr="gone"),
    )

    with pytest.raises(ExternalAgentRouteRejected, match="CODEBUDDY_PROCESS_EXITED"):
        _seal_codebuddy_bootstrap_sync(
            container_name="forgeflow-codebuddy-gone",
            image="sandbox:test",
        )


def test_codebuddy_capacity_gate_is_cross_execution_and_releasable(tmp_path: Path) -> None:
    state_dir = tmp_path / "state"
    first = _acquire_codebuddy_capacity(state_dir=state_dir, max_concurrency=1)
    try:
        with pytest.raises(ExternalAgentRouteRejected, match="CODEBUDDY_CAPACITY_BUSY"):
            _acquire_codebuddy_capacity(state_dir=state_dir, max_concurrency=1)
    finally:
        first.release()

    second = _acquire_codebuddy_capacity(state_dir=state_dir, max_concurrency=1)
    second.release()


def test_codebuddy_rejects_invalid_max_concurrency(tmp_path: Path) -> None:
    binary = _binary(tmp_path)
    auth = _auth_dir(tmp_path)
    with pytest.raises(ExternalAgentRouteRejected, match="MAX_CONCURRENCY_INVALID"):
        CodeBuddyExternalAgentExecution(
            env={
                "HOME": str(tmp_path),
                "FORGEFLOW_CODEBUDDY_BIN": str(binary),
                "FORGEFLOW_CODEBUDDY_AUTH_STATE_DIR": str(auth),
                "FORGEFLOW_EXTERNAL_AGENT_OUTER_SANDBOX": "docker",
                "FORGEFLOW_CODEBUDDY_MAX_CONCURRENCY": "0",
            }
        )
