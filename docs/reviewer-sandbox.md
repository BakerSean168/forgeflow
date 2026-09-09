# Isolated reviewer sandbox

ForgeFlow Policy V1 never permits the Open SWE official reviewer to use
`SANDBOX_TYPE=local`. A local sandbox executes model-controlled commands under
the same Unix principal as the Open SWE service and is therefore not a secret
boundary.

The GCP Dev default is `langsmith`, matching pinned Open SWE's most complete
sandbox integration. Credentials stay outside the repository in
`~/.config/forgeflow-policy/sandbox.env` with mode `0600`; the service startup
script sources that file before applying the default provider.

## One-time Tailscale bootstrap

Run the bootstrap only on GCP Dev:

```bash
uv run python deploy/gcp-dev/langsmith_sandbox_bootstrap.py \
  --bind "$(tailscale ip -4)" --port 8766
```

Open the printed Tailscale URL from a browser on the same tailnet. Create a
LangSmith API key under **Settings → API Keys** and paste it into the private
bootstrap page. Do not paste the key into chat, a Git issue, or a repository
file.

Before persisting the key the bootstrap performs a real provider smoke:

1. create one ephemeral LangSmith sandbox;
2. execute `printf forgeflow-sandbox-ok` inside it;
3. delete the sandbox;
4. atomically write `sandbox.env` with mode `0600`;
5. restart `forgeflow-policy.service`.

If create, execute, or validation fails, the key is not persisted and ForgeFlow
continues to fail closed with `REVIEWER_SANDBOX_UNAVAILABLE`.

## Manual fallback

Use `deploy/gcp-dev/sandbox.env.example` as the key-name template. After editing
the external env file, restart `forgeflow-policy.service`. Never switch the
production policy service to `local`; use one of the isolated providers already
supported by the pinned Open SWE revision.
