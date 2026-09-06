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
const selfPromoteUnit = read('deploy/gcp/forgeflow-self-promote.service');
const selfPromotePath = read('deploy/gcp/forgeflow-self-promote.path');
const selfPromoteScript = read('scripts/self-promote-gcp.sh');
const artifactDigest = read('scripts/artifact-digest.sh');
const headless = read('openhands_tools/headless_review_acp.mjs');
const launcher = read('openhands_tools/harness_agent_launcher.sh');
const forgeFlowEnv = read('deploy/forgeflow.env.example');
const planWorktrees = read('src/core/adapters/planWorktrees.ts');

test('ForgeFlow service is standalone, headless, and fail-closed around host writes', () => {
  assert.match(service, /Description=ForgeFlow Autonomous Software Engineering Control Plane/);
  assert.match(service, /WorkingDirectory=\/home\/dev\/projects\/forgeflow/);
  assert.match(service, /UMask=0077/);
  assert.match(service, /FORGEFLOW_PORT=8420/);
  assert.match(service, /FORGEFLOW_DB=\/var\/lib\/forgeflow\/forgeflow\.sqlite/);
  assert.match(service, /FORGEFLOW_RESOURCE_SELECTOR_ENABLED=true/);
  assert.match(service, /FORGEFLOW_SINGLE_ACTIVE_PLAN_ENABLED=true/);
  assert.match(service, /EnvironmentFile=\/etc\/forgeflow\/forgeflow\.env/);
  assert.match(service, /TimeoutStopSec=120/);
  assert.match(service, /ProtectSystem=strict/);
  assert.match(service, /RestrictSUIDSGID=true/);
  assert.match(service, /ReadWritePaths=\/var\/lib\/forgeflow/);
  assert.doesNotMatch(service, /ReadWritePaths=\/home\/dev\/projects\s*$/m);
});

test('Supervisor deployment uses governed bounded resource selection rather than a static model alias', () => {
  assert.match(service, /FORGEFLOW_SUPERVISOR_RUNTIME_ENABLED=true/);
  assert.match(forgeFlowEnv, /FORGEFLOW_SUPERVISOR_MAX_RESOURCE_ATTEMPTS=3/);
  assert.match(forgeFlowEnv, /FORGEFLOW_SUPERVISOR_ADMISSION_TTL_MS=900000/);
  assert.match(forgeFlowEnv, /FORGEFLOW_SUPERVISOR_ADMISSION_FAILURE_TTL_MS=300000/);
  assert.match(forgeFlowEnv, /FORGEFLOW_SUPERVISOR_ADMISSION_TIMEOUT_MS=30000/);
  assert.doesNotMatch(forgeFlowEnv, /FORGEFLOW_SUPERVISOR_MODEL=/);
  assert.doesNotMatch(forgeFlowEnv, /FORGEFLOW_SUPERVISOR_ENDPOINT=/);
});

test('Improvement deployment is opt-in and self-change is disabled by default', () => {
  assert.match(forgeFlowEnv, /FORGEFLOW_IMPROVEMENT_DISCOVERY_ENABLED=false/);
  assert.match(forgeFlowEnv, /FORGEFLOW_IMPROVEMENT_ADOPTION_ENABLED=false/);
  assert.match(forgeFlowEnv, /FORGEFLOW_IMPROVEMENT_AUTO_ADOPT_LOW_RISK=false/);
  assert.match(forgeFlowEnv, /FORGEFLOW_IMPROVEMENT_PROJECTS=\n/);
  assert.match(forgeFlowEnv, /FORGEFLOW_IMPROVEMENT_AI_DIAGNOSIS_ENABLED=false/);
  assert.match(forgeFlowEnv, /FORGEFLOW_IMPROVEMENT_AI_DIAGNOSIS_MAX_PER_CYCLE=2/);
  assert.match(forgeFlowEnv, /FORGEFLOW_IMPROVEMENT_AI_DIAGNOSIS_MAX_RESOURCE_ATTEMPTS=3/);
  assert.match(forgeFlowEnv, /FORGEFLOW_IMPROVEMENT_AI_DIAGNOSIS_TIMEOUT_MS=60000/);
  assert.doesNotMatch(forgeFlowEnv, /FORGEFLOW_IMPROVEMENT_AI_DIAGNOSIS_MODEL=/);
  assert.match(forgeFlowEnv, /FORGEFLOW_IMPROVEMENT_SELF_CHANGE_ENABLED=false/);
  assert.match(forgeFlowEnv, /FORGEFLOW_IMPROVEMENT_SELF_PROMOTION_ENABLED=false/);
  assert.match(forgeFlowEnv, /FORGEFLOW_IMPROVEMENT_SELF_AUTO_PROMOTION_ENABLED=false/);
  assert.match(forgeFlowEnv, /FORGEFLOW_IMPROVEMENT_SELF_PROJECT_KEY=forgeflow/);
  assert.match(
    forgeFlowEnv,
    /FORGEFLOW_IMPROVEMENT_SELF_REPOSITORY=\/home\/dev\/projects\/forgeflow/,
  );
  assert.match(forgeFlowEnv, /FORGEFLOW_IMPROVEMENT_SELF_CANARY_ROOT=\/var\/lib\/forgeflow\/self-canary/);
  assert.match(forgeFlowEnv, /FORGEFLOW_IMPROVEMENT_SELF_CANARY_TIMEOUT_MS=900000/);
  assert.match(forgeFlowEnv, /FORGEFLOW_IMPROVEMENT_SELF_PROMOTION_REQUEST_FILE=\/var\/lib\/forgeflow\/self-promotion-request\.json/);
  assert.match(forgeFlowEnv, /FORGEFLOW_IMPROVEMENT_CYCLE_MS=30000/);
  assert.doesNotMatch(forgeFlowEnv, /FORGEFLOW_IMPROVEMENT_SELF_CHANGE_ENABLED=true/);
  assert.doesNotMatch(forgeFlowEnv, /FORGEFLOW_IMPROVEMENT_SELF_PROMOTION_ENABLED=true/);
  assert.doesNotMatch(forgeFlowEnv, /FORGEFLOW_IMPROVEMENT_SELF_AUTO_PROMOTION_ENABLED=true/);
  assert.doesNotMatch(forgeFlowEnv, /FORGEFLOW_IMPROVEMENT_AI_DIAGNOSIS_ENABLED=true/);
  assert.doesNotMatch(forgeFlowEnv, /FORGEFLOW_IMPROVEMENT_AUTO_ADOPT_LOW_RISK=true/);
});

test('OpenHands execution plane uses ForgeFlow-only paths and no visualization surface', () => {
  assert.match(compose, /container_name: forgeflow-openhands/);
  assert.match(compose, /dns:\s*\n\s*- 100\.100\.100\.100/);
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
  assert.match(installer, /LiteLLM admin API preflight failed: \/model\/info HTTP/);
  assert.match(installer, /-m 0711 \/var\/lib\/forgeflow/);
  assert.match(installer, /apparmor_parser -r \/etc\/apparmor\.d\/forgeflow-openhands-codex/);
  assert.match(installer, /FORGEFLOW_OPENHANDS_CONTAINER=forgeflow-openhands FORGEFLOW_DSH_SEED_DIR=/);
  assert.match(installer, /ReadWritePaths=%s/);
  assert.match(installer, /forgeflow-self-promote\.service/);
  assert.match(installer, /forgeflow-self-promote\.path/);
  assert.match(installer, /forgeflow-self-promote\.sh/);
  assert.match(installer, /artifact-digest\.sh/);
  assert.doesNotMatch(installer, /self-promotion\.env/);
  assert.match(installer, /systemctl enable forgeflow\.service forgeflow-host-cache\.timer forgeflow-self-promote\.path/);
  assert.match(installer, /systemctl restart forgeflow\.service/);
  assert.match(installer, /systemctl restart forgeflow-host-cache\.timer/);
  assert.match(installer, /systemctl restart forgeflow-self-promote\.path/);
});

test('exact-SHA release is rooted in refs/forgeflow and validates v1 health', () => {
  assert.match(pin, /refs\/forgeflow\/release-approved/);
  assert.match(pin, /merge-base --is-ancestor/);
  assert.match(pin, /update-ref/);
  assert.match(release, /refs\/forgeflow\/release-approved/);
  assert.match(release, /worktree add --detach/);
  assert.match(release, /npm run check-types && npm test/);
  assert.match(release, /atomic-exchange-directories\.py/);
  assert.match(release, /sudo \/usr\/bin\/node --input-type=module/);
  assert.match(release, /new DatabaseSync\(source, \{ readOnly: true \}\)/);
  assert.match(release, /sudo chmod 0600 \"\$backup\"/);
  assert.match(release, /candidate.*release-candidates/);
  assert.match(release, /artifact-digest\.sh/);
  assert.match(release, /FORGEFLOW_EXPECTED_ARTIFACT_SHA256/);
  assert.match(release, /FORGEFLOW_RELEASE_SOURCE_SHA/);
  assert.match(release, /FORGEFLOW_ADVANCE_RELEASE_REF_ON_SUCCESS/);
  assert.match(release, /release source override must fast-forward the approved release/);
  assert.match(release, /release artifact digest does not match the approved canary/);
  assert.match(release, /ForgeFlow verified release promotion/);
  assert.match(release, /FORGEFLOW_RELEASE_PROVENANCE_FILE/);
  assert.match(release, /sudo install -o root -g root -m 0600 .*provenance_file/);
  assert.ok(
    release.indexOf('atomic-exchange-directories.py') < release.indexOf('write_provenance PENDING'),
  );
  assert.match(release, /p\.status !== 'PENDING'/);
  assert.match(release, /p\.sourceSha !== process\.env\.SOURCE_SHA/);
  assert.match(release, /p\.artifactSha256 !== process\.env\.ARTIFACT_SHA256/);
  assert.ok(release.indexOf('write_provenance PENDING') < release.indexOf('write_provenance HEALTHY'));
  assert.match(release, /p\.status !== 'HEALTHY'/);
  assert.match(release, /h\.service !== 'forgeflow-control-plane'/);
  assert.match(release, /h\.apiVersion !== 1/);
  assert.match(forgeFlowEnv, /FORGEFLOW_RELEASE_PROVENANCE_FILE=\/var\/lib\/forgeflow\/release-provenance\.json/);
});

test('self-promotion runs outside the control-plane cgroup and is exact-canary gated', () => {
  assert.match(selfPromoteUnit, /Type=oneshot/);
  assert.match(selfPromoteUnit, /UMask=0077/);
  assert.doesNotMatch(selfPromoteUnit, /EnvironmentFile=/);
  assert.match(selfPromoteUnit, /FORGEFLOW_HEALTH_URL=http:\/\/127\.0\.0\.1:8420\/api\/health/);
  assert.match(selfPromoteUnit, /ExecStart=\/usr\/local\/libexec\/forgeflow-self-promote\.sh/);
  assert.match(selfPromoteUnit, /TimeoutStartSec=30min/);
  assert.match(selfPromoteUnit, /Restart=on-failure/);
  assert.match(selfPromoteUnit, /StartLimitBurst=3/);
  assert.match(selfPromotePath, /PathChanged=\/var\/lib\/forgeflow\/self-promotion-request\.json/);
  assert.match(selfPromotePath, /Unit=forgeflow-self-promote\.service/);
  assert.match(selfPromoteScript, /improvementRuntime\?\.selfPromotionEnabled !== true/);
  assert.match(selfPromoteScript, /never from forgeflow\.env/);
  assert.doesNotMatch(selfPromoteScript, /FORGEFLOW_IMPROVEMENT_SELF_PROMOTION_ENABLED/);
  assert.doesNotMatch(selfPromoteScript, /pin-release-ref\.sh/);
  assert.match(selfPromoteScript, /FORGEFLOW_RELEASE_SOURCE_SHA/);
  assert.match(selfPromoteScript, /FORGEFLOW_EXPECTED_ARTIFACT_SHA256/);
  assert.match(selfPromoteScript, /FORGEFLOW_ADVANCE_RELEASE_REF_ON_SUCCESS=true/);
  assert.match(selfPromoteScript, /release-gcp\.sh/);
  assert.match(selfPromoteScript, /rm -f -- \"\$request_file\"/);
  assert.match(artifactDigest, /find \. -type f -print0 \| sort -z \| xargs -0 sha256sum/);
});

test('literal worktree Git object access is read-minimized and revoked after Plan cleanup', () => {
  assert.match(planWorktrees, /grantObjectStoreAcl\(objects, uid\)/);
  assert.match(planWorktrees, /\['-R', '-m', `u:\$\{uid\}:rX`, '--', objects\]/);
  assert.match(planWorktrees, /grantDirectoryAcl\(directories, uid, true\)/);
  assert.match(planWorktrees, /revokeObjectStoreAcl\(path\.join\(common, 'objects'\), uid\)/);
  assert.match(planWorktrees, /\['-R', '-x', `u:\$\{uid\}`, '--', objects\]/);
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
  assert.match(launcher, /exec \"\$DSH_BIN\" --profile acp/);
  assert.doesNotMatch(launcher, /exec .*dsh-acp-server/);
  assert.match(antigravityUnit, /forgeflow-antigravity-unit\.mjs/);
});

test('checked-in deployment scripts are syntactically valid', () => {
  for (const file of [
    'deploy/gcp/install.sh',
    'scripts/pin-release-ref.sh',
    'scripts/release-gcp.sh',
    'scripts/artifact-digest.sh',
    'scripts/self-promote-gcp.sh',
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
