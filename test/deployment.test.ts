import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8');
const service = read('deploy/gcp/forgeflow.service');
const installer = read('deploy/gcp/install.sh');
const compose = read('deploy/openhands/docker-compose.yml');
const release = read('scripts/release-gcp.sh');
const pin = read('scripts/pin-release-ref.sh');
const cache = read('scripts/prune-host-cache.sh');
const antigravityUnit = read('deploy/gcp/forgeflow-antigravity@.service');
const headless = read('openhands_tools/headless_review_acp.mjs');
const launcher = read('openhands_tools/harness_agent_launcher.sh');

test('ForgeFlow service is standalone, headless, and fail-closed around host writes', () => {
  assert.match(service, /Description=ForgeFlow Autonomous Software Engineering Control Plane/);
  assert.match(service, /WorkingDirectory=\/home\/dev\/projects\/forgeflow/);
  assert.match(service, /FORGEFLOW_PORT=8420/);
  assert.match(service, /FORGEFLOW_DB=\/var\/lib\/forgeflow\/forgeflow\.sqlite/);
  assert.match(service, /FORGEFLOW_RESOURCE_SELECTOR_ENABLED=true/);
  assert.match(service, /FORGEFLOW_SINGLE_ACTIVE_PLAN_ENABLED=true/);
  assert.match(service, /EnvironmentFile=\/etc\/forgeflow\/forgeflow\.env/);
  assert.match(service, /ProtectSystem=strict/);
  assert.match(service, /RestrictSUIDSGID=true/);
  assert.match(service, /ReadWritePaths=\/var\/lib\/forgeflow/);
  assert.doesNotMatch(service, /ReadWritePaths=\/home\/dev\/projects\s*$/m);
});

test('OpenHands execution plane uses ForgeFlow-only paths and no visualization surface', () => {
  assert.match(compose, /container_name: forgeflow-openhands/);
  assert.match(compose, /"18420"/);
  assert.match(compose, /\/var\/lib\/forgeflow\/workspaces:\/workspace/);
  assert.match(compose, /\/opt\/forgeflow-tools:ro/);
  assert.match(compose, /FORGEFLOW_CONTROL_PLANE_URL: http:\/\/127\.0\.0\.1:8420/);
  assert.match(compose, /cap_drop: \["ALL"\]/);
  assert.match(compose, /no-new-privileges:true/);
});

test('installer provisions only ForgeFlow state and refuses unconfigured autonomous execution', () => {
  assert.match(installer, /\/etc\/forgeflow/);
  assert.match(installer, /install -d -o 10001 -g 10001 -m 0750 \/var\/lib\/forgeflow\/openhands/);
  assert.match(installer, /install -d -o 10001 -g 10001 -m 0751 \/var\/lib\/forgeflow\/workspaces/);
  assert.match(installer, /\/var\/lib\/forgeflow\/workspaces\/forgeflow\/executions/);
  assert.match(installer, /configure FORGEFLOW_AUTOMATION_PROJECTS first/);
  assert.match(installer, /configure FORGEFLOW_REPOSITORY_WRITE_PATHS first/);
  assert.match(installer, /configure FORGEFLOW_OPENHANDS_TOKEN first/);
  assert.match(installer, /configure FORGEFLOW_LITELLM_BASE_URL first/);
  assert.match(installer, /configure FORGEFLOW_LITELLM_API_KEY first/);
  assert.match(installer, /apparmor_parser -r \/etc\/apparmor\.d\/forgeflow-openhands-codex/);
  assert.match(installer, /FORGEFLOW_OPENHANDS_CONTAINER=forgeflow-openhands FORGEFLOW_DSH_SEED_DIR=/);
  assert.match(installer, /ReadWritePaths=%s/);
  assert.match(installer, /systemctl enable --now forgeflow\.service forgeflow-host-cache\.timer/);
});

test('exact-SHA release is rooted in refs/forgeflow and validates v1 health', () => {
  assert.match(pin, /refs\/forgeflow\/release-approved/);
  assert.match(pin, /merge-base --is-ancestor/);
  assert.match(pin, /update-ref/);
  assert.match(release, /refs\/forgeflow\/release-approved/);
  assert.match(release, /worktree add --detach/);
  assert.match(release, /npm run check-types && npm test/);
  assert.match(release, /atomic-exchange-directories\.py/);
  assert.match(release, /h\.service !== 'forgeflow-control-plane'/);
  assert.match(release, /h\.apiVersion !== 1/);
});

test('host cache maintenance remains bounded and never prunes Docker volumes', () => {
  assert.match(cache, /FORGEFLOW_HOST_CACHE_TRIGGER_FREE_BYTES/);
  assert.match(cache, /\/api\/v1\/executions\?status=RUNNING/);
  assert.match(cache, /builder prune -af/);
  assert.match(cache, /image prune -af/);
  assert.doesNotMatch(cache, /volume prune|system prune/);
});

test('provider tools use the ForgeFlow execution/evidence contract', () => {
  assert.match(headless, /FORGEFLOW_HEADLESS_DRIVER/);
  assert.match(headless, /FORGEFLOW_IMPLEMENTATION_EVIDENCE_PATH/);
  assert.ok(headless.includes('workspace\\/forgeflow\\/plans'));
  assert.match(launcher, /FORGEFLOW_EXECUTION_ID/);
  assert.match(launcher, /FORGEFLOW_WORKSPACE_REF/);
  assert.match(launcher, /\/workspace\/forgeflow\/plans/);
  assert.match(antigravityUnit, /forgeflow-antigravity-unit\.mjs/);
});

test('checked-in deployment scripts are syntactically valid', () => {
  for (const file of [
    'deploy/gcp/install.sh',
    'scripts/pin-release-ref.sh',
    'scripts/release-gcp.sh',
    'scripts/prune-host-cache.sh',
    'scripts/build-openhands-source.sh',
    'scripts/install-openhands-tooling.sh',
    'scripts/run-antigravity-sandbox.sh',
    'scripts/verify-supervisor-provider.sh',
    'openhands_tools/harness_agent_launcher.sh',
  ]) execFileSync('bash', ['-n', path.join(root, file)]);
  for (const file of [
    'scripts/run-antigravity-unit.mjs',
    'openhands_tools/headless_review_acp.mjs',
  ]) execFileSync('node', ['--check', path.join(root, file)]);
});
