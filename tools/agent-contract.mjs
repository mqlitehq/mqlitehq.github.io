// A review gate for the source behind the hand-written website guidance. This is
// deliberately read-only: regenerating fingerprints is not a semantic review.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { resolve } from 'node:path';

const FORMAT_VERSION = 1;
const SOURCE_DIRECTORIES = ['engine', 'server', 'wire', 'cmd/mqlite-mcp', 'cmd/mqlite', 'internal'];
// console.go embeds all:web. Its built runtime can change independently of Go,
// so every asset path and byte belongs to the reviewed production inventory.
const ASSET_DIRECTORIES = ['server/web'];
const DOCUMENTS = [
  'docs/mcp.md', 'docs/api-reference.md', 'docs/access-keys.md',
  'docs/concepts.md', 'docs/operations.md', 'docs/conformance.md',
  'docs/retention.md', 'docs/dependencies.md', 'docs/cli.md', 'docs/internals.md',
  'docs/deployment.md', 'docs/observability.md', 'docs/observability-cloud.md',
  'docs/turso.md', 'docs/benchmark.md', 'docs/examples.md',
];
// These public repository inputs define the documented floor, build targets,
// packaging, release checks and local deployment. No environment files belong
// here. Review helper implementations too: an unchanged workflow is insufficient
// when the script it invokes changes the release policy.
const BUILD_AND_RELEASE_FILES = [
  'Dockerfile', 'docker-compose.yml', 'Makefile', '.goreleaser.yaml',
  '.github/dependabot.yml', '.github/workflows/ci.yml',
  '.github/workflows/release.yml', '.github/workflows/release-image.yml',
  '.github/scripts/release_guard.py', '.github/scripts/image_candidate.py',
];
const EXCLUDED_VERSION_SOURCE = 'internal/version/version.go';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const demand = (ok, message) => { if (!ok) throw new Error(`agent contract: ${message}`); };

function read(root, file) {
  try {
    demand(lstatSync(resolve(root, file)).isFile(), `expected a regular source file: ${file}`);
    return readFileSync(resolve(root, file));
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`agent contract: missing source file: ${file}`);
    throw error;
  }
}

function one(text, pattern, name) {
  const matches = [...text.matchAll(pattern)];
  demand(matches.length === 1, `cannot read the single ${name}`);
  return matches[0][1];
}

export function sourceAgentFacts(mq) {
  const goVersion = one(read(mq, 'go.mod').toString('utf8'), /^go[ \t]+([1-9]\d*\.\d+(?:\.\d+)?)[ \t]*$/gm, 'Go version directive');
  const schemaVersion = one(read(mq, 'engine/schema.go').toString('utf8'), /^const schemaVersion = "([A-Za-z0-9._-]+)"[ \t]*$/gm, 'schema version token');
  const brokerPort = one(read(mq, 'internal/defaults/defaults.go').toString('utf8'), /^[ \t]*(?:const[ \t]+)?BrokerPort[ \t]*=[ \t]*"([1-9]\d{0,4})"[ \t]*$/gm, 'broker port constant');
  demand(Number(brokerPort) <= 65535, 'broker port is outside the TCP port range');
  return { goVersion, schemaVersion, brokerPort };
}

function sourceInventory(mq) {
  const files = new Set();
  const productionGo = (file) => file.endsWith('.go') && !file.endsWith('_test.go') && file !== EXCLUDED_VERSION_SOURCE;
  function directory(relative, recursive, include = productionGo) {
    let entries;
    try {
      demand(lstatSync(resolve(mq, relative)).isDirectory(), `expected a regular source directory: ${relative || '.'}`);
      entries = readdirSync(resolve(mq, relative), { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error(`agent contract: missing source directory: ${relative || '.'}`);
      throw error;
    }
    for (const entry of entries) {
      const file = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        demand(!recursive && !include(file), `symbolic links are not accepted in the source scope: ${file}`);
      } else if (entry.isDirectory() && recursive) directory(file, true, include);
      else if (entry.isFile() && include(file)) files.add(file);
    }
  }
  directory('', false);
  for (const name of SOURCE_DIRECTORIES) directory(name, true);
  for (const name of ASSET_DIRECTORIES) directory(name, true, () => true);
  return [...new Set([...files, 'go.mod', 'go.sum', ...DOCUMENTS, ...BUILD_AND_RELEASE_FILES])].sort();
}

export function checkAgentContract(siteRoot, mq) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(resolve(siteRoot, 'tools/agent-contract.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('agent contract: missing tools/agent-contract.json; review the source before recording fingerprints');
    throw new Error('agent contract: cannot parse tools/agent-contract.json');
  }
  demand(manifest?.formatVersion === FORMAT_VERSION, 'unsupported review manifest version');
  demand(typeof manifest.reviewedRevision === 'string' && /^[0-9a-f]{40}$/.test(manifest.reviewedRevision), 'invalid reviewed source revision');
  demand(manifest.files && typeof manifest.files === 'object' && !Array.isArray(manifest.files), 'invalid reviewed file inventory');
  const actual = sourceInventory(mq);
  const expected = Object.keys(manifest.files).sort();
  const added = actual.filter((name) => !Object.hasOwn(manifest.files, name));
  const removed = expected.filter((name) => !actual.includes(name));
  demand(!added.length && !removed.length,
    `source inventory changed (added: ${added.join(', ') || 'none'}; removed: ${removed.join(', ') || 'none'}); review the website guidance`);
  const verified = {};
  for (const file of actual) {
    demand(typeof manifest.files[file] === 'string' && /^[0-9a-f]{64}$/.test(manifest.files[file]), `invalid reviewed fingerprint: ${file}`);
    verified[file] = digest(read(mq, file));
    demand(verified[file] === manifest.files[file], `${file} changed; review the English/Chinese website guidance before updating its fingerprint`);
  }
  // The revision describes the review basis. It need not equal HEAD: a version-
  // only commit or an unrelated change may retain this exact reviewed scope.
  return {
    formatVersion: FORMAT_VERSION,
    reviewedRevision: manifest.reviewedRevision,
    sourceDigest: digest(JSON.stringify(verified)),
    filesReviewed: actual.length,
  };
}
