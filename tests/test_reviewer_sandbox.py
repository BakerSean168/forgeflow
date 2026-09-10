from forgeflow import deployment
from forgeflow.deployment import reviewer_sandbox_preflight


def test_local_reviewer_sandbox_is_forbidden_even_if_explicit(monkeypatch) -> None:
    monkeypatch.setenv("SANDBOX_TYPE", "local")
    result = reviewer_sandbox_preflight()
    assert result.ready is False
    assert result.failure_code == "LOCAL_SANDBOX_FORBIDDEN"


def test_default_docker_sandbox_fails_closed_when_runtime_is_unavailable(monkeypatch) -> None:
    monkeypatch.delenv("SANDBOX_TYPE", raising=False)
    monkeypatch.setattr(deployment, "_docker_runtime_ready", lambda: False)
    result = reviewer_sandbox_preflight()
    assert result.ready is False
    assert result.provider == "docker"
    assert result.failure_code == "DOCKER_SANDBOX_RUNTIME_UNAVAILABLE"


def test_default_docker_sandbox_is_ready_only_after_runtime_preflight(monkeypatch) -> None:
    monkeypatch.delenv("SANDBOX_TYPE", raising=False)
    monkeypatch.setattr(deployment, "_docker_runtime_ready", lambda: True)
    result = reviewer_sandbox_preflight()
    assert result.ready is True
    assert result.provider == "docker"


def test_remote_provider_becomes_ready_only_with_its_credentials(monkeypatch) -> None:
    monkeypatch.setenv("SANDBOX_TYPE", "e2b")
    monkeypatch.delenv("E2B_API_KEY", raising=False)
    assert reviewer_sandbox_preflight().ready is False
    monkeypatch.setenv("E2B_API_KEY", "test-only")
    result = reviewer_sandbox_preflight()
    assert result.ready is True
    assert result.provider == "e2b"
