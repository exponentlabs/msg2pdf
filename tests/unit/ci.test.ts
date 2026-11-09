import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const { requiresNative, assertGate, assertInstallerBuild } = createRequire(import.meta.url)(
  '../../scripts/ci-policy.cjs',
) as {
  requiresNative: (paths: string[]) => boolean;
  assertGate: (checks: string, required: string, native: string) => void;
  assertInstallerBuild: (
    build: Record<string, unknown>,
    tag: Record<string, unknown>,
    release: Record<string, unknown>,
    provenance: Record<string, unknown>,
    repository: string,
    releaseTag: string,
  ) => void;
};
const { checkDocs } = createRequire(import.meta.url)('../../scripts/check-doc-links.cjs') as {
  checkDocs: (root: string) => { files: number; links: number };
};

describe('CI verification gates', () => {
  it('classifies real commit diffs and forces native checks for dispatch or missing history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'msg2pdf-ci-diff-'));
    const execute = promisify(execFile);
    const git = (...args: string[]) => execute('git', args, { cwd: root });
    const commit = (message: string) =>
      git(
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.test',
        '-c',
        'commit.gpgSign=false',
        'commit',
        '-qm',
        message,
      );
    try {
      await git('init', '-q');
      await writeFile(join(root, 'README.md'), 'Initial documentation\n');
      await git('add', '.');
      await commit('Initial');
      const base = (await git('rev-parse', 'HEAD')).stdout.trim();
      await writeFile(join(root, 'README.md'), 'Updated documentation\n');
      await git('add', '.');
      await commit('Docs');
      const event = join(root, 'event.json');
      const output = join(root, 'output.txt');
      const classify = async (before: string, name = 'push') => {
        await writeFile(event, JSON.stringify({ before }));
        await writeFile(output, '');
        await execute(
          process.execPath,
          [createRequire(import.meta.url).resolve('../../scripts/ci-policy.cjs'), 'changes'],
          {
            cwd: root,
            env: {
              ...process.env,
              GITHUB_EVENT_PATH: event,
              GITHUB_EVENT_NAME: name,
              GITHUB_OUTPUT: output,
            },
          },
        );
        return readFile(output, 'utf8');
      };
      expect(await classify(base)).toBe('native=false\n');
      expect(await classify(base, 'workflow_dispatch')).toBe('native=true\n');
      expect(await classify('1'.repeat(40))).toBe('native=true\n');
      await writeFile(join(root, 'runtime.ts'), 'export const changed = true;\n');
      await git('add', 'runtime.ts');
      await commit('Code');
      expect(await classify(base)).toBe('native=true\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('limits the lightweight path to documentation and runs native checks for unknown changes', () => {
    expect(
      requiresNative(['README.md', 'docs/adr/README.md', '.github/PULL_REQUEST_TEMPLATE.md']),
    ).toBe(false);
    for (const path of [
      'src/main/index.ts',
      'package.json',
      'pnpm-lock.yaml',
      '.github/workflows/ci.yml',
      'docs/example.json',
      'LICENSE',
    ])
      expect(requiresNative(['README.md', path])).toBe(true);
    expect(requiresNative([])).toBe(true);
    expect(requiresNative(['src/old.ts', 'docs/new.md'])).toBe(true);
  });

  it('does not turn failures, cancellations or skipped required jobs into a green aggregate check', () => {
    expect(() => assertGate('success', 'false', 'skipped')).not.toThrow();
    expect(() => assertGate('success', 'true', 'success')).not.toThrow();
    expect(() => assertGate('success', '', 'skipped')).toThrow();
    for (const result of ['failure', 'cancelled', 'skipped']) {
      expect(() => assertGate(result, 'false', 'skipped')).toThrow();
      expect(() => assertGate('success', 'true', result)).toThrow();
    }
  });

  it('accepts only an explicit, matching main-branch installer build and its current provenance', () => {
    const repository = 'example/project';
    const build = {
      id: 123,
      run_attempt: 1,
      repository: { full_name: repository },
      head_repository: { full_name: repository },
      status: 'completed',
      conclusion: 'success',
      event: 'workflow_dispatch',
      head_branch: 'main',
      path: '.github/workflows/ci.yml',
      head_sha: 'abc',
    };
    const provenance = {
      schemaVersion: 1,
      kind: 'review-installers',
      repository,
      ref: 'refs/heads/main',
      sha: 'abc',
      runId: '123',
      runAttempt: '1',
    };
    const tag = { sha: 'abc' };
    const release = { tagName: 'v1.0.0', isDraft: true };
    const validate = (b = build, t = tag, r = release, p = provenance) =>
      assertInstallerBuild(b, t, r, p, repository, 'v1.0.0');
    expect(() => validate()).not.toThrow();
    for (const patch of [
      { event: 'push' },
      { event: 'pull_request' },
      { head_branch: 'feature' },
      { conclusion: 'failure' },
      { status: 'in_progress' },
      { path: '.github/workflows/other.yml' },
      { repository: { full_name: 'other/project' } },
      { head_repository: { full_name: 'fork/project' } },
      { run_attempt: 2 },
    ])
      expect(() => validate({ ...build, ...patch })).toThrow();
    expect(() => validate(build, { sha: 'other' })).toThrow();
    expect(() => validate(build, tag, { ...release, isDraft: false })).toThrow();
    expect(() => validate(build, tag, { ...release, tagName: 'v2.0.0' })).toThrow();
    for (const patch of [
      { kind: 'source-only' },
      { sha: 'other' },
      { runId: '456' },
      { ref: 'refs/heads/feature' },
      { schemaVersion: 2 },
    ])
      expect(() => validate(build, tag, release, { ...provenance, ...patch })).toThrow();
  });

  it('checks repository-relative documentation links without fetching external URLs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'msg2pdf-doc-links-'));
    try {
      await mkdir(join(root, 'docs'));
      await writeFile(
        join(root, 'README.md'),
        '[Guide](docs/guide.md#section) [Web](https://example.test)',
      );
      await writeFile(
        join(root, 'docs/guide.md'),
        '[Home](../README.md)\n```md\n[Example](absent.md)\n```\n',
      );
      expect(checkDocs(root)).toEqual({ files: 2, links: 2 });
      await writeFile(join(root, 'docs/guide.md'), '[Missing](missing.md)');
      expect(() => checkDocs(root)).toThrow('missing.md');
      await writeFile(join(root, 'docs/guide.md'), '[Outside](../../outside.md)');
      expect(() => checkDocs(root)).toThrow('out-of-repository');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
