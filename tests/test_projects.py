import json

from forgeflow.projects import load_repository_policy


def test_repository_policy_extends_open_swe_projects_manifest_without_second_registry(
    tmp_path, monkeypatch
) -> None:
    manifest = tmp_path / "projects.json"
    manifest.write_text(
        json.dumps(
            [
                {
                    "cwd": "/work/digital-biome",
                    "name": "Digital Biome",
                    "repo": "BakerSean168/digital-biome",
                    "ci_required": True,
                    "required_checks": ["Type Check", "Type Check"],
                }
            ]
        )
    )
    monkeypatch.setenv("OPEN_SWE_LOCAL_PROJECTS_FILE", str(manifest))
    policy = load_repository_policy("bakersean168", "digital-biome")
    assert policy.ci_required is True
    assert policy.required_checks == ("Type Check",)


def test_missing_or_malformed_repository_policy_fails_closed(tmp_path, monkeypatch) -> None:
    monkeypatch.delenv("OPEN_SWE_LOCAL_PROJECTS_FILE", raising=False)
    assert load_repository_policy("o", "r").required_checks == ()

    manifest = tmp_path / "projects.json"
    manifest.write_text('{"not":"a list"}')
    monkeypatch.setenv("OPEN_SWE_LOCAL_PROJECTS_FILE", str(manifest))
    assert load_repository_policy("o", "r").required_checks == ()


def test_repository_can_explicitly_disable_ci(tmp_path, monkeypatch) -> None:
    manifest = tmp_path / "projects.json"
    manifest.write_text(
        json.dumps([{"repo": "o/r", "cwd": "/work/r", "name": "R", "ci_required": False}])
    )
    monkeypatch.setenv("OPEN_SWE_LOCAL_PROJECTS_FILE", str(manifest))
    policy = load_repository_policy("o", "r")
    assert policy.ci_required is False
    assert policy.required_checks == ()


def test_external_agent_project_config_reuses_existing_manifest(tmp_path, monkeypatch) -> None:
    from forgeflow.projects import load_external_agent_project_config

    repo = tmp_path / "repo"
    repo.mkdir()
    manifest = tmp_path / "projects.json"
    manifest.write_text(
        json.dumps(
            [
                {
                    "repo": "o/r",
                    "cwd": str(repo),
                    "external_agent_test_command": ["uv", "run", "pytest", "-q"],
                }
            ]
        )
    )
    monkeypatch.setenv("OPEN_SWE_LOCAL_PROJECTS_FILE", str(manifest))
    config = load_external_agent_project_config("O", "R")
    assert config is not None
    assert config.cwd == repo.resolve()
    assert config.test_command == ("uv", "run", "pytest", "-q")


def test_external_agent_project_config_fails_closed_without_test_command(tmp_path, monkeypatch) -> None:
    from forgeflow.projects import load_external_agent_project_config

    repo = tmp_path / "repo"
    repo.mkdir()
    manifest = tmp_path / "projects.json"
    manifest.write_text(json.dumps([{"repo": "o/r", "cwd": str(repo)}]))
    monkeypatch.setenv("OPEN_SWE_LOCAL_PROJECTS_FILE", str(manifest))
    assert load_external_agent_project_config("o", "r") is None
