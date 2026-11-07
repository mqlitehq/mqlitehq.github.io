import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderSite, sourceMetadata, BUNDLE_FILES, checkClaims } from './build.mjs';
import { renderFacts } from './facts.mjs';
import { translateHandwritten } from './i18n.mjs';
const site = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const canonical = [resolve(site, '../mqlite'), resolve(site, 'mqlite-src')].find(p => existsSync(resolve(p, 'docs/mcp.md')));
const read = (root, file) => readFileSync(resolve(root, file), 'utf8');
function put(root, file, value) { mkdirSync(dirname(resolve(root, file)), { recursive: true }); writeFileSync(resolve(root, file), value); }
function snapshot(t) {
  const root = mkdtempSync(resolve(tmpdir(), 'mqlite-agent-guide-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const contract = JSON.parse(read(site, 'tools/agent-contract.json'));
  const files = new Set([...Object.keys(contract.files), ...BUNDLE_FILES.map(n => `docs/${n}`), 'internal/version/version.go', 'CHANGELOG.md']);
  for (const file of files) { mkdirSync(dirname(resolve(root, file)), { recursive: true }); copyFileSync(resolve(canonical, file), resolve(root, file)); }
  return root;
}
test('agent entry points install a matching latest pair and identify deployed capabilities', () => {
  const { outputs } = renderSite(canonical);
  for (const locale of ['', 'zh-CN/']) {
    const agents = String(outputs.get(`${locale}agents.html`));
    assert.match(agents, /go install github\.com\/mqlitehq\/mqlite\/cmd\/mqlite@latest github\.com\/mqlitehq\/mqlite\/cmd\/mqlite-mcp@latest/);
    assert.ok(agents.includes('serverInfo.version'));
    assert.ok(!agents.includes('mqlite-mcp --version'));
    assert.ok(!agents.includes('{{BROKER_PORT}}'));
    assert.ok(agents.includes('https://mqlitehq.github.io/api.html'));
    for (const file of ['index.html', 'agents.html', 'llms.txt']) assert.doesNotMatch(String(outputs.get(locale + file)), /github\.com\/mqlitehq\/mqlite(?:-go)?(?:\/cmd\/mqlite(?:-mcp)?)?@v\d+\.\d+\.\d+/);
  }
});
test('a source-only version bump updates both languages without claiming main was released', (t) => {
  const root = snapshot(t);
  put(root, 'internal/version/version.go', 'package version\nconst Version = "9.9.0"\n');
  const { outputs, metadata } = renderSite(root);
  assert.equal(metadata.sourceVersion, '9.9.0');
  assert.equal(metadata.latestRelease, sourceMetadata(canonical).latestRelease);
  for (const locale of ['', 'zh-CN/']) for (const file of ['index.html', 'agents.html', 'llms.txt']) {
    const text = String(outputs.get(locale + file));
    assert.ok(text.includes('v9.9.0'), locale + file);
    assert.ok(!text.includes('/releases/tag/v9.9.0'), locale + file);
    assert.ok(text.includes(locale ? '未发布' : 'unreleased'), locale + file);
  }
});
test('a new stable documentation baseline updates links while historical boundaries stay fixed', (t) => {
  const root = snapshot(t);
  put(root, 'internal/version/version.go', 'package version\nconst Version = "9.9.0"\n');
  put(root, 'CHANGELOG.md', '# Changelog\n\n## Unreleased\n\n## v9.9.0 — 2030-01-01\n\n' + read(root, 'CHANGELOG.md'));
  const { outputs, metadata } = renderSite(root);
  assert.equal(metadata.latestRelease, 'v9.9.0');
  for (const locale of ['', 'zh-CN/']) {
    const agents = String(outputs.get(locale + 'agents.html'));
    assert.ok(agents.includes('/releases/tag/v9.9.0'));
    assert.ok(agents.includes('/tree/v9.9.0/docs'));
    assert.ok(agents.includes('@latest'));
    assert.ok(!agents.includes('mqlite-mcp@v9.9.0'));
    assert.ok(agents.includes('v0.3.3'));
    assert.ok(agents.includes('v0.3.2'));
  }
  assert.ok(String(outputs.get('index.html')).includes('v0.4.2 still reclaims'));
  for (const file of ['index.html', 'llms.txt', 'zh-CN/index.html', 'zh-CN/llms.txt']) {
    assert.doesNotMatch(String(outputs.get(file)), /Unreleased main|未发布的 main/);
  }
});
test('a dated release candidate cannot replace an existing stable documentation baseline', (t) => {
  const root = snapshot(t);
  put(root, 'CHANGELOG.md', '## v9.9.0-rc.1 — 2030-01-01\n\n' + read(root, 'CHANGELOG.md'));
  assert.equal(sourceMetadata(root).latestRelease, sourceMetadata(canonical).latestRelease);
});
test('current install instructions cannot silently reintroduce a stale pinned module', (t) => {
  const { outputs, metadata } = renderSite(canonical);
  const root = mkdtempSync(resolve(tmpdir(), 'mqlite-agent-pins-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [file, content] of outputs) put(root, file, content);
  checkClaims(metadata, root);
  put(root, 'agents.html', read(root, 'agents.html').replace('cmd/mqlite-mcp@latest', 'cmd/mqlite-mcp@v0.4.2'));
  assert.throws(() => checkClaims(metadata, root), /installation commands must use @latest/);
});

test('latest examples configure their port even when main defaults differ from the installed release', () => {
  const metadata = { ...sourceMetadata(canonical), brokerPort: '16754', schemaVersion: 'future_schema', goVersion: '1.25' };
  const template = read(site, 'templates/index.html');
  const catalog = JSON.parse(read(site, 'i18n/zh-CN/interface.json'));
  for (const text of [template, translateHandwritten(template, catalog, 'index.html')]) {
    const rendered = renderFacts(text, metadata);
    assert.ok(rendered.includes('mqlite serve --addr :16754 &'));
    assert.ok(rendered.includes('ghcr.io/mqlitehq/mqlite:latest serve --addr :16754'));
    assert.ok(rendered.includes('-p 127.0.0.1:16754:16754'));
    assert.ok(rendered.includes('localhost:16754/mqlite.v1.AdminService/CreateQueue'));
  }
  const english = renderFacts(read(site, 'templates/llms.txt'), metadata);
  const chinese = renderFacts(read(site, 'i18n/zh-CN/llms.txt'), metadata, true);
  assert.match(english, /latest supported release is v[\d.]+\. The documented main source\nuses default port 16754 and schema token future_schema/);
  assert.match(chinese, /最新受支持版本为 v[\d.]+。当前文档对应的 main 源码使用默认端口 16754，schema token 为 future_schema/);
});
