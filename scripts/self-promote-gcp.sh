#!/usr/bin/env bash
set -euo pipefail

canonical_root="${FORGEFLOW_ROOT:-/home/dev/projects/forgeflow}"
request_file="${FORGEFLOW_IMPROVEMENT_SELF_PROMOTION_REQUEST_FILE:-/var/lib/forgeflow/self-promotion-request.json}"
health_url="${FORGEFLOW_HEALTH_URL:-http://127.0.0.1:8420/api/health}"

[[ -f "$request_file" && ! -L "$request_file" ]] || {
  echo "self-promotion request is missing or unsafe" >&2
  exit 1
}
[[ "$(stat -c %s -- "$request_file")" -le 16384 ]] || {
  echo "self-promotion request is too large" >&2
  exit 1
}

mapfile -t fields < <(/usr/bin/node --input-type=module - "$request_file" <<'NODE'
import fs from 'node:fs';
const file = process.argv[2];
const value = JSON.parse(fs.readFileSync(file, 'utf8'));
const identity = /^[A-Za-z0-9._:-]{1,200}$/;
if (
  value.version !== 1 ||
  typeof value.candidateId !== 'string' || !identity.test(value.candidateId) ||
  typeof value.planId !== 'string' || !identity.test(value.planId) ||
  typeof value.sourceRevision !== 'string' || !/^[0-9a-f]{40}$/.test(value.sourceRevision) ||
  typeof value.artifactSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.artifactSha256) ||
  typeof value.canaryAttestationId !== 'string' || !identity.test(value.canaryAttestationId) ||
  typeof value.requestedAt !== 'string' || value.requestedAt.length > 64 || /[\u0000-\u001f\u007f]/.test(value.requestedAt) || !Number.isFinite(Date.parse(value.requestedAt))
) process.exit(2);
for (const field of [
  value.candidateId,
  value.planId,
  value.sourceRevision,
  value.artifactSha256,
  value.canaryAttestationId,
  value.requestedAt,
]) process.stdout.write(field + '\n');
NODE
)
[[ "${#fields[@]}" -eq 6 ]] || { echo "invalid self-promotion request" >&2; exit 1; }
candidate_id="${fields[0]}"
plan_id="${fields[1]}"
source_sha="${fields[2]}"
artifact_sha256="${fields[3]}"
canary_id="${fields[4]}"
requested_at="${fields[5]}"

# Authorization comes from the running control plane's non-secret health projection,
# never from forgeflow.env. This keeps provider/API credentials out of the release
# process while ensuring a stale request cannot promote after the operator disables
# the self-promotion gate.
health_payload="$(curl -fsS --max-time 5 "$health_url")" || {
  echo "ForgeFlow health is unavailable; refusing self-promotion" >&2
  exit 1
}
HEALTH_JSON="$health_payload" /usr/bin/node - <<'NODE' || {
const h=JSON.parse(process.env.HEALTH_JSON ?? '{}');
if (
  h.status !== 'ok' ||
  h.service !== 'forgeflow-control-plane' ||
  h.apiVersion !== 1 ||
  h.improvementRuntime?.selfPromotionEnabled !== true
) process.exit(1);
NODE
  echo "ForgeFlow live self-promotion gate is not enabled" >&2
  exit 1
}

# A replay after successful promotion is a no-op. The control plane will reconcile
# the durable request event against HEALTHY release provenance after its new boot.
if HEALTH_JSON="$health_payload" SOURCE_SHA="$source_sha" ARTIFACT_SHA256="$artifact_sha256" /usr/bin/node - <<'NODE'
const h=JSON.parse(process.env.HEALTH_JSON ?? '{}');
const p=h.releaseProvenance ?? {};
if (p.status !== 'HEALTHY' || p.sourceSha !== process.env.SOURCE_SHA || p.artifactSha256 !== process.env.ARTIFACT_SHA256) process.exit(1);
NODE
then
  rm -f -- "$request_file"
  echo "ForgeFlow self-promotion already healthy; candidate=$candidate_id plan=$plan_id source_sha=$source_sha canary=$canary_id requested_at=$requested_at"
  exit 0
fi

FORGEFLOW_RELEASE_SOURCE_SHA="$source_sha" \
FORGEFLOW_EXPECTED_ARTIFACT_SHA256="$artifact_sha256" \
FORGEFLOW_ADVANCE_RELEASE_REF_ON_SUCCESS=true \
  "$canonical_root/scripts/release-gcp.sh"

# release-gcp.sh already verifies the restarted process and HEALTHY provenance.
# Remove only the filesystem trigger; the durable request event remains in SQLite
# so the new process can prove which Candidate/Plan/canary caused this release.
rm -f -- "$request_file"
echo "ForgeFlow self-promotion healthy; candidate=$candidate_id plan=$plan_id source_sha=$source_sha canary=$canary_id"
