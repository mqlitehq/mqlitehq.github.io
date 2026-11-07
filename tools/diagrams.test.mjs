import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, cpSync, rmSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Marked } from 'marked';
import { sha256 } from './i18n.mjs';
import { DIAGRAM_ASSETS, loadConceptDiagrams, conceptDiagramRenderer } from './concept-diagrams.mjs';

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
  assert.deepEqual(diagrams.map((d) => d.asset), DIAGRAM_ASSETS);
  assert.ok(diagrams.reduce((sum, d) => sum + Buffer.byteLength(d.svg), 0) < 40 * 1024);
  assert.ok(diagrams[0].svg.includes('data-node="orders-queue"'));
  assert.ok(diagrams[1].svg.includes('data-state="dead_lettered"'));
  assert.ok(diagrams[2].svg.includes('data-edge="reject-invalid-expression"'));
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
