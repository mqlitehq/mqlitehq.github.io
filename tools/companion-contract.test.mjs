import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCompanionContract } from './companion-contract.mjs';

const site = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const canonical = [process.env.MQLITE_COMPANION_SRC, resolve(site, '../mqlite-go'), resolve(site, 'mqlite-go-src')]
  .filter(Boolean).find((root) => existsSync(resolve(root, 'go.mod')));
const manifest = JSON.parse(readFileSync(resolve(site, 'tools/companion-contract.json'), 'utf8'));
function put(root, file, text) {
  const path = resolve(root, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}
function fixture(t) {
  assert.ok(canonical, 'canonical mqlite-go checkout is required');
  const root = mkdtempSync(resolve(tmpdir(), 'mqlite-companion-contract-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sdk = resolve(root, 'sdk'), website = resolve(root, 'site');
  for (const file of Object.keys(manifest.files)) {
    mkdirSync(dirname(resolve(sdk, file)), { recursive: true });
    copyFileSync(resolve(canonical, file), resolve(sdk, file));
  }
  put(website, 'tools/companion-contract.json', JSON.stringify(manifest));
  return { sdk, website, check: () => checkCompanionContract(website, sdk) };
}

test('the real reviewed companion contract has a single source Go floor', () => {
  assert.ok(canonical, 'canonical mqlite-go checkout is required');
  const checked = checkCompanionContract(site, canonical);
  assert.equal(checked.reviewedRevision, manifest.reviewedRevision);
  assert.equal(checked.filesReviewed, Object.keys(manifest.files).length);
  assert.match(checked.goVersion, /^[1-9]\d*\.\d+(?:\.\d+)?$/);
  assert.match(checked.sourceDigest, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(checked).includes(canonical));
});

test('same-name runtime behavior changes require review', (t) => {
  const f = fixture(t), file = 'client.go';
  const before = readFileSync(resolve(f.sdk, file), 'utf8');
  const after = before.replace('return http.ErrUseLastResponse', 'return nil');
  assert.notEqual(before, after, 'change the actual HTTP redirect policy');
  put(f.sdk, file, after);
  assert.throws(f.check, /client\.go changed/);
});

test('new and deleted runtime packages fail, including a same-count replacement', (t) => {
  const f = fixture(t), added = 'newruntime/driver.go';
  put(f.sdk, added, 'package newruntime\n');
  assert.throws(f.check, /source inventory changed.*added: newruntime\/driver\.go/);
  rmSync(resolve(f.sdk, 'internal/wire/responses.go'));
  assert.throws(f.check, /source inventory changed.*added: newruntime\/driver\.go.*removed: internal\/wire\/responses\.go/);
  rmSync(resolve(f.sdk, added));
  assert.throws(f.check, /source inventory changed.*removed: internal\/wire\/responses\.go/);
});

test('the Go floor and its actual CI compatibility gate both require review', (t) => {
  const f = fixture(t), current = f.check().goVersion;
  const [major, minor] = current.split('.'), next = `${major}.${Number(minor) + 1}`;
  for (const [file, from, to] of [
    ['go.mod', `go ${current}`, `go ${next}`],
    ['.github/workflows/ci.yml', `go: ${current}.15`, `go: ${next}.15`],
    ['.github/workflows/release.yml', 'go-version: stable', `go-version: ${current}.15`],
  ]) {
    const before = readFileSync(resolve(f.sdk, file), 'utf8');
    const after = before.replace(from, to);
    assert.notEqual(before, after, `change an actual floor or release declaration: ${file}`);
    put(f.sdk, file, after);
    assert.throws(f.check, /changed; review/);
    put(f.sdk, file, before);
  }
  f.check();
});

test('a future dependency checksum file cannot be added without review', (t) => {
  const f = fixture(t), file = 'go.sum';
  if (Object.hasOwn(manifest.files, file)) {
    rmSync(resolve(f.sdk, file));
    assert.throws(f.check, /source inventory changed.*removed: go\.sum/);
  } else {
    put(f.sdk, file, 'example.invalid/dependency v1.0.0 h1:not-reviewed\n');
    assert.throws(f.check, /source inventory changed.*added: go\.sum/);
  }
});

test('a release-string-only change is automatic but logic in version.go remains reviewed', (t) => {
  const f = fixture(t), file = 'internal/version/version.go', before = f.check();
  const original = readFileSync(resolve(f.sdk, file), 'utf8');
  const changed = original.replace(/^const Version = "[^"]+"$/m, 'const Version = "99.99.99"');
  assert.notEqual(changed, original);
  put(f.sdk, file, changed);
  assert.deepEqual(f.check(), before);
  put(f.sdk, file, changed + '\nfunc NewRuntimeBehavior() bool { return true }\n');
  assert.throws(f.check, /internal\/version\/version\.go changed/);
  rmSync(resolve(f.sdk, file));
  assert.throws(f.check, /source inventory changed.*removed: internal\/version\/version\.go/);
});

test('test helpers stay outside the shipped source contract', (t) => {
  const f = fixture(t), before = f.check();
  put(f.sdk, 'client_new_test.go', 'package mqlite\n');
  put(f.sdk, 'test/size/newprobe/main.go', 'package main\nfunc main() {}\n');
  assert.deepEqual(f.check(), before);
});

test('README scope and dependency promises require semantic review', (t) => {
  const f = fixture(t), file = 'README.md';
  const before = readFileSync(resolve(f.sdk, file), 'utf8');
  const after = before.replace('remote-only Go client', 'embedded Go client');
  assert.notEqual(before, after);
  put(f.sdk, file, after);
  assert.throws(f.check, /README\.md changed/);
});

test('missing, malformed or incompatible review manifests fail closed', (t) => {
  const f = fixture(t), file = 'tools/companion-contract.json';
  rmSync(resolve(f.website, file));
  assert.throws(f.check, /missing tools\/companion-contract\.json/);
  put(f.website, file, '{');
  assert.throws(f.check, /cannot parse/);
  put(f.website, file, JSON.stringify({ ...manifest, formatVersion: 99 }));
  assert.throws(f.check, /unsupported review manifest/);
});

test('missing or duplicated Go floor directives are never accepted', (t) => {
  const f = fixture(t), file = 'go.mod', before = readFileSync(resolve(f.sdk, file), 'utf8');
  put(f.sdk, file, before.replace(/^go .+$/m, ''));
  assert.throws(f.check, /single Go version directive/);
  put(f.sdk, file, before + '\ngo 99.99\n');
  assert.throws(f.check, /single Go version directive/);
});
