import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { readSiteIndex, checkSiteIndex, packageSite, readVersionSources } from './site-index.mjs';

const write = (root, file, text) => { mkdirSync(dirname(resolve(root, file)), { recursive: true }); writeFileSync(resolve(root, file), text); };
function fixture(t) {
  const root = mkdtempSync(resolve(tmpdir(), 'mqlite-index-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const metadata = { generatedFiles: ['index.html', 'site-metadata.json'], locales: ['en'], defaultLocale: 'en' };
  const index = { formatVersion: 1, entries: [
    { output: 'index.html', locale: 'en', owner: 'English template and shared facts', policy: 'generated', sources: ['site/templates/index.html'] },
    { output: 'site-metadata.json', owner: 'Canonical source metadata', policy: 'generated', sources: ['site/templates/index.html'] },
  ], versionSources: ['site/templates/index.html'] };
  write(root, 'index.html', '<h1>Example</h1>');
  write(root, 'site-metadata.json', JSON.stringify(metadata));
  write(root, 'tools/site-index.json', JSON.stringify(index));
  write(root, 'templates/index.html', '<h1>Example</h1>');
  return { root, index, metadata };
}

test('an extra unmarked HTML page fails both review and packaging rather than joining a glob', (t) => {
  const { root, index, metadata } = fixture(t);
  write(root, 'download.html', 'source v0.1.0; go install github.com/mqlitehq/mqlite/cmd/mqlite@v0.1.0');
  assert.throws(() => checkSiteIndex(index, root, metadata), /unregistered: download.html/);
  assert.throws(() => packageSite(root, resolve(root, '_site')), /unregistered: download.html/);
});

test('a new locale directory and an unregistered nested asset are discovered independently', (t) => {
  const { root, index, metadata } = fixture(t);
  write(root, 'fr/index.html', '<h1>Unreviewed translation</h1>');
  write(root, 'assets/new/icon.svg', '<svg/>');
  assert.throws(() => checkSiteIndex(index, root, metadata), /assets\/new\/icon.svg, fr\/index.html/);
});

test('missing outputs and missing generated ownership fail even if the remaining page is fresh', (t) => {
  const { root, index, metadata } = fixture(t);
  assert.throws(() => checkSiteIndex(index, root, { ...metadata, generatedFiles: ['index.html'] }), /generated ownership differs/);
  rmSync(resolve(root, 'index.html'));
  assert.throws(() => checkSiteIndex(index, root, metadata), /missing: index.html/);
});

test('a registered translation must have the complete English page inventory', (t) => {
  const { root, index, metadata } = fixture(t);
  assert.throws(() => checkSiteIndex(index, root, { ...metadata, locales: ['en', 'zh-CN'] }), /zh-CN: public page correspondence/);
});

test('a newly registered static HTML page cannot omit its locale to evade correspondence', (t) => {
  const { root, index, metadata } = fixture(t);
  const text = '<h1>English only</h1>';
  write(root, 'faq.html', text);
  index.entries.push({ output: 'faq.html', policy: 'reviewed-static', owner: 'Reviewed FAQ source and facts', sources: ['site/faq.html'], sha256: createHash('sha256').update(text).digest('hex') });
  assert.throws(() => checkSiteIndex(index, root, metadata), /faq.html: page must declare a published locale/);
  index.entries.at(-1).locale = 'zh-CN';
  assert.throws(() => checkSiteIndex(index, root, { ...metadata, locales: ['en', 'zh-CN'] }), /locale path differs/);
});

test('hand-maintained public content needs a reviewed fingerprint', (t) => {
  const { root, index, metadata } = fixture(t);
  write(root, 'assets/banner.js', 'const release = "latest";');
  index.entries.push({ output: 'assets/banner.js', policy: 'reviewed-static', owner: 'Reviewed site behavior source', sources: ['site/assets/banner.js'], sha256: createHash('sha256').update('const release = "latest";').digest('hex') });
  checkSiteIndex(index, root, metadata);
  write(root, 'assets/banner.js', 'const release = "v0.1.0";');
  assert.throws(() => checkSiteIndex(index, root, metadata), /static content changed/);
});

test('unsafe and duplicate paths cannot enter the publishing index', (t) => {
  const { root, index } = fixture(t);
  for (const output of ['../private.html', '/private.html', 'tools/private.html', 'assets/../private.html', 'assets\\private.html', 'index.html']) {
    write(root, 'tools/site-index.json', JSON.stringify({ ...index, entries: [...index.entries, { ...index.entries[0], output }] }));
    assert.throws(() => readSiteIndex(root), /invalid|duplicate|internal/);
  }
});

test('a public symlink and a source symlink cannot bypass source or output ownership', (t) => {
  const { root, index, metadata } = fixture(t);
  symlinkSync(resolve(root, 'templates/index.html'), resolve(root, 'extra.html'));
  assert.throws(() => checkSiteIndex(index, root, metadata), /symbolic public candidate/);
  rmSync(resolve(root, 'extra.html'));
  rmSync(resolve(root, 'templates/index.html'));
  symlinkSync(resolve(root, 'index.html'), resolve(root, 'templates/index.html'));
  assert.throws(() => readVersionSources(index, root), /expected a regular source file/);
});

test('new mapped prose cannot be silently omitted from the version review ledger', (t) => {
  const { root, index } = fixture(t);
  for (const extension of ['html', 'json', 'mjs', 'js']) {
    write(root, `templates/unreviewed.${extension}`, 'Download v0.1.0');
    index.entries[0].sources = ['site/templates/index.html', `site/templates/unreviewed.${extension}`];
    assert.throws(() => readVersionSources(index, root), /content source is missing from version review/);
  }
});
