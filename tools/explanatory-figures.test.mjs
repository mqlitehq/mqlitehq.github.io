import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Marked, Renderer } from 'marked';
import {
  EXPLANATORY_FIGURES, loadExplanatoryFigures, findExplanatoryFigure,
  renderExplanatoryFigure, explanatoryFigureRenderer,
} from './explanatory-figures.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const canonical = [resolve(here, '../../mqlite'), resolve(here, '../mqlite-src')]
  .find((root) => existsSync(resolve(root, 'docs/concepts.md')));
const sources = () => new Map(EXPLANATORY_FIGURES.map(({ file }) => [file, readFileSync(resolve(canonical, 'docs', file), 'utf8')]));

test('exactly five reviewed explanatory figures load from a Map or object without changing source', () => {
  const input = sources();
  const before = [...input];
  const figures = loadExplanatoryFigures(input);
  assert.deepEqual(figures.map(({ id }) => id), ['monitoring', 'capacity', 'validation', 'shutdown-budget', 'creation']);
  assert.deepEqual(input, new Map(before));
  assert.deepEqual(loadExplanatoryFigures(Object.fromEntries(input)), figures);
  assert.ok(figures.every(({ token }) => token.raw.includes(token.text)));
});

test('any canonical block or surrounding prose drift blocks presentation generation', () => {
  for (const { file, id } of EXPLANATORY_FIGURES) {
    const input = sources();
    input.set(file, input.get(file) + '\nUnreviewed surrounding contract.\n');
    assert.throws(() => loadExplanatoryFigures(input), new RegExp(`${id}: canonical diagram or surrounding contract changed`));
    input.delete(file);
    assert.throws(() => loadExplanatoryFigures(input), /missing canonical document/);
  }
  const input = sources();
  input.set('operations.md', input.get('operations.md').replace('25s HTTP drain +', '20s HTTP drain +'));
  assert.throws(() => loadExplanatoryFigures(input), /canonical diagram or surrounding contract changed/);
});

test('both languages present semantic figures while retaining the exact original code in closed details', () => {
  for (const figure of loadExplanatoryFigures(sources())) {
    const literal = new Renderer().code(figure.token);
    for (const chinese of [false, true]) {
      const html = renderExplanatoryFigure(figure, chinese);
      assert.ok(html.includes(`data-explanatory-figure="${figure.id}"`));
      assert.ok(html.includes(literal), `${figure.id}: original source changed`);
      assert.equal(html.split(literal).length, 2, `${figure.id}: source must appear once`);
      assert.ok(html.includes('<details class="diagram-source">'));
      assert.ok(!html.includes('<details class="diagram-source" open'));
      assert.ok(html.includes('tabindex="0"'));
      assert.ok(html.includes(chinese ? '查看英文原始文字示意图' : 'View the original English text figure'));
    }
  }
});

test('Chinese main figures translate prose and retain important API names, units and conditions', () => {
  const figures = loadExplanatoryFigures(sources());
  const main = (id) => renderExplanatoryFigure(figures.find((figure) => figure.id === id), true).split('<details')[0];
  for (const [id, terms] of Object.entries({
    monitoring: ['采集器（collector）', '私有路由（private route）', '监控 Bearer 令牌', 'MQLite :6754/metrics', 'Prometheus-compatible storage', 'Grafana'],
    capacity: ['历史部署容量样本', '19 MB', '50k', '38 MB', '256 MB', '0.4 KB', '256 B', '4 MB WAL', '1 GB', '1.1M', '0.6 KB × 1.5', '1000s/s', '1 个共享 vCPU', '10.9 MiB', '15 MB', '&lt; 1 s', '不存在通用的积压阈值'],
    validation: ['隔离测试（hermetic）', '始终运行，包含 CI', '须配置测试凭据（creds-gated）', '夜间任务（nightly）', 'engine/storage_test.go', 'engine/turso_test.go', '真实 Turso'],
    'shutdown-budget': ['必须大于', '25s HTTP 排空（HTTP drain）', 'Engine.Close', '耗时', '日志与进程退出余量'],
    creation: ['两种显式创建操作', 'CreateQueue(name)', 'Subscribe(topic, sub, filter)', 'Send', '支撑队列（backing queue）', 'sub', 'topic', '主题（Topic）随之隐式形成'],
  })) for (const term of terms) assert.ok(main(id).includes(term), `${id}: missing ${term}`);
  for (const id of ['capacity', 'validation', 'creation']) {
    assert.ok(main(id).includes('<table'));
    assert.ok(main(id).includes('<th scope="col">'));
    assert.ok(main(id).includes('<th scope="row">'));
  }
});

test('the code hook matches only reviewed token text and language; real examples remain literal', () => {
  const figures = loadExplanatoryFigures(sources());
  const marked = new Marked({ renderer: explanatoryFigureRenderer(figures, true) });
  const examples = '```go\nSubscribe(topic, sub, filter)\nfmt.Println("<active>")\n```\n\n```\nvisible_at - enqueued_at > days(1)\n```\n';
  assert.equal(marked.parse(examples), new Marked().parse(examples));
  for (const figure of figures) {
    assert.equal(findExplanatoryFigure(figures, figure.token), figure);
    assert.equal(findExplanatoryFigure(figures, { ...figure.token, lang: 'go' }), undefined);
    assert.equal(findExplanatoryFigure(figures, { ...figure.token, text: figure.token.text + ' changed' }), undefined);
    const rendered = marked.parse(figure.token.raw);
    assert.ok(rendered.includes(`data-explanatory-figure="${figure.id}"`));
  }
});

test('full document rendering preserves every code example verbatim and replaces only its explanatory block', () => {
  const input = sources();
  const figures = loadExplanatoryFigures(input);
  for (const [file, markdown] of input) {
    const own = figures.filter((figure) => figure.file === file);
    const rendered = new Marked({ renderer: explanatoryFigureRenderer(own, true) }).parse(markdown);
    assert.equal((rendered.match(/data-explanatory-figure=/g) || []).length, 1);
    for (const token of new Marked().lexer(markdown).filter((token) => token.type === 'code')) {
      assert.ok(rendered.includes(new Renderer().code(token)), `${file}: literal code was lost`);
    }
  }
});
