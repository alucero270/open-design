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
      throw new Error(`unexpected git command: ${command}`);
    };

    const snapshot = await captureLinkedRepoSnapshot(['/repo'], { runGit });

    expect(snapshot.linkedDirs[0]).toMatchObject({
      path: '/repo',
      status: 'changed',
      branch: 'main',
      headSha: 'abc1234',
      statusLines: [' M src/app.ts', '?? src/new.ts'],
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
});
