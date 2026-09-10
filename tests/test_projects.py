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
