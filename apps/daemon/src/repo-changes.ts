import { execFile as execFileCallback } from 'node:child_process';

import type {
  LinkedRepoChangeDirectorySummary,
  LinkedRepoChangeStatus,
  LinkedRepoChangeSummary,
} from '@open-design/contracts';

const DEFAULT_GIT_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_STATUS_LINES = 120;
const DEFAULT_MAX_DIFF_STAT_CHARS = 8_000;

export interface LinkedRepoSnapshotDir {
  path: string;
  status: LinkedRepoChangeStatus;
  branch: string | null;
  headSha: string | null;
  statusLines: string[];
  statusLineCount: number;
  untrackedFileCount: number;
  statusTruncated?: boolean;
  diffStat: string | null;
  diffStatTruncated?: boolean;
  error: string | null;
}

export interface LinkedRepoSnapshot {
  generatedAt: number;
  linkedDirs: LinkedRepoSnapshotDir[];
}

export interface RunGitResult {
  stdout: string;
  stderr: string;
}

export type RunGit = (dir: string, args: string[]) => Promise<RunGitResult>;

export interface CaptureLinkedRepoSnapshotOptions {
  runGit?: RunGit;
  maxStatusLines?: number;
  maxDiffStatChars?: number;
}

export async function captureLinkedRepoSnapshot(
  linkedDirs: string[],
  options: CaptureLinkedRepoSnapshotOptions = {},
): Promise<LinkedRepoSnapshot> {
  const runGit = options.runGit ?? defaultRunGit;
  const maxStatusLines = options.maxStatusLines ?? DEFAULT_MAX_STATUS_LINES;
  const maxDiffStatChars = options.maxDiffStatChars ?? DEFAULT_MAX_DIFF_STAT_CHARS;
  const uniqueDirs = Array.from(new Set(linkedDirs.filter((dir) => typeof dir === 'string' && dir.trim())));
  const dirs = await Promise.all(
    uniqueDirs.map((dir) => captureLinkedRepoDir(dir, runGit, maxStatusLines, maxDiffStatChars)),
  );
  return {
    generatedAt: Date.now(),
    linkedDirs: dirs,
  };
}

export async function captureLinkedRepoChangeSummary(
  before: LinkedRepoSnapshot,
  options: CaptureLinkedRepoSnapshotOptions = {},
): Promise<LinkedRepoChangeSummary> {
  const after = await captureLinkedRepoSnapshot(
    before.linkedDirs.map((dir) => dir.path),
    options,
  );
  return summarizeLinkedRepoChanges(before, after);
}

export function summarizeLinkedRepoChanges(
  before: LinkedRepoSnapshot,
  after: LinkedRepoSnapshot,
): LinkedRepoChangeSummary {
  const beforeByPath = new Map(before.linkedDirs.map((dir) => [dir.path, dir]));
  const linkedDirs: LinkedRepoChangeDirectorySummary[] = after.linkedDirs.map((dir) => {
    const baseline = beforeByPath.get(dir.path);
    const baselinePaths = new Set((baseline?.statusLines ?? []).flatMap(statusLinePaths));
    const newStatusLineCount = dir.statusLines.filter((line) => {
      const paths = statusLinePaths(line);
      return paths.length === 0 || paths.every((path) => !baselinePaths.has(path));
    }).length;
    const preexistingChangeCount = Math.min(
      dir.statusLineCount,
      Math.max(0, dir.statusLineCount - newStatusLineCount),
    );
    return {
      path: dir.path,
      status: dir.status,
      branch: dir.branch,
      headSha: dir.headSha,
      changedFileCount: dir.statusLineCount,
      newStatusLineCount,
      preexistingChangeCount,
      untrackedFileCount: dir.untrackedFileCount,
      statusLines: dir.statusLines,
      ...(dir.statusTruncated ? { statusTruncated: true } : {}),
      diffStat: dir.diffStat,
      ...(dir.diffStatTruncated ? { diffStatTruncated: true } : {}),
      error: dir.error,
    };
  });
  const changedFileCount = linkedDirs.reduce((sum, dir) => sum + dir.changedFileCount, 0);
  const newStatusLineCount = linkedDirs.reduce((sum, dir) => sum + dir.newStatusLineCount, 0);
  const preexistingChangeCount = linkedDirs.reduce((sum, dir) => sum + dir.preexistingChangeCount, 0);
  const untrackedFileCount = linkedDirs.reduce((sum, dir) => sum + dir.untrackedFileCount, 0);
  return {
    generatedAt: after.generatedAt,
    linkedDirCount: linkedDirs.length,
    changedFileCount,
    newStatusLineCount,
    preexistingChangeCount,
    untrackedFileCount,
    hasChanges: changedFileCount > 0,
    linkedDirs,
  };
}

async function captureLinkedRepoDir(
  dir: string,
  runGit: RunGit,
  maxStatusLines: number,
  maxDiffStatChars: number,
): Promise<LinkedRepoSnapshotDir> {
  try {
    await runGit(dir, ['rev-parse', '--show-toplevel']);
  } catch (err) {
    return emptySnapshotDir(dir, 'not_git', errorMessage(err));
  }

  try {
    const [branch, headSha, status, diffStat] = await Promise.all([
      runGit(dir, ['branch', '--show-current']).catch(() => ({ stdout: '', stderr: '' })),
      runGit(dir, ['rev-parse', '--short', 'HEAD']).catch(() => ({ stdout: '', stderr: '' })),
      runGit(dir, ['status', '--short', '--untracked-files=all']),
      runGit(dir, ['diff', '--stat', '--']).catch(() => ({ stdout: '', stderr: '' })),
    ]);
    const allStatusLines = splitLines(status.stdout);
    const statusLines = allStatusLines.slice(0, maxStatusLines);
    const rawDiffStat = diffStat.stdout.trim();
    const diffStatTruncated = rawDiffStat.length > maxDiffStatChars;
    const statusValue: LinkedRepoChangeStatus = allStatusLines.length > 0 ? 'changed' : 'clean';
    return {
      path: dir,
      status: statusValue,
      branch: branch.stdout.trim() || null,
      headSha: headSha.stdout.trim() || null,
      statusLines,
      statusLineCount: allStatusLines.length,
      untrackedFileCount: allStatusLines.filter((line) => line.startsWith('??')).length,
      ...(allStatusLines.length > statusLines.length ? { statusTruncated: true } : {}),
      diffStat: rawDiffStat
        ? rawDiffStat.slice(0, maxDiffStatChars)
        : null,
      ...(diffStatTruncated ? { diffStatTruncated: true } : {}),
      error: null,
    };
  } catch (err) {
    return emptySnapshotDir(dir, 'error', errorMessage(err));
  }
}

function emptySnapshotDir(
  dir: string,
  status: LinkedRepoChangeStatus,
  error: string | null,
): LinkedRepoSnapshotDir {
  return {
    path: dir,
    status,
    branch: null,
    headSha: null,
    statusLines: [],
    statusLineCount: 0,
    untrackedFileCount: 0,
    diffStat: null,
    error,
  };
}

function splitLines(value: string): string[] {
  return value
    .split(/\r?\n/g)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
}

function statusLinePaths(line: string): string[] {
  const value = line.length > 3 ? line.slice(3).trim() : line.trim();
  if (!value) return [];
  const renameSeparator = ' -> ';
  if (!value.includes(renameSeparator)) return [value];
  return value
    .split(renameSeparator)
    .map((part) => part.trim())
    .filter(Boolean);
}

function errorMessage(err: unknown): string {
  if (!err) return 'Unknown git error.';
  if (err instanceof Error && err.message.trim()) return err.message.trim();
  return String(err);
}

function defaultRunGit(dir: string, args: string[]): Promise<RunGitResult> {
  const gitArgs = ['-c', 'core.quotepath=false', '-C', dir, ...args];
  return new Promise((resolve, reject) => {
    execFileCallback(
      'git',
      gitArgs,
      {
        encoding: 'utf8',
        timeout: DEFAULT_GIT_TIMEOUT_MS,
        maxBuffer: 512 * 1024,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        const result = {
          stdout: typeof stdout === 'string' ? stdout : String(stdout ?? ''),
          stderr: typeof stderr === 'string' ? stderr : String(stderr ?? ''),
        };
        if (err) {
          const message = result.stderr.trim() || result.stdout.trim() || err.message;
          reject(new Error(message));
          return;
        }
        resolve(result);
      },
    );
  });
}
