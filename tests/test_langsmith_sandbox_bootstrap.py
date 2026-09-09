import importlib.util
import shlex
import stat
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "deploy/gcp-dev/langsmith_sandbox_bootstrap.py"
spec = importlib.util.spec_from_file_location("langsmith_sandbox_bootstrap", SCRIPT)
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def test_sandbox_env_is_external_mode_600_and_roundtrips_key(tmp_path: Path) -> None:
    env = tmp_path / "sandbox.env"
    module.write_sandbox_env(env, "lsv2_pt_example-secret", "https://apac.api.smith.langchain.com")
    assert stat.S_IMODE(env.stat().st_mode) == 0o600
    values = {}
    for line in env.read_text().splitlines():
        key, encoded = line.split("=", 1)
        values[key] = shlex.split(encoded)[0]
    assert values == {
        "SANDBOX_TYPE": "langsmith",
        "SANDBOX_LANGSMITH_API_KEY": "lsv2_pt_example-secret",
        "SANDBOX_LANGSMITH_ENDPOINT": "https://apac.api.smith.langchain.com",
    }


def test_empty_key_is_rejected_before_persistence(tmp_path: Path) -> None:
    env = tmp_path / "sandbox.env"
    try:
        module.write_sandbox_env(env, "   ", "https://api.smith.langchain.com")
    except ValueError as exc:
        assert "empty" in str(exc)
    else:
        raise AssertionError("empty key was accepted")
    assert not env.exists()


def test_start_script_sources_external_sandbox_env_before_default() -> None:
    start = (SCRIPT.parent / "start-forgeflow-policy.sh").read_text(encoding="utf-8")
    source_at = start.index('. "$sandbox_env"')
    default_at = start.index('export SANDBOX_TYPE="${SANDBOX_TYPE:-langsmith}"')
    assert source_at < default_at


def test_only_official_regional_endpoints_can_be_persisted(tmp_path: Path) -> None:
    env = tmp_path / "sandbox.env"
    try:
        module.write_sandbox_env(env, "lsv2_pt_example-secret", "https://attacker.invalid")
    except ValueError as exc:
        assert "unsupported" in str(exc)
    else:
        raise AssertionError("arbitrary sandbox endpoint was accepted")
    assert not env.exists()


def test_bootstrap_exposes_all_supported_langsmith_regions() -> None:
    assert module.LANGSMITH_REGIONS == {
        "us-gcp": ("GCP US", "https://api.smith.langchain.com"),
        "eu-gcp": ("GCP EU", "https://eu.api.smith.langchain.com"),
        "apac-gcp": ("GCP APAC", "https://apac.api.smith.langchain.com"),
        "us-aws": ("AWS US", "https://aws.api.smith.langchain.com"),
    }
