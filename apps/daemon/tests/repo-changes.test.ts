import { describe, expect, it } from 'vitest';

import {
  captureLinkedRepoSnapshot,
  summarizeLinkedRepoChanges,
  type LinkedRepoSnapshot,
  type RunGit,
} from '../src/repo-changes.js';

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
        'src/app.ts\u0000worktree:app-worktree-hash',
        'src/new.ts\u0000worktree:new-worktree-hash',
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

  it('treats status-only transitions on the same path as pre-existing changes', () => {
    const before: LinkedRepoSnapshot = {
      generatedAt: 1,
      linkedDirs: [
        {
          path: '/repo',
          status: 'changed',
          branch: 'main',
          headSha: 'abc1234',
          statusLines: [' M src/app.ts'],
          statusFingerprints: ['src/app.ts\u0000worktree:same-content'],
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
          statusFingerprints: ['src/app.ts\u0000worktree:same-content'],
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
    });
    expect(summary.linkedDirs[0]).toMatchObject({
      changedFileCount: 1,
      newStatusLineCount: 0,
      preexistingChangeCount: 1,
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
      'src/file-449.ts\u0000worktree:hash-for-src/file-449.ts',
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
      newStatusLineCount: 0,
      preexistingChangeCount: 1,
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
});
