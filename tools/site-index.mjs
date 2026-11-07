// The reviewed public-file inventory is also the Pages packaging allowlist.
import { readFileSync, readdirSync, lstatSync, realpathSync, mkdirSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const site = resolve(here, '..');
const internalDirectories = new Set(['.git', '.github', 'tools', 'templates', 'i18n', 'node_modules', 'mqlite-src', 'mqlite-go-src', '_site']);
const publicExtension = /\.(?:html?|txt|json|svg|css|m?js|xml|webmanifest|ico|png|jpe?g|webp|gif|woff2?|pdf)$/i;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const demand = (ok, message) => { if (!ok) throw new Error(`site index: ${message}`); };
const safePath = (path) => typeof path === 'string' && !!path && !path.includes('\\') &&
  !isAbsolute(path) && path.split('/').every((part) => part && part !== '.' && part !== '..' && !part.startsWith('.'));

export function readSiteIndex(root = site) {
  const index = JSON.parse(readFileSync(resolve(root, 'tools/site-index.json'), 'utf8'));
  demand(index.formatVersion === 1 && Array.isArray(index.entries) && index.entries.length > 0, 'invalid format or empty public inventory');
  const outputs = new Set();
  for (const entry of index.entries) {
    demand(safePath(entry.output) && !outputs.has(entry.output), `invalid or duplicate output ${entry.output}`);
    demand(!internalDirectories.has(entry.output.split('/')[0]), `internal output ${entry.output}`);
    outputs.add(entry.output);
    demand(['generated', 'reviewed-static'].includes(entry.policy), `${entry.output}: invalid ownership policy`);
    demand(typeof entry.owner === 'string' && entry.owner.trim().length > 8, `${entry.output}: missing maintenance owner`);
    demand(Array.isArray(entry.sources) && entry.sources.length > 0 && new Set(entry.sources).size === entry.sources.length,
      `${entry.output}: missing or duplicate source mapping`);
    for (const source of entry.sources) demand(/^(?:site|mqlite)\//.test(source) && safePath(source), `${entry.output}: unsafe source ${source}`);
    if (entry.policy === 'reviewed-static') demand(/^[a-f0-9]{64}$/.test(entry.sha256 ?? ''), `${entry.output}: missing reviewed static fingerprint`);
  }
  demand(Array.isArray(index.versionSources) && index.versionSources.length > 0 && new Set(index.versionSources).size === index.versionSources.length,
    'missing or duplicate version-source inventory');
  for (const source of index.versionSources) demand(/^(?:site|mqlite)\//.test(source) && safePath(source), `unsafe version source ${source}`);
  return index;
}

// Discover candidates independently of the index, so an unregistered new HTML
// page, locale directory, image or script cannot silently enter a glob package.
export function discoverPublicFiles(root) {
  const files = [];
  function walk(directory, prefix = '') {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const file = prefix + entry.name;
      if (!prefix && internalDirectories.has(entry.name)) continue;
      demand(!entry.isSymbolicLink(), `symbolic public candidate ${file}`);
      if (entry.isDirectory()) walk(resolve(directory, entry.name), file + '/');
      else if (entry.isFile() && (file.startsWith('assets/') || publicExtension.test(file))) files.push(file);
    }
  }
  walk(root);
  return files.sort();
}

function sourceFile(name, root, mq) {
  const [namespace, ...parts] = name.split('/');
  const base = namespace === 'site' ? root : mq;
  demand(typeof base === 'string' && base.length > 0, `${name}: canonical checkout required`);
  const path = resolve(base, ...parts);
  demand(lstatSync(path).isFile(), `${name}: expected a regular source file`);
  const outside = relative(realpathSync(base), realpathSync(path));
  demand(outside !== '..' && !outside.startsWith('../') && !isAbsolute(outside), `${name}: source escapes its checkout`);
  return path;
}

export function checkSiteIndex(index, root, metadata, mq) {
  const expected = index.entries.map(({ output }) => output).sort();
  const actual = discoverPublicFiles(root);
  const extra = actual.filter((file) => !expected.includes(file));
  const missing = expected.filter((file) => !actual.includes(file));
  demand(!extra.length && !missing.length, `public inventory differs (unregistered: ${extra.join(', ') || 'none'}; missing: ${missing.join(', ') || 'none'})`);
  const generated = index.entries.filter(({ policy }) => policy === 'generated').map(({ output }) => output).sort();
  demand(JSON.stringify(generated) === JSON.stringify([...metadata.generatedFiles].sort()), 'generated ownership differs from generator inventory');
  for (const entry of index.entries) {
    const page = /\.(?:html|txt)$/.test(entry.output);
    if (page) demand(typeof entry.locale === 'string' && metadata.locales.includes(entry.locale), `${entry.output}: page must declare a published locale`);
    if (entry.locale) {
      demand(metadata.locales.includes(entry.locale), `${entry.output}: unknown locale ${entry.locale}`);
      if (entry.locale !== metadata.defaultLocale) demand(entry.output.startsWith(`${entry.locale}/`), `${entry.output}: locale path differs from ${entry.locale}`);
      else demand(!metadata.locales.some((locale) => entry.output.startsWith(`${locale}/`)), `${entry.output}: default locale must use the root path`);
    }
    if (entry.policy === 'reviewed-static') demand(digest(readFileSync(resolve(root, entry.output))) === entry.sha256,
      `${entry.output}: static content changed; review its facts and source mapping`);
    if (mq) for (const source of entry.sources) {
      // Local development may reuse an already installed node_modules through
      // a symlink. This one locked vendor input is byte-checked by build.mjs;
      // prose and artwork sources never receive this exception.
      if (entry.output === 'assets/highlight.min.js' && source === 'site/tools/node_modules/@highlightjs/cdn-assets/highlight.min.js') {
        demand(lstatSync(resolve(root, 'tools/node_modules/@highlightjs/cdn-assets/highlight.min.js')).isFile(), 'missing installed highlighter source');
      } else sourceFile(source, root, mq);
    }
  }
  // Every actual locale needs the same HTML and machine-readable page inventory.
  const english = index.entries.filter(({ locale }) => locale === metadata.defaultLocale).map(({ output }) => output).sort();
  for (const locale of metadata.locales.filter((locale) => locale !== metadata.defaultLocale)) {
    const translated = index.entries.filter((entry) => entry.locale === locale).map(({ output }) => output.replace(`${locale}/`, '')).sort();
    demand(JSON.stringify(translated) === JSON.stringify(english), `${locale}: public page correspondence differs`);
  }
  return { publicFiles: expected.length, generatedFiles: generated.length, staticFiles: expected.length - generated.length };
}

export function readVersionSources(index, root, mq) {
  const sources = new Map();
  for (const source of index.versionSources) sources.set(source, readFileSync(sourceFile(source, root, mq), 'utf8'));
  // Every prose source and hand-maintained public asset must be scanned. A
  // source mapping cannot exempt a new document merely by omitting this list.
  for (const entry of index.entries) {
    for (const source of entry.sources) {
      // Metadata reads CHANGELOG to choose the tagged baseline; it does not
      // publish the changelog body as current product guidance.
      const content = !['site-metadata.json', 'assets/highlight.min.js'].includes(entry.output) &&
        (/\.(?:md|html|txt|svg|css|json|m?js)$/.test(source) || entry.policy === 'reviewed-static');
      if (content) demand(sources.has(source), `${source}: content source is missing from version review`);
    }
  }
  return sources;
}

export function packageSite(root, destination) {
  const index = readSiteIndex(root);
  const metadata = JSON.parse(readFileSync(resolve(root, 'site-metadata.json'), 'utf8'));
  checkSiteIndex(index, root, metadata);
  mkdirSync(destination); // Existing destinations are deliberately refused.
  for (const { output } of index.entries) {
    const target = resolve(destination, output);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(resolve(root, output), target);
  }
  return index.entries.length;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  demand(process.argv.length === 4 && process.argv[2] === 'package', 'usage: node tools/site-index.mjs package NEW_OUTPUT_DIRECTORY');
  console.log(`Packaged ${packageSite(site, resolve(process.argv[3]))} indexed public files.`);
}
