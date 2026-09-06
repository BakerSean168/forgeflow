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
source_sha="$(git -C "$canonical_root" rev-parse "${release_ref}^{commit}")"
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
(cd "$worktree" && npm exec -- tsc -p tsconfig.json --outDir "$candidate")
test -s "$candidate/main.js"
artifact_sha256="$(cd "$candidate" && find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | awk '{print $1}')"
[[ "$artifact_sha256" =~ ^[0-9a-f]{64}$ ]] || { echo "invalid release artifact digest" >&2; exit 1; }

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
      echo "ForgeFlow release healthy; source_sha=$source_sha artifact_sha256=$artifact_sha256"
      exit 0
    fi
    sleep 1
  done
  echo "ForgeFlow release health check failed" >&2
  exit 1
fi

echo "ForgeFlow artifact built and installed; service not installed, source_sha=$source_sha"
