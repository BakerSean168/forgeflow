from forgeflow.deployment import reviewer_sandbox_preflight


def test_local_reviewer_sandbox_is_forbidden_even_if_explicit(monkeypatch) -> None:
    monkeypatch.setenv("SANDBOX_TYPE", "local")
    result = reviewer_sandbox_preflight()
    assert result.ready is False
    assert result.failure_code == "LOCAL_SANDBOX_FORBIDDEN"


def test_default_langsmith_sandbox_requires_credentials(monkeypatch) -> None:
    monkeypatch.delenv("SANDBOX_TYPE", raising=False)
    monkeypatch.delenv("SANDBOX_LANGSMITH_API_KEY", raising=False)
    monkeypatch.delenv("LANGSMITH_API_KEY", raising=False)
    result = reviewer_sandbox_preflight()
    assert result.ready is False
    assert result.provider == "langsmith"
    assert result.failure_code == "REVIEWER_SANDBOX_CREDENTIAL_MISSING"


def test_isolated_provider_becomes_ready_only_with_its_credentials(monkeypatch) -> None:
    monkeypatch.setenv("SANDBOX_TYPE", "e2b")
    monkeypatch.delenv("E2B_API_KEY", raising=False)
    assert reviewer_sandbox_preflight().ready is False
    monkeypatch.setenv("E2B_API_KEY", "test-only")
    result = reviewer_sandbox_preflight()
    assert result.ready is True
    assert result.provider == "e2b"
