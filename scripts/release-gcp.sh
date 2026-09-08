#!/usr/bin/env bash
set -euo pipefail

canonical_root="${FORGEFLOW_ROOT:-/home/dev/projects/forgeflow}"
release_ref="${FORGEFLOW_RELEASE_REF:-refs/forgeflow/release-approved}"
release_root="${FORGEFLOW_RELEASE_WORKTREE_ROOT:-/home/dev/projects/.forgeflow-release-worktrees}"
release_lock="${FORGEFLOW_RELEASE_LOCK:-/tmp/forgeflow-release.lock}"
service="${FORGEFLOW_SYSTEMD_SERVICE:-forgeflow.service}"
health_url="${FORGEFLOW_HEALTH_URL:-http://127.0.0.1:8420/api/health}"
db_file="${FORGEFLOW_DB:-/var/lib/forgeflow/forgeflow.sqlite}"
backup_dir="${FORGEFLOW_BACKUP_DIR:-/var/lib/forgeflow/backups}"
provenance_file="${FORGEFLOW_RELEASE_PROVENANCE_FILE:-/var/lib/forgeflow/release-provenance.json}"

exec 9>"$release_lock"
flock -n 9 || { echo "another ForgeFlow release is active" >&2; exit 1; }
[[ "$release_ref" == refs/forgeflow/* ]] || { echo "release ref must stay below refs/forgeflow" >&2; exit 1; }
approved_sha="$(git -C "$canonical_root" rev-parse --verify "${release_ref}^{commit}" 2>/dev/null || true)"
source_override="${FORGEFLOW_RELEASE_SOURCE_SHA:-}"
if [[ -n "$source_override" ]]; then
  [[ "$source_override" =~ ^[0-9a-f]{40}$ ]] || { echo "release source override must be an exact commit SHA" >&2; exit 1; }
  source_sha="$(git -C "$canonical_root" rev-parse "${source_override}^{commit}")"
  [[ "$source_sha" == "$source_override" ]] || { echo "release source override must resolve exactly" >&2; exit 1; }
  if [[ -n "$approved_sha" ]] && ! git -C "$canonical_root" merge-base --is-ancestor "$approved_sha" "$source_sha"; then
    echo "release source override must fast-forward the approved release" >&2
    exit 1
  fi
else
  [[ -n "$approved_sha" ]] || { echo "release approval ref is missing" >&2; exit 1; }
  source_sha="$approved_sha"
fi
advance_release_ref_on_success="${FORGEFLOW_ADVANCE_RELEASE_REF_ON_SUCCESS:-false}"
[[ "$advance_release_ref_on_success" == "true" || "$advance_release_ref_on_success" == "false" ]] || {
  echo "FORGEFLOW_ADVANCE_RELEASE_REF_ON_SUCCESS must be true or false" >&2
  exit 1
}
release_started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
git -C "$canonical_root" cat-file -e "${source_sha}^{commit}"
mkdir -p "$release_root"
git -C "$canonical_root" worktree prune --expire now
worktree="$release_root/${source_sha}-$$"
candidate=""
cleanup() {
  git -C "$canonical_root" worktree unlock -- "$worktree" >/dev/null 2>&1 || true
  git -C "$canonical_root" worktree remove --force -- "$worktree" >/dev/null 2>&1 || true
  git -C "$canonical_root" worktree prune --expire now >/dev/null 2>&1 || true
  if [[ -n "$candidate" && "$candidate" == "$canonical_root/.release-candidates/"* ]]; then
    rm -rf -- "$candidate"
  fi
}
trap cleanup EXIT INT TERM

git -C "$canonical_root" worktree add --detach "$worktree" "$source_sha"
[[ "$(git -C "$worktree" rev-parse HEAD)" == "$source_sha" ]]
[[ -z "$(git -C "$worktree" status --porcelain)" ]]
[[ -d "$canonical_root/node_modules" ]] || { echo "canonical node_modules missing" >&2; exit 1; }
ln -s "$canonical_root/node_modules" "$worktree/node_modules"

(cd "$worktree" && npm run check-types && npm test)
candidate="$canonical_root/.release-candidates/${source_sha}-$$"
rm -rf "$candidate"
mkdir -p "$(dirname "$candidate")"
# Build in the exact detached worktree, identical to the self-change canary. This
# keeps source-map paths and every emitted byte part of one reproducible artifact
# identity instead of compiling the same SHA into two different output roots.
(cd "$worktree" && npm run build)
test -s "$worktree/dist/main.js"
mkdir -p "$candidate"
cp -a "$worktree/dist/." "$candidate/"
test -s "$candidate/main.js"
artifact_sha256="$("$canonical_root/scripts/artifact-digest.sh" "$candidate")"
[[ "$artifact_sha256" =~ ^[0-9a-f]{64}$ ]] || { echo "invalid release artifact digest" >&2; exit 1; }
expected_artifact_sha256="${FORGEFLOW_EXPECTED_ARTIFACT_SHA256:-}"
if [[ -n "$expected_artifact_sha256" && "$artifact_sha256" != "$expected_artifact_sha256" ]]; then
  echo "release artifact digest does not match the approved canary" >&2
  exit 1
fi

sync_antigravity_runtime() {
  # Antigravity executes outside forgeflow.service. Keep its root-owned systemd
  # runner and mount sandbox byte-identical to this exact detached release SHA;
  # otherwise release provenance could claim a source revision while a stale
  # /usr/local/libexec helper actually executes provider work.
  if [[ ! -f /etc/systemd/system/forgeflow-antigravity@.service ]]; then
    return 0
  fi
  sudo install -d -o root -g root -m 0755 /usr/local/libexec
  sudo install -o root -g root -m 0755 \
    "$worktree/scripts/run-antigravity-unit.mjs" \
    /usr/local/libexec/forgeflow-antigravity-unit.mjs
  sudo install -o root -g root -m 0644 \
    "$worktree/scripts/forgeflow-antigravity-git-provenance.mjs" \
    /usr/local/libexec/forgeflow-antigravity-git-provenance.mjs
  sudo install -o root -g root -m 0755 \
    "$worktree/scripts/run-antigravity-sandbox.sh" \
    /usr/local/libexec/forgeflow-antigravity-sandbox.sh
  sudo install -o root -g root -m 0644 \
    "$worktree/deploy/gcp/forgeflow-antigravity@.service" \
    /etc/systemd/system/forgeflow-antigravity@.service
  cmp -s "$worktree/scripts/run-antigravity-unit.mjs" /usr/local/libexec/forgeflow-antigravity-unit.mjs || {
    echo "Antigravity unit helper drifted during release" >&2
    exit 1
  }
  cmp -s "$worktree/scripts/forgeflow-antigravity-git-provenance.mjs" /usr/local/libexec/forgeflow-antigravity-git-provenance.mjs || {
    echo "Antigravity Git provenance helper drifted during release" >&2
    exit 1
  }
  cmp -s "$worktree/scripts/run-antigravity-sandbox.sh" /usr/local/libexec/forgeflow-antigravity-sandbox.sh || {
    echo "Antigravity sandbox helper drifted during release" >&2
    exit 1
  }
  sudo systemctl daemon-reload
}

write_provenance() {
  local state="$1"
  local temp
  temp="$(mktemp)"
  /usr/bin/node --input-type=module - "$source_sha" "$artifact_sha256" "$state" "$release_started_at" <<'NODE' >"$temp"
const [sourceSha, artifactSha256, status, releasedAt] = process.argv.slice(2);
process.stdout.write(JSON.stringify({ version: 1, status, sourceSha, artifactSha256, releasedAt }) + '\n');
NODE
  sudo install -d -o root -g root -m 0711 "$(dirname "$provenance_file")"
  sudo install -o root -g root -m 0600 "$temp" "$provenance_file"
  rm -f "$temp"
}

if [[ -f "$db_file" ]]; then
  sudo install -d -o root -g root -m 0750 "$backup_dir"
  backup="$backup_dir/forgeflow-$(date -u +%Y%m%dT%H%M%SZ)-${source_sha:0:12}.sqlite"
  # Production state is deliberately root:root 0600. Release backup therefore crosses
  # that privilege boundary explicitly instead of weakening database permissions.
  sudo /usr/bin/node --input-type=module - "$db_file" "$backup" <<'NODE'
import { DatabaseSync, backup } from 'node:sqlite';
const [source, target] = process.argv.slice(2);
const db = new DatabaseSync(source, { readOnly: true });
try { await backup(db, target); } finally { db.close(); }
NODE
  sudo chown root:root "$backup"
  sudo chmod 0600 "$backup"
  sudo test -s "$backup"
fi

live="$canonical_root/dist"
if [[ -d "$live" ]]; then
  python3 "$worktree/scripts/atomic-exchange-directories.py" "$live" "$candidate"
  rm -rf "$candidate"
else
  mv "$candidate" "$live"
fi

sync_antigravity_runtime
write_provenance PENDING

if systemctl cat "$service" >/dev/null 2>&1; then
  sudo systemctl restart "$service"
  for _ in $(seq 1 45); do
    if payload="$(curl -fsS --max-time 2 "$health_url" 2>/dev/null)"; then
      HEALTH_JSON="$payload" SOURCE_SHA="$source_sha" ARTIFACT_SHA256="$artifact_sha256" node - <<'NODE'
const h=JSON.parse(process.env.HEALTH_JSON ?? '{}');
const p=h.releaseProvenance ?? {};
if (
  h.status !== 'ok' ||
  h.service !== 'forgeflow-control-plane' ||
  h.apiVersion !== 1 ||
  p.status !== 'PENDING' ||
  p.sourceSha !== process.env.SOURCE_SHA ||
  p.artifactSha256 !== process.env.ARTIFACT_SHA256
) process.exit(1);
NODE
      write_provenance HEALTHY
      verified="$(curl -fsS --max-time 2 "$health_url")"
      HEALTH_JSON="$verified" SOURCE_SHA="$source_sha" ARTIFACT_SHA256="$artifact_sha256" node - <<'NODE'
const h=JSON.parse(process.env.HEALTH_JSON ?? '{}');
const p=h.releaseProvenance ?? {};
if (
  h.status !== 'ok' ||
  h.service !== 'forgeflow-control-plane' ||
  h.apiVersion !== 1 ||
  p.status !== 'HEALTHY' ||
  p.sourceSha !== process.env.SOURCE_SHA ||
  p.artifactSha256 !== process.env.ARTIFACT_SHA256
) process.exit(1);
NODE
      if [[ "$advance_release_ref_on_success" == "true" && "$source_sha" != "${approved_sha:-}" ]]; then
        old_ref="${approved_sha:-0000000000000000000000000000000000000000}"
        git -C "$canonical_root" update-ref -m "ForgeFlow verified release promotion" "$release_ref" "$source_sha" "$old_ref"
      fi
      echo "ForgeFlow release healthy; source_sha=$source_sha artifact_sha256=$artifact_sha256"
      exit 0
    fi
    sleep 1
  done
  echo "ForgeFlow release health check failed" >&2
  exit 1
fi

echo "ForgeFlow artifact built and installed; service not installed, source_sha=$source_sha"
