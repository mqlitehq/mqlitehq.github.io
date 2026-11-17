// Read-only whole-site checks. Reports are diagnostics, never an acceptance updater.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceMetadata, renderSite, checkOutputs, checkClaims, checkLinks } from './build.mjs';
import { readSiteIndex, checkSiteIndex, readVersionSources } from './site-index.mjs';
import { collectVersionReferences, checkVersionReferences } from './version-references.mjs';
import { checkCompanionContract } from './companion-contract.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const site = resolve(here, '..');
const demand = (ok, message) => { if (!ok) throw new Error(`site facts: ${message}`); };
const semver = 'v\\d+\\.\\d+\\.\\d+(?:-rc\\.\\d+)?';

export function checkCurrentVersionClaims(texts, metadata) {
  for (const [file, text] of texts) {
    if (!/\.(?:html|txt)$/.test(file)) continue;
    const visible = text.replace(/<[^>]*>/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/\*\*/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
    const sourcePatterns = [new RegExp(`\\bsource\\s+(?:version[:\\s]*)?(${semver})`, 'gi'),
      new RegExp(`(?:源码(?:版本)?|源版本)[：:\\s]*(${semver})`, 'g')];
    const sourceClaims = sourcePatterns.flatMap((pattern) => [...visible.matchAll(pattern)].map((match) => match[1]));
    demand(sourceClaims.length > 0, `${file}: missing generated source-version declaration`);
    for (const value of sourceClaims) demand(value === `v${metadata.sourceVersion}`, `${file}: stale source version ${value}`);
    const releasePatterns = [
      new RegExp(`(?:latest(?: (?:recorded|published|supported))? release|最新受支持(?:的)?版本)(?::|：| is|为|是)?\\s*(${semver})`, 'gi'),
      new RegExp(`(${semver})\\s*,?\\s*(?:is\\s+)?the latest supported release\\b`, 'gi'),
    ];
    const releaseClaims = releasePatterns.flatMap((pattern) => [...visible.matchAll(pattern)].map((match) => match[1]));
    demand(releaseClaims.length > 0, `${file}: missing generated stable-release declaration`);
    for (const value of releaseClaims) demand(value === metadata.latestRelease, `${file}: stale supported release ${value} (expected ${metadata.latestRelease})`);
  }
  return true;
}

export function checkReviewBaseline(index, metadata) {
  demand(index.releaseReview?.reviewedValue === metadata.latestRelease && index.releaseReview?.reason?.trim(),
    `whole-site release checklist was not reviewed for ${metadata.latestRelease}`);
  for (const field of ['brokerPort', 'schemaVersion', 'goVersion']) {
    demand(index.defaultReview?.values?.[field] === metadata[field],
      `review all indexed default/floor examples: ${field} changed to ${metadata[field]}`);
  }
  demand(index.defaultReview?.reason?.trim(), 'missing default/floor review rationale');
}

export function auditSite(root, mq, { sdkRoot } = {}) {
  const report = { formatVersion: 1, errors: [], files: [], references: [] };
  const attempt = (operation) => { try { return operation(); } catch (error) { report.errors.push(error.message); } };
  const metadata = attempt(() => sourceMetadata(mq));
  if (!metadata) return report;
  report.sourceVersion = metadata.sourceVersion;
  report.latestRelease = metadata.latestRelease;
  report.companion = attempt(() => checkCompanionContract(root, sdkRoot));
  const index = attempt(() => readSiteIndex(root));
  if (!index) return report;
  report.files = index.entries;
  attempt(() => checkReviewBaseline(index, metadata));
  report.inventory = attempt(() => checkSiteIndex(index, root, metadata, mq));
  const sources = attempt(() => readVersionSources(index, root, mq));
  if (sources) {
    report.contentSources = sources.size;
    // Preserve diagnostic positions even when a new/changed reference fails.
    report.references = collectVersionReferences(sources);
    const reviewed = attempt(() => checkVersionReferences(sources,
      JSON.parse(readFileSync(resolve(root, 'tools/version-references.json'), 'utf8')), metadata));
    if (reviewed) report.references = reviewed;
  }
  const rendered = attempt(() => renderSite(mq, { translationRoot: root }));
  if (rendered) attempt(() => checkOutputs(rendered.outputs, root));
  attempt(() => checkClaims(metadata, root));
  attempt(() => checkLinks(root));
  const texts = new Map(index.entries.filter(({ output }) => /\.(?:html|txt)$/.test(output))
    .flatMap(({ output }) => {
      const text = attempt(() => readFileSync(resolve(root, output), 'utf8'));
      return text === undefined ? [] : [[output, text]];
    }));
  attempt(() => checkCurrentVersionClaims(texts, metadata));
  return report;
}

function summary(report) {
  const escape = (text) => String(text).replace(/[|\r\n]/g, ' ');
  return `## Whole-site documentation audit\n\n${report.errors.length ? 'FAILED' : 'PASSED'}: ` +
    `${report.files.length} public files; ${report.contentSources ?? 0} content sources; ` +
    `${report.references.length} version-reference lines. Source v${report.sourceVersion}; tagged baseline ${report.latestRelease}. ` +
    `Remote SDK: ${report.companion?.filesReviewed ?? 0} reviewed inputs, Go ${report.companion?.goVersion ?? 'unverified'}.\n\n` +
    report.errors.map((error) => `- ${escape(error)}\n`).join('') +
    '\n| Public file | Policy | Maintained sources |\n| --- | --- | --- |\n' +
    report.files.map((entry) => `| ${escape(entry.output)} | ${entry.policy} | ${entry.sources.map(escape).join(', ')} |`).join('\n') + '\n';
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const mq = args.shift();
  demand(mq && !mq.startsWith('--'), 'usage: node tools/site-audit.mjs CANONICAL_MQLITE --sdk CANONICAL_MQLITE_GO [--report FILE] [--summary FILE]');
  const options = new Map();
  while (args.length) {
    const name = args.shift(), value = args.shift();
    demand(['--sdk', '--report', '--summary'].includes(name) && value && !value.startsWith('--') && !options.has(name), 'invalid report arguments');
    options.set(name, value);
  }
  demand(options.has('--sdk'), 'the canonical remote SDK checkout is required (--sdk)');
  const report = auditSite(site, resolve(here, mq), { sdkRoot: resolve(here, options.get('--sdk')) });
  if (options.has('--report')) writeFileSync(resolve(options.get('--report')), JSON.stringify(report, null, 2) + '\n');
  if (options.has('--summary')) writeFileSync(resolve(options.get('--summary')), summary(report));
  console.log(`${report.errors.length ? 'FAILED' : 'Verified'} whole-site audit: ${report.files.length} public files, ${report.contentSources ?? 0} content sources, ${report.references.length} version-reference lines.`);
  for (const error of report.errors) console.error(error);
  if (report.errors.length) process.exitCode = 1;
}
