#!/usr/bin/env python3
"""Loopback-only bridge from Codex auth.json to Open SWE's OAuth provider."""

import hmac
import http.server
import json
import os
from pathlib import Path

STATE_DIR = Path(os.environ.get("FORGEFLOW_POLICY_STATE_DIR", Path.home() / ".local/share/forgeflow-policy"))
AUTH_FILE = Path(os.environ.get("OPEN_SWE_CODEX_AUTH_FILE", Path.home() / ".codex/auth.json"))
SECRET_FILE = STATE_DIR / "codex-broker.secret"
PORT = int(os.environ.get("OPEN_SWE_CODEX_BROKER_PORT", "58811"))


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, _format: str, *args: object) -> None:
        return

    def do_GET(self) -> None:
        if self.path != "/token":
            self.send_response(404)
            self.end_headers()
            return
        expected = "Bearer " + SECRET_FILE.read_text(encoding="utf-8").strip()
        supplied = self.headers.get("Authorization", "")
        if not hmac.compare_digest(supplied, expected):
            self.send_response(401)
            self.end_headers()
            return
        try:
            payload = json.loads(AUTH_FILE.read_text(encoding="utf-8"))
            tokens = payload["tokens"]
            response = {
                "access_token": tokens["access_token"],
                "account_id": tokens["account_id"],
            }
            body = json.dumps(response, separators=(",", ":")).encode()
        except (OSError, json.JSONDecodeError, KeyError, TypeError):
            self.send_response(500)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    if not SECRET_FILE.is_file():
        raise SystemExit(f"missing broker secret: {SECRET_FILE}")
    if not AUTH_FILE.is_file():
        raise SystemExit(f"missing Codex auth file: {AUTH_FILE}")
    server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    server.serve_forever()
