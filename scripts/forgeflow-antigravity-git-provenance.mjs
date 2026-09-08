import fs from 'node:fs';
import path from 'node:path';

export class AntigravityGitProvenanceError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
    this.name = 'AntigravityGitProvenanceError';
  }
}

function reject(code) {
  throw new AntigravityGitProvenanceError(code);
}

function inside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function safeWorktreeAdminName(value) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,240}$/.test(value);
}

function safeFile(file, code) {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.isSymbolicLink()) reject(code);
  return stat;
}

function safeDirectory(directory, code) {
  const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!stat?.isDirectory() || stat.isSymbolicLink()) reject(code);
  return stat;
}

function parseAbsoluteGitdir(file, code) {
  safeFile(file, code);
  const match = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(fs.readFileSync(file, 'utf8'));
  if (!match || !path.isAbsolute(match[1])) reject(code);
  return path.resolve(match[1]);
}

/**
 * Resolve the repository's authoritative Git common directory without invoking Git.
 *
 * A canonical checkout may be either a normal repository whose `.git` entry is a
 * directory, or a linked worktree whose `.git` entry is a gitfile. Linked worktrees
 * are accepted only when the source gitfile, admin directory, admin `gitdir`
 * backlink, and `commondir` form one closed provenance chain under
 * `<common>/.git/worktrees/<id>`.
 */
export function resolveSourceCommonGitDir(sourceRepositoryInput) {
  const sourceRepository = path.resolve(String(sourceRepositoryInput ?? ''));
  safeDirectory(sourceRepository, 'ANTIGRAVITY_UNIT_SOURCE_REPOSITORY_INVALID');
  if (fs.realpathSync(sourceRepository) !== sourceRepository)
    reject('ANTIGRAVITY_UNIT_SOURCE_REPOSITORY_INVALID');

  const sourceGitEntry = path.join(sourceRepository, '.git');
  const entryStat = fs.lstatSync(sourceGitEntry, { throwIfNoEntry: false });
  if (entryStat?.isDirectory() && !entryStat.isSymbolicLink())
    return fs.realpathSync(sourceGitEntry);
  if (!entryStat?.isFile() || entryStat.isSymbolicLink())
    reject('ANTIGRAVITY_UNIT_SOURCE_GIT_INVALID');

  const admin = parseAbsoluteGitdir(sourceGitEntry, 'ANTIGRAVITY_UNIT_SOURCE_GITFILE_INVALID');
  safeDirectory(admin, 'ANTIGRAVITY_UNIT_SOURCE_GITDIR_INVALID');

  const backlinkFile = path.join(admin, 'gitdir');
  safeFile(backlinkFile, 'ANTIGRAVITY_UNIT_SOURCE_GITDIR_INVALID');
  const backlink = fs.readFileSync(backlinkFile, 'utf8').trim();
  if (!backlink || !path.isAbsolute(backlink) || path.resolve(backlink) !== sourceGitEntry)
    reject('ANTIGRAVITY_UNIT_SOURCE_GITDIR_INVALID');

  const commondirFile = path.join(admin, 'commondir');
  safeFile(commondirFile, 'ANTIGRAVITY_UNIT_SOURCE_COMMONDIR_INVALID');
  const commondir = fs.readFileSync(commondirFile, 'utf8').trim();
  if (!commondir) reject('ANTIGRAVITY_UNIT_SOURCE_COMMONDIR_INVALID');
  let common;
  try {
    common = fs.realpathSync(path.resolve(admin, commondir));
  } catch {
    reject('ANTIGRAVITY_UNIT_SOURCE_COMMONDIR_INVALID');
  }
  safeDirectory(common, 'ANTIGRAVITY_UNIT_SOURCE_COMMONDIR_INVALID');

  const relativeAdmin = path.relative(common, admin).split(path.sep).filter(Boolean);
  if (
    !inside(admin, common) ||
    relativeAdmin.length !== 2 ||
    relativeAdmin[0] !== 'worktrees' ||
    !safeWorktreeAdminName(relativeAdmin[1])
  )
    reject('ANTIGRAVITY_UNIT_SOURCE_GITDIR_INVALID');

  return common;
}
