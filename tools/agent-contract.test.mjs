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

test('normative guidance changes require explicit agent review', (t) => {
  const f = fixture(t), file = 'docs/mcp.md';
  put(f.mq, file, readFileSync(resolve(f.mq, file), 'utf8') + '\nChanged authorization semantics.\n');
  assert.throws(f.check, /docs\/mcp\.md changed/);
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
