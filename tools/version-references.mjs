// A review ledger for literal version references. It detects textual drift;
// assigning a kind and reason still requires reading the surrounding meaning.
import { createHash } from 'node:crypto';

const kinds = new Set(['current-release', 'source-go', 'historical', 'upstream']);
const semverReference = /(?<![\d.])v?\d+\.\d+\.(?:\d+|x|\*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?!\d|\.\d)/i;
const goReference = /\bgo\s*(?:(?:>=|>|≥|=|~|\^)\s*)?\d+\.\d+(?:\.\d+)?(?:(?:rc|beta)\d+)?(?!\d|\.\d)/i;
const imageReference = /\bmqlite(?::v?\d+(?:\.[0-9x*]+){0,2}(?:[-+][0-9A-Za-z.-]+)?|@sha256:[a-f0-9]{64})\b/i;
const dynamicRefs = new Set(['main', 'master', 'HEAD', 'latest']);

function fail(message) {
  throw new Error(`version references: ${message}`);
}

function referenceKey(source, text, occurrence) {
  return `${source}:${createHash('sha256').update(text).digest('hex')}:${occurrence}`;
}

function recognitionText(text) {
  // Decode only comparison/space entities for recognition, retaining the exact
  // original trimmed source line for review and hashing.
  return text.replace(/&gt;|&#62;/gi, '>')
    .replace(/&ge;|&geq;|&#8805;|&#x2265;/gi, '≥').replace(/&nbsp;/gi, ' ');
}

function hasReference(text) {
  const probe = recognitionText(text);
  const unmarked = probe.replace(/<\/?[A-Za-z][^>]*>/g, '').replace(/[`*_]/g, '');
  if (semverReference.test(probe) || goReference.test(unmarked) || imageReference.test(probe)) return true;
  for (const match of probe.matchAll(/github\.com\/mqlitehq\/mqlite(?:-go)?\/(?:blob|tree|releases\/(?:tag|download))\/([^/\s"'<>?#)]+)/g)) {
    const ref = match[1];
    if (!dynamicRefs.has(ref) && !ref.includes('{{')) return true;
  }
  return false;
}

function containsReviewedValue(text, kind, value) {
  // This is a literal safeguard, not a claim to understand surrounding prose.
  // In particular, updating only reviewedValue must not bless stale body text.
  const probe = recognitionText(text).replace(/<\/?[A-Za-z][^>]*>/g, '').replace(/[`*_]/g, '');
  if (kind === 'current-release') {
    if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(value)) return false;
    const literal = value.slice(1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![\\d.])v?${literal}(?![0-9A-Za-z+_-]|\\.\\d)`).test(probe);
  }
  if (kind === 'source-go') {
    if (!/^\d+\.\d+(?:\.\d+)?$/.test(value)) return false;
    const literal = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\bgo\\s*(?:(?:>=|>|≥|=|~|\\^)\\s*)?${literal}(?!\\d|\\.\\d)`, 'i').test(probe);
  }
  return true;
}

export function collectVersionReferences(sources) {
  if (!(sources instanceof Map)) fail('sources must be a Map of logical paths to text');
  const result = [];
  for (const [source, content] of sources) {
    if (typeof source !== 'string' || !source || source.trim() !== source || /[\0\r\n]/.test(source)) {
      fail('invalid source path');
    }
    if (typeof content !== 'string') fail(`source must be text: ${source}`);
    const occurrences = new Map();
    content.split(/\r?\n/).forEach((raw, index) => {
      const text = raw.trim();
      if (!hasReference(text)) return;
      const occurrence = (occurrences.get(text) ?? 0) + 1;
      occurrences.set(text, occurrence);
      result.push({ source, line: index + 1, text, occurrence, key: referenceKey(source, text, occurrence) });
    });
  }
  return result;
}

export function checkVersionReferences(sources, ledger, metadata) {
  const actual = collectVersionReferences(sources);
  if (!Array.isArray(ledger)) fail('review ledger must be an array');
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) fail('metadata must be an object');
  const byKey = new Map(actual.map((record) => [record.key, record]));
  const reviews = new Map();
  for (const record of ledger) {
    if (!record || typeof record !== 'object' || Array.isArray(record) ||
        typeof record.source !== 'string' || !record.source || record.source.trim() !== record.source ||
        /[\0\r\n]/.test(record.source) || typeof record.text !== 'string' || !record.text ||
        record.text.trim() !== record.text || /[\r\n]/.test(record.text) ||
        !Number.isSafeInteger(record.occurrence) || record.occurrence < 1) {
      fail('invalid review entry identity');
    }
    if (!kinds.has(record.kind)) fail(`unknown review kind: ${record.kind}`);
    if (typeof record.reason !== 'string' || !record.reason.trim()) fail(`review reason is required: ${record.source}`);
    const key = referenceKey(record.source, record.text, record.occurrence);
    if (reviews.has(key)) fail(`duplicate review entry: ${record.source} occurrence ${record.occurrence}`);
    reviews.set(key, record);
    if (!byKey.has(key)) fail(`obsolete review entry: ${record.source} occurrence ${record.occurrence}; review removed or changed references`);
  }
  return actual.map((reference) => {
    const review = reviews.get(reference.key);
    if (!review) fail(`unreviewed reference: ${reference.source}:${reference.line} occurrence ${reference.occurrence}`);
    const field = review.kind === 'current-release' ? 'latestRelease' : review.kind === 'source-go' ? 'goVersion' : null;
    if (field && (typeof metadata[field] !== 'string' || !metadata[field] || review.reviewedValue !== metadata[field])) {
      fail(`${review.kind} review is stale: ${reference.source}:${reference.line}; review against the current ${field}`);
    }
    if (field && !containsReviewedValue(reference.text, review.kind, metadata[field])) {
      fail(`${review.kind} text is stale: ${reference.source}:${reference.line}; the exact line must contain the current ${field}`);
    }
    if (review.reviewedValue !== undefined && (typeof review.reviewedValue !== 'string' || !review.reviewedValue.trim())) {
      fail(`invalid reviewed value: ${reference.source}:${reference.line}`);
    }
    return { ...reference, kind: review.kind, reason: review.reason.trim(),
      ...(review.reviewedValue !== undefined ? { reviewedValue: review.reviewedValue } : {}) };
  });
}
