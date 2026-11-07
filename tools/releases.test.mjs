import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readReleaseTags, isReleaseTree } from './releases.mjs';

test('release tag discovery performs exactly one bounded read-only local Git command', () => {
  const calls = [];
  const tags = readReleaseTags('/canonical path/with spaces', (...args) => {
    calls.push(args);
    return 'v0.4.2\nv0.5.0-rc.1\n';
  });
  assert.deepEqual(tags, ['v0.4.2', 'v0.5.0-rc.1']);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ['git', ['-C', '/canonical path/with spaces', 'tag', '--list'], {
    encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }]);
});

test('non-version names are filtered while stable and valid prerelease names remain distinct', () => {
  const input = ['notes', 'docs/checkpoint', 'v1.2', 'v01.2.3', 'v1.2.3-01',
    'v1.2.3', 'v2.0.0-rc.1', 'v2.0.0-beta.0', 'v2.0.0+build.07'].join('\n');
  assert.deepEqual(readReleaseTags('/canonical', () => input),
    ['v1.2.3', 'v2.0.0-rc.1', 'v2.0.0-beta.0', 'v2.0.0+build.07']);
  // Selecting a supported stable release is the caller's separate operation.
  assert.deepEqual(readReleaseTags('/canonical', () => 'v2.0.0-rc.1\r\nv1.2.3\r\n'),
    ['v2.0.0-rc.1', 'v1.2.3']);
});

test('missing Git, a non-repository checkout and command timeout fail closed without fallback tags', () => {
  for (const error of [Object.assign(new Error('missing git'), { code: 'ENOENT' }),
    Object.assign(new Error('not a repository'), { status: 128 }),
    Object.assign(new Error('timeout'), { code: 'ETIMEDOUT', signal: 'SIGTERM' })]) {
    let calls = 0;
    assert.throws(() => readReleaseTags('/canonical', () => { calls++; throw error; }),
      /fetch canonical tags before build/);
    assert.equal(calls, 1);
  }
});

test('empty, malformed, oversized and non-text catalogs cannot establish a published baseline', () => {
  for (const value of ['', '\n', 'notes\ndocs/checkpoint\n', 'v0.4.2\n\nv0.4.1\n',
    ' v0.4.2\n', 'v0.4.2\t\n', 'v0.4.2\0\n', 'v0.4.2\n\u001b[31mwarning\n',
    'v0.4.2\nv0.4.2\n', 'v0.4.2\n' + 'x'.repeat(1024 * 1024),
    undefined, null, {}, Buffer.from('v0.4.2\n')]) {
    assert.throws(() => readReleaseTags('/canonical', () => value), /fetch canonical tags before build/);
  }
});

test('invalid root inputs fail before a process can be dispatched', () => {
  let calls = 0;
  for (const root of [undefined, null, '', '   ', 1, {}]) {
    assert.throws(() => readReleaseTags(root, () => { calls++; return 'v0.4.2\n'; }),
      /fetch canonical tags before build/);
  }
  assert.equal(calls, 0);
});

test('a release-tree match uses one bounded local diff with external transformations and optional writes disabled', () => {
  const calls = [], priorLocks = process.env.GIT_OPTIONAL_LOCKS;
  assert.equal(isReleaseTree('/canonical path', 'v0.4.2', (...args) => {
    calls.push(args);
    return '';
  }), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'git');
  assert.deepEqual(calls[0][1], ['-C', '/canonical path', 'diff', '--quiet', '--no-ext-diff', '--no-textconv', 'v0.4.2', '--']);
  const { env, ...options } = calls[0][2];
  assert.deepEqual(options, {
    encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(env.GIT_OPTIONAL_LOCKS, '0');
  assert.equal(process.env.GIT_OPTIONAL_LOCKS, priorLocks);
});

test('only a normal Git diff exit 1 means the tracked tree has unreleased changes', () => {
  assert.equal(isReleaseTree('/canonical', 'v0.4.2', () => { throw { status: 1, signal: null }; }), false);
  for (const error of [{ status: 128 }, { code: 'ENOENT' },
    { code: 'ETIMEDOUT', signal: 'SIGTERM' }, { status: 1, code: 'ETIMEDOUT' },
    { status: 1, signal: 'SIGTERM' }, { status: 1, killed: true }]) {
    assert.throws(() => isReleaseTree('/canonical', 'v0.4.2', () => { throw error; }),
      /fetch canonical tags before build/);
  }
});

test('release-tree checks refuse prerelease, malformed and option-like revisions before Git runs', () => {
  let calls = 0;
  for (const tag of ['v0.4.3-rc.1', 'v0.4.2+build.1', '0.4.2', 'v01.2.3',
    'v0.4.2\n', 'v0.4.2 --output=file', '--output=file', '', null]) {
    assert.throws(() => isReleaseTree('/canonical', tag, () => { calls++; return ''; }),
      /fetch canonical tags before build/);
  }
  assert.throws(() => isReleaseTree('', 'v0.4.2', () => { calls++; return ''; }),
    /fetch canonical tags before build/);
  assert.equal(calls, 0);
});
