// Build-time translations only: the browser downloads one language, never both.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Marked } from 'marked';

export const sha256 = (text) => createHash('sha256').update(text).digest('hex');
export const INTERFACE_FILES = ['tools/build.mjs', 'tools/i18n.mjs', 'tools/concept-diagrams.mjs', 'tools/diagrams/manifest.json', 'assets/site.js', 'assets/demo.js'];
const demand = (ok, message) => { if (!ok) throw new Error(message); };
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const normalize = (text) => text.replace(/\r\n/g, '\n');
const lexer = new Marked({ gfm: true });
const same = (a, b, message) => demand(JSON.stringify(a) === JSON.stringify(b), message);

function inlineFacts(tokens = []) {
  const result = { code: [], links: [], images: [] };
  function visit(items) {
    for (const token of items) {
      if (token.type === 'codespan') result.code.push(token.text);
      if (token.type === 'link') result.links.push(token.href);
      if (token.type === 'image') result.images.push(token.href);
      if (token.tokens) visit(token.tokens);
    }
  }
  visit(tokens);
  result.code.sort();
  result.links.sort();
  result.images.sort();
  return result;
}

function shape(tokens, path) {
  return tokens.filter((t) => t.type !== 'space').map((token, i) => {
    const at = `${path}/${i}:${token.type}`;
    const value = { type: token.type };
    if (token.type === 'code') return { ...value, lang: token.lang ?? '', text: token.text };
    if (token.type === 'heading') value.depth = token.depth;
    if (token.type === 'list') {
      value.ordered = token.ordered;
      value.start = token.start;
      value.items = token.items.map((item, j) => ({ task: item.task, checked: item.checked, blocks: shape(item.tokens, `${at}/${j}`) }));
    } else if (token.type === 'blockquote') {
      value.blocks = shape(token.tokens, at);
    } else if (token.type === 'table') {
      value.align = token.align;
      value.header = token.header.map((cell) => inlineFacts(cell.tokens));
      value.rows = token.rows.map((row) => row.map((cell) => inlineFacts(cell.tokens)));
    } else if (token.type === 'html') {
      // HTML structure, anchors, and embedded literal code are contract data.
      value.tags = [...token.raw.matchAll(/<\/?[A-Za-z][^>]*>/g)].map((m) => m[0]);
      value.code = [...token.raw.matchAll(/<code\b[^>]*>([\s\S]*?)<\/code>/g)].map((m) => m[1]);
    } else {
      value.inline = inlineFacts(token.tokens);
    }
    return value;
  });
}

export const markdownContract = (text) => shape(lexer.lexer(normalize(text)), 'document');

export function checkMarkdownPair(english, chinese, name = 'document') {
  const en = normalize(english), zh = normalize(chinese);
  demand(/[\u3400-\u9fff]/u.test(zh), `${name}: missing Simplified Chinese prose`);
  same(shape(lexer.lexer(en), name), shape(lexer.lexer(zh), name), `${name}: translated structure/code/link contract differs`);
  lexer.walkTokens(lexer.lexer(zh), (token) => {
    if (token.type === 'text' && !token.tokens?.length) demand(!token.text.includes('**'), `${name}: untranslated Markdown emphasis is visible in prose`);
  });
  // Numbers in code, URLs and prose must survive translation, including versions,
  // bounds, measured workloads, dates, units' numeric parts and negative values.
  checkNumericPair(en, zh, name);
}

export function checkNumericPair(english, chinese, name) {
  const numbers = (s) => [...s.matchAll(/-?\d+(?:[.,]\d+)*/g)].map((match) => {
    // A hyphen in non-2xx, go-1.21 or 32-or-1 is punctuation, not a sign.
    const wordHyphen = match[0][0] === '-' && /[A-Za-z0-9_]/.test(s[match.index - 1] ?? '');
    return wordHyphen ? match[0].slice(1) : match[0];
  }).sort();
  same(numbers(english), numbers(chinese), `${name}: translated numeric contract differs`);
}

export function agentPromptSource(html) {
  const matches = [...html.matchAll(/<pre id="p1"><code>([\s\S]*?)<\/code><\/pre>/g)];
  demand(matches.length === 1, 'agents.html: expected one copyable agent prompt');
  return decodeText(matches[0][1]);
}

export function checkAgentPrompt(english, chinese) {
  demand(/[\u3400-\u9fff]/u.test(chinese), 'agent prompt needs Chinese prose');
  checkNumericPair(english, chinese, 'agent prompt');
  for (const pattern of [
    /https?:\/\/[^\s)]+/g,
    /"(?:\\.|[^"\\])*"/g,
    /\b(?:QueueService|AdminService|AuthService)\/(?:[A-Za-z_][A-Za-z0-9_]*|<Method>)/g,
    /\b[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+\b/g,
    /<MQLITE_[A-Z_]+>/g,
  ]) same((english.match(pattern) ?? []).sort(), (chinese.match(pattern) ?? []).sort(), 'agent prompt: literal protocol data differs');
  same((english.match(/^- /gm) ?? []).length, (chinese.match(/^- /gm) ?? []).length, 'agent prompt: rule inventory differs');
}

export function translateAgentPrompt(html, prompt) {
  agentPromptSource(html);
  return html.replace(/(<pre id="p1"><code>)[\s\S]*?(<\/code><\/pre>)/, (_all, before, after) => before + escape(prompt) + after);
}

export function loadTranslations(siteRoot, mq, files) {
  const root = resolve(siteRoot, 'i18n/zh-CN');
  const manifest = json(resolve(root, 'manifest.json'));
  demand(manifest.locale === 'zh-CN' && manifest.sourceLocale === 'en', 'invalid translation locales');
  same(Object.keys(manifest.runtimeSources ?? {}).sort(), [...INTERFACE_FILES].sort(), 'interface runtime inventory differs');
  for (const name of INTERFACE_FILES) {
    demand(manifest.runtimeSources[name] === sha256(readFileSync(resolve(siteRoot, name))), `${name}: interface source changed; review both languages`);
  }
  same(Object.keys(manifest.documents).sort(), [...files].sort(), 'translation document inventory differs');
  const documents = new Map();
  for (const name of files) {
    const english = readFileSync(resolve(mq, 'docs', name), 'utf8');
    const chinese = readFileSync(resolve(root, 'docs', name), 'utf8');
    demand(manifest.documents[name].sourceSha256 === sha256(english), `${name}: English source changed; review its translation`);
    demand(manifest.documents[name].translationSha256 === sha256(chinese), `${name}: translation changed; review its source pairing`);
    checkMarkdownPair(english, chinese, name);
    documents.set(name, chinese);
  }
  const interfaceSource = readFileSync(resolve(root, 'interface.json'), 'utf8');
  demand(manifest.interfaceSha256 === sha256(interfaceSource), 'interface translations changed; review their source pairing');
  const englishSummary = readFileSync(resolve(siteRoot, 'llms.txt'), 'utf8');
  const summary = readFileSync(resolve(root, 'llms.txt'), 'utf8');
  demand(manifest.summary.sourceSha256 === sha256(englishSummary), 'llms.txt: English summary changed; review Chinese');
  demand(manifest.summary.translationSha256 === sha256(summary), 'llms.txt: Chinese summary changed; review pairing');
  checkMarkdownPair(englishSummary, summary, 'llms.txt');
  const englishPrompt = agentPromptSource(readFileSync(resolve(siteRoot, 'agents.html'), 'utf8'));
  const prompt = readFileSync(resolve(root, 'agent-prompt.txt'), 'utf8');
  demand(manifest.agentPrompt?.sourceSha256 === sha256(englishPrompt), 'agent prompt: English changed; review Chinese');
  demand(manifest.agentPrompt?.translationSha256 === sha256(prompt), 'agent prompt: Chinese changed; review pairing');
  checkAgentPrompt(englishPrompt, prompt);
  return { documents, manifest, interface: JSON.parse(interfaceSource), summary, prompt };
}

export function keepEnglishHeadingIds(englishHtml, chineseHtml, name) {
  const headings = (s) => [...s.matchAll(/<h([1-6])\b[^>]*\bid="([^"]+)"/g)].map((m) => [m[1], m[2]]);
  const en = headings(englishHtml), zh = headings(chineseHtml);
  same(en.map((h) => h[0]), zh.map((h) => h[0]), `${name}: heading correspondence differs`);
  let index = 0;
  return chineseHtml.replace(/(<h[1-6]\b[^>]*\bid=")([^"]+)(")/g, (_m, before, _id, after) => `${before}${en[index++][1]}${after}`);
}

const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', rarr: '→', copy: '©', ndash: '–', mdash: '—' };
export function decodeText(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, name) => {
    if (name[0] === '#') return String.fromCodePoint(name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1)));
    return entities[name] ?? all;
  });
}
export const textKey = (text) => decodeText(text).replace(/\s+/g, ' ').trim();
const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
// Keep scripts, code examples, styles and diagrams opaque; prose outside them is
// exhaustive, including metadata, accessible names and descriptions.
const htmlTokens = (html) => html.match(/<!--[\s\S]*?-->|<a\b[^>]*data-language-switch[^>]*>[\s\S]*?<\/a>|<(pre|code|script|style|svg)\b[\s\S]*?<\/\1\s*>|<[^>]+>|[^<]+/gi) ?? [];

export function handwrittenStrings(html) {
  const values = new Set();
  for (const token of htmlTokens(html)) {
    if (/^<!--|^<(?:pre|code|script|style|svg)\b|^<a\b[^>]*data-language-switch/i.test(token)) continue;
    if (token[0] === '<') {
      for (const m of token.matchAll(/\b(?:aria-label|title|alt|placeholder)=(["'])(.*?)\1/g)) if (textKey(m[2])) values.add(textKey(m[2]));
      if (/^<meta\b[^>]*(?:name=["']description["']|property=["']og:(?:title|description)["'])/i.test(token)) {
        const content = /\bcontent=(["'])(.*?)\1/.exec(token)?.[2];
        if (content) values.add(textKey(content));
      }
    } else if (textKey(token)) values.add(textKey(token));
  }
  return [...values].sort();
}

export function translateHandwritten(html, catalog, name) {
  const record = catalog.pages[name];
  demand(record?.sourceSha256 === sha256(html), `${name}: hand-written English changed; review Chinese`);
  const required = handwrittenStrings(html);
  for (const key of required) demand(typeof catalog.strings[key] === 'string' && catalog.strings[key].trim(), `${name}: untranslated interface text: ${key}`);
  const translate = (text) => {
    const key = textKey(text);
    if (!key) return text;
    const leading = /^\s*/.exec(text)[0], trailing = /\s*$/.exec(text)[0];
    return leading + escape(catalog.strings[key]) + trailing;
  };
  return htmlTokens(html).map((token) => {
    if (/^<!--|^<(?:pre|code|script|style|svg)\b|^<a\b[^>]*data-language-switch/i.test(token)) return token;
    if (token[0] !== '<') return translate(token);
    token = token.replace(/\b(aria-label|title|alt|placeholder)=(["'])(.*?)\2/g, (_m, attr, quote, value) => `${attr}=${quote}${translate(value)}${quote}`);
    if (/^<meta\b[^>]*(?:name=["']description["']|property=["']og:(?:title|description)["'])/i.test(token)) token = token.replace(/\bcontent=(["'])(.*?)\1/, (_m, quote, value) => `content=${quote}${translate(value)}${quote}`);
    return token;
  }).join('');
}

export function localeLinks(html, chinese = false) {
  if (!chinese) return html;
  return html.replace(/\b(href|src)="([^"]+)"/g, (all, attr, href) => {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(href)) return all;
    if (href.startsWith('assets/') || /^(?:favicon|logo)\.svg(?:#.*)?$/.test(href)) return `${attr}="../${href}"`;
    return all;
  });
}

export function languageLinks(file, chinese = false) {
  const english = chinese ? `../${file}` : file;
  const zh = chinese ? file : `zh-CN/${file}`;
  return `<link rel="alternate" hreflang="en" href="${english}">\n<link rel="alternate" hreflang="zh-CN" href="${zh}">\n<link rel="alternate" hreflang="x-default" href="${english}">`;
}

export function languageSwitch(file, chinese = false) {
  return `<a class="language-switch" data-language-switch href="${chinese ? `../${file}` : `zh-CN/${file}`}" hreflang="${chinese ? 'en' : 'zh-CN'}" lang="${chinese ? 'en' : 'zh-CN'}" aria-label="${chinese ? 'Switch to English' : '切换为简体中文'}">${chinese ? 'English' : '简体中文'}</a>`;
}
