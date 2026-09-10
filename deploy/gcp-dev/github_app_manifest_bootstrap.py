#!/usr/bin/env python3
"""One-time Tailscale-only GitHub App manifest bootstrap for ForgeFlow Policy.

The browser only approves registration/installation. Manifest conversion and
credential persistence happen on GCP Dev; secrets are never rendered back to
browser pages or logs.
"""

from __future__ import annotations

import argparse
import html
import json
import os
import secrets
import shlex
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import jwt

GITHUB_API = "https://api.github.com"
GITHUB_REGISTER = "https://github.com/settings/apps/new"
APP_NAME = "ForgeFlow Open SWE BakerSean168"
APP_HOME = "https://github.com/BakerSean168/forgeflow"
REQUIRED_REPOS = ("digital-biome", "forgeflow")
OWNER = "BakerSean168"
PERMISSIONS: dict[str, str] = {
    "actions": "read",
    "checks": "write",
    "contents": "write",
    "issues": "write",
    "metadata": "read",
    "pull_requests": "write",
    "statuses": "read",
    "workflows": "write",
}
EVENTS = (
    "check_run",
    "check_suite",
    "issue_comment",
    "pull_request_review",
    "pull_request_review_comment",
    "status",
    "workflow_run",
)


def build_manifest(base_url: str) -> dict[str, Any]:
    return {
        "name": APP_NAME,
        "url": APP_HOME,
        "description": "Dedicated Open SWE GitHub App for ForgeFlow Policy V1.",
        "hook_attributes": {
            "url": "https://example.com/forgeflow-open-swe-disabled-webhook",
            "active": False,
        },
        "redirect_url": f"{base_url}/manifest-callback",
        "setup_url": f"{base_url}/installed",
        "setup_on_update": True,
        "public": False,
        "request_oauth_on_install": False,
        "default_permissions": PERMISSIONS,
        "default_events": list(EVENTS),
    }


def _api_json(
    method: str,
    path: str,
    *,
    token: str | None = None,
    body: dict[str, Any] | None = None,
) -> dict[str, Any]:
    data = json.dumps(body).encode() if body is not None else None
    headers = {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2026-03-10",
        "User-Agent": "forgeflow-policy-bootstrap",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(
        f"{GITHUB_API}{path}", data=data, headers=headers, method=method
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        payload = json.load(response)
    if not isinstance(payload, dict):
        raise TypeError("GitHub returned a non-object response")
    return payload


def exchange_manifest(code: str) -> dict[str, Any]:
    return _api_json("POST", f"/app-manifests/{urllib.parse.quote(code, safe='')}/conversions")


def _app_jwt(app_id: str, private_key: str) -> str:
    now = int(time.time())
    return jwt.encode(
        {"iat": now - 60, "exp": now + 540, "iss": app_id},
        private_key.replace("\\n", "\n"),
        algorithm="RS256",
    )


def repository_installation_id(
    *, app_id: str, private_key: str, owner: str, repo: str
) -> int:
    payload = _api_json(
        "GET",
        f"/repos/{urllib.parse.quote(owner, safe='')}/{urllib.parse.quote(repo, safe='')}/installation",
        token=_app_jwt(app_id, private_key),
    )
    value = payload.get("id")
    if not isinstance(value, int) or value <= 0:
        raise RuntimeError(f"GitHub returned no installation id for {owner}/{repo}")
    return value


def _shell_line(key: str, value: str) -> str:
    return f"{key}={shlex.quote(value)}\n"


def write_app_env(path: Path, app: dict[str, Any], *, installation_id: int | None = None) -> None:
    app_id = app.get("id")
    client_id = app.get("client_id")
    client_secret = app.get("client_secret")
    pem = app.get("pem")
    webhook_secret = app.get("webhook_secret")
    required = {
        "GITHUB_APP_ID": app_id,
        "GITHUB_APP_CLIENT_ID": client_id,
        "GITHUB_APP_CLIENT_SECRET": client_secret,
        "GITHUB_APP_PRIVATE_KEY": pem.replace("\n", "\\n") if isinstance(pem, str) else None,
        "GITHUB_WEBHOOK_SECRET": webhook_secret,
    }
    missing = [key for key, value in required.items() if not isinstance(value, (str, int)) or not str(value)]
    if missing:
        raise RuntimeError(f"manifest conversion omitted required fields: {missing}")
    if installation_id is not None:
        required["GITHUB_APP_INSTALLATION_ID"] = installation_id
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as handle:
        for key, value in required.items():
            handle.write(_shell_line(key, str(value)))
    os.chmod(tmp, 0o600)
    tmp.replace(path)
    os.chmod(path, 0o600)


def read_app_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        if not raw or raw.lstrip().startswith("#") or "=" not in raw:
            continue
        key, encoded = raw.split("=", 1)
        parsed = shlex.split(encoded)
        if len(parsed) != 1:
            raise RuntimeError(f"invalid bootstrap env line for {key}")
        values[key] = parsed[0]
    return values


def write_pending_app(path: Path, app: dict[str, Any]) -> None:
    required = ("id", "client_id", "client_secret", "pem", "webhook_secret", "slug")
    missing = [key for key in required if not app.get(key)]
    if missing:
        raise RuntimeError(f"manifest conversion omitted required fields: {missing}")
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps({key: app[key] for key in required}), encoding="utf-8")
    os.chmod(tmp, 0o600)
    tmp.replace(path)
    os.chmod(path, 0o600)


def read_pending_app(path: Path) -> dict[str, Any]:
    if not path.is_file():
        raise RuntimeError("GitHub App manifest conversion has not completed")
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise TypeError("pending GitHub App payload is invalid")
    return payload


def finalize_installation(
    env_path: Path, app: dict[str, Any], installation_id: int
) -> tuple[dict[str, str], list[str]]:
    app_id = str(app.get("id") or "")
    pem = app.get("pem")
    private_key = pem if isinstance(pem, str) else ""
    if not app_id or not private_key:
        raise RuntimeError("GitHub App manifest conversion has not completed")
    observed = {
        repo: repository_installation_id(
            app_id=app_id, private_key=private_key, owner=OWNER, repo=repo
        )
        for repo in REQUIRED_REPOS
    }
    mismatched = [repo for repo, value in observed.items() if value != installation_id]
    if mismatched:
        raise RuntimeError(
            "installation does not cover the required repositories: " + ", ".join(mismatched)
        )
    write_app_env(env_path, app, installation_id=installation_id)
    root = Path(__file__).resolve().parents[2]
    results: list[str] = []
    subprocess.run(["systemctl", "--user", "restart", "forgeflow-policy.service"], check=True)
    for repo in REQUIRED_REPOS:
        check = subprocess.run(
            [str(root / "deploy/gcp-dev/check-github-app.sh"), f"{OWNER}/{repo}"],
            cwd=root,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=60,
            check=False,
        )
        results.append(check.stdout.strip())
        if check.returncode != 0:
            raise RuntimeError(f"ForgeFlow GitHub App preflight failed for {repo}")
    return observed, results


class BootstrapServer(ThreadingHTTPServer):
    def __init__(self, address: tuple[str, int], env_path: Path):
        super().__init__(address, Handler)
        self.csrf_state = secrets.token_urlsafe(32)
        self.base_url = f"http://{address[0]}:{address[1]}"
        self.env_path = env_path
        self.pending_path = env_path.with_suffix(env_path.suffix + ".pending.json")
        self.app_slug: str | None = None
        self.completed = False


class Handler(BaseHTTPRequestHandler):
    server: BootstrapServer

    def log_message(self, _format: str, *_args: object) -> None:
        # Never log callback query strings or one-time manifest codes.
        return

    def _html(self, title: str, body: str, status: int = HTTPStatus.OK) -> None:
        payload = (
            "<!doctype html><meta charset='utf-8'>"
            f"<title>{html.escape(title)}</title>"
            "<style>body{font-family:system-ui;max-width:760px;margin:48px auto;padding:0 20px;line-height:1.55}"
            "button,a.button{display:inline-block;padding:10px 16px;border:1px solid #888;border-radius:8px;text-decoration:none}"
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
        parsed = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(parsed.query)
        try:
            if parsed.path == "/":
                self._registration_page()
            elif parsed.path == "/manifest-callback":
                self._manifest_callback(query)
            elif parsed.path == "/installed":
                self._installed(query)
            else:
                self._html("Not found", "<p>Unknown bootstrap path.</p>", HTTPStatus.NOT_FOUND)
        except (RuntimeError, KeyError, urllib.error.HTTPError, urllib.error.URLError) as exc:
            self._html(
                "Bootstrap blocked",
                f"<p>ForgeFlow refused to continue: <code>{html.escape(str(exc))}</code></p>",
                HTTPStatus.BAD_REQUEST,
            )

    def _registration_page(self) -> None:
        manifest = build_manifest(self.server.base_url)
        action = f"{GITHUB_REGISTER}?state={urllib.parse.quote(self.server.csrf_state, safe='')}"
        encoded = html.escape(json.dumps(manifest, separators=(",", ":")), quote=True)
        perms = "".join(
            f"<li><code>{html.escape(key)}</code>: {html.escape(value)}</li>"
            for key, value in sorted(PERMISSIONS.items())
        )
        body = f"""
        <p>This creates a <strong>private, dedicated</strong> GitHub App for ForgeFlow/Open SWE.</p>
        <p>Webhook delivery starts disabled. Repository access is chosen on the later install page.</p>
        <ul>{perms}</ul>
        <form action="{html.escape(action, quote=True)}" method="post">
          <input type="hidden" name="manifest" value="{encoded}">
          <button type="submit">Create ForgeFlow Open SWE GitHub App</button>
        </form>
        """
        self._html("ForgeFlow GitHub App bootstrap", body)

    def _manifest_callback(self, query: dict[str, list[str]]) -> None:
        state = query.get("state", [""])[0]
        code = query.get("code", [""])[0]
        if not secrets.compare_digest(state, self.server.csrf_state) or not code:
            raise RuntimeError("manifest callback state/code validation failed")
        app = exchange_manifest(code)
        write_pending_app(self.server.pending_path, app)
        slug = app.get("slug")
        if not isinstance(slug, str) or not slug:
            raise RuntimeError("GitHub manifest response omitted app slug")
        self.server.app_slug = slug
        install_url = f"https://github.com/apps/{urllib.parse.quote(slug, safe='-')}/installations/new"
        body = f"""
        <p>Registration succeeded. Credentials are held in a private pending file until repository installation is verified.</p>
        <p>Install the App on <strong>{OWNER}</strong>. Choose <strong>Only select repositories</strong> and select:</p>
        <ul><li><code>digital-biome</code></li><li><code>forgeflow</code></li></ul>
        <p><a class="button" href="{html.escape(install_url, quote=True)}">Install App on repositories</a></p>
        """
        self._html("GitHub App registered", body)

    def _installed(self, query: dict[str, list[str]]) -> None:
        raw = query.get("installation_id", [""])[0]
        if not raw.isdigit() or int(raw) <= 0:
            raise RuntimeError("installation callback did not provide a valid installation_id")
        app = read_pending_app(self.server.pending_path)
        observed, checks = finalize_installation(self.server.env_path, app, int(raw))
        self.server.pending_path.unlink(missing_ok=True)
        self.server.completed = True
        detail = "".join(f"<li><code>{html.escape(item)}</code></li>" for item in checks)
        body = (
            "<p>GitHub App installation verified for both required repositories.</p>"
            f"<p>Installation ID: <code>{int(raw)}</code>; repos verified: {html.escape(', '.join(observed))}</p>"
            f"<ul>{detail}</ul>"
            "<p>ForgeFlow policy service has been restarted with the new App credentials. "
            "The remaining gate is the isolated reviewer sandbox credential.</p>"
        )
        self._html("ForgeFlow GitHub App ready", body)
        threading.Timer(5, self.server.shutdown).start()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bind", required=True, help="Tailscale IPv4 address only")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument(
        "--env-file",
        default=str(Path.home() / ".config/forgeflow-policy/github-app.env"),
    )
    args = parser.parse_args()
    if not args.bind.startswith("100."):
        raise SystemExit("bootstrap must bind to a Tailscale 100.x address")
    server = BootstrapServer((args.bind, args.port), Path(args.env_file))
    print(f"bootstrap_url={server.base_url}/", flush=True)
    print("webhook_active=false", flush=True)
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        server.server_close()
    raise SystemExit(0 if server.completed else 2)


if __name__ == "__main__":
    main()
