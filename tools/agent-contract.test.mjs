import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceAgentFacts, checkAgentContract } from './agent-contract.mjs';

const site = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const canonical = [resolve(site, '../mqlite'), resolve(site, 'mqlite-src')]
  .find((root) => existsSync(resolve(root, 'go.mod')));
const manifest = JSON.parse(readFileSync(resolve(site, 'tools/agent-contract.json'), 'utf8'));
function put(root, file, text) {
  const path = resolve(root, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}
function fixture(t) {
  assert.ok(canonical, 'canonical mqlite checkout is required');
  const root = mkdtempSync(resolve(tmpdir(), 'mqlite-agent-contract-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const mq = resolve(root, 'canonical'), website = resolve(root, 'site');
  for (const file of Object.keys(manifest.files)) {
    mkdirSync(dirname(resolve(mq, file)), { recursive: true });
    copyFileSync(resolve(canonical, file), resolve(mq, file));
  }
  put(website, 'tools/agent-contract.json', JSON.stringify(manifest));
  return { mq, website, check: () => checkAgentContract(website, mq) };
}

test('the reviewed real agent source contract and generated defaults match', () => {
  assert.ok(canonical, 'canonical mqlite checkout is required');
  const facts = sourceAgentFacts(canonical);
  assert.match(facts.goVersion, /^[1-9]\d*\.\d+(?:\.\d+)?$/);
  assert.match(facts.schemaVersion, /^[A-Za-z0-9._-]+$/);
  assert.ok(Number(facts.brokerPort) > 0 && Number(facts.brokerPort) <= 65535);
  const checked = checkAgentContract(site, canonical);
  assert.equal(checked.reviewedRevision, manifest.reviewedRevision);
  assert.equal(checked.filesReviewed, Object.keys(manifest.files).length);
  assert.match(checked.sourceDigest, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(checked).includes(canonical));
});

test('a same-name MCP parameter change cannot hide behind an unchanged tool count', (t) => {
  const f = fixture(t), name = 'cmd/mqlite-mcp/main.go';
  const before = readFileSync(resolve(f.mq, name), 'utf8');
  const after = before.replace('"max_messages"', '"max_items"');
  assert.notEqual(before, after);
  assert.equal([...before.matchAll(/name:\s+"/g)].length, [...after.matchAll(/name:\s+"/g)].length);
  put(f.mq, name, after);
  assert.throws(f.check, /cmd\/mqlite-mcp\/main\.go changed/);
});

test('a permission change is rejected while all route and tool names stay unchanged', (t) => {
  const f = fixture(t), name = 'server/server.go';
  const before = readFileSync(resolve(f.mq, name), 'utf8');
  const after = before.replace('h(wire.PathSubscribe, engine.KeyListen', 'h(wire.PathSubscribe, engine.KeyManage');
  assert.notEqual(before, after);
  put(f.mq, name, after);
  assert.throws(f.check, /server\/server\.go changed/);
  put(f.mq, name, before);
  const mcp = 'cmd/mqlite-mcp/main.go';
  const description = readFileSync(resolve(f.mq, mcp), 'utf8');
  const changed = description.replace('named subscription (listen)', 'named subscription (manage)');
  assert.notEqual(description, changed);
  put(f.mq, mcp, changed);
  assert.throws(f.check, /cmd\/mqlite-mcp\/main\.go changed/);
});

test('added and removed production files are rejected, including a same-count replacement', (t) => {
  const f = fixture(t);
  put(f.mq, 'engine/new_agent_behavior.go', 'package engine\n');
  assert.throws(f.check, /source inventory changed.*added: engine\/new_agent_behavior\.go/);
  rmSync(resolve(f.mq, 'engine/new_agent_behavior.go'));
  rmSync(resolve(f.mq, 'wire/wire.go'));
  assert.throws(f.check, /source inventory changed.*removed: wire\/wire\.go/);
  put(f.mq, 'wire/replacement.go', 'package wire\n');
  assert.throws(f.check, /source inventory changed.*added: wire\/replacement\.go.*removed: wire\/wire\.go/);
});

test('a bundled console behavior change is rejected without an embed Go change', (t) => {
  const f = fixture(t);
  const file = Object.keys(manifest.files).find((name) => /^server\/web\/assets\/.*\.js$/.test(name));
  assert.ok(file, 'the shipped console JavaScript must be reviewed');
  const embedSource = readFileSync(resolve(f.mq, 'server/console.go'));
  const before = readFileSync(resolve(f.mq, file), 'utf8');
  const after = before.replace('"/mqlite.v1.AdminService/Observe"', '"/mqlite.v1.AdminService/Status"');
  assert.notEqual(before, after, 'mutate an actual console RPC, not a comment');
  put(f.mq, file, after);
  assert.deepEqual(readFileSync(resolve(f.mq, 'server/console.go')), embedSource);
  assert.throws(f.check, /server\/web\/assets\/.*\.js changed/);
});

test('new and removed embedded web assets require review, even with the same asset count', (t) => {
  const f = fixture(t), added = 'server/web/assets/new-runtime.js';
  put(f.mq, added, 'globalThis.mqliteConsoleReadOnly = false;\n');
  assert.throws(f.check, /source inventory changed.*added: server\/web\/assets\/new-runtime\.js/);
  rmSync(resolve(f.mq, 'server/web/favicon.svg'));
  assert.throws(f.check, /source inventory changed.*added: server\/web\/assets\/new-runtime\.js.*removed: server\/web\/favicon\.svg/);
  rmSync(resolve(f.mq, added));
  assert.throws(f.check, /source inventory changed.*removed: server\/web\/favicon\.svg/);
});

test('floor, packaging and release policy changes require review', (t) => {
  const f = fixture(t), floor = sourceAgentFacts(f.mq).goVersion;
  const [major, minor] = floor.split('.');
  const port = sourceAgentFacts(f.mq).brokerPort;
  for (const [file, from, to] of [
    ['.github/workflows/ci.yml', `'${major}.${minor}.x'`, `'${major}.${Number(minor) + 1}.x'`],
    ['.goreleaser.yaml', 'goarch: [amd64, arm64]', 'goarch: [amd64]'],
    ['Dockerfile', `EXPOSE ${port}`, `EXPOSE ${Number(port) % 65535 + 1}`],
    ['.github/workflows/release.yml', 'release --clean', 'release --clean --skip=validate'],
    ['.github/dependabot.yml', 'versions: [">=1.36.2"]', 'versions: ["*"]'],
    ['.github/scripts/release_guard.py', 'check_ci(api, repository, target)', 'skip_ci(api, repository, target)'],
  ]) {
    const before = readFileSync(resolve(f.mq, file), 'utf8');
    const after = before.replace(from, to);
    assert.notEqual(before, after, `a real policy declaration must change: ${file}`);
    put(f.mq, file, after);
    assert.throws(f.check, /changed; review/);
    put(f.mq, file, before);
  }
  f.check();
});

test('a missing or invalid review manifest never silently disables the gate', (t) => {
  const f = fixture(t), file = 'tools/agent-contract.json';
  rmSync(resolve(f.website, file));
  assert.throws(f.check, /missing tools\/agent-contract\.json/);
  put(f.website, file, '{');
  assert.throws(f.check, /cannot parse/);
  put(f.website, file, JSON.stringify({ ...manifest, formatVersion: 99 }));
  assert.throws(f.check, /unsupported review manifest version/);
});

test('defaults are read from source while changed defaults still require contract review', (t) => {
  const f = fixture(t);
  const current = sourceAgentFacts(f.mq);
  const [major, minor] = current.goVersion.split('.');
  const nextGo = `${major}.${Number(minor) + 1}`;
  const nextSchema = `${current.schemaVersion}-next`;
  const nextPort = String(Number(current.brokerPort) % 65535 + 1);
  for (const [file, from, to, field, value] of [
    ['go.mod', `go ${current.goVersion}`, `go ${nextGo}`, 'goVersion', nextGo],
    ['engine/schema.go', `schemaVersion = "${current.schemaVersion}"`, `schemaVersion = "${nextSchema}"`, 'schemaVersion', nextSchema],
    ['internal/defaults/defaults.go', `BrokerPort = "${current.brokerPort}"`, `BrokerPort = "${nextPort}"`, 'brokerPort', nextPort],
  ]) {
    const before = readFileSync(resolve(f.mq, file), 'utf8');
    const after = before.replace(from, to);
    assert.notEqual(before, after);
    put(f.mq, file, after);
    assert.equal(sourceAgentFacts(f.mq)[field], value);
    assert.throws(f.check, /changed; review/);
    put(f.mq, file, before);
  }
  f.check();
});

test('test-only files and the project version constant do not require agent semantic review', (t) => {
  const f = fixture(t), before = f.check();
  put(f.mq, 'engine/new_behavior_test.go', 'package engine\n');
  put(f.mq, 'internal/version/version.go', 'package version\nconst Version = "9.9.9"\n');
  assert.deepEqual(f.check(), before);
});

test('all sixteen normative website documents require explicit review', (t) => {
  const f = fixture(t), documents = Object.keys(manifest.files).filter((file) => file.startsWith('docs/'));
  assert.equal(documents.length, 16);
  for (const file of documents) {
    const before = readFileSync(resolve(f.mq, file), 'utf8');
    put(f.mq, file, before + '\nChanged documented behavior.\n');
    assert.throws(f.check, /docs\/.*\.md changed/);
    put(f.mq, file, before);
  }
  f.check();
});

test('ambiguous or invalid generated source facts are rejected', (t) => {
  const f = fixture(t), name = 'internal/defaults/defaults.go';
  const before = readFileSync(resolve(f.mq, name), 'utf8');
  const current = sourceAgentFacts(f.mq);
  put(f.mq, name, before.replace(`BrokerPort = "${current.brokerPort}"`, 'BrokerPort = "65536"'));
  assert.throws(() => sourceAgentFacts(f.mq), /outside the TCP port range/);
  put(f.mq, name, before + '\nconst BrokerPort = "6755"\n');
  assert.throws(() => sourceAgentFacts(f.mq), /single broker port/);
});
