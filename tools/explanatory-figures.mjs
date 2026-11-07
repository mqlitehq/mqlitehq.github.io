// Reviewed presentation companions for five explanatory text blocks. The exact
// English source stays in native details; canonical Markdown is never rewritten.
import { createHash } from 'node:crypto';
import { Marked, Renderer } from 'marked';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const demand = (ok, message) => { if (!ok) throw new Error(message); };
const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// A change anywhere in the surrounding document requires semantic re-review;
// matching a familiar first line alone must never substitute stale artwork.
export const EXPLANATORY_FIGURES = Object.freeze([
  {
    id: 'monitoring', file: 'observability-cloud.md', language: 'text',
    documentSha256: '3a7036ab0b934aae12130e7dfe52d39a852dc6e06ffabbb71a5b25550623e1a5',
    sourceSha256: 'd8bcf87ed693a1d95120a949ccb39f7621522e9e61fd6b6b3d2330927afb1441',
    title: { en: 'Metrics collection, storage and dashboards', 'zh-CN': '指标采集、存储与看板' },
  },
  {
    id: 'capacity', file: 'benchmark.md', language: '',
    documentSha256: 'd217ac950e46a6578a76196ce4b6bd6552aad29eec44c1de34367d352509aa4a',
    sourceSha256: '8403c3c2c82335ff30740c6e4ea5aadbf885ebe53b4d82c56a7ea1ac81329bff',
    title: { en: 'Historical deployment sizing sample (Fly.io)', 'zh-CN': '历史部署容量样本（Fly.io）' },
  },
  {
    id: 'validation', file: 'turso.md', language: '',
    documentSha256: '009bd6f0b56831e5d3dec54d29dfa234814458488fdbe6981d25499e2a35aa73',
    sourceSha256: '64247b689cb1abfc244788d648ebe1eac51aaf1e1b2eed302a7e693e8c6e2fbf',
    title: { en: 'Turso validation lanes and their entry points', 'zh-CN': 'Turso 验证分层与测试入口' },
  },
  {
    id: 'shutdown-budget', file: 'operations.md', language: 'text',
    documentSha256: '3f3c7d639e3da78a9c9c9361df6e1e89d21c6cd9041e4b14a426d86ea4eff8d1',
    sourceSha256: 'b6d90cd9a19a22f34050707f22fb90b8ce0afbc6604e35a8391f6c55e20d2b90',
    title: { en: 'The outer termination grace must exceed this total', 'zh-CN': '外层终止宽限期必须大于以下总和' },
  },
  {
    id: 'creation', file: 'concepts.md', language: '',
    documentSha256: '93d4de5f0fccd7acc54ff091564aacc5ba1fc30bc46d091bdb75c57de65c6bde',
    sourceSha256: 'e1072d2553e38dd3c7c5136341949be4051e8fdbddf5ed03711ab745df0ed64c',
    title: { en: 'Two explicit creation operations', 'zh-CN': '两种显式创建操作' },
  },
].map((record) => Object.freeze({ ...record, title: Object.freeze(record.title) })));

/** Load canonical English documents keyed by their docs/ basenames (Map or object). */
export function loadExplanatoryFigures(documentSources) {
  return EXPLANATORY_FIGURES.map((record) => {
    const markdown = documentSources instanceof Map ? documentSources.get(record.file) : documentSources?.[record.file];
    demand(typeof markdown === 'string', `${record.id}: missing canonical document ${record.file}`);
    demand(sha256(markdown) === record.documentSha256, `${record.id}: canonical diagram or surrounding contract changed; review its presentation`);
    const matches = new Marked().lexer(markdown).filter((token) => token.type === 'code'
      && (token.lang || '') === record.language && sha256(token.text) === record.sourceSha256);
    demand(matches.length === 1, `${record.id}: expected exactly one reviewed explanatory source block`);
    return Object.freeze({ ...record, token: Object.freeze({ ...matches[0] }) });
  });
}

/** Pass only records for the current document when composing multiple renderers. */
export function findExplanatoryFigure(figures, token) {
  if (token.type !== 'code') return undefined;
  return figures.find((record) => (token.lang || '') === record.language && sha256(token.text) === record.sourceSha256);
}

const table = (headings, rows, minimumWidth = 600) => `<table style="width:100%;min-width:${minimumWidth}px;border-collapse:collapse"><thead><tr>${headings.map((heading) => `<th scope="col">${heading}</th>`).join('')}</tr></thead><tbody>${rows.map(([heading, ...cells]) => `<tr><th scope="row">${heading}</th>${cells.map((cell) => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table>`;

function monitoring(chinese) {
  // Scraping is a request from collector to broker; it is not an unauthenticated
  // push from the broker. Ordered stages describe the collection stack.
  const stages = chinese ? [
    '<strong>采集器（collector）</strong><p>经由私有路由（private route），携带监控 Bearer 令牌，抓取 <code>MQLite :6754/metrics</code>。</p>',
    '<strong>Prometheus 兼容存储（Prometheus-compatible storage）</strong>',
    '<strong>现有 Grafana 与规则（existing Grafana + rules）</strong>',
  ] : [
    '<strong>Collector</strong><p>Scrape <code>MQLite :6754/metrics</code> over a private route with a monitor Bearer token.</p>',
    '<strong>Prometheus-compatible storage</strong>',
    '<strong>Existing Grafana + rules</strong>',
  ];
  return `<ol class="explanatory-flow" style="margin:0;padding-left:1.5em">${stages.map((stage, index) => `<li style="padding:0.6em 0">${stage}${index < stages.length - 1 ? '<div aria-hidden="true" style="margin-top:0.5em">↓</div>' : ''}</li>`).join('')}</ol>`;
}

function capacity(chinese) {
  const headings = chinese ? ['资源（resource）', '历史实测（1 broker）', 'Fly 配置与容量考量'] : ['Resource', 'Measured (1 broker)', 'Fly choice'];
  const rows = chinese ? [
    ['内存（memory）', '空闲时 19 MB；积压 50k 条消息时为 38 MB', '历史测试使用 256 MB；先验证当前峰值内存，不存在通用的积压阈值'],
    ['磁盘（disk）', '每条 256 B 消息约需 0.4 KB；本次测试另有约 4 MB WAL', '1 GB 卷（规划约 1.1M 条消息）；容量 = 积压消息数（backlog）× 0.6 KB × 1.5'],
    ['虚拟 CPU（vCPU）', '单次操作开销很小；批处理为每秒数千次（1000s/s）', '实测环境使用 1 个共享 vCPU'],
    ['镜像（image）', '10.9 MiB 静态二进制；无需 CGO（CGO-free）', 'distroless/scratch 镜像约 15 MB；冷启动 &lt; 1 s，可缩容至零（scale-to-zero）'],
  ] : [
    ['Memory', '19 MB idle; 38 MB @ 50k messages queued', '256 MB used in the historical test; validate current peak memory first; no universal backlog threshold'],
    ['Disk', '~0.4 KB / 256 B message; + ~4 MB WAL in this run', '1 GB volume (~1.1M planned messages); size = backlog × 0.6 KB × 1.5'],
    ['vCPU', 'Tiny/op; 1000s/s batched', '1 shared vCPU in the measured setup'],
    ['Image', '10.9 MiB static binary (CGO-free)', 'distroless/scratch ≈ 15 MB image; cold start &lt; 1 s (scale-to-zero ok)'],
  ];
  return table(headings, rows);
}

function validation(chinese) {
  return table(chinese ? ['测试层级', '运行条件', '测试入口', '验证范围'] : ['Lane', 'Run conditions', 'Entry point', 'Coverage'], chinese ? [
    ['隔离测试（hermetic）', '始终运行，包含 CI', '<code style="white-space:nowrap">engine/storage_test.go</code>', '连接错误的重试分类器（conn-error retry classifier）'],
    ['在线测试（live）', '须配置测试凭据（creds-gated）；夜间任务（nightly）', '<code style="white-space:nowrap">engine/turso_test.go</code>', '对真实 Turso 验证完整生命周期（full lifecycle）'],
  ] : [
    ['Hermetic', 'Always, including CI', '<code style="white-space:nowrap">engine/storage_test.go</code>', 'Connection-error retry classifier'],
    ['Live', 'Credentials-gated, nightly', '<code style="white-space:nowrap">engine/turso_test.go</code>', 'Full lifecycle against real Turso'],
  ], 760);
}

function shutdownBudget(chinese) {
  const terms = chinese ? ['25s HTTP 排空（HTTP drain）', '<code>Engine.Close</code> 耗时', '日志与进程退出余量'] : ['25s HTTP drain', '<code>Engine.Close</code> duration', 'Log and process-exit margin'];
  return `<p class="explanatory-formula" style="margin:0;line-height:2">${terms.map((term) => `<span style="display:inline-block">${term}</span>`).join(' <span>+</span> ')}</p>`;
}

function creation(chinese) {
  return table(chinese ? ['显式操作', '创建结果'] : ['Explicit operation', 'Result'], chinese ? [
    ['<code>CreateQueue(name)</code>', '创建一个独立工作队列（Queue）；调用 <code>Send</code> 前，该队列必须已存在。'],
    ['<code>Subscribe(topic, sub, filter)</code>', '自动创建名为 <code>sub</code> 的支撑队列（backing queue），并将订阅挂接到 <code>topic</code>；主题（Topic）随之隐式形成。'],
  ] : [
    ['<code>CreateQueue(name)</code>', 'Create one independent work queue, which must exist before Send.'],
    ['<code>Subscribe(topic, sub, filter)</code>', 'Auto-create backing queue=sub and attach the subscription to topic; the topic comes into being as a side effect.'],
  ]);
}

const bodyRenderers = { monitoring, capacity, validation, 'shutdown-budget': shutdownBudget, creation };

/** Render a loaded record; the original code token is always retained verbatim. */
export function renderExplanatoryFigure(record, chinese = false) {
  demand(bodyRenderers[record.id] && record.token, 'expected a loaded explanatory figure');
  const caption = escape(record.title[chinese ? 'zh-CN' : 'en']);
  return `<figure class="concept-diagram explanatory-figure" data-explanatory-figure="${record.id}" aria-labelledby="explanatory-${record.id}-caption">
<figcaption id="explanatory-${record.id}-caption">${caption}</figcaption>
<div class="explanatory-viewport" role="region" tabindex="0" aria-label="${caption}" style="overflow-x:auto;padding:1rem;border:1px solid var(--line, #777);border-radius:8px">${bodyRenderers[record.id](chinese)}</div>
${['capacity', 'validation', 'creation'].includes(record.id) ? `<p class="diagram-hint">${chinese ? '窄屏下可在表格内左右滑动，或聚焦后用方向键滚动。' : 'On narrow screens, scroll inside the table or focus it and use the arrow keys.'}</p>` : ''}
<details class="diagram-source"><summary>${chinese ? '查看英文原始文字示意图' : 'View the original English text figure'}</summary>
${new Renderer().code(record.token)}</details>
</figure>\n`;
}

/** Standalone hook; a combined hook can call find + render before normal.code. */
export function explanatoryFigureRenderer(figures, chinese = false) {
  const normal = new Renderer();
  return {
    code(token) {
      const record = findExplanatoryFigure(figures, token);
      return record ? renderExplanatoryFigure(record, chinese) : normal.code(token);
    },
  };
}
