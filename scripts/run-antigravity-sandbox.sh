#!/bin/bash
set -euo pipefail

workspace_root=''
workspace=''
source_git_dir=''
home=''
binary=''
uid=''
gid=''
auth_uid=''
auth_gid=''
workspace_gid=''
user=''
read_only_workspace=false

while (($#)); do
  case "$1" in
    --workspace-root) workspace_root="$2"; shift 2 ;;
    --workspace) workspace="$2"; shift 2 ;;
    --source-git-dir) source_git_dir="$2"; shift 2 ;;
    --home) home="$2"; shift 2 ;;
    --binary) binary="$2"; shift 2 ;;
    --uid) uid="$2"; shift 2 ;;
    --gid) gid="$2"; shift 2 ;;
    --auth-uid) auth_uid="$2"; shift 2 ;;
    --auth-gid) auth_gid="$2"; shift 2 ;;
    --workspace-gid) workspace_gid="$2"; shift 2 ;;
    --user) user="$2"; shift 2 ;;
    --read-only-workspace) read_only_workspace=true; shift ;;
    --) shift; break ;;
    *) echo "unknown sandbox argument: $1" >&2; exit 64 ;;
  esac
done

for value in workspace_root workspace source_git_dir home binary uid gid auth_uid auth_gid workspace_gid user; do
  if [[ -z ${!value} ]]; then
    echo "missing sandbox argument: $value" >&2
    exit 64
  fi
done
if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo 'Antigravity mount sandbox requires root setup before dropping privileges' >&2
  exit 77
fi

workspace_root="$(realpath -e "$workspace_root")"
workspace="$(realpath -e "$workspace")"
home="$(realpath -e "$home")"
binary="$(realpath -e "$binary")"
source_git_dir="$(realpath -e "$source_git_dir")"
case "$source_git_dir" in
  "$home"/*/.git) ;;
  *) echo 'source Git metadata escapes Antigravity home scope' >&2; exit 71 ;;
esac
if [[ ! -d "$source_git_dir" || -L "$source_git_dir" ]]; then
  echo 'source Git metadata is not a safe directory' >&2
  exit 72
fi
case "$workspace" in
  "$workspace_root"/*) ;;
  *) echo 'workspace escapes configured workspace root' >&2; exit 65 ;;
esac

auth="$home/.gemini/antigravity-cli"
if [[ ! -d "$auth" ]]; then
  echo 'Antigravity auth directory is missing' >&2
  exit 66
fi

stash="$(mktemp -d /run/forgeflow-antigravity.XXXXXX)"
mkdir -p "$stash/workspace" "$stash/auth" "$stash/source-git"
touch "$stash/agy"
mount --bind "$workspace" "$stash/workspace"
mount --bind "$source_git_dir" "$stash/source-git"

# Build a private writable Antigravity state from the minimum consumer-auth files.
# The host credential directory is never mounted into the agent namespace, so token
# refreshes/conversation caches can mutate only this short-lived tmpfs copy.
mount -t tmpfs -o "mode=0700,uid=$uid,gid=$gid,size=64m" tmpfs "$stash/auth"
auth_files=(
  antigravity-oauth-token
  installation_id
  jetski_state.pbtxt
  settings.json
  cache/default_project_id.txt
  cache/onboarding.json
)
for rel in "${auth_files[@]}"; do
  src="$auth/$rel"
  [[ -e "$src" ]] || continue
  if [[ -L "$src" || ! -f "$src" ]]; then
    echo "unsupported Antigravity auth state file: $rel" >&2
    exit 67
  fi
  if [[ $(stat -c '%u:%g' "$src") != "$auth_uid:$auth_gid" ]]; then
    echo "Antigravity auth state owner mismatch: $rel" >&2
    exit 68
  fi
  mkdir -p "$stash/auth/$(dirname "$rel")"
  cp -p -- "$src" "$stash/auth/$rel"
done
if [[ ! -f "$stash/auth/antigravity-oauth-token" ]]; then
  echo 'Antigravity OAuth token is missing' >&2
  exit 69
fi
chown -R "$uid:$gid" "$stash/auth"
mount --bind "$binary" "$stash/agy"

# Hide every home directory, then restore only the private Antigravity state copy
# and the CLI binary. The agent cannot browse the operator's projects, SSH config,
# cloud credentials, prior Antigravity conversations, or unrelated personal files.
mount -t tmpfs -o mode=0755 tmpfs /home
mkdir -p "$home/.gemini/antigravity-cli" "$home/.local/bin"
touch "$home/.local/bin/agy"
chown "$uid:$gid" "$home" "$home/.gemini" "$home/.local" "$home/.local/bin"
mount --bind "$stash/auth" "$home/.gemini/antigravity-cli"
mount --bind "$stash/agy" "$home/.local/bin/agy"
mount -o remount,bind,ro "$home/.local/bin/agy"
# Restore only the exact execution repository's Git metadata. The source working tree
# remains hidden with the rest of /home. REVIEW gets a kernel-enforced read-only mount;
# IMPLEMENT uses ForgeFlow's scoped worker ACLs for its exact admin/ref and object creation.
mkdir -p "$source_git_dir"
mount --bind "$stash/source-git" "$source_git_dir"
if [[ "$read_only_workspace" == true ]]; then
  mount -o remount,bind,ro "$source_git_dir"
else
  # systemd ProtectHome=read-only makes the source Git metadata mount read-only before
  # this private namespace is created. Re-enable writes only on this exact rebound
  # repository metadata mount. Existing ForgeFlow ACLs still restrict the worker UID
  # to its worktree admin area, Plan ref/log namespace, and object creation paths.
  mount -o remount,bind,rw "$source_git_dir"
fi

# Hide every other ForgeFlow workspace. Re-bind exactly one execution workspace at
# the same absolute path so tools that honor cwd cannot escape into sibling runs.
workspace_relative="${workspace#"$workspace_root"/}"
mount -t tmpfs -o mode=0755 tmpfs "$workspace_root"
mkdir -p "$(dirname "$workspace_root/$workspace_relative")" "$workspace_root/$workspace_relative"
mount --bind "$stash/workspace" "$workspace_root/$workspace_relative"
if [[ "$read_only_workspace" == true ]]; then
  # REVIEW is enforced read-only by the kernel, not only by prompt or POSIX owner bits.
  mount -o remount,bind,ro "$workspace_root/$workspace_relative"
fi
# The process entered this mount namespace with cwd pointing at the pre-overmount
# workspace dentry. Re-enter the rebound path explicitly so relative `..` traversal
# cannot retain a reference into the hidden host workspace tree.
cd "$workspace_root/$workspace_relative"

# Give tool subprocesses disposable scratch without exposing host /tmp. During
# local smoke tests the workspace root can itself live under /tmp, in which case
# masking /tmp would also hide the rebound workspace and is intentionally skipped.
case "$workspace_root" in
  /tmp/*) ;;
  *) mount -t tmpfs -o mode=1777 tmpfs /tmp ;;
esac

# Drop the alternate stash paths after the destination bind mounts are established.
umount "$stash/workspace"
umount "$stash/auth"
umount "$stash/agy"
umount "$stash/source-git"
rmdir "$stash/workspace" "$stash/auth"
rmdir "$stash/source-git"
rm -f "$stash/agy"
rmdir "$stash"

export HOME="$home"
export USER="$user"
export LOGNAME="$user"
# The literal worktree root intentionally remains source-owned. Trust only this exact
# rebound workspace instead of weakening Git ownership checks globally.
export GIT_CONFIG_KEY_0=safe.directory
export GIT_CONFIG_VALUE_0="$workspace"
if [[ "$read_only_workspace" == true ]]; then
  # Read-only review Git commands must never refresh/write the linked-worktree index.
  export GIT_CONFIG_COUNT=1
  export GIT_OPTIONAL_LOCKS=0
else
  # Provider-native implementation may create commits, but it must not auto-pack or
  # maintenance-rewrite the shared object database behind the literal worktree.
  export GIT_CONFIG_COUNT=3
  export GIT_CONFIG_KEY_1=gc.auto
  export GIT_CONFIG_VALUE_1=0
  export GIT_CONFIG_KEY_2=maintenance.auto
  export GIT_CONFIG_VALUE_2=false
fi
# Keep native-agent output writable by the OpenHands execution group.
umask 0002
exec /usr/bin/setpriv \
  --reuid="$uid" \
  --regid="$workspace_gid" \
  --clear-groups \
  --bounding-set=-all \
  --inh-caps=-all \
  --ambient-caps=-all \
  --no-new-privs \
  -- "$home/.local/bin/agy" "$@"
