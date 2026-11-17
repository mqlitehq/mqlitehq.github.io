// Read-only semantic review gate for website claims about the remote-only SDK.
// Recording new fingerprints requires review, not merely a successful hash run.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { resolve } from 'node:path';

const FORMAT_VERSION = 1;
const VERSION_SOURCE = 'internal/version/version.go';
const FIXED_INPUTS = ['go.mod', 'README.md', '.github/workflows/ci.yml', '.github/workflows/release.yml'];
// The test tree contains live-broker and linked-size probes, not shipped SDK code.
// Traverse every other directory so a newly introduced runtime package is caught.
const EXCLUDED_DIRECTORIES = new Set(['.git', 'test']);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const demand = (ok, message) => { if (!ok) throw new Error(`companion contract: ${message}`); };

function read(root, file) {
  try {
    demand(lstatSync(resolve(root, file)).isFile(), `expected a regular source file: ${file}`);
    return readFileSync(resolve(root, file));
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`companion contract: missing source file: ${file}`);
    throw error;
  }
}

function goFloor(sdkRoot) {
  const matches = [...read(sdkRoot, 'go.mod').toString('utf8')
    .matchAll(/^go[ \t]+([1-9]\d*\.\d+(?:\.\d+)?)[ \t]*$/gm)];
  demand(matches.length === 1, 'cannot read the single Go version directive');
  return matches[0][1];
}

function fingerprint(file, bytes) {
  if (file !== VERSION_SOURCE) return digest(bytes);
  const text = bytes.toString('utf8');
  const pattern = /^const Version = "([^"]+)"$/gm;
  demand([...text.matchAll(pattern)].length === 1, 'cannot read the single SDK release version constant');
  // Ignore only the release string. Package changes, comments, new imports and
  // executable logic in this file remain reviewed bytes rather than exceptions.
  return digest(text.replace(pattern, 'const Version = "<release-version>"'));
}

function sourceInventory(sdkRoot) {
  const files = new Set(FIXED_INPUTS);
  function directory(relative) {
    let entries;
    try {
      demand(lstatSync(resolve(sdkRoot, relative)).isDirectory(), `expected a regular source directory: ${relative || '.'}`);
      entries = readdirSync(resolve(sdkRoot, relative), { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error(`companion contract: missing source directory: ${relative || '.'}`);
      throw error;
    }
    for (const entry of entries) {
      const file = relative ? `${relative}/${entry.name}` : entry.name;
      if (EXCLUDED_DIRECTORIES.has(file)) continue;
      demand(!entry.isSymbolicLink(), `symbolic links are not accepted in the source scope: ${file}`);
      if (entry.isDirectory()) directory(file);
      else if (entry.isFile() && file.endsWith('.go') && !file.endsWith('_test.go')) files.add(file);
    }
  }
  directory('');
  try {
    lstatSync(resolve(sdkRoot, 'go.sum'));
    files.add('go.sum');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return [...files].sort();
}

export function checkCompanionContract(siteRoot, sdkRoot) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(resolve(siteRoot, 'tools/companion-contract.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('companion contract: missing tools/companion-contract.json; review the source before recording fingerprints');
    throw new Error('companion contract: cannot parse tools/companion-contract.json');
  }
  demand(manifest?.formatVersion === FORMAT_VERSION, 'unsupported review manifest version');
  demand(typeof manifest.reviewedRevision === 'string' && /^[0-9a-f]{40}$/.test(manifest.reviewedRevision), 'invalid reviewed SDK revision');
  demand(manifest.files && typeof manifest.files === 'object' && !Array.isArray(manifest.files), 'invalid reviewed file inventory');
  const goVersion = goFloor(sdkRoot);
  const actual = sourceInventory(sdkRoot), expected = Object.keys(manifest.files).sort();
  const added = actual.filter((file) => !Object.hasOwn(manifest.files, file));
  const removed = expected.filter((file) => !actual.includes(file));
  demand(!added.length && !removed.length,
    `source inventory changed (added: ${added.join(', ') || 'none'}; removed: ${removed.join(', ') || 'none'}); review the website guidance`);
  const verified = {};
  for (const file of actual) {
    demand(typeof manifest.files[file] === 'string' && /^[0-9a-f]{64}$/.test(manifest.files[file]), `invalid reviewed fingerprint: ${file}`);
    verified[file] = fingerprint(file, read(sdkRoot, file));
    demand(verified[file] === manifest.files[file], `${file} changed; review the English/Chinese SDK guidance before updating its fingerprint`);
  }
  // reviewedRevision is the review basis, not a demand for a particular HEAD.
  // A version-only commit can retain exactly the same reviewed semantics.
  return {
    reviewedRevision: manifest.reviewedRevision,
    sourceDigest: digest(JSON.stringify(verified)),
    filesReviewed: actual.length,
    goVersion,
  };
}
