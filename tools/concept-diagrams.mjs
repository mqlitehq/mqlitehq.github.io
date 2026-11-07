// Website illustrations are reviewed companions to exact canonical diagram blocks.
// Machine-readable Markdown remains unchanged; no keyword-based replacement.
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Marked, Renderer } from 'marked';
import { sha256, decodeText } from './i18n.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), 'diagrams');
export const DIAGRAM_IDS = ['overview', 'lifecycle', 'filter'];
// Reuse the existing no-script landing illustration URL for the reviewed overview.
export const EN_DIAGRAM_ASSETS = ['assets/fig-overview.svg', 'assets/concepts-lifecycle.svg', 'assets/concepts-filter.svg'];
export const ZH_DIAGRAM_ASSETS = EN_DIAGRAM_ASSETS.map((asset) => asset.replace('assets/', 'assets/zh-CN/'));
export const DIAGRAM_ASSETS = [...EN_DIAGRAM_ASSETS, ...ZH_DIAGRAM_ASSETS];
const demand = (ok, message) => { if (!ok) throw new Error(message); };
const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Keep one reviewed drawing. Only its text changes; paths, nodes and arrows do not.
export function localizeDiagram(svg, catalog, id) {
  const labels = [...svg.matchAll(/<(title|desc|text)\b[^>]*>([^<]*)<\/\1>/g)].map((match) => decodeText(match[2]));
  demand(JSON.stringify([...new Set(labels)].sort()) === JSON.stringify(Object.keys(catalog).sort()), `${id}: diagram translation inventory differs`);
  return svg.replace('<svg ', '<svg lang="zh-CN" ').replace(/<(title|desc|text)\b([^>]*)>([^<]*)<\/\1>/g, (match, tag, attributes, original) => {
    const value = catalog[decodeText(original)];
    const item = typeof value === 'string' ? { text: value } : value;
    demand(item && typeof item === 'object' && Object.keys(item).every((key) => ['text', 'lines', 'fontSize', 'lineHeight', 'offsetY'].includes(key)), `${id}: invalid translation format`);
    const lines = item.lines ?? [item.text];
    demand(Array.isArray(lines) && lines.length > 0 && lines.length <= 3 && lines.every((line) => typeof line === 'string' && line.trim()), `${id}: empty diagram translation`);
    demand(lines.length === 1 || tag === 'text', `${id}: only visible text may wrap`);
    let attrs = attributes;
    if (item.fontSize !== undefined) {
      demand(tag === 'text' && Number.isFinite(item.fontSize) && item.fontSize >= 14 && item.fontSize <= 36, `${id}: unreadable diagram font size`);
      // Inline style also overrides the English drawing's class-based font sizes.
      attrs = /\bstyle="/.test(attrs) ? attrs.replace(/style="/, `style="font-size:${item.fontSize}px;`) : `${attrs} style="font-size:${item.fontSize}px"`;
    }
    let content = escape(lines[0]);
    if (lines.length > 1) {
      const x = /\bx="([\d.-]+)"/.exec(attrs)?.[1];
      const y = Number(/\by="([\d.-]+)"/.exec(attrs)?.[1]);
      const height = item.lineHeight;
      const offset = item.offsetY ?? 0;
      demand(x !== undefined && Number.isFinite(y) && Number.isFinite(height) && height >= (item.fontSize ?? 14) && height <= 40 && Number.isFinite(offset) && Math.abs(offset) <= 40, `${id}: invalid diagram line layout`);
      content = lines.map((line, index) => `<tspan x="${x}" ${index ? `dy="${height}"` : `y="${y + offset}"`}>${escape(line)}</tspan>`).join('');
    }
    return `<${tag}${attrs}>${content}</${tag}>`;
  });
}

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
    const translation = readFileSync(resolve(directory, `zh-CN-${record.id}.json`), 'utf8');
    demand(sha256(translation) === record.translationSha256, `${record.id}: diagram translation changed; review its pairing`);
    const chineseSvg = localizeDiagram(svg, JSON.parse(translation), record.id);
    const index = DIAGRAM_IDS.indexOf(record.id);
    return { ...record, svg, chineseSvg, width: Number(box[1]), height: Number(box[2]), asset: EN_DIAGRAM_ASSETS[index], chineseAsset: ZH_DIAGRAM_ASSETS[index] };
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
<div class="diagram-viewport" role="region" tabindex="0" aria-label="${caption}"><img src="${chinese ? record.chineseAsset : record.asset}" width="${record.width}" height="${record.height}" alt="${escape(record.description[locale])}"></div>
<p class="diagram-hint">${chinese ? '窄屏下可在图内左右滑动，或聚焦后用方向键滚动。关键术语同时标注英文。' : 'On narrow screens, scroll inside the figure or focus it and use the arrow keys.'}</p>
<details class="diagram-source"><summary>${chinese ? '查看英文原始文字示意图' : 'View the source text diagram'}</summary>
${normal.code(token)}</details>
</figure>\n`;
    },
  };
}
