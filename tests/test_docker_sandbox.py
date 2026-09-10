from pathlib import Path

import pytest

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


def test_deepagents_artifacts_share_the_persistent_workspace_volume() -> None:
    source = Path(__file__).resolve().parents[1] / "openswe_ext/docker_sandbox.py"
    text = source.read_text(encoding="utf-8")
    assert '.open-swe-artifacts/large_tool_results' in text
    assert '.open-swe-artifacts/conversation_history' in text
    assert 'dst=/large_tool_results' in text
    assert 'dst=/conversation_history' in text
    assert 'volume-subpath={_LARGE_TOOL_RESULTS_SUBPATH}' in text
    assert 'volume-subpath={_CONVERSATION_HISTORY_SUBPATH}' in text
    # Artifacts reuse the one provider-owned workspace volume so GC ownership
    # and cleanup do not gain extra volume lifecycle state.
    assert 'container_id}-artifacts' not in text


def test_network_setup_blocks_metadata_private_and_tailscale_ranges() -> None:
    setup = (
        Path(__file__).resolve().parents[1] / "deploy/gcp-dev/ensure-docker-sandbox-network.sh"
    ).read_text(encoding="utf-8")
    for destination in (
        "169.254.0.0/16",
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


def test_sandbox_image_pins_uv_and_python_314_toolchain() -> None:
    dockerfile = (
        Path(__file__).resolve().parents[1] / "deploy/gcp-dev/Dockerfile.openswe-sandbox"
    ).read_text(encoding="utf-8")
    assert (
        "FROM ghcr.io/astral-sh/uv@sha256:"
        "cf4eedcaa81655197f625739489effcbe71b61ceb1506f332c3facae5deceded AS uv"
        in dockerfile
    )
    assert "COPY --from=uv /uv /uvx /usr/local/bin/" in dockerfile
    assert "UV_PYTHON_INSTALL_DIR=/opt/uv/python" in dockerfile
    assert "uv python install 3.14.6" in dockerfile
    assert "uv python find 3.14.6" in dockerfile


def test_package_includes_runtime_extension_without_putting_it_under_policy_package() -> None:
    root = Path(__file__).resolve().parents[1]
    pyproject = (root / "pyproject.toml").read_text(encoding="utf-8")
    assert 'packages = ["forgeflow", "openswe_ext"]' in pyproject
    assert (root / "openswe_ext/docker_sandbox.py").exists()



def test_only_forgeflow_implementation_is_write_capable() -> None:
    from types import SimpleNamespace

    from openswe_ext.docker_sandbox import _is_forgeflow_implementation

    assert _is_forgeflow_implementation(
        SimpleNamespace(source="forgeflow", reviewer_thread_id=None)
    )
    assert not _is_forgeflow_implementation(
        SimpleNamespace(source="github", reviewer_thread_id=None)
    )
    assert not _is_forgeflow_implementation(
        SimpleNamespace(source="forgeflow", reviewer_thread_id="review-thread")
    )


def test_project_manifest_declares_same_owner_read_only_sandbox_dependencies(
    tmp_path: Path, monkeypatch
) -> None:
    import json
    from types import SimpleNamespace

    from openswe_ext.docker_sandbox import _sandbox_read_repositories

    manifest = tmp_path / "projects.json"
    manifest.write_text(
        json.dumps(
            [
                {
                    "repo": "BakerSean168/digital-biome",
                    "sandbox_read_repositories": [
                        "BakerSean168/thought-forest",
                        "BakerSean168/thought-forest",
                    ],
                }
            ]
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("OPEN_SWE_LOCAL_PROJECTS_FILE", str(manifest))
    cfg = SimpleNamespace(
        repo=SimpleNamespace(owner="BakerSean168", name="digital-biome")
    )
    assert _sandbox_read_repositories(cfg) == ("thought-forest",)


def test_project_manifest_rejects_cross_owner_dependency(tmp_path: Path, monkeypatch) -> None:
    import json
    from types import SimpleNamespace

    import pytest

    from openswe_ext.docker_sandbox import DockerSandboxError, _sandbox_read_repositories

    manifest = tmp_path / "projects.json"
    manifest.write_text(
        json.dumps(
            [
                {
                    "repo": "BakerSean168/digital-biome",
                    "sandbox_read_repositories": ["other-owner/private-vault"],
                }
            ]
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("OPEN_SWE_LOCAL_PROJECTS_FILE", str(manifest))
    cfg = SimpleNamespace(
        repo=SimpleNamespace(owner="BakerSean168", name="digital-biome")
    )
    with pytest.raises(DockerSandboxError, match="share the primary owner"):
        _sandbox_read_repositories(cfg)


def test_high_volume_package_caches_use_persistent_workspace_volume() -> None:
    from openswe_ext.docker_sandbox import _runtime_env_prelude

    prelude = _runtime_env_prelude()
    assert "/workspace/.open-swe-cache/xdg-data" in prelude
    assert "/workspace/.open-swe-cache/corepack" in prelude
    assert "/workspace/.open-swe-cache/npm" in prelude
    assert "/workspace/.open-swe-cache/uv" in prelude
    assert "/workspace/.open-swe-cache/go-mod" in prelude
    assert "/workspace/.open-swe-runtime/last-used" in prelude
    assert "TMPDIR=/workspace/.open-swe-runtime/tmp" in prelude
    assert "XDG_RUNTIME_DIR=/tmp/.runtime" in prelude
    assert "/home/sandbox/.local" not in prelude


def test_git_https_auth_uses_token_free_path_aware_credential_helper() -> None:
    from openswe_ext.docker_sandbox import _git_credential_script

    script = _git_credential_script(
        read_token_path="/tmp/openswe-github-read-token",
        write_token_path="/tmp/openswe-github-write-token",
        write_repository="BakerSean168/digital-biome",
    )
    assert "credential" not in script.lower()  # helper itself contains no GitHub credential value
    assert "/tmp/openswe-github-read-token" in script
    assert "/tmp/openswe-github-write-token" in script
    assert "BakerSean168/digital-biome" in script
    assert "x-access-token" in script
    assert "https://x-access-token:" not in script

    source = (
        Path(__file__).resolve().parents[1] / "openswe_ext/docker_sandbox.py"
    ).read_text(encoding="utf-8")
    assert 'self._git_credential_path = "/workspace/.open-swe-runtime/git-credential"' in source
    assert 'self._github_read_token_path = "/tmp/openswe-github-read-token"' in source
    assert 'self._github_write_token_path = "/tmp/openswe-github-write-token"' in source
    assert "credential.useHttpPath" in source
    assert "GIT_TERMINAL_PROMPT=0" in source
    assert "GIT_ASKPASS" not in source


def test_git_credential_helper_selects_write_only_for_primary_repo(tmp_path: Path) -> None:
    import os
    import subprocess

    from openswe_ext.docker_sandbox import _git_credential_script

    read = tmp_path / "read-token"
    write = tmp_path / "write-token"
    helper = tmp_path / "git-credential"
    read.write_text("READ_ONLY", encoding="utf-8")
    write.write_text("PRIMARY_WRITE", encoding="utf-8")
    helper.write_text(
        _git_credential_script(
            read_token_path=str(read),
            write_token_path=str(write),
            write_repository="BakerSean168/digital-biome",
        ),
        encoding="utf-8",
    )
    helper.chmod(0o700)

    def lookup(path: str) -> str:
        result = subprocess.run(
            [os.fspath(helper), "get"],
            input=f"protocol=https\nhost=github.com\npath={path}\n\n",
            text=True,
            capture_output=True,
            check=True,
        )
        return result.stdout

    assert "password=PRIMARY_WRITE" in lookup("BakerSean168/digital-biome.git")
    assert "password=READ_ONLY" in lookup("BakerSean168/thought-forest.git")


@pytest.mark.asyncio
async def test_runtime_mints_dependency_read_token_and_primary_write_token(
    tmp_path: Path, monkeypatch
) -> None:
    import json

    import agent.github.app as app_module
    import langgraph.config as langgraph_config

    from openswe_ext.docker_sandbox import _github_credentials_from_run_context

    manifest = tmp_path / "projects.json"
    manifest.write_text(
        json.dumps(
            [
                {
                    "repo": "BakerSean168/digital-biome",
                    "sandbox_read_repositories": ["BakerSean168/thought-forest"],
                }
            ]
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("OPEN_SWE_LOCAL_PROJECTS_FILE", str(manifest))
    monkeypatch.setattr(
        langgraph_config,
        "get_config",
        lambda: {
            "configurable": {
                "source": "forgeflow",
                "repo": {"owner": "BakerSean168", "name": "digital-biome"},
            }
        },
    )
    calls: list[dict[str, object]] = []

    async def mint(**kwargs):
        calls.append(kwargs)
        return ("READ_TOKEN" if len(calls) == 1 else "WRITE_TOKEN"), "2099-01-01"

    monkeypatch.setattr(app_module, "get_github_app_installation_token_with_expiry", mint)
    credentials = await _github_credentials_from_run_context()
    assert credentials is not None
    assert credentials.read_token == "READ_TOKEN"
    assert credentials.write_token == "WRITE_TOKEN"
    assert credentials.write_repository == "BakerSean168/digital-biome"
    assert calls == [
        {
            "repositories": ["digital-biome", "thought-forest"],
            "permissions": {"contents": "read", "pull_requests": "read"},
            "log_errors": False,
        },
        {
            "repositories": ["digital-biome"],
            "permissions": {"contents": "write", "pull_requests": "read"},
            "log_errors": False,
        },
    ]


def test_execute_preserves_empty_stdout_for_structured_backend_parsers(monkeypatch) -> None:
    import subprocess

    from openswe_ext import docker_sandbox

    monkeypatch.setattr(docker_sandbox, "_assert_owned_container", lambda _sid: None)
    monkeypatch.setattr(docker_sandbox, "_container_running", lambda _sid: True)
    monkeypatch.setattr(
        docker_sandbox,
        "_docker",
        lambda *args, **kwargs: subprocess.CompletedProcess(args=args, returncode=0, stdout=b"", stderr=b""),
    )
    result = docker_sandbox.DockerSandbox("openswe-sbx-test").execute("true")
    assert result.exit_code == 0
    assert result.output == ""
    assert result.truncated is False
