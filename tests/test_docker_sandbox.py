from pathlib import Path

from openswe_ext.docker_sandbox import DockerSandboxConfig, _normalize_path


def test_docker_defaults_are_bounded_and_use_dedicated_network(monkeypatch) -> None:
    for name in (
        "OPEN_SWE_DOCKER_IMAGE",
        "OPEN_SWE_DOCKER_NETWORK",
        "OPEN_SWE_DOCKER_CPUS",
        "OPEN_SWE_DOCKER_MEMORY",
        "OPEN_SWE_DOCKER_PIDS_LIMIT",
    ):
        monkeypatch.delenv(name, raising=False)
    cfg = DockerSandboxConfig.from_env()
    assert cfg.network == "openswe-sandbox"
    assert cfg.cpus == "2"
    assert cfg.memory == "8g"
    assert cfg.pids_limit == "1024"


def test_transfer_paths_never_escape_container_workspace() -> None:
    assert _normalize_path("hello.txt") == "/workspace/hello.txt"
    assert _normalize_path("/workspace/a.txt") == "/workspace/a.txt"
    try:
        _normalize_path("../host-secret")
    except ValueError:
        pass
    else:
        raise AssertionError("parent traversal was accepted")


def test_container_template_has_required_isolation_flags() -> None:
    source = Path(__file__).resolve().parents[1] / "openswe_ext/docker_sandbox.py"
    text = source.read_text(encoding="utf-8")
    for expected in (
        '"--read-only"',
        '"--cap-drop=ALL"',
        '"--security-opt=no-new-privileges:true"',
        '"--security-opt=apparmor=docker-default"',
        '"--pids-limit"',
        '"--memory"',
        '"--cpus"',
        '"--user"',
        '"1000:1000"',
    ):
        assert expected in text
    assert "/var/run/docker.sock" not in text
    assert ".codex" not in text
    assert "github-app.env" not in text


def test_network_setup_blocks_metadata_private_and_tailscale_ranges() -> None:
    setup = (
        Path(__file__).resolve().parents[1] / "deploy/gcp-dev/setup-docker-sandbox.sh"
    ).read_text(encoding="utf-8")
    for destination in (
        "169.254.169.254/32",
        "10.0.0.0/8",
        "172.16.0.0/12",
        "192.168.0.0/16",
        "100.64.0.0/10",
    ):
        assert destination in setup
    assert "DOCKER-USER" in setup
    assert "openswe-sandbox" in setup


def test_graph_wrapper_registers_docker_without_forking_upstream_graphs() -> None:
    from agent.sandboxes.providers.registry import SANDBOX_FACTORIES

    from openswe_ext.graphs import register_runtime_extensions

    register_runtime_extensions()
    assert SANDBOX_FACTORIES["docker"] == (
        "openswe_ext.docker_sandbox",
        "create_docker_sandbox",
    )


def test_package_includes_runtime_extension_without_putting_it_under_policy_package() -> None:
    root = Path(__file__).resolve().parents[1]
    pyproject = (root / "pyproject.toml").read_text(encoding="utf-8")
    assert 'packages = ["forgeflow", "openswe_ext"]' in pyproject
    assert (root / "openswe_ext/docker_sandbox.py").exists()


def test_github_token_scope_is_read_only_by_default() -> None:
    from types import SimpleNamespace

    from openswe_ext.docker_sandbox import _github_permissions_for_run

    reviewer = SimpleNamespace(source="github", reviewer_thread_id="review-thread")
    other = SimpleNamespace(source="slack", reviewer_thread_id=None)
    assert _github_permissions_for_run(reviewer) == {
        "contents": "read",
        "pull_requests": "read",
    }
    assert _github_permissions_for_run(other) == {
        "contents": "read",
        "pull_requests": "read",
    }


def test_only_forgeflow_implementation_gets_repo_write_without_workflow_write() -> None:
    from types import SimpleNamespace

    from openswe_ext.docker_sandbox import _github_permissions_for_run

    implementation = SimpleNamespace(source="forgeflow", reviewer_thread_id=None)
    permissions = _github_permissions_for_run(implementation)
    assert permissions == {"contents": "write", "pull_requests": "read"}
    assert "workflows" not in permissions
    assert "issues" not in permissions
    assert "checks" not in permissions
