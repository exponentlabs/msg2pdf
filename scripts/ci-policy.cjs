const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs');

function requiresNative(paths) {
  // An unknown/empty comparison must never silently bypass native verification.
  return (
    paths.length === 0 ||
    paths.some(
      (path) =>
        !(
          (/^[^/]+\.md$/.test(path) || path.startsWith('docs/') || path.startsWith('.github/')) &&
          path.endsWith('.md')
        ),
    )
  );
}

function assertGate(checks, nativeRequired, nativeResult) {
  assert.equal(checks, 'success', 'Source/documentation checks did not succeed');
  assert.ok(['true', 'false'].includes(nativeRequired), 'Missing change-classification result');
  assert.equal(
    nativeResult,
    nativeRequired === 'true' ? 'success' : 'skipped',
    'Required native verification did not succeed',
  );
}

function assertInstallerBuild(build, tag, release, provenance, repository, releaseTag) {
  assert.equal(build.repository.full_name, repository, 'Unexpected build repository');
  assert.equal(build.head_repository.full_name, repository, 'Fork builds cannot be published');
  assert.equal(build.status, 'completed');
  assert.equal(build.conclusion, 'success');
  assert.equal(build.event, 'workflow_dispatch', 'Only explicitly requested installers qualify');
  assert.equal(build.head_branch, 'main');
  assert.equal(build.path, '.github/workflows/ci.yml');
  assert.equal(build.head_sha, tag.sha, 'Tag does not match the installer build');
  assert.ok(releaseTag, 'Missing release tag');
  assert.equal(release.tagName, releaseTag);
  assert.equal(release.isDraft, true);
  assert.equal(provenance.schemaVersion, 1);
  assert.equal(provenance.kind, 'review-installers');
  assert.equal(provenance.repository, repository);
  assert.equal(provenance.ref, 'refs/heads/main');
  assert.equal(provenance.sha, build.head_sha);
  assert.equal(provenance.runId, String(build.id));
  assert.equal(
    provenance.runAttempt,
    String(build.run_attempt),
    'Re-run all jobs for new provenance',
  );
}

function main(command) {
  const env = process.env;
  if (command === 'changes') {
    const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
    const base = event.pull_request?.base?.sha ?? event.before;
    let native = true;
    if (env.GITHUB_EVENT_NAME !== 'workflow_dispatch' && /^[a-f0-9]{40}$/.test(base ?? '')) {
      try {
        // --no-renames includes both old and new paths when a file changes category.
        const paths = execFileSync(
          'git',
          ['diff', '--no-renames', '--name-only', '-z', base, 'HEAD'],
          {
            encoding: 'utf8',
          },
        )
          .split('\0')
          .filter(Boolean);
        native = requiresNative(paths);
      } catch {
        console.warn('Change comparison unavailable; running the full native matrix.');
      }
    }
    appendFileSync(env.GITHUB_OUTPUT, `native=${native}\n`);
    console.log(native ? 'Native verification required.' : 'Documentation-only verification.');
  } else if (command === 'provenance') {
    assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch');
    writeFileSync(
      'installer-build.json',
      JSON.stringify(
        {
          schemaVersion: 1,
          kind: 'review-installers',
          repository: env.GITHUB_REPOSITORY,
          ref: env.GITHUB_REF,
          sha: env.GITHUB_SHA,
          runId: env.GITHUB_RUN_ID,
          runAttempt: env.GITHUB_RUN_ATTEMPT,
        },
        null,
        2,
      ),
    );
  } else if (command === 'verify-release') {
    const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
    assertInstallerBuild(
      read('build.json'),
      read('tag.json'),
      read('release.json'),
      read('artifacts/installer-source/installer-build.json'),
      env.GITHUB_REPOSITORY,
      env.RELEASE_TAG,
    );
  } else if (command === 'gate') {
    assertGate(env.CHECKS_RESULT, env.NATIVE_REQUIRED, env.NATIVE_RESULT);
  } else {
    throw new Error(`Unknown CI policy command: ${command}`);
  }
}

module.exports = { requiresNative, assertGate, assertInstallerBuild };
if (require.main === module) main(process.argv[2]);
