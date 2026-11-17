import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, cpSync, rmSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Marked } from 'marked';
import { sha256 } from './i18n.mjs';
import { DIAGRAM_ASSETS, EN_DIAGRAM_ASSETS, loadConceptDiagrams, localizeDiagram, conceptDiagramRenderer } from './concept-diagrams.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const canonical = [resolve(here, '../../mqlite'), resolve(here, '../mqlite-src')].find((root) => existsSync(resolve(root, 'docs/concepts.md')));
const markdown = () => readFileSync(resolve(canonical, 'docs/concepts.md'), 'utf8');
function fixture(t) {
  const root = mkdtempSync(resolve(tmpdir(), 'mqlite-diagrams-'));
  cpSync(resolve(here, 'diagrams'), root, { recursive: true });
  t.after(() => rmSync(root, { force: true, recursive: true }));
  return root;
}

test('all three concepts illustrations have an exact source pairing and a bounded asset budget', () => {
  const diagrams = loadConceptDiagrams(markdown());
  assert.deepEqual(diagrams.map((d) => d.asset), EN_DIAGRAM_ASSETS);
  assert.deepEqual([...diagrams.map((d) => d.asset), ...diagrams.map((d) => d.chineseAsset)], DIAGRAM_ASSETS);
  assert.ok(diagrams.reduce((sum, d) => sum + Buffer.byteLength(d.svg), 0) < 40 * 1024);
  assert.ok(diagrams[0].svg.includes('data-node="orders-queue"'));
  assert.ok(diagrams[1].svg.includes('data-state="dead_lettered"'));
  assert.ok(diagrams[2].svg.includes('data-edge="reject-invalid-expression"'));
});

test('Chinese diagrams translate every label while preserving the exact drawing and protocol terms', () => {
  const geometry = (svg) => svg.replace(/<(title|desc|text)\b[\s\S]*?<\/\1>/g, '').replace(' lang="zh-CN"', '');
  const required = [['Receive', 'Complete', 'active', 'locked', 'dead_lettered', 'orders', 'events', 'audit', 'billing'],
    ['ReceiveDeferred', 'RenewBatch', 'delivery_count', 'max_delivery_count', 'dead_letter_on_expire', 'Cancel', 'Redrive'],
    ['Subscribe', 'Publish', 'true', 'false', '400', 'invalid_argument', 'program(message)']];
  loadConceptDiagrams(markdown()).forEach((diagram, index) => {
    assert.notEqual(diagram.svg, diagram.chineseSvg);
    assert.equal(geometry(diagram.svg), geometry(diagram.chineseSvg), diagram.id);
    for (const term of required[index]) assert.ok(diagram.chineseSvg.includes(term), `${diagram.id}: ${term}`);
    assert.match(diagram.chineseSvg, /lang="zh-CN"/);
    assert.match(diagram.chineseSvg, /[\u3400-\u9fff]/);
  });
});

test('missing, stale or unreviewed diagram translations block generation', (t) => {
  const root = fixture(t);
  const file = resolve(root, 'zh-CN-filter.json');
  writeFileSync(file, readFileSync(file, 'utf8').replace('无效表达式', '有效表达式'));
  assert.throws(() => loadConceptDiagrams(markdown(), root), /translation changed/);
  rmSync(file);
  assert.throws(() => loadConceptDiagrams(markdown(), root));
  const svg = '<svg viewBox="0 0 100 100"><text x="1" y="2">valid</text></svg>';
  assert.throws(() => localizeDiagram(svg, {}, 'fixture'), /inventory differs/);
  assert.throws(() => localizeDiagram(svg, { valid: { text: '有效', fontSize: 9 } }, 'fixture'), /font size/);
  assert.ok(localizeDiagram(svg, { valid: '<script>有效</script>' }, 'fixture').includes('&lt;script&gt;'));
});

test('a changed source diagram blocks rendering even when its old keywords remain', () => {
  const changed = markdown().replace('receive / claim (count++)', 'receive / claim (count unchanged)');
  assert.notEqual(changed, markdown());
  assert.throws(() => loadConceptDiagrams(changed), /canonical diagram changed/);
});

test('a change to the surrounding contract also requires illustration review', () => {
  const changed = markdown().replace('a row is in exactly one state at a time', 'a row is in two states at a time');
  assert.notEqual(changed, markdown());
  assert.throws(() => loadConceptDiagrams(changed), /surrounding contract changed/);
});

test('unreviewed artwork or a missing illustration blocks generation', (t) => {
  const root = fixture(t);
  const file = resolve(root, 'overview.svg');
  writeFileSync(file, readFileSync(file, 'utf8').replace('stores no messages', 'stores messages'));
  assert.throws(() => loadConceptDiagrams(markdown(), root), /artwork changed/);
  rmSync(file);
  assert.throws(() => loadConceptDiagrams(markdown(), root));
});

test('only reviewed diagram blocks become images; their exact text remains available in native details', () => {
  const diagrams = loadConceptDiagrams(markdown());
  const marked = new Marked({ renderer: conceptDiagramRenderer(diagrams) });
  const html = marked.parse(markdown());
  assert.equal((html.match(/data-concept-diagram=/g) ?? []).length, 3);
  assert.equal((html.match(/<details class="diagram-source">/g) ?? []).length, 3);
  assert.ok(!html.includes('<details class="diagram-source" open'));
  assert.ok(html.includes('You only ever do two kinds of &quot;create&quot;:'));
  assert.ok(html.includes('visible_at - enqueued_at'));
  const sourceBlocks = new Marked().lexer(markdown()).filter((token) => token.type === 'code');
  for (const diagram of diagrams) {
    const source = sourceBlocks.find((block) => sha256(block.text) === diagram.sourceSha256);
    const literal = new Marked().parse(source.raw);
    assert.ok(html.includes(literal), diagram.id);
  }
});
