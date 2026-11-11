import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, copyFileSync, symlinkSync, rmSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { auditSite } from './site-audit.mjs';
import { readSiteIndex, packageSite } from './site-index.mjs';
import { INTERFACE_FILES } from './i18n.mjs';

const site = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mq = [resolve(site, '../mqlite'), resolve(site, 'mqlite-src')].find((root) => existsSync(resolve(root, 'docs/mcp.md')));
const sdk = process.env.MQLITE_COMPANION_SRC ?? [resolve(site, '../mqlite-go'), resolve(site, 'mqlite-go-src')].find((root) => existsSync(resolve(root, 'go.mod')));

test('the real whole-site audit rejects both previously escaping cases in an isolated public tree', (t) => {
  const temporary = mkdtempSync(resolve(tmpdir(), 'mqlite-whole-site-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const root = resolve(temporary, 'site');
  const index = readSiteIndex(site);
  const files = new Set([...index.entries.map(({ output }) => output), ...INTERFACE_FILES,
    ...index.versionSources.filter((name) => name.startsWith('site/')).map((name) => name.slice(5)), 'i18n/zh-CN/manifest.json']);
  for (const file of files) {
    mkdirSync(dirname(resolve(root, file)), { recursive: true });
    copyFileSync(resolve(site, file), resolve(root, file));
  }
  symlinkSync(resolve(site, 'tools/node_modules'), resolve(root, 'tools/node_modules'));
  const check = () => auditSite(root, mq, { sdkRoot: sdk });
  const initial = check();
  assert.deepEqual(initial.errors, [], 'the unmodified copied website must pass');
  writeFileSync(resolve(root, 'download.html'), 'source v0.1.0; go install github.com/mqlitehq/mqlite/cmd/mqlite@v0.1.0');
  assert.ok(check().errors.some((error) => /unregistered: download.html/.test(error)));
  assert.throws(() => packageSite(root, resolve(temporary, 'package')), /unregistered: download.html/);
  rmSync(resolve(root, 'download.html'));
  const retention = readFileSync(resolve(root, 'retention.html'), 'utf8');
  const wrong = initial.latestRelease === 'v9.9.9' ? 'v9.9.8' : 'v9.9.9';
  assert.ok(retention.includes('</main>'));
  const staleClaim = `<p>This page describes ${wrong}, the latest supported release.</p>`;
  writeFileSync(resolve(root, 'retention.html'), retention.replace('</main>', `${staleClaim}</main>`));
  const errors = check().errors;
  assert.ok(errors.some((error) => /stale generated output: retention.html/.test(error)));
  assert.ok(errors.some((error) => error.includes(`retention.html: stale supported release ${wrong}`)));
});
