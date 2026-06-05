import { execFile as execFileCallback } from 'node:child_process';

import type {
  LinkedRepoChangeDirectorySummary,
  LinkedRepoChangeStatus,
  LinkedRepoChangeSummary,
} from '@open-design/contracts';

const DEFAULT_GIT_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_STATUS_LINES = 120;
const DEFAULT_MAX_DIFF_STAT_CHARS = 8_000;
const HASH_OBJECT_BATCH_SIZE = 200;

export interface LinkedRepoSnapshotDir {
  path: string;
  status: LinkedRepoChangeStatus;
  branch: string | null;
  headSha: string | null;
  statusLines: string[];
  // Full normalized path identities for comparison; statusLines may be capped for display.
  statusPathSets?: string[][];
  // Full per-status-line worktree identities for comparison; statusLines may be capped for display.
  statusFingerprints?: string[];
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
    const baselinePaths = new Set(statusPathSetsForDir(baseline).flat());
    const baselineFingerprintCounts = statusFingerprintsForDir(baseline).reduce((counts, fingerprint) => {
      counts.set(fingerprint, (counts.get(fingerprint) ?? 0) + 1);
      return counts;
    }, new Map<string, number>());
    const statusPathSets = statusPathSetsForDir(dir);
    const statusFingerprints = statusFingerprintsForDir(dir);
    const newStatusLineCount = Math.min(
      dir.statusLineCount,
      statusPathSets.filter((paths, index) =>
        statusPathsIntroduceNewOutput(paths, baselinePaths, baselineFingerprintCounts, statusFingerprints[index]),
      ).length,
    );
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
    return emptySnapshotDir(dir, statusForRepoProbeError(err), errorMessage(err));
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
    const statusPathSets = allStatusLines.map((line) => statusLineInfo(line).paths);
    const statusBitsPerLine = allStatusLines.map((line) => statusLineInfo(line).statusBits);
    const statusFingerprints = await statusLineFingerprints(dir, runGit, statusPathSets, statusBitsPerLine);
    const rawDiffStat = diffStat.stdout.trim();
    const diffStatTruncated = rawDiffStat.length > maxDiffStatChars;
    const statusValue: LinkedRepoChangeStatus = allStatusLines.length > 0 ? 'changed' : 'clean';
    return {
      path: dir,
      status: statusValue,
      branch: branch.stdout.trim() || null,
      headSha: headSha.stdout.trim() || null,
      statusLines,
      statusPathSets,
      statusFingerprints,
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
    statusPathSets: [],
    statusFingerprints: [],
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

interface StatusLineInfo {
  paths: string[];
  statusBits: string;
}

function statusLineInfo(line: string): StatusLineInfo {
  const statusBits = line.length >= 2 ? line.slice(0, 2) : '  ';
  const value = line.length > 3 ? line.slice(3).trim() : line.trim();
  if (!value) return { paths: [], statusBits };
  const renameSeparator = ' -> ';
  if (!value.includes(renameSeparator)) return { paths: [unescapePath(value)], statusBits };
  return {
    paths: value
      .split(renameSeparator)
      .map((part) => unescapePath(part.trim()))
      .filter(Boolean),
    statusBits,
  };
}

// Git C-style escape sequences (see quote.c `quote_c_style`). `core.quotepath`
// only governs whether *high-bit* bytes are octal-escaped — control characters
// (tab, newline, …), `"`, and `\` are ALWAYS escaped and the whole path wrapped
// in double quotes. Decoding only `\"`/`\\` therefore leaves real tab/newline
// bytes encoded as the literal two characters `\t`/`\n`, which then makes the
// follow-up `git hash-object -- <path>` probe miss the real file.
const C_STYLE_ESCAPES: Record<string, number> = {
  a: 0x07,
  b: 0x08,
  t: 0x09,
  n: 0x0a,
  v: 0x0b,
  f: 0x0c,
  r: 0x0d,
  '"': 0x22,
  '\\': 0x5c,
};

function unescapePath(path: string): string {
  if (!(path.length >= 2 && path[0] === '"' && path[path.length - 1] === '"')) {
    return path;
  }
  const body = path.slice(1, -1);
  // Octal escapes encode raw bytes, and literal runs may contain multi-byte
  // UTF-8, so reassemble at the byte level and decode once at the end.
  const bytes: number[] = [];
  let literalStart = 0;
  const flushLiteral = (end: number): void => {
    if (end > literalStart) {
      const slice = Buffer.from(body.slice(literalStart, end), 'utf8');
      for (let i = 0; i < slice.length; i += 1) bytes.push(slice[i]!);
    }
  };
  let cursor = 0;
  while (cursor < body.length) {
    if (body[cursor] !== '\\' || cursor + 1 >= body.length) {
      cursor += 1;
      continue;
    }
    flushLiteral(cursor);
    const next = body[cursor + 1]!;
    if (next >= '0' && next <= '7') {
      // Up to three octal digits → one byte (git always emits exactly three).
      let digits = '';
      let scan = cursor + 1;
      while (scan < body.length && digits.length < 3 && body[scan]! >= '0' && body[scan]! <= '7') {
        digits += body[scan];
        scan += 1;
      }
      bytes.push(parseInt(digits, 8) & 0xff);
      cursor = scan;
    } else if (next in C_STYLE_ESCAPES) {
      bytes.push(C_STYLE_ESCAPES[next]!);
      cursor += 2;
    } else {
      // Unknown escape — preserve the escaped character literally.
      const slice = Buffer.from(next, 'utf8');
      for (let i = 0; i < slice.length; i += 1) bytes.push(slice[i]!);
      cursor += 2;
    }
    literalStart = cursor;
  }
  flushLiteral(body.length);
  return Buffer.from(bytes).toString('utf8');
}

function statusPathSetsForDir(dir: LinkedRepoSnapshotDir | undefined): string[][] {
  return dir?.statusPathSets ?? (dir?.statusLines ?? []).map((line) => statusLineInfo(line).paths);
}

function statusFingerprintsForDir(dir: LinkedRepoSnapshotDir | undefined): string[] {
  if (!dir) return [];
  return dir.statusFingerprints ?? (dir?.statusLines ?? []).map((line) => statusLineFingerprintFromPathFingerprints(statusLineInfo(line).paths, statusLineInfo(line).statusBits));
}

function statusLineFingerprintFromPathFingerprints(paths: string[], statusBits: string): string {
  return `${paths.join('\0')}\0status:${statusBits}`;
}

function statusPathsIntroduceNewOutput(
  paths: string[],
  baselinePaths: Set<string>,
  baselineFingerprintCounts: Map<string, number>,
  fingerprint: string | undefined,
): boolean {
  if (paths.length === 0 || paths.some((path) => !baselinePaths.has(path))) return true;
  if (!fingerprint) return false;
  const count = baselineFingerprintCounts.get(fingerprint) ?? 0;
  if (count <= 0) return true;
  if (count === 1) baselineFingerprintCounts.delete(fingerprint);
  else baselineFingerprintCounts.set(fingerprint, count - 1);
  return false;
}

async function statusLineFingerprints(
  dir: string,
  runGit: RunGit,
  statusPathSets: string[][],
  statusBitsPerLine: string[],
): Promise<string[]> {
  const uniquePaths = Array.from(new Set(statusPathSets.flat()));
  const pathFingerprints = await statusPathFingerprints(dir, runGit, uniquePaths);
  return statusPathSets.map((paths, index) =>
    statusLineFingerprintFromPathFingerprints(
      paths.map((path) =>
        pathFingerprints.get(path) ?? statusPathMissingFingerprint(path),
      ),
      statusBitsPerLine[index] ?? '  ',
    ),
  );
}

async function statusPathFingerprints(
  dir: string,
  runGit: RunGit,
  paths: string[],
): Promise<Map<string, string>> {
  const fingerprints = new Map<string, string>();
  for (let index = 0; index < paths.length; index += HASH_OBJECT_BATCH_SIZE) {
    const batch = paths.slice(index, index + HASH_OBJECT_BATCH_SIZE);
    if (batch.length === 0) continue;
    try {
      const result = await runGit(dir, ['hash-object', '--', ...batch]);
      const hashes = splitLines(result.stdout);
      if (hashes.length !== batch.length) throw new Error('hash-object returned an unexpected path count');
      batch.forEach((path, offset) => {
        fingerprints.set(path, statusPathContentFingerprint(path, hashes[offset] ?? ''));
      });
    } catch {
      for (const path of batch) {
        fingerprints.set(path, await statusPathFingerprint(dir, runGit, path));
      }
    }
  }
  return fingerprints;
}

async function statusPathFingerprint(dir: string, runGit: RunGit, path: string): Promise<string> {
  try {
    const result = await runGit(dir, ['hash-object', '--', path]);
    return statusPathContentFingerprint(path, result.stdout.trim());
  } catch {
    return statusPathMissingFingerprint(path);
  }
}

function statusPathContentFingerprint(path: string, hash: string): string {
  return `${path}\0worktree:${hash || 'empty'}`;
}

function statusPathMissingFingerprint(path: string): string {
  return `${path}\0worktree:missing`;
}

function statusForRepoProbeError(err: unknown): LinkedRepoChangeStatus {
  return /not a git repository/i.test(errorMessage(err)) ? 'not_git' : 'error';
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
