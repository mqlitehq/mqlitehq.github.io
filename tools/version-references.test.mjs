import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectVersionReferences, checkVersionReferences } from './version-references.mjs';

const metadata = { latestRelease: 'v0.4.2', goVersion: '1.21' };
const reviewed = (sources, kind = 'historical', extra = {}) => collectVersionReferences(sources)
  .map(({ source, text, occurrence }) => ({ source, text, occurrence, kind, reason: 'Reviewed literal compatibility or release context.', ...extra }));

test('literal references cover both languages, Go floors, fixed image and Git references', () => {
  const sources = new Map([
    ['docs/deployment.md', '  Latest supported release: v0.4.2.\nimage: ghcr.io/mqlitehq/mqlite:0.4.2\nPin exact `0.4.2` in production.\n'],
    ['zh-CN/dependencies.md', '当前源码要求 Go ≥ 1.21。\n最低 Go &gt;= 1.21\nGo1.22rc1 is an upstream test compiler.\n'],
    ['links.txt', [
      'https://github.com/mqlitehq/mqlite/tree/v0.4.2/docs',
      'https://github.com/mqlitehq/mqlite/blob/7834304/docs/cli.md',
      'https://github.com/mqlitehq/mqlite-go/releases/tag/v0.1.1',
      'https://github.com/mqlitehq/mqlite/releases/download/v0.4.3-rc.1/archive.tar.gz',
    ].join('\n')],
  ]);
  const refs = collectVersionReferences(sources);
  assert.equal(refs.length, 10);
  assert.equal(refs[0].text, 'Latest supported release: v0.4.2.');
  assert.equal(refs[0].line, 1);
  assert.equal(refs[3].source, 'zh-CN/dependencies.md');
  assert.match(refs[0].key, /^docs\/deployment\.md:[0-9a-f]{64}:1$/);
});

test('loopback IPs, dynamic branch links and fact-only lines are not literal version references', () => {
  const sources = new Map([['templates/example.html', [
    'http://127.0.0.1:6754/', '192.168.0.10', 'Go 127.0.0.1',
    'Go ≥ {{GO_VERSION}}', '<a href="https://github.com/mqlitehq/mqlite/tree/{{LATEST_RELEASE}}/docs">release</a>',
    'https://github.com/mqlitehq/mqlite/blob/main/docs/mcp.md',
    'https://github.com/mqlitehq/mqlite/tree/master',
    'https://github.com/mqlitehq/mqlite/releases/tag/latest',
    'go install github.com/mqlitehq/mqlite/cmd/mqlite@latest',
  ].join('\n')]]);
  assert.deepEqual(collectVersionReferences(sources), []);
  assert.deepEqual(checkVersionReferences(sources, [], metadata), []);
});

test('release families and Go toolchain families are reviewed without treating Actions major pins as product versions', () => {
  const families = new Map([['history.md', 'The v0.3.x and v0.4.x release families differ.\nBuild with go1.21.x.\nimage: mqlite:0.4.2']]);
  assert.equal(collectVersionReferences(families).length, 3);
  const workflow = new Map([['workflow.yml', 'uses: actions/checkout@v7\nuses: actions/setup-go@v7']]);
  assert.deepEqual(collectVersionReferences(workflow), []);
});

test('a new occurrence of the same version cannot reuse an existing review entry', () => {
  const line = 'Compatibility begins at v0.3.2.';
  const initial = new Map([['guide.md', `${line}\n${line}`]]);
  const ledger = reviewed(initial);
  const refs = checkVersionReferences(initial, ledger, metadata);
  assert.deepEqual(refs.map((r) => r.occurrence), [1, 2]);
  assert.notEqual(refs[0].key, refs[1].key);
  assert.throws(() => checkVersionReferences(new Map([['guide.md', `${line}\n${line}\n${line}`]]), ledger, metadata),
    /unreviewed reference/);
  const newContext = new Map([['guide.md', `${line}\n${line}\nInstall v0.3.2 for this example.`]]);
  assert.throws(() => checkVersionReferences(newContext, ledger, metadata), /unreviewed reference/);
});

test('same-count context edits and removed references require another explicit review', () => {
  const sources = new Map([['guide.md', 'Released behavior in v0.4.2.']]);
  const ledger = reviewed(sources);
  const changed = new Map([['guide.md', 'Experimental behavior in v0.4.2.']]);
  assert.equal(collectVersionReferences(changed).length, collectVersionReferences(sources).length);
  assert.throws(() => checkVersionReferences(changed, ledger, metadata), /obsolete review entry/);
  assert.throws(() => checkVersionReferences(new Map([['guide.md', 'No literal version remains.']]), ledger, metadata),
    /obsolete review entry/);
});

test('current release and source-floor reviews cannot be borrowed after the canonical facts change', () => {
  const release = new Map([['guide.md', 'Current installation: v0.4.2.']]);
  const releaseLedger = reviewed(release, 'current-release', { reviewedValue: 'v0.4.2' });
  checkVersionReferences(release, releaseLedger, metadata);
  assert.throws(() => checkVersionReferences(release, releaseLedger, { ...metadata, latestRelease: 'v0.5.0' }), /current-release review is stale/);
  const floor = new Map([['dependencies.md', 'Documented source floor: Go 1.21.']]);
  const floorLedger = reviewed(floor, 'source-go', { reviewedValue: '1.21' });
  checkVersionReferences(floor, floorLedger, metadata);
  assert.throws(() => checkVersionReferences(floor, floorLedger, { ...metadata, goVersion: '1.22' }), /source-go review is stale/);
});

test('changing only reviewedValue cannot approve old release or source-floor text', () => {
  const release = new Map([['guide.md', 'Current release: v0.4.2.']]);
  const forgedRelease = reviewed(release, 'current-release', { reviewedValue: 'v0.5.0' });
  assert.throws(() => checkVersionReferences(release, forgedRelease, { ...metadata, latestRelease: 'v0.5.0' }), /current-release text is stale/);
  const floor = new Map([['dependencies.md', 'Current source floor: Go 1.21.']]);
  const forgedFloor = reviewed(floor, 'source-go', { reviewedValue: '1.22' });
  assert.throws(() => checkVersionReferences(floor, forgedFloor, { ...metadata, goVersion: '1.22' }), /source-go text is stale/);
  for (const text of ['Do not confuse v10.4.2 with the current version.', 'Historical v0.4.20.', 'Prerelease v0.4.2-rc.1.', 'Address 10.0.4.2']) {
    const sources = new Map([['guide.md', text]]);
    const ledger = reviewed(sources, 'current-release', { reviewedValue: metadata.latestRelease });
    // Addresses are not collected. Every collected, different version must fail.
    if (ledger.length) assert.throws(() => checkVersionReferences(sources, ledger, metadata), /current-release text is stale/);
  }
  const differentFloor = new Map([['dependencies.md', 'Use Go 1.210, not the intended toolchain.']]);
  assert.throws(() => checkVersionReferences(differentFloor,
    reviewed(differentFloor, 'source-go', { reviewedValue: metadata.goVersion }), metadata), /source-go text is stale/);
});

test('reviewed body values allow exact production pins and marked-up Go requirements in both languages', () => {
  const releases = new Map([['deploy.md', 'image: ghcr.io/mqlitehq/mqlite:0.4.2\n固定 `0.4.2` 用于生产环境。\nLatest: v0.4.2.']]);
  assert.equal(checkVersionReferences(releases,
    reviewed(releases, 'current-release', { reviewedValue: metadata.latestRelease }), metadata).length, 3);
  const floors = new Map([['dependencies.md', '源码最低版本 **`go 1.21`**。\nGo &gt;= <code>1.21</code>\nGo ≥ 1.21\nGo1.21.x toolchain matrix']]);
  assert.equal(checkVersionReferences(floors,
    reviewed(floors, 'source-go', { reviewedValue: metadata.goVersion }), metadata).length, 4);
});

test('historical and upstream literals survive source or release updates unchanged', () => {
  const sources = new Map([['history.md', 'v0.2.0 used another port.\nSDK source compatibility: Go 1.13.']]);
  const ledger = reviewed(sources);
  ledger[1].kind = 'upstream';
  const after = checkVersionReferences(sources, ledger, { latestRelease: 'v9.9.0', goVersion: '1.30' });
  assert.deepEqual(after.map(({ text }) => text), [...sources.values()][0].split('\n'));
  assert.deepEqual(after.map(({ kind }) => kind), ['historical', 'upstream']);
});

test('duplicate, unclassified or unexplained entries fail and report fresh physical locations', () => {
  const sources = new Map([['guide.md', '\n  Since v0.3.2.\n']]);
  const ledger = reviewed(sources);
  assert.throws(() => checkVersionReferences(sources, [...ledger, { ...ledger[0] }], metadata), /duplicate review entry/);
  assert.throws(() => checkVersionReferences(sources, [{ ...ledger[0], kind: 'guess' }], metadata), /unknown review kind/);
  assert.throws(() => checkVersionReferences(sources, [{ ...ledger[0], reason: ' ' }], metadata), /review reason is required/);
  assert.throws(() => checkVersionReferences(sources, [{ ...ledger[0], occurrence: 0 }], metadata), /invalid review entry/);
  assert.throws(() => checkVersionReferences(sources, [{ ...ledger[0], occurrence: '1' }], metadata), /invalid review entry/);
  const report = checkVersionReferences(new Map([['guide.md', '\n\n\nSince v0.3.2.']]), ledger, metadata);
  assert.equal(report[0].line, 4);
  assert.equal(report[0].kind, 'historical');
  assert.ok(report[0].reason);
});
