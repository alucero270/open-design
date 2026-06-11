import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import {
  captureLinkedRepoChangeSummary,
  captureLinkedRepoSnapshot,
  summarizeLinkedRepoChanges,
  type LinkedRepoSnapshot,
  type RunGit,
} from '../src/repo-changes.js';

const execFileAsync = promisify(execFile);

describe('linked repo change summaries', () => {
  it('captures git status, diff stat, branch, and head for linked dirs', async () => {
    const runGit: RunGit = async (_dir, args) => {
      const command = args.join(' ');
      if (command === 'rev-parse --show-toplevel') return { stdout: '/repo\n', stderr: '' };
      if (command === 'branch --show-current') return { stdout: 'main\n', stderr: '' };
      if (command === 'rev-parse --short HEAD') return { stdout: 'abc1234\n', stderr: '' };
      if (command === 'status --short --untracked-files=all') {
        return { stdout: ' M src/app.ts\n?? src/new.ts\n', stderr: '' };
      }
      if (command === 'diff --stat --') {
        return { stdout: ' src/app.ts | 8 +++++---\n 1 file changed, 5 insertions(+), 3 deletions(-)\n', stderr: '' };
      }
      if (command === 'hash-object -- src/app.ts src/new.ts') {
        return { stdout: 'app-worktree-hash\nnew-worktree-hash\n', stderr: '' };
      }
      throw new Error(`unexpected git command: ${command}`);
    };

    const snapshot = await captureLinkedRepoSnapshot(['/repo'], { runGit });

    expect(snapshot.linkedDirs[0]).toMatchObject({
      path: '/repo',
      status: 'changed',
      branch: 'main',
      headSha: 'abc1234',
      statusLines: [' M src/app.ts', '?? src/new.ts'],
      statusPathSets: [['src/app.ts'], ['src/new.ts']],
      statusFingerprints: [
        'src/app.ts\u0000worktree:app-worktree-hash\u0000status: M',
        'src/new.ts\u0000worktree:new-worktree-hash\u0000status:??',
      ],
      statusLineCount: 2,
      untrackedFileCount: 1,
      diffStat: 'src/app.ts | 8 +++++---\n 1 file changed, 5 insertions(+), 3 deletions(-)',
      error: null,
    });
  });

  it('summarizes new and pre-existing status lines against the baseline', () => {
    const before: LinkedRepoSnapshot = {
      generatedAt: 1,
      linkedDirs: [
        {
          path: '/repo',
          status: 'changed',
          branch: 'main',
          headSha: 'abc1234',
          statusLines: [' M README.md'],
          statusLineCount: 1,
          untrackedFileCount: 0,
          diffStat: 'README.md | 2 ++',
          error: null,
        },
      ],
    };
    const after: LinkedRepoSnapshot = {
      generatedAt: 2,
      linkedDirs: [
        {
          path: '/repo',
          status: 'changed',
          branch: 'main',
          headSha: 'abc1234',
          statusLines: [' M README.md', '?? src/new.ts'],
          statusLineCount: 2,
          untrackedFileCount: 1,
          diffStat: 'README.md | 2 ++\n src/new.ts | 4 ++++',
          error: null,
        },
      ],
    };

    const summary = summarizeLinkedRepoChanges(before, after);

    expect(summary).toMatchObject({
      generatedAt: 2,
      linkedDirCount: 1,
      changedFileCount: 2,
      newStatusLineCount: 1,
      preexistingChangeCount: 1,
      untrackedFileCount: 1,
      hasChanges: true,
    });
    expect(summary.linkedDirs[0]).toMatchObject({
      changedFileCount: 2,
      newStatusLineCount: 1,
      preexistingChangeCount: 1,
    });
  });

  it('treats unchanged already-dirty paths as pre-existing changes', () => {
    const before: LinkedRepoSnapshot = {
      generatedAt: 1,
      linkedDirs: [
        {
          path: '/repo',
          status: 'changed',
          branch: 'main',
          headSha: 'abc1234',
          statusLines: [' M src/app.ts'],
          statusFingerprints: ['src/app.ts\u0000worktree:same-content\u0000status: M'],
          statusLineCount: 1,
          untrackedFileCount: 0,
          diffStat: 'src/app.ts | 2 ++',
          error: null,
        },
      ],
    };
    const after: LinkedRepoSnapshot = {
      generatedAt: 2,
      linkedDirs: [
        {
          path: '/repo',
          status: 'changed',
          branch: 'main',
          headSha: 'abc1234',
          statusLines: [' M src/app.ts'],
          statusFingerprints: ['src/app.ts\u0000worktree:same-content\u0000status: M'],
          statusLineCount: 1,
          untrackedFileCount: 0,
          diffStat: 'src/app.ts | 2 ++',
          error: null,
        },
      ],
    };

    const summary = summarizeLinkedRepoChanges(before, after);

    expect(summary).toMatchObject({
      changedFileCount: 1,
      newStatusLineCount: 0,
      preexistingChangeCount: 1,
      hasChanges: false,
    });
    expect(summary.linkedDirs[0]).toMatchObject({
      changedFileCount: 1,
      newStatusLineCount: 0,
      preexistingChangeCount: 1,
    });
  });

  it('treats clean HEAD changes as run output', () => {
    const before: LinkedRepoSnapshot = {
      generatedAt: 1,
      linkedDirs: [
        {
          path: '/repo',
          status: 'clean',
          branch: 'main',
          headSha: 'abc1234',
          statusLines: [],
          statusLineCount: 0,
          untrackedFileCount: 0,
          diffStat: null,
          error: null,
        },
      ],
    };
    const after: LinkedRepoSnapshot = {
      generatedAt: 2,
      linkedDirs: [
        {
          path: '/repo',
          status: 'clean',
          branch: 'main',
          headSha: 'def5678',
          statusLines: [],
          statusLineCount: 0,
          untrackedFileCount: 0,
          diffStat: null,
          error: null,
        },
      ],
    };

    const summary = summarizeLinkedRepoChanges(before, after);

    expect(summary).toMatchObject({
      changedFileCount: 0,
      newStatusLineCount: 0,
      preexistingChangeCount: 0,
      refChangeCount: 1,
      hasChanges: true,
    });
    expect(summary.linkedDirs[0]).toMatchObject({
      status: 'clean',
      headSha: 'def5678',
      headChanged: true,
    });
  });

  it('captures changed paths and diff stat for clean committed output', async () => {
    let phase: 'before' | 'after' = 'before';
    const runGit: RunGit = async (_dir, args) => {
      const command = args.join(' ');
      if (command === 'rev-parse --show-toplevel') return { stdout: '/repo\n', stderr: '' };
      if (command === 'branch --show-current') return { stdout: 'main\n', stderr: '' };
      if (command === 'rev-parse --short HEAD') {
        return { stdout: phase === 'before' ? 'abc1234\n' : 'def5678\n', stderr: '' };
      }
      if (command === 'status --short --untracked-files=all') return { stdout: '', stderr: '' };
      if (command === 'diff --stat --') return { stdout: '', stderr: '' };
      if (command === 'diff --name-status -z abc1234..def5678 --') {
        return { stdout: 'A\0committed-output.ts\0', stderr: '' };
      }
      if (command === 'diff --stat abc1234..def5678 --') {
        return {
          stdout: ' committed-output.ts | 1 +\n 1 file changed, 1 insertion(+)\n',
          stderr: '',
        };
      }
      throw new Error(`unexpected git command: ${command}`);
    };

    const before = await captureLinkedRepoSnapshot(['/repo'], { runGit });
    phase = 'after';
    const summary = await captureLinkedRepoChangeSummary(before, { runGit });

    expect(summary).toMatchObject({
      changedFileCount: 1,
      newStatusLineCount: 1,
      preexistingChangeCount: 0,
      refChangeCount: 1,
      hasChanges: true,
    });
    expect(summary.linkedDirs[0]).toMatchObject({
      status: 'clean',
      headSha: 'def5678',
      headChanged: true,
      changedFileCount: 1,
      newStatusLineCount: 1,
      statusLines: ['A  committed-output.ts'],
      diffStat: 'committed-output.ts | 1 +\n 1 file changed, 1 insertion(+)',
    });
  });

  it('captures committed paths when the baseline repo had an unborn branch', async () => {
    let phase: 'before' | 'after' = 'before';
    const runGit: RunGit = async (_dir, args) => {
      const command = args.join(' ');
      if (command === 'rev-parse --show-toplevel') return { stdout: '/repo\n', stderr: '' };
      if (command === 'branch --show-current') return { stdout: 'main\n', stderr: '' };
      if (command === 'rev-parse --short HEAD') {
        if (phase === 'before') throw new Error('fatal: ambiguous argument \'HEAD\': unknown revision');
        return { stdout: 'def5678\n', stderr: '' };
      }
      if (command === 'status --short --untracked-files=all') return { stdout: '', stderr: '' };
      if (command === 'diff --stat --') return { stdout: '', stderr: '' };
      if (command === 'rev-parse --show-object-format') return { stdout: 'sha1\n', stderr: '' };
      if (command === 'diff --name-status -z 4b825dc642cb6eb9a060e54bf8d69288fbee4904..def5678 --') {
        return { stdout: 'A\0initial-output.ts\0A\0src/second.ts\0', stderr: '' };
      }
      if (command === 'diff --stat 4b825dc642cb6eb9a060e54bf8d69288fbee4904..def5678 --') {
        return {
          stdout: ' initial-output.ts | 3 +++\n src/second.ts | 1 +\n 2 files changed, 4 insertions(+)\n',
          stderr: '',
        };
      }
      throw new Error(`unexpected git command: ${command}`);
    };

    const before = await captureLinkedRepoSnapshot(['/repo'], { runGit });
    expect(before.linkedDirs[0]?.headSha).toBeNull();
    phase = 'after';
    const summary = await captureLinkedRepoChangeSummary(before, { runGit });

    expect(summary).toMatchObject({
      changedFileCount: 2,
      newStatusLineCount: 2,
      preexistingChangeCount: 0,
      refChangeCount: 1,
      hasChanges: true,
    });
    expect(summary.linkedDirs[0]).toMatchObject({
      status: 'clean',
      headSha: 'def5678',
      headChanged: true,
      changedFileCount: 2,
      newStatusLineCount: 2,
      statusLines: ['A  initial-output.ts', 'A  src/second.ts'],
      diffStat: 'initial-output.ts | 3 +++\n src/second.ts | 1 +\n 2 files changed, 4 insertions(+)',
    });
  });

  it('captures both committed and live-dirty paths after a run that does both', async () => {
    let phase: 'before' | 'after' = 'before';
    const runGit: RunGit = async (_dir, args) => {
      const command = args.join(' ');
      if (command === 'rev-parse --show-toplevel') return { stdout: '/repo\n', stderr: '' };
      if (command === 'branch --show-current') return { stdout: 'main\n', stderr: '' };
      if (command === 'rev-parse --short HEAD') {
        return { stdout: phase === 'before' ? 'abc1234\n' : 'def5678\n', stderr: '' };
      }
      if (command === 'status --short --untracked-files=all') {
        return { stdout: phase === 'before' ? '' : '?? notes.md\n', stderr: '' };
      }
      if (command === 'diff --stat --') return { stdout: '', stderr: '' };
      if (command === 'hash-object -- notes.md') return { stdout: 'notes-hash\n', stderr: '' };
      if (command === 'diff --name-status -z abc1234..def5678 --') {
        return { stdout: 'A\0committed-output.ts\0', stderr: '' };
      }
      if (command === 'diff --stat abc1234..def5678 --') {
        return {
          stdout: ' committed-output.ts | 1 +\n 1 file changed, 1 insertion(+)\n',
          stderr: '',
        };
      }
      throw new Error(`unexpected git command: ${command}`);
    };

    const before = await captureLinkedRepoSnapshot(['/repo'], { runGit });
    phase = 'after';
    const summary = await captureLinkedRepoChangeSummary(before, { runGit });

    expect(summary).toMatchObject({
      changedFileCount: 2,
      newStatusLineCount: 2,
      preexistingChangeCount: 0,
      refChangeCount: 1,
      hasChanges: true,
    });
    expect(summary.linkedDirs[0]).toMatchObject({
      status: 'changed',
      headSha: 'def5678',
      headChanged: true,
      changedFileCount: 2,
      newStatusLineCount: 2,
      untrackedFileCount: 1,
      statusLines: ['A  committed-output.ts', '?? notes.md'],
      diffStat: 'committed-output.ts | 1 +\n 1 file changed, 1 insertion(+)',
    });
  });

  it('falls back to the ref-update summary when the unborn-baseline range probe fails', async () => {
    let phase: 'before' | 'after' = 'before';
    const runGit: RunGit = async (_dir, args) => {
      const command = args.join(' ');
      if (command === 'rev-parse --show-toplevel') return { stdout: '/repo\n', stderr: '' };
      if (command === 'branch --show-current') return { stdout: 'main\n', stderr: '' };
      if (command === 'rev-parse --short HEAD') {
        if (phase === 'before') throw new Error('fatal: ambiguous argument \'HEAD\': unknown revision');
        return { stdout: 'def5678\n', stderr: '' };
      }
      if (command === 'status --short --untracked-files=all') return { stdout: '', stderr: '' };
      if (command === 'diff --stat --') return { stdout: '', stderr: '' };
      if (command === 'rev-parse --show-object-format') return { stdout: 'sha1\n', stderr: '' };
      throw new Error(`unexpected git command: ${command}`);
    };

    const before = await captureLinkedRepoSnapshot(['/repo'], { runGit });
    phase = 'after';
    const summary = await captureLinkedRepoChangeSummary(before, { runGit });

    expect(summary).toMatchObject({
      changedFileCount: 0,
      refChangeCount: 1,
      hasChanges: true,
    });
    expect(summary.linkedDirs[0]).toMatchObject({
      status: 'clean',
      headSha: 'def5678',
      headChanged: true,
    });
  });

  it('treats further edits to an already-dirty path as new output', async () => {
    let phase: 'before' | 'after' = 'before';
    const runGit: RunGit = async (_dir, args) => {
      const command = args.join(' ');
      if (command === 'rev-parse --show-toplevel') return { stdout: '/repo\n', stderr: '' };
      if (command === 'branch --show-current') return { stdout: 'main\n', stderr: '' };
      if (command === 'rev-parse --short HEAD') return { stdout: 'abc1234\n', stderr: '' };
      if (command === 'status --short --untracked-files=all') {
        return { stdout: ' M src/app.ts\n', stderr: '' };
      }
      if (command === 'diff --stat --') {
        return {
          stdout: phase === 'before'
            ? ' src/app.ts | 2 ++\n 1 file changed, 2 insertions(+)\n'
            : ' src/app.ts | 4 ++++\n 1 file changed, 4 insertions(+)\n',
          stderr: '',
        };
      }
      if (command === 'hash-object -- src/app.ts') {
        return {
          stdout: phase === 'before' ? 'before-worktree-hash\n' : 'after-worktree-hash\n',
          stderr: '',
        };
      }
      throw new Error(`unexpected git command: ${command}`);
    };

    const before = await captureLinkedRepoSnapshot(['/repo'], { runGit });
    phase = 'after';
    const after = await captureLinkedRepoSnapshot(['/repo'], { runGit });

    const summary = summarizeLinkedRepoChanges(before, after);

    expect(summary).toMatchObject({
      changedFileCount: 1,
      newStatusLineCount: 1,
      preexistingChangeCount: 0,
    });
    expect(summary.linkedDirs[0]).toMatchObject({
      statusLines: [' M src/app.ts'],
      changedFileCount: 1,
      newStatusLineCount: 1,
      preexistingChangeCount: 0,
    });
  });

  it('batches worktree fingerprints for large dirty snapshots', async () => {
    const dirtyPaths = Array.from({ length: 450 }, (_, index) => `src/file-${index}.ts`);
    const hashObjectCommands: string[][] = [];
    const runGit: RunGit = async (_dir, args) => {
      const command = args.join(' ');
      if (command === 'rev-parse --show-toplevel') return { stdout: '/repo\n', stderr: '' };
      if (command === 'branch --show-current') return { stdout: 'main\n', stderr: '' };
      if (command === 'rev-parse --short HEAD') return { stdout: 'abc1234\n', stderr: '' };
      if (command === 'status --short --untracked-files=all') {
        return { stdout: dirtyPaths.map((path) => ` M ${path}`).join('\n'), stderr: '' };
      }
      if (command === 'diff --stat --') return { stdout: '', stderr: '' };
      if (args[0] === 'hash-object' && args[1] === '--') {
        const paths = args.slice(2);
        hashObjectCommands.push(paths);
        return {
          stdout: paths.map((path) => `hash-for-${path}`).join('\n') + '\n',
          stderr: '',
        };
      }
      throw new Error(`unexpected git command: ${command}`);
    };

    const snapshot = await captureLinkedRepoSnapshot(['/repo'], { runGit });

    expect(hashObjectCommands).toHaveLength(3);
    expect(hashObjectCommands.map((paths) => paths.length)).toEqual([200, 200, 50]);
    expect(snapshot.linkedDirs[0]?.statusLineCount).toBe(450);
    expect(snapshot.linkedDirs[0]?.statusFingerprints).toHaveLength(450);
    expect(snapshot.linkedDirs[0]?.statusFingerprints?.[449]).toBe(
      'src/file-449.ts\u0000worktree:hash-for-src/file-449.ts\u0000status: M',
    );
  });

  it('treats renames from pre-existing dirty paths as new output when the target path is new', () => {
    const before: LinkedRepoSnapshot = {
      generatedAt: 1,
      linkedDirs: [
        {
          path: '/repo',
          status: 'changed',
          branch: 'main',
          headSha: 'abc1234',
          statusLines: [' M src/old.ts'],
          statusLineCount: 1,
          untrackedFileCount: 0,
          diffStat: 'src/old.ts | 2 ++',
          error: null,
        },
      ],
    };
    const after: LinkedRepoSnapshot = {
      generatedAt: 2,
      linkedDirs: [
        {
          path: '/repo',
          status: 'changed',
          branch: 'main',
          headSha: 'abc1234',
          statusLines: ['R  src/old.ts -> src/new.ts'],
          statusLineCount: 1,
          untrackedFileCount: 0,
          diffStat: 'src/old.ts => src/new.ts | 2 ++',
          error: null,
        },
      ],
    };

    const summary = summarizeLinkedRepoChanges(before, after);

    expect(summary).toMatchObject({
      changedFileCount: 1,
      newStatusLineCount: 1,
      preexistingChangeCount: 0,
    });
    expect(summary.linkedDirs[0]).toMatchObject({
      changedFileCount: 1,
      newStatusLineCount: 1,
      preexistingChangeCount: 0,
    });
  });

  it('compares against uncapped baseline path identities when visible status lines are truncated', () => {
    const before: LinkedRepoSnapshot = {
      generatedAt: 1,
      linkedDirs: [
        {
          path: '/repo',
          status: 'changed',
          branch: 'main',
          headSha: 'abc1234',
          statusLines: [' M src/shown.ts'],
          statusPathSets: [['src/shown.ts'], ['src/hidden.ts']],
          statusLineCount: 2,
          untrackedFileCount: 0,
          statusTruncated: true,
          diffStat: null,
          error: null,
        },
      ],
    };
    const after: LinkedRepoSnapshot = {
      generatedAt: 2,
      linkedDirs: [
        {
          path: '/repo',
          status: 'changed',
          branch: 'main',
          headSha: 'abc1234',
          statusLines: ['M  src/hidden.ts'],
          statusPathSets: [['src/hidden.ts']],
          statusLineCount: 1,
          untrackedFileCount: 0,
          diffStat: null,
          error: null,
        },
      ],
    };

    const summary = summarizeLinkedRepoChanges(before, after);

    expect(summary).toMatchObject({
      changedFileCount: 1,
      newStatusLineCount: 1,
      preexistingChangeCount: 0,
    });
  });

  it('reports a linked dir as not_git when git cannot read it as a repository', async () => {
    const runGit: RunGit = async () => {
      throw new Error('fatal: not a git repository');
    };

    const snapshot = await captureLinkedRepoSnapshot(['/plain-folder'], { runGit });

    expect(snapshot.linkedDirs[0]).toMatchObject({
      path: '/plain-folder',
      status: 'not_git',
      statusLineCount: 0,
      error: 'fatal: not a git repository',
    });
  });

  it('reports a linked dir as error when the git repository probe fails for execution reasons', async () => {
    const runGit: RunGit = async () => {
      throw new Error('spawn git ENOENT');
    };

    const snapshot = await captureLinkedRepoSnapshot(['/repo'], { runGit });

    expect(snapshot.linkedDirs[0]).toMatchObject({
      path: '/repo',
      status: 'error',
      statusLineCount: 0,
      error: 'spawn git ENOENT',
    });
  });

  it('handles quoted paths with spaces in git status output', async () => {
    const runGit: RunGit = async (_dir, args) => {
      const command = args.join(' ');
      if (command === 'rev-parse --show-toplevel') return { stdout: '/repo\n', stderr: '' };
      if (command === 'branch --show-current') return { stdout: 'main\n', stderr: '' };
      if (command === 'rev-parse --short HEAD') return { stdout: 'abc1234\n', stderr: '' };
      if (command === 'status --short --untracked-files=all') {
        return { stdout: ' M "a b.txt"\n', stderr: '' };
      }
      if (command === 'diff --stat --') return { stdout: '', stderr: '' };
      if (command === 'hash-object -- a b.txt') {
        return { stdout: 'space-file-hash\n', stderr: '' };
      }
      throw new Error(`unexpected git command: ${command}`);
    };

    const snapshot = await captureLinkedRepoSnapshot(['/repo'], { runGit });

    expect(snapshot.linkedDirs[0]?.statusPathSets).toEqual([['a b.txt']]);
    expect(snapshot.linkedDirs[0]?.statusFingerprints?.[0]).toContain('a b.txt');
    expect(snapshot.linkedDirs[0]?.statusFingerprints?.[0]).toContain('status: M');
  });

  it('treats further edits to an already-dirty quoted path as new output', async () => {
    let phase: 'before' | 'after' = 'before';
    const runGit: RunGit = async (_dir, args) => {
      const command = args.join(' ');
      if (command === 'rev-parse --show-toplevel') return { stdout: '/repo\n', stderr: '' };
      if (command === 'branch --show-current') return { stdout: 'main\n', stderr: '' };
      if (command === 'rev-parse --short HEAD') return { stdout: 'abc1234\n', stderr: '' };
      if (command === 'status --short --untracked-files=all') {
        return { stdout: ' M "a b.txt"\n', stderr: '' };
      }
      if (command === 'diff --stat --') {
        return {
          stdout: phase === 'before'
            ? ' "a b.txt" | 2 ++\n 1 file changed, 2 insertions(+)\n'
            : ' "a b.txt" | 4 ++++\n 1 file changed, 4 insertions(+)\n',
          stderr: '',
        };
      }
      if (command === 'hash-object -- a b.txt') {
        return {
          stdout: phase === 'before' ? 'before-hash\n' : 'after-hash\n',
          stderr: '',
        };
      }
      throw new Error(`unexpected git command: ${command}`);
    };

    const before = await captureLinkedRepoSnapshot(['/repo'], { runGit });
    phase = 'after';
    const after = await captureLinkedRepoSnapshot(['/repo'], { runGit });

    const summary = summarizeLinkedRepoChanges(before, after);

    expect(summary).toMatchObject({
      changedFileCount: 1,
      newStatusLineCount: 1,
      preexistingChangeCount: 0,
    });
  });

  it('decodes C-style escaped paths (tab/newline) so the worktree probe hits the real file', async () => {
    // `core.quotepath=false` still C-quotes control characters, so git emits
    // the literal two-character sequence `\t` inside double quotes. The real
    // pathname contains a tab byte, and `git hash-object --` must receive that
    // real byte — not the `\t` digraph — for the worktree fingerprint to work.
    const tabPath = 'tab\tfile.txt';
    const newlinePath = 'multi\nline.txt';
    const hashObjectPaths: string[] = [];
    // git hash-object emits one clean SHA per line; key a stable fake off the
    // path index so control characters never leak into stdout.
    const fakeHash = (path: string) => `sha-${[tabPath, newlinePath].indexOf(path)}`;
    const runGit: RunGit = async (_dir, args) => {
      const command = args.join(' ');
      if (command === 'rev-parse --show-toplevel') return { stdout: '/repo\n', stderr: '' };
      if (command === 'branch --show-current') return { stdout: 'main\n', stderr: '' };
      if (command === 'rev-parse --short HEAD') return { stdout: 'abc1234\n', stderr: '' };
      if (command === 'status --short --untracked-files=all') {
        return { stdout: ' M "tab\\tfile.txt"\n?? "multi\\nline.txt"\n', stderr: '' };
      }
      if (command === 'diff --stat --') return { stdout: '', stderr: '' };
      if (args[0] === 'hash-object' && args[1] === '--') {
        const paths = args.slice(2);
        hashObjectPaths.push(...paths);
        return { stdout: paths.map(fakeHash).join('\n') + '\n', stderr: '' };
      }
      throw new Error(`unexpected git command: ${JSON.stringify(command)}`);
    };

    const snapshot = await captureLinkedRepoSnapshot(['/repo'], { runGit });

    // Paths are decoded to their real (control-character-bearing) form.
    expect(snapshot.linkedDirs[0]?.statusPathSets).toEqual([[tabPath], [newlinePath]]);
    // hash-object received the real decoded bytes, not the `\t` / `\n` digraphs.
    expect(hashObjectPaths).toContain(tabPath);
    expect(hashObjectPaths).toContain(newlinePath);
    expect(hashObjectPaths.some((path) => path.includes('\\t') || path.includes('\\n'))).toBe(false);
    // The worktree probe resolved, so no fingerprint fell back to "missing".
    expect(snapshot.linkedDirs[0]?.statusFingerprints?.[0]).toBe(
      `${tabPath}\u0000worktree:sha-0\u0000status: M`,
    );
    expect(snapshot.linkedDirs[0]?.statusFingerprints?.[0]).not.toContain('worktree:missing');
  });

  it('counts further edits to an already-dirty escaped path as new output', async () => {
    // Regression: when the tab path was not decoded, `git hash-object` failed
    // and both snapshots fell back to `worktree:missing`, so a real content
    // change on the already-dirty path was misreported as pre-existing.
    const tabPath = 'tab\tfile.txt';
    let phase: 'before' | 'after' = 'before';
    const runGit: RunGit = async (_dir, args) => {
      const command = args.join(' ');
      if (command === 'rev-parse --show-toplevel') return { stdout: '/repo\n', stderr: '' };
      if (command === 'branch --show-current') return { stdout: 'main\n', stderr: '' };
      if (command === 'rev-parse --short HEAD') return { stdout: 'abc1234\n', stderr: '' };
      if (command === 'status --short --untracked-files=all') {
        return { stdout: ' M "tab\\tfile.txt"\n', stderr: '' };
      }
      if (command === 'diff --stat --') return { stdout: '', stderr: '' };
      // Only matches when the real tab byte is passed through (proves decoding).
      if (args[0] === 'hash-object' && args[1] === '--' && args[2] === tabPath) {
        return {
          stdout: phase === 'before' ? 'before-hash\n' : 'after-hash\n',
          stderr: '',
        };
      }
      throw new Error(`unexpected git command: ${JSON.stringify(command)}`);
    };

    const before = await captureLinkedRepoSnapshot(['/repo'], { runGit });
    phase = 'after';
    const after = await captureLinkedRepoSnapshot(['/repo'], { runGit });

    const summary = summarizeLinkedRepoChanges(before, after);

    expect(summary).toMatchObject({
      changedFileCount: 1,
      newStatusLineCount: 1,
      preexistingChangeCount: 0,
    });
  });

  it('does not split a non-rename path that literally contains " -> "', async () => {
    // git emits ` M a -> b.txt` for a modified file named `a -> b.txt` (no
    // special chars, so unquoted). The ` -> ` is part of the name, not a
    // rename separator. If it were split, the probe would target the
    // nonexistent `a` and `b.txt`, fall back to worktree:missing, and a later
    // edit would be misclassified as pre-existing instead of new output.
    const weirdPath = 'a -> b.txt';
    const hashObjectPaths: string[] = [];
    let phase: 'before' | 'after' = 'before';
    const runGit: RunGit = async (_dir, args) => {
      const command = args.join(' ');
      if (command === 'rev-parse --show-toplevel') return { stdout: '/repo\n', stderr: '' };
      if (command === 'branch --show-current') return { stdout: 'main\n', stderr: '' };
      if (command === 'rev-parse --short HEAD') return { stdout: 'abc1234\n', stderr: '' };
      if (command === 'status --short --untracked-files=all') {
        return { stdout: ' M a -> b.txt\n', stderr: '' };
      }
      if (command === 'diff --stat --') return { stdout: '', stderr: '' };
      if (args[0] === 'hash-object' && args[1] === '--') {
        const paths = args.slice(2);
        hashObjectPaths.push(...paths);
        // Real git only resolves the actual on-disk path; the buggy split
        // paths ('a', 'b.txt') would error and fall back to worktree:missing.
        if (paths.length === 1 && paths[0] === weirdPath) {
          return { stdout: (phase === 'before' ? 'h-before' : 'h-after') + '\n', stderr: '' };
        }
        throw new Error(`pathspec did not match: ${paths.join(', ')}`);
      }
      throw new Error(`unexpected git command: ${JSON.stringify(command)}`);
    };

    const before = await captureLinkedRepoSnapshot(['/repo'], { runGit });
    // The ` -> ` stays inside a single path.
    expect(before.linkedDirs[0]?.statusPathSets).toEqual([[weirdPath]]);
    expect(hashObjectPaths).toEqual([weirdPath]);
    expect(before.linkedDirs[0]?.statusFingerprints?.[0]).not.toContain('worktree:missing');

    phase = 'after';
    const after = await captureLinkedRepoSnapshot(['/repo'], { runGit });
    const summary = summarizeLinkedRepoChanges(before, after);
    expect(summary).toMatchObject({
      changedFileCount: 1,
      newStatusLineCount: 1,
      preexistingChangeCount: 0,
    });
  });

  it('still splits a real rename entry on the top-level " -> " separator', async () => {
    const runGit: RunGit = async (_dir, args) => {
      const command = args.join(' ');
      if (command === 'rev-parse --show-toplevel') return { stdout: '/repo\n', stderr: '' };
      if (command === 'branch --show-current') return { stdout: 'main\n', stderr: '' };
      if (command === 'rev-parse --short HEAD') return { stdout: 'abc1234\n', stderr: '' };
      if (command === 'status --short --untracked-files=all') {
        return { stdout: 'R  src/old.ts -> src/new.ts\n', stderr: '' };
      }
      if (command === 'diff --stat --') return { stdout: '', stderr: '' };
      if (args[0] === 'hash-object' && args[1] === '--') {
        const paths = args.slice(2);
        return { stdout: paths.map((p) => `hash-${p}`).join('\n') + '\n', stderr: '' };
      }
      throw new Error(`unexpected git command: ${JSON.stringify(command)}`);
    };

    const snapshot = await captureLinkedRepoSnapshot(['/repo'], { runGit });
    expect(snapshot.linkedDirs[0]?.statusPathSets).toEqual([['src/old.ts', 'src/new.ts']]);
  });

  it('treats index-only staging of already-dirty path as new output', () => {
    const before: LinkedRepoSnapshot = {
      generatedAt: 1,
      linkedDirs: [
        {
          path: '/repo',
          status: 'changed',
          branch: 'main',
          headSha: 'abc1234',
          statusLines: [' M src/app.ts'],
          statusFingerprints: ['src/app.ts\u0000worktree:same-content\u0000status: M'],
          statusLineCount: 1,
          untrackedFileCount: 0,
          diffStat: 'src/app.ts | 2 ++',
          error: null,
        },
      ],
    };
    const after: LinkedRepoSnapshot = {
      generatedAt: 2,
      linkedDirs: [
        {
          path: '/repo',
          status: 'changed',
          branch: 'main',
          headSha: 'abc1234',
          statusLines: ['M  src/app.ts'],
          statusFingerprints: ['src/app.ts\u0000worktree:same-content\u0000status:M '],
          statusLineCount: 1,
          untrackedFileCount: 0,
          diffStat: 'src/app.ts | 2 ++',
          error: null,
        },
      ],
    };

    const summary = summarizeLinkedRepoChanges(before, after);

    expect(summary).toMatchObject({
      changedFileCount: 1,
      newStatusLineCount: 1,
      preexistingChangeCount: 0,
    });
    expect(summary.linkedDirs[0]).toMatchObject({
      changedFileCount: 1,
      newStatusLineCount: 1,
      preexistingChangeCount: 0,
    });
  });

  it('does not classify a repo as unreadable when status output exceeds maxBuffer', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'repo-changes-maxbuffer-'));
    try {
      await execFileAsync('git', ['init', '-q'], { cwd: dir });
      await execFileAsync(
        'git',
        ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '--allow-empty', '-m', 'init'],
        { cwd: dir },
      );
      for (let index = 0; index < 30; index += 1) {
        await writeFile(join(dir, `untracked-file-with-a-fairly-long-name-${index}.txt`), 'content');
      }

      const snapshot = await captureLinkedRepoSnapshot([dir], { maxBuffer: 200 });

      expect(snapshot.linkedDirs[0]?.error).toBeNull();
      expect(snapshot.linkedDirs[0]?.status).not.toBe('error');
      expect(snapshot.linkedDirs[0]?.status).not.toBe('not_git');
      expect(snapshot.linkedDirs[0]?.statusLineCount).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
