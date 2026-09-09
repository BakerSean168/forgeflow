# Open SWE GitHub App for ForgeFlow Policy

ForgeFlow does not keep a second GitHub credential store. Exact-head PR/CI evidence and the
**official Open SWE Reviewer** use the upstream Open SWE GitHub App authentication path.

The GCP Dev deployment is intentionally fail-closed: if the App is not configured, a new
ForgeFlow objective escalates with `GITHUB_APP_NOT_CONFIGURED` before spending an implementation
model call. If credentials exist but the App cannot access the target repository with the required
scopes, the objective remains `NEW` with `GITHUB_APP_REPO_OR_PERMISSION_UNAVAILABLE` and can
recover after the installation is fixed.

## Create a dedicated App

Do not reuse the MemoFlow App. Create a separate GitHub App for this Open SWE deployment and
install it only on repositories ForgeFlow may operate on. ForgeFlow Policy V1 also requires the target repository to resolve to the exact configured `GITHUB_APP_INSTALLATION_ID`; it will not fall across multiple installations.

Use the pinned Open SWE permission contract:

- Repository permissions:
  - Contents: Read & write
  - Pull requests: Read & write
  - Issues: Read & write
  - Checks: Read & write
  - Commit statuses: Read-only
  - Actions: Read-only (write only if `/baby-sit` reruns are deliberately enabled)
  - Workflows: Read & write
  - Metadata: Read-only
- Organization permissions:
  - Members: Read-only when organization-membership gating is enabled
- Events:
  - Issue comment
  - Pull request review
  - Pull request review comment
  - Check run
  - Check suite
  - Workflow run
  - Status (for legacy status integrations)

For the full Open SWE dashboard/webhook surface, configure callback URL
`<deployment-url>/dashboard/api/auth/callback` and webhook URL `<deployment-url>/webhooks/github`.
The current GCP Dev service is loopback-only, so inbound webhooks require a separately secured
tunnel/reverse proxy; ForgeFlow's direct review dispatch does not require a public webhook.

## One-time Tailscale manifest bootstrap

On GCP Dev, the preferred setup path is the one-time manifest bootstrap. It binds only to the
server's Tailscale IPv4 address, keeps webhook delivery disabled during local Policy V1
acceptance, and writes manifest-conversion credentials directly to the external `0600` env file.
No PEM, client secret, or webhook secret is printed to the terminal or browser.

```bash
uv run python deploy/gcp-dev/github_app_manifest_bootstrap.py \
  --bind "$(tailscale ip -4)" --port 8765
```

Open the printed Tailscale URL from a browser on the same tailnet. GitHub still requires the human
owner to approve App creation and installation. On the installation page choose **Only select
repositories** and select exactly `digital-biome` and `forgeflow`. The install callback verifies
both repositories resolve to the same installation before persisting
`GITHUB_APP_INSTALLATION_ID`; failed verification leaves ForgeFlow fail-closed.

The manifest uses GitHub's official three-step flow: browser registration, state-checked redirect,
and server-side `POST /app-manifests/{code}/conversions`. The bootstrap exits after successful
installation and restarts `forgeflow-policy.service` so Open SWE reloads the App credentials.

## Configure GCP Dev

Create `~/.config/forgeflow-policy/github-app.env` with mode `0600`, using
`deploy/gcp-dev/github-app.env.example` as the key-name template. Never commit that file.

Then verify one repository without printing credentials or tokens:

```bash
./deploy/gcp-dev/check-github-app.sh BakerSean168/digital-biome
```

Expected result:

```json
{"installation_id":123456,"repository":"BakerSean168/digital-biome","status":"READY"}
```

After changing the env file, restart `forgeflow-policy.service`; Open SWE reads App credentials at
process import time.


## Required-check policy

ForgeFlow extends the same `OPEN_SWE_LOCAL_PROJECTS_FILE` entries Open SWE already uses. It does
not maintain a second project database. Each governed repository that requires CI must declare
`repo`, `ci_required`, and an explicit non-empty `required_checks` list. Missing required-check
policy escalates before the first implementation model call.
