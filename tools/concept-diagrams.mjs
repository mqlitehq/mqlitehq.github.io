// Website illustrations are reviewed companions to exact canonical diagram blocks.
// Machine-readable Markdown remains unchanged; no keyword-based replacement.
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Marked, Renderer } from 'marked';
import { sha256 } from './i18n.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), 'diagrams');
export const DIAGRAM_IDS = ['overview', 'lifecycle', 'filter'];
// Reuse the existing no-script landing illustration URL for the reviewed overview.
export const DIAGRAM_ASSETS = ['assets/fig-overview.svg', 'assets/concepts-lifecycle.svg', 'assets/concepts-filter.svg'];
const demand = (ok, message) => { if (!ok) throw new Error(message); };
const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function loadConceptDiagrams(markdown, directory = root) {
  const manifest = JSON.parse(readFileSync(resolve(directory, 'manifest.json'), 'utf8'));
  demand(JSON.stringify(manifest.map((record) => record.id)) === JSON.stringify(DIAGRAM_IDS), 'concept diagram inventory changed; review every illustration');
  const blocks = new Marked().lexer(markdown).filter((token) => token.type === 'code' && !token.lang);
  return manifest.map((record) => {
    demand(record.documentSha256 === sha256(markdown), `${record.id}: canonical diagram changed or its surrounding contract changed; review its illustration`);
    demand(blocks.filter((block) => sha256(block.text) === record.sourceSha256).length === 1, `${record.id}: canonical diagram changed; review its illustration`);
    const svg = readFileSync(resolve(directory, `${record.id}.svg`), 'utf8');
    demand(sha256(svg) === record.artworkSha256, `${record.id}: artwork changed; review its source pairing`);
    demand(/^<svg\b/.test(svg.trim()) && !/<(?:script|foreignObject|!DOCTYPE)\b|\bon[a-z]+\s*=|\b(?:href|src)\s*=\s*["'](?!#)|@import/i.test(svg), `${record.id}: expected a self-contained static SVG`);
    const box = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg);
    demand(box && Number(box[1]) > 0 && Number(box[2]) > 0, `${record.id}: missing SVG dimensions`);
    for (const locale of ['en', 'zh-CN']) demand(record.title?.[locale] && record.description?.[locale], `${record.id}: missing bilingual caption`);
    return { ...record, svg, width: Number(box[1]), height: Number(box[2]), asset: DIAGRAM_ASSETS[DIAGRAM_IDS.indexOf(record.id)] };
  });
}

export function conceptDiagramRenderer(diagrams, chinese = false) {
  const normal = new Renderer();
  return {
    code(token) {
      const record = !token.lang && diagrams.find((diagram) => diagram.sourceSha256 === sha256(token.text));
      if (!record) return normal.code(token);
      const locale = chinese ? 'zh-CN' : 'en';
      const caption = escape(record.title[locale]);
      return `<figure class="concept-diagram" data-concept-diagram="${record.id}" aria-labelledby="diagram-${record.id}-caption">
<figcaption id="diagram-${record.id}-caption">${caption}</figcaption>
<div class="diagram-viewport" role="region" tabindex="0" aria-label="${caption}"><img src="${record.asset}" width="${record.width}" height="${record.height}" alt="${escape(record.description[locale])}"></div>
<p class="diagram-hint">${chinese ? '窄屏下可在图内左右滑动，或聚焦后用方向键滚动。图中术语保留英文。' : 'On narrow screens, scroll inside the figure or focus it and use the arrow keys.'}</p>
<details class="diagram-source"><summary>${chinese ? '查看文字版示意图' : 'View the source text diagram'}</summary>
${normal.code(token)}</details>
</figure>\n`;
    },
  };
}
