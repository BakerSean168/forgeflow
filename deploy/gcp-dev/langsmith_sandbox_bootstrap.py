#!/usr/bin/env python3
"""One-time Tailscale-only LangSmith sandbox credential bootstrap."""

from __future__ import annotations

import argparse
import asyncio
import html
import os
import secrets
import shlex
import subprocess
import threading
import urllib.parse
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import httpx
from langsmith.sandbox import (
    AsyncSandboxClient,
    QuotaExceededError,
    SandboxAuthenticationError,
)

SUCCESS_MARKER = "forgeflow-sandbox-ok"

LANGSMITH_REGIONS: dict[str, tuple[str, str]] = {
    "us-gcp": ("GCP US", "https://api.smith.langchain.com"),
    "eu-gcp": ("GCP EU", "https://eu.api.smith.langchain.com"),
    "apac-gcp": ("GCP APAC", "https://apac.api.smith.langchain.com"),
    "us-aws": ("AWS US", "https://aws.api.smith.langchain.com"),
}


def _shell_line(key: str, value: str) -> str:
    return f"{key}={shlex.quote(value)}\n"


def write_sandbox_env(path: Path, api_key: str, endpoint: str) -> None:
    if not api_key.strip():
        raise ValueError("LangSmith API key is empty")
    if endpoint not in {item[1] for item in LANGSMITH_REGIONS.values()}:
        raise ValueError("unsupported LangSmith regional endpoint")
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as handle:
        handle.write(_shell_line("SANDBOX_TYPE", "langsmith"))
        handle.write(_shell_line("SANDBOX_LANGSMITH_API_KEY", api_key.strip()))
        handle.write(_shell_line("SANDBOX_LANGSMITH_ENDPOINT", endpoint))
    os.chmod(tmp, 0o600)
    tmp.replace(path)
    os.chmod(path, 0o600)


async def validate_langsmith_sandbox(api_key: str, endpoint: str) -> dict[str, Any]:
    """Create, execute in, and delete one real LangSmith sandbox."""
    sandbox_name: str | None = None
    api_endpoint = f"{endpoint.rstrip('/')}/v2/sandboxes"
    async with AsyncSandboxClient(api_key=api_key.strip(), api_endpoint=api_endpoint) as client:
        try:
            sandbox = await client.create_sandbox(
                name=f"forgeflow-preflight-{secrets.token_hex(6)}",
                wait_for_ready=True,
                timeout=45,
                idle_ttl_seconds=60,
                delete_after_stop_seconds=60,
            )
            sandbox_name = sandbox.name
            result = await sandbox.run(f"printf {SUCCESS_MARKER}", timeout=20)
            stdout = getattr(result, "stdout", "") or ""
            exit_code = getattr(result, "exit_code", None)
            if exit_code != 0 or stdout != SUCCESS_MARKER:
                raise RuntimeError("sandbox command smoke did not return the expected marker")
            return {
                "provider": "langsmith",
                "endpoint": endpoint,
                "sandbox_created": True,
                "command_ok": True,
            }
        finally:
            if sandbox_name:
                try:
                    await client.delete_sandbox(sandbox_name)
                except Exception as exc:  # noqa: BLE001 - cleanup must not expose request data
                    print(f"sandbox_cleanup_warning={type(exc).__name__}", flush=True)


def _http_status_from_exception(exc: BaseException) -> int | None:
    """Extract only an HTTP status code from a provider exception chain."""
    current: BaseException | None = exc
    seen: set[int] = set()
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        if isinstance(current, httpx.HTTPStatusError):
            return current.response.status_code
        current = current.__cause__ or current.__context__
    return None


def configure_sandbox(env_path: Path, api_key: str, endpoint: str) -> dict[str, Any]:
    result = asyncio.run(validate_langsmith_sandbox(api_key, endpoint))
    write_sandbox_env(env_path, api_key, endpoint)
    subprocess.run(["systemctl", "--user", "restart", "forgeflow-policy.service"], check=True)
    active = subprocess.run(
        ["systemctl", "--user", "is-active", "--quiet", "forgeflow-policy.service"],
        check=False,
    ).returncode == 0
    if not active:
        raise RuntimeError("forgeflow-policy.service did not restart successfully")
    return result


class SandboxBootstrapServer(ThreadingHTTPServer):
    def __init__(self, address: tuple[str, int], env_path: Path):
        super().__init__(address, Handler)
        self.env_path = env_path
        self.completed = False


class Handler(BaseHTTPRequestHandler):
    server: SandboxBootstrapServer

    def log_message(self, _format: str, *_args: object) -> None:
        # Never log request bodies containing an API key.
        return

    def _html(self, title: str, body: str, status: int = HTTPStatus.OK) -> None:
        payload = (
            "<!doctype html><meta charset='utf-8'>"
            f"<title>{html.escape(title)}</title>"
            "<style>body{font-family:system-ui;max-width:760px;margin:48px auto;padding:0 20px;line-height:1.55}"
            "input{width:100%;padding:10px;box-sizing:border-box}button,a.button{display:inline-block;margin-top:12px;padding:10px 16px;border:1px solid #888;border-radius:8px;text-decoration:none}"
            "code{background:#eee;padding:2px 5px;border-radius:4px}</style>"
            f"<h1>{html.escape(title)}</h1>{body}"
        ).encode()
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:
        if urllib.parse.urlparse(self.path).path != "/":
            self._html("Not found", "<p>Unknown bootstrap path.</p>", HTTPStatus.NOT_FOUND)
            return
        options = "".join(
            f"<option value='{html.escape(region)}'>{html.escape(label)}</option>"
            for region, (label, _endpoint) in LANGSMITH_REGIONS.items()
        )
        body = f"""
        <p>ForgeFlow uses LangSmith only as the isolated reviewer sandbox provider.</p>
        <p><strong>Select the same region shown in your LangSmith browser URL.</strong> For example,
        <code>apac.smith.langchain.com</code> means <strong>GCP APAC</strong>. LangSmith API keys are
        regional and a non-US key sent to the default US endpoint can look invalid.</p>
        <p>Create a key that can manage sandbox lifecycle. The minimum required operations are
        <code>sandboxes:create</code>, <code>sandboxes:read</code>, and <code>sandboxes:delete</code>.
        On plans without granular service-key RBAC, use a normal workspace API key with sandbox access.</p>
        <p>The key is sent only over your Tailscale network to the selected official LangSmith API
        endpoint. It is never echoed back or persisted unless create/execute/delete validation passes.</p>
        <form action="/configure" method="post">
          <label>LangSmith region</label>
          <select name="region" required>{options}</select>
          <br>
          <label>LangSmith API key</label>
          <input type="password" name="api_key" autocomplete="off" required>
          <button type="submit">Validate sandbox and configure ForgeFlow</button>
        </form>
        """
        self._html("ForgeFlow reviewer sandbox bootstrap", body)

    def do_POST(self) -> None:
        if urllib.parse.urlparse(self.path).path != "/configure":
            self._html("Not found", "<p>Unknown bootstrap path.</p>", HTTPStatus.NOT_FOUND)
            return
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length <= 0 or length > 16_384:
            self._html("Bootstrap blocked", "<p>Invalid request body.</p>", HTTPStatus.BAD_REQUEST)
            return
        body = self.rfile.read(length).decode("utf-8", errors="strict")
        fields = urllib.parse.parse_qs(body, keep_blank_values=True)
        key = fields.get("api_key", [""])[0].strip()
        region = fields.get("region", [""])[0].strip()
        region_config = LANGSMITH_REGIONS.get(region)
        if not key:
            self._html("Bootstrap blocked", "<p>API key is required.</p>", HTTPStatus.BAD_REQUEST)
            return
        if region_config is None:
            self._html("Bootstrap blocked", "<p>Select a supported LangSmith region.</p>", HTTPStatus.BAD_REQUEST)
            return
        region_label, endpoint = region_config
        try:
            result = configure_sandbox(self.server.env_path, key, endpoint)
        except SandboxAuthenticationError as exc:
            status = _http_status_from_exception(exc)
            detail = (
                f"HTTP {status}. " if status is not None else ""
            ) + "The key was not persisted. Check that the selected region matches your LangSmith URL and that the key has sandbox create/read/delete access."
            self._html(
                "Sandbox authentication failed",
                f"<p>Region: <code>{html.escape(region_label)}</code>.</p><p>{html.escape(detail)}</p>",
                HTTPStatus.BAD_REQUEST,
            )
            return
        except QuotaExceededError:
            self._html(
                "Sandbox quota unavailable",
                "<p>The key authenticated, but LangSmith rejected sandbox creation because the workspace quota is unavailable or exhausted. The key was not persisted.</p>",
                HTTPStatus.BAD_REQUEST,
            )
            return
        except Exception as exc:  # noqa: BLE001 - redact provider errors that may carry request metadata
            self._html(
                "Sandbox validation failed",
                f"<p>The key was not persisted. Failure class: <code>{html.escape(type(exc).__name__)}</code>.</p>",
                HTTPStatus.BAD_REQUEST,
            )
            return
        self.server.completed = True
        self._html(
            "ForgeFlow reviewer sandbox ready",
            "<p>Real LangSmith microVM create/execute/delete smoke passed. "
            "The key was stored with mode 0600 and <code>forgeflow-policy.service</code> was restarted.</p>"
            f"<p>Provider: <code>{html.escape(str(result['provider']))}</code>; endpoint: "
            f"<code>{html.escape(str(result['endpoint']))}</code>.</p>",
        )
        threading.Timer(5, self.server.shutdown).start()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bind", required=True, help="Tailscale IPv4 address only")
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument(
        "--env-file", default=str(Path.home() / ".config/forgeflow-policy/sandbox.env")
    )
    args = parser.parse_args()
    if not args.bind.startswith("100."):
        raise SystemExit("bootstrap must bind to a Tailscale 100.x address")
    server = SandboxBootstrapServer((args.bind, args.port), Path(args.env_file))
    print(f"bootstrap_url=http://{args.bind}:{args.port}/", flush=True)
    print("provider=langsmith", flush=True)
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        server.server_close()
    raise SystemExit(0 if server.completed else 2)


if __name__ == "__main__":
    main()
