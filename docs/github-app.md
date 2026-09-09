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
install it only on repositories ForgeFlow may operate on.

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
