import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INTERFACE_FILES, checkAgentPrompt, translateAgentPrompt, checkMarkdownPair, checkNumericPair, sha256, loadTranslations, keepEnglishHeadingIds, handwrittenStrings, translateHandwritten } from './i18n.mjs';
import { localizeSummary, renderSite, PAGES, ALL_GENERATED_FILES } from './build.mjs';

const site = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const en = '# Lease\n\nA `token` expires in 30 seconds. [Read](operations.md#expiry).\n\n| Limit | Value |\n| --- | --- |\n| Count | 3 |\n\n```go\nComplete(ctx, token)\n```\n';
const zh = '# 租约\n\n`token` 在 30 秒后到期。[阅读](operations.md#expiry)。\n\n| 限制 | 值 |\n| --- | --- |\n| 次数 | 3 |\n\n```go\nComplete(ctx, token)\n```\n';
const put = (root, name, value) => { const path = resolve(root, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); };

test('translation contracts reject lost blocks, changed code, targets, identifiers and numeric facts', () => {
  checkMarkdownPair(en, zh);
  for (const bad of [
    zh.replace('Complete(ctx, token)', 'Complete(ctx, other)'),
    zh.replace('`token`', '`lock_token`'),
    zh.replace('operations.md#expiry', 'operations.md#other'),
    zh.replace('30 秒', '31 秒'),
    zh.replace('| 次数 | 3 |\n', ''),
    zh.replace('# 租约', '## 租约'),
    zh.replace('# 租约', '# **租约：**处理'),
    zh.replace(/\n\n`token`[\s\S]*?。\n/, '\n'),
  ]) assert.throws(() => checkMarkdownPair(en, bad));
  checkNumericPair('non-2xx go-1.21 32-or-1, -1, 1–3', '非 2xx，Go 1.21，32 或 1，-1，1–3', 'punctuation');
  assert.throws(() => checkNumericPair('-1', '1', 'negative value'));
});

test('pairing manifest rejects source drift, unreviewed translations and missing counterparts', (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'mqlite-translation-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const canonical = resolve(root, 'canonical');
  const catalog = '{"pages":{},"strings":{}}\n';
  const manifest = {
    locale: 'zh-CN', sourceLocale: 'en', documents: { 'concepts.md': { sourceSha256: sha256(en), translationSha256: sha256(zh) } },
    interfaceSha256: sha256(catalog), summary: { sourceSha256: sha256(en), translationSha256: sha256(zh) },
    runtimeSources: Object.fromEntries(INTERFACE_FILES.map((name) => [name, sha256(name)])),
    agentPrompt: { sourceSha256: sha256(en), translationSha256: sha256(zh) },
  };
  for (const name of INTERFACE_FILES) put(root, name, name);
  put(canonical, 'docs/concepts.md', en);
  put(root, 'llms.txt', en);
  put(root, 'agents.html', `<pre id="p1"><code>${en}</code></pre>`);
  put(root, 'i18n/zh-CN/agent-prompt.txt', zh);
  put(root, 'i18n/zh-CN/docs/concepts.md', zh);
  put(root, 'i18n/zh-CN/interface.json', catalog);
  put(root, 'i18n/zh-CN/llms.txt', zh);
  put(root, 'i18n/zh-CN/manifest.json', JSON.stringify(manifest));
  const load = () => loadTranslations(root, canonical, ['concepts.md']);
  assert.equal(load().documents.get('concepts.md'), zh);
  put(root, 'assets/site.js', 'changed interface text');
  assert.throws(load, /interface source changed/);
  put(root, 'assets/site.js', 'assets/site.js');
  put(canonical, 'docs/concepts.md', `${en}\nChanged source.\n`);
  assert.throws(load, /English source changed/);
  put(canonical, 'docs/concepts.md', en);
  put(root, 'i18n/zh-CN/docs/concepts.md', `${zh}\n额外内容。\n`);
  assert.throws(load, /translation changed/);
  put(root, 'i18n/zh-CN/docs/concepts.md', zh);
  manifest.documents.extra = manifest.documents['concepts.md'];
  put(root, 'i18n/zh-CN/manifest.json', JSON.stringify(manifest));
  assert.throws(load, /inventory differs/);
});

test('hand-written prose is exhaustive, escaped and paired with its exact English source', () => {
  const html = `<html lang="en"><title>Queue</title><p title="Reliable" aria-label='Reliable'>At least once</p><code>Complete(ctx)</code><pre>ASCII diagram</pre></html>`;
  assert.deepEqual(handwrittenStrings(html), ['At least once', 'Queue', 'Reliable']);
  const catalog = { pages: { 'index.html': { sourceSha256: sha256(html) } }, strings: { Queue: '队列', Reliable: '可靠', 'At least once': '至少一次' } };
  const translated = translateHandwritten(html, catalog, 'index.html');
  assert.ok(translated.includes('<code>Complete(ctx)</code><pre>ASCII diagram</pre>'));
  assert.ok(translated.includes('title="可靠"'));
  assert.ok(translated.includes("aria-label='可靠'"));
  assert.throws(() => translateHandwritten(html.replace('Queue', 'Topic'), catalog, 'index.html'), /English changed/);
  delete catalog.strings.Reliable;
  assert.throws(() => translateHandwritten(html, catalog, 'index.html'), /untranslated interface text/);
  catalog.strings.Reliable = '<script>"injected"</script>';
  assert.ok(!translateHandwritten(html, catalog, 'index.html').includes('<script>'));
});

test('heading anchors retain the English contract and reject missing Chinese headings', () => {
  assert.equal(keepEnglishHeadingIds('<h1 id="lease">Lease</h1>', '<h1 id="租约">租约</h1>', 'test'), '<h1 id="lease">租约</h1>');
  assert.throws(() => keepEnglishHeadingIds('<h1 id="lease">Lease</h1>', '<h2 id="租约">租约</h2>', 'test'), /correspondence/);
});

test('the copyable Chinese agent prompt preserves protocol literals and rule count', () => {
  const en = '- Use QueueService/Complete {"lock_token":"..."}, not a new Receive.\n', zh = '- 使用 QueueService/Complete {"lock_token":"..."}，不要重新 Receive。\n';
  checkAgentPrompt(en, zh);
  assert.throws(() => checkAgentPrompt(en, zh.replace('Complete', 'Abandon')), /protocol data/);
  assert.throws(() => checkAgentPrompt(en, zh.replace('lock_token', 'token')), /protocol data/);
  assert.throws(() => checkAgentPrompt(en, zh.replace('- ', '')), /rule inventory/);
  const rendered = translateAgentPrompt('<pre id="p1"><code>Original</code></pre>', '端点 <MQLITE_ENDPOINT>');
  assert.ok(rendered.includes('端点 &lt;MQLITE_ENDPOINT&gt;'));
});

test('Chinese machine navigation is local while English source references remain canonical', () => {
  const target = 'https://github.com/mqlitehq/mqlite/blob/main/docs/turso.md';
  const summary = `<https://mqlitehq.github.io/>\n\n## 文档\n\n[Turso](${target})\n\n## 源码\n\n[英文源码](${target})\n`;
  const translated = localizeSummary(summary);
  assert.ok(translated.includes('<https://mqlitehq.github.io/zh-CN/>'));
  assert.ok(translated.includes('[Turso](turso.html)'));
  assert.ok(translated.includes(`[英文源码](${target})`));
});

test('the real bilingual site covers every source and keeps code and anchors identical', () => {
  const canonical = [resolve(site, '../mqlite'), resolve(site, 'mqlite-src')].find((root) => existsSync(resolve(root, 'docs/concepts.md')));
  assert.ok(canonical, 'canonical source checkout is required');
  const { outputs, metadata } = renderSite(canonical);
  const description = PAGES[0][3];
  try {
    PAGES[0][3] = 'Unreviewed English description';
    assert.throws(() => renderSite(canonical), /review Chinese chrome/);
  } finally { PAGES[0][3] = description; }
  assert.deepEqual([...outputs.keys()], ALL_GENERATED_FILES);
  assert.deepEqual(metadata.locales, ['en', 'zh-CN']);
  assert.equal(metadata.defaultLocale, 'en');
  for (const [, file] of PAGES) {
    const english = outputs.get(file), chinese = outputs.get(`zh-CN/${file}`);
    const ids = (html) => [...html.matchAll(/<h[1-6]\b[^>]*id="([^"]+)"/g)].map((m) => m[1]);
    const code = (html) => [...html.matchAll(/<pre>[\s\S]*?<\/pre>/g)].map((m) => m[0]);
    assert.deepEqual(ids(chinese), ids(english), file);
    assert.deepEqual(code(chinese), code(english), file);
    assert.ok(chinese.includes('<html lang="zh-CN">'), file);
    assert.ok(chinese.includes(`href="../${file}" hreflang="en"`), file);
    assert.ok(!chinese.includes('assets/demo.js'), file);
  }
  // Locale dictionaries and Markdown sources must never become browser dependencies.
  for (const [file, content] of outputs) if (file.endsWith('.html')) {
    assert.ok(!String(content).includes('src="i18n/'), file);
    assert.ok(!String(content).includes('fonts.googleapis.com'), file);
  }
});
