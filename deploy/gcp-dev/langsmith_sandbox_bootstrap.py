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

from langsmith.sandbox import AsyncSandboxClient

SUCCESS_MARKER = "forgeflow-sandbox-ok"


def _shell_line(key: str, value: str) -> str:
    return f"{key}={shlex.quote(value)}\n"


def write_sandbox_env(path: Path, api_key: str) -> None:
    if not api_key.strip():
        raise ValueError("LangSmith API key is empty")
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as handle:
        handle.write(_shell_line("SANDBOX_TYPE", "langsmith"))
        handle.write(_shell_line("SANDBOX_LANGSMITH_API_KEY", api_key.strip()))
    os.chmod(tmp, 0o600)
    tmp.replace(path)
    os.chmod(path, 0o600)


async def validate_langsmith_sandbox(api_key: str) -> dict[str, Any]:
    """Create, execute in, and delete one real LangSmith sandbox."""
    sandbox_name: str | None = None
    async with AsyncSandboxClient(api_key=api_key.strip()) as client:
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
            return {"provider": "langsmith", "sandbox_created": True, "command_ok": True}
        finally:
            if sandbox_name:
                try:
                    await client.delete_sandbox(sandbox_name)
                except Exception as exc:  # noqa: BLE001 - cleanup must not expose request data
                    print(f"sandbox_cleanup_warning={type(exc).__name__}", flush=True)


def configure_sandbox(env_path: Path, api_key: str) -> dict[str, Any]:
    result = asyncio.run(validate_langsmith_sandbox(api_key))
    write_sandbox_env(env_path, api_key)
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
        body = """
        <p>ForgeFlow uses LangSmith only as the isolated reviewer sandbox provider. The Developer
        plan currently includes sandbox free usage; create an API key in LangSmith under
        <strong>Settings → API Keys</strong>, then paste it here.</p>
        <p>The key is sent only over your Tailscale network to GCP Dev. It is never echoed back.</p>
        <form action="/configure" method="post">
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
        key = urllib.parse.parse_qs(body, keep_blank_values=True).get("api_key", [""])[0].strip()
        if not key:
            self._html("Bootstrap blocked", "<p>API key is required.</p>", HTTPStatus.BAD_REQUEST)
            return
        try:
            result = configure_sandbox(self.server.env_path, key)
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
            f"<p>Provider: <code>{html.escape(str(result['provider']))}</code>.</p>",
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
