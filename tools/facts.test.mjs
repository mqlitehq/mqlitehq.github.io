import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderFacts, checkFactPair } from './facts.mjs';

const metadata = {
  sourceVersion: '0.4.2', latestRelease: 'v0.4.2', hasUnreleasedChanges: false,
  brokerPort: '6754', schemaVersion: '7', goVersion: '1.21',
  mcpTools: ['send', 'receive'], routes: ['/send', '/receive', '/settle'], cliCommands: ['serve'],
};

test('one fact set renders HTML, machine Markdown and Chinese prompts without rewriting historical literals', () => {
  const input = '<p>source {{SOURCE_VERSION}}{{SOURCE_STATUS}}; release {{LATEST_RELEASE}}</p>\n'
    + 'Go {{GO_VERSION}}, port {{BROKER_PORT}}, schema {{SCHEMA_VERSION}}.\n'
    + '{{TOOL_COUNT}} tools / {{ROUTE_COUNT}} routes / {{CLI_COUNT}} commands.\n'
    + 'Since v0.3.2. Install @latest; pin @v0.4.1 when reproducing that release.';
  const expected = '<p>source v0.4.2; release v0.4.2</p>\n'
    + 'Go 1.21, port 6754, schema 7.\n'
    + '2 tools / 3 routes / 1 commands.\n'
    + 'Since v0.3.2. Install @latest; pin @v0.4.1 when reproducing that release.';
  assert.equal(renderFacts(input, metadata), expected);
  assert.equal(renderFacts(input, metadata, true), expected);
});

test('an unreleased source and a published release remain distinct through version changes', () => {
  const text = '{{SOURCE_VERSION}}{{SOURCE_STATUS}} / {{LATEST_RELEASE}}';
  assert.equal(renderFacts(text, { ...metadata, sourceVersion: '0.5.0' }),
    'v0.5.0 with unreleased changes / v0.4.2');
  assert.equal(renderFacts(text, { ...metadata, sourceVersion: '0.5.0' }, true),
    'v0.5.0（含未发布变更） / v0.4.2');
  assert.equal(renderFacts(text, { ...metadata, hasUnreleasedChanges: true }),
    'v0.4.2 with unreleased changes / v0.4.2');
  assert.equal(renderFacts(text, { ...metadata, hasUnreleasedChanges: true }, true),
    'v0.4.2（含未发布变更） / v0.4.2');
  assert.equal(renderFacts(text, { ...metadata, sourceVersion: '0.5.0', latestRelease: 'v0.5.0' }),
    'v0.5.0 / v0.5.0');
});

test('port, schema, Go floor and capability counts come from the supplied canonical facts', () => {
  const changed = {
    ...metadata, brokerPort: 7042, schemaVersion: 'schema_8.rc-1', goVersion: '1.22.3',
    mcpTools: ['a', 'b', 'c'], routes: ['/one'], cliCommands: [],
  };
  assert.equal(renderFacts('{{BROKER_PORT}} {{SCHEMA_VERSION}} {{GO_VERSION}} {{TOOL_COUNT}} {{ROUTE_COUNT}} {{CLI_COUNT}}', changed),
    '7042 schema_8.rc-1 1.22.3 3 1 0');
  assert.equal(renderFacts('{{BROKER_PORT}} {{BROKER_PORT}}', metadata), '6754 6754');
});

test('unknown fact placeholders fail closed instead of silently reaching published pages', () => {
  for (const token of ['BROKER_PRORT', 'FUTURE_FACT', 'SOURCE_VERSION_2', '_NOT_FACT']) {
    assert.throws(() => renderFacts(`before {{${token}}} after`, metadata), /unknown fact placeholder/);
  }
  // Ordinary JSON and other template syntaxes are not interpreted as facts.
  assert.equal(renderFacts('{"port":6754} {{ .Field }}', metadata), '{"port":6754} {{ .Field }}');
});

test('malformed or injectable scalar facts cannot become HTML or prompt text', () => {
  const mutations = [
    ['sourceVersion', 'SOURCE_VERSION', '0.4.2<script>alert(1)</script>'],
    ['sourceVersion', 'SOURCE_VERSION', 'v0.4.2'],
    ['sourceVersion', 'SOURCE_VERSION', '0.4.2\n'],
    ['latestRelease', 'LATEST_RELEASE', 'v0.4.2" onload="alert(1)'],
    ['latestRelease', 'LATEST_RELEASE', 'latest'],
    ['latestRelease', 'LATEST_RELEASE', 'v0.4.2\n'],
    ['brokerPort', 'BROKER_PORT', '6754</code>'],
    ['brokerPort', 'BROKER_PORT', 0],
    ['brokerPort', 'BROKER_PORT', 65536],
    ['brokerPort', 'BROKER_PORT', '6.754e3'],
    ['brokerPort', 'BROKER_PORT', '6754\n'],
    ['brokerPort', 'BROKER_PORT', Infinity],
    ['schemaVersion', 'SCHEMA_VERSION', '7" data-injected="yes'],
    ['schemaVersion', 'SCHEMA_VERSION', -1],
    ['schemaVersion', 'SCHEMA_VERSION', 1.5],
    ['schemaVersion', 'SCHEMA_VERSION', '7\n'],
    ['goVersion', 'GO_VERSION', '1.21\n<script>'],
    ['goVersion', 'GO_VERSION', 'go1.21'],
    ['goVersion', 'GO_VERSION', '1.21\n'],
    ['hasUnreleasedChanges', 'SOURCE_STATUS', 'false'],
  ];
  for (const [field, token, value] of mutations) {
    assert.throws(() => renderFacts(`{{${token}}}`, { ...metadata, [field]: value }), /invalid .* fact/, field);
  }
  for (const [field, token] of [['mcpTools', 'TOOL_COUNT'], ['routes', 'ROUTE_COUNT'], ['cliCommands', 'CLI_COUNT']]) {
    assert.throws(() => renderFacts(`{{${token}}}`, { ...metadata, [field]: '99' }), /expected an array/);
  }
  assert.throws(() => renderFacts('{{SOURCE_VERSION}}', null), /metadata must be an object/);
  assert.throws(() => renderFacts('{{SOURCE_VERSION}}', metadata, 'zh-CN'), /locale flag must be boolean/);
  assert.throws(() => renderFacts('{{SOURCE_STATUS}}', { ...metadata, hasUnreleasedChanges: true, latestRelease: '<bad>' }), /invalid latestRelease fact/);
});

test('translations preserve fact identities even when source and release currently have the same number', () => {
  checkFactPair('source {{SOURCE_VERSION}}; release {{LATEST_RELEASE}}', '发布版 {{LATEST_RELEASE}}；源码 {{SOURCE_VERSION}}');
  assert.throws(() => checkFactPair('source {{SOURCE_VERSION}}', '源码 {{LATEST_RELEASE}}'), /fact placeholders differ/);
  assert.throws(() => checkFactPair('port {{BROKER_PORT}}', '端口 6754'), /fact placeholders differ/);
  assert.throws(() => checkFactPair('{{TOOL_COUNT}} tools', '{{TOOL_COUNT}} 个工具，{{TOOL_COUNT}}'), /fact placeholders differ/);
});
