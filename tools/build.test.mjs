import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { PAGES, BUNDLE_FILES, GENERATED_FILES, sourceMetadata, renderSite, checkOutputs, checkClaims, checkLinks, rewriteLinks, rewriteMdLinks } from './build.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const site = resolve(here, '..');
const put = (root, path, text) => {
  mkdirSync(dirname(resolve(root, path)), { recursive: true });
  writeFileSync(resolve(root, path), text);
};

function fixture(t) {
  const root = mkdtempSync(resolve(tmpdir(), 'mqlite-site-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  put(root, 'internal/version/version.go', 'package version\nconst Version = "0.3.0"\n');
  put(root, 'CHANGELOG.md', '# Changelog\n\n## Unreleased\n\n### Behavior changes\n\n## v0.2.0 — 2026-07-11\n\n## v0.1.1 — 2026-06-23\n');
  put(root, 'wire/wire.go', Array.from({ length: 5 }, (_, i) => `PathMethod${i} = "/mqlite.v1.QueueService/Method${i}"`).join('\n'));
  put(root, 'cmd/mqlite-mcp/main.go', Array.from({ length: 5 }, (_, i) => `  name: "tool${i}",`).join('\n'));
  put(root, 'cmd/mqlite/main.go', '\tswitch cmd {\n' + Array.from({ length: 5 }, (_, i) => `\tcase "command${i}":`).join('\n') + '\n\tcase "version", "help", "-v", "--version", "-h", "--help", "create-subscription":\n\t}\n');
  for (const src of BUNDLE_FILES) {
    put(root, `docs/${src}`, `# Shared heading\n\nCanonical ${src}.\n\n[Operations](operations.md#backup)\n\n\`\`\`\nSend(scheduled)\nAbandon(delay_ms>0) -> scheduled\nCancel: never-delivered only\n\`\`\`\n`);
  }
  return root;
}

function materialize(t, outputs) {
  const root = mkdtempSync(resolve(tmpdir(), 'mqlite-site-output-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [file, content] of outputs) put(root, file, content);
  put(root, 'index.html', 'latest release v0.2.0; 5 routes, 5 tools, 5 commands.');
  return root;
}

test('the complete generated output and source inventories are explicit', () => {
  assert.deepEqual(PAGES.map(([src, out]) => [src, out]), [
    ['concepts.md', 'concepts.html'], ['internals.md', 'internals.html'], ['api-reference.md', 'api.html'],
    ['cli.md', 'cli.html'], ['access-keys.md', 'access-keys.html'], ['deployment.md', 'deployment.html'], ['observability.md', 'observability.html'],
    ['operations.md', 'operations.html'],
  ]);
  assert.deepEqual(BUNDLE_FILES, ['concepts.md', 'internals.md', 'api-reference.md', 'cli.md', 'access-keys.md', 'deployment.md', 'observability.md', 'operations.md', 'mcp.md', 'examples.md']);
  assert.deepEqual(GENERATED_FILES, ['concepts.html', 'internals.html', 'api.html', 'cli.html', 'access-keys.html', 'deployment.html', 'observability.html', 'operations.html', 'llms-full.txt', 'site-metadata.json', 'assets/highlight.min.js']);
});

test('source and dated latest release stay distinct across patch preparation and publication', (t) => {
  const root = fixture(t);
  for (const [source, released] of [['0.3.0', '0.2.0'], ['0.3.1', '0.3.0'], ['0.3.1', '0.3.1']]) {
    put(root, 'internal/version/version.go', `const Version = "${source}"\n`);
    put(root, 'CHANGELOG.md', `## Unreleased\n\n## v${released} — 2026-09-06\n\n## v0.1.0 — 2026-06-20\n`);
    const { metadata, outputs } = renderSite(root);
    assert.equal(metadata.sourceVersion, source);
    assert.equal(metadata.latestRelease, `v${released}`);
    for (const [, out] of PAGES) {
      assert.ok(outputs.get(out).includes(`source v${source}; latest release:`));
      assert.equal(outputs.get(out).includes('The source changes are unreleased.'), source !== released);
      assert.ok(outputs.get(out).includes(`releases/tag/v${released}`));
      assert.ok(outputs.get(out).includes('mqlite main'));
      assert.ok(!outputs.get(out).includes('upcoming v0.3.0'));
      assert.ok(outputs.get(out).includes('id="shared-heading"'));
    }
    assert.ok(outputs.get('llms-full.txt').includes(`Source version: v${source}. Latest recorded release: v${released}.`));
  }
});

test('missing/ambiguous metadata and source contracts fail closed', (t) => {
  for (const [file, bad] of [
    ['internal/version/version.go', '// const Version = "0.3.0"'],
    ['internal/version/version.go', 'const Version = "0.3.0"\nconst Version = "0.2.0"'],
    ['CHANGELOG.md', '## Unreleased\n### Mention v0.3.0'],
    ['wire/wire.go', 'PathOne = "/mqlite.v1.QueueService/One"'],
    ['cmd/mqlite-mcp/main.go', 'name: "tool"'],
    ['cmd/mqlite/main.go', 'switch somethingElse {}'],
  ]) {
    const root = fixture(t);
    put(root, file, bad);
    assert.throws(() => sourceMetadata(root), undefined, file);
  }
  const root = fixture(t);
  put(root, 'wire/wire.go', Array.from({ length: 5 }, (_, i) => `Path${i} = "/mqlite.v1.QueueService/Duplicate"`).join('\n'));
  assert.throws(() => sourceMetadata(root), /invalid routes/);
});

test('canonical diagram changes remain visible in every generated page and the bundle', (t) => {
  const root = fixture(t);
  let { outputs } = renderSite(root);
  for (const [, out] of PAGES) {
    assert.ok(outputs.get(out).includes('Abandon(delay_ms&gt;0) -&gt; scheduled'));
    assert.ok(outputs.get(out).includes('Cancel: never-delivered only'));
    assert.ok(!outputs.get(out).includes('<figure'));
    assert.ok(outputs.get(out).includes('href="operations.html#backup"'));
  }
  put(root, 'docs/concepts.md', '# Model\n\n```\nSend(scheduled)\nnew canonical transition\n```\n');
  ({ outputs } = renderSite(root));
  assert.ok(outputs.get('concepts.html').includes('new canonical transition'));
  assert.ok(outputs.get('llms-full.txt').includes('new canonical transition'));
  for (const file of BUNDLE_FILES) assert.ok(outputs.get('llms-full.txt').includes(`docs/${file} =====`));
});

test('every generated file rejects missing or changed content, including metadata and assets', (t) => {
  const { outputs } = renderSite(fixture(t));
  const root = materialize(t, outputs);
  checkOutputs(outputs, root);
  for (const [file, content] of outputs) {
    rmSync(resolve(root, file));
    assert.throws(() => checkOutputs(outputs, root), /missing generated output/, file);
    put(root, file, 'stale or edited');
    assert.throws(() => checkOutputs(outputs, root), /stale generated output/, file);
    put(root, file, content);
  }
  put(root, 'obsolete.html', outputs.get('cli.html'));
  assert.throws(() => checkOutputs(outputs, root), /obsolete generated output/);
});

test('all numerical claims are checked, so one correct count cannot hide another stale count', (t) => {
  const { outputs, metadata } = renderSite(fixture(t));
  const root = materialize(t, outputs);
  checkClaims(metadata, root);
  for (const kind of ['routes', 'tools', 'commands']) {
    for (const claim of [`4 ${kind}`, `<strong>4</strong> ${kind}`, `**4** ${kind}`, `4 CLI ${kind}`]) {
      put(root, 'agents.html', `5 ${kind}; ${claim}`);
      assert.throws(() => checkClaims(metadata, root), new RegExp(`stale ${kind}`));
    }
    rmSync(resolve(root, 'agents.html'));
  }
  put(root, 'index.html', 'No published API counts.');
  assert.throws(() => checkClaims(metadata, root), /missing a source-derived/);
});

test('latest-release, legacy-port and source links cannot silently drift', (t) => {
  const { outputs, metadata } = renderSite(fixture(t));
  const root = materialize(t, outputs);
  for (const content of ['latest release v0.3.0', 'latest published release is v0.3.0', 'latest <b>release</b>\nis v0.3.0', 'latest release: <a href="#">v0.3.0</a>', 'newest RELEASE is v0.3.0',
    'Use port 8080', 'https://github.com/mqlitehq.github.io/blob/main/api.html']) {
    put(root, 'agents.html', content);
    assert.throws(() => checkClaims(metadata, root), undefined, content);
  }
  put(root, 'agents.html', 'The 0.2.0 release listens on 8080.');
  checkClaims(metadata, root);
  put(root, 'llms-full.txt', '[bad](operations.md)');
  assert.throws(() => checkClaims(metadata, root), /relative source links/);
});

test('all generated pages and bundle links resolve to the correct source or preview page', () => {
  for (const [src, out] of PAGES) {
    assert.equal(rewriteLinks(`<a href="${src}#part">`), `<a href="${out}#part">`);
    assert.equal(rewriteLinks(`<a href="${out}#part">`), `<a href="${out}#part">`);
    assert.equal(rewriteMdLinks(`[read](${src}#part)`), `[read](https://github.com/mqlitehq/mqlite/blob/main/docs/${src}#part)`);
  }
  for (const target of ['https://example.test/doc', '#part', 'mailto:team@example.test']) {
    assert.equal(rewriteLinks(`<a href="${target}">`), `<a href="${target}">`);
    assert.equal(rewriteMdLinks(`[read](${target})`), `[read](${target})`);
  }
  assert.equal(rewriteLinks('<a href="../README.md#start">'), '<a href="https://github.com/mqlitehq/mqlite/blob/main/README.md#start">');
  assert.equal(rewriteMdLinks('[read](../engine/tx.go)'), '[read](https://github.com/mqlitehq/mqlite/blob/main/engine/tx.go)');
});

test('the full Pages workflow contract pins validation, artifact scope and main-only deployment', () => {
  const workflow = readFileSync(resolve(site, '.github/workflows/site.yml'), 'utf8');
  assert.equal(workflow, readFileSync(resolve(here, 'site-workflow.golden.yml'), 'utf8'));
});

test('the real Pages package contains the complete static inventory with identical bytes and valid links', (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'mqlite-site-package-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = resolve(root, 'site');
  execFileSync('sh', [resolve(here, 'package-site.sh'), output]);
  const files = (dir, prefix = '') => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const name = `${prefix}${entry.name}`;
    return entry.isDirectory() ? files(resolve(dir, entry.name), `${name}/`) : [name];
  });
  const expected = [
    'access-keys.html', 'agents.html', 'api.html', 'assets/fig-lifecycle.svg', 'assets/fig-overview.svg',
    'assets/highlight.min.js', 'assets/site.css', 'assets/site.js', 'cli.html',
    'concepts.html', 'deployment.html', 'favicon.svg', 'index.html', 'internals.html',
    'llms-full.txt', 'llms.txt', 'logo.svg', 'observability.html', 'operations.html',
    'site-metadata.json',
  ].sort();
  assert.deepEqual(files(output).sort(), expected);
  for (const file of expected) {
    assert.deepEqual(readFileSync(resolve(output, file)), readFileSync(resolve(site, file)), file);
  }
  checkLinks(output);
});

test('every local HTML asset, navigation target and anchor must exist', (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'mqlite-site-links-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  put(root, 'index.html', '<a href="operations.html#restore">Restore</a><img src="logo.svg">');
  put(root, 'operations.html', '<h2 id="restore">Restore</h2><a href="./">Home</a>');
  put(root, 'logo.svg', '<svg></svg>');
  put(root, 'llms.txt', '[Operations](operations.html#restore)\n[Source](https://github.com/mqlitehq/mqlite)');
  checkLinks(root);
  for (const href of ['missing.html', 'operations.html#missing', 'assets/missing.svg']) {
    put(root, 'index.html', `<a href="${href}">Missing</a>`);
    assert.throws(() => checkLinks(root), /missing local/);
  }
  put(root, 'index.html', '<a href="https://example.test/">External</a>');
  put(root, 'llms.txt', '[Missing](missing.html)');
  assert.throws(() => checkLinks(root), /missing local link/);
});
