import { execFileSync } from 'node:child_process';

const maximumBytes = 1024 * 1024;
const number = '(?:0|[1-9]\\d*)';
const prerelease = '(?:0|[1-9]\\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)';
const semverTag = new RegExp(`^v${number}\\.${number}\\.${number}(?:-${prerelease}(?:\\.${prerelease})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);
const stableTag = new RegExp(`^v${number}\\.${number}\\.${number}$`);

function fail(reason) {
  throw new Error(`release tags: ${reason}; fetch canonical tags before build and verify the canonical Git checkout`);
}

// Return an array of local SemVer tag names, including prereleases. This only
// reads the local tag catalog; it neither selects "latest" nor queries a module
// proxy, fetches refs, creates tags, or proves that an archive was published.
export function readReleaseTags(root, run = execFileSync) {
  if (typeof root !== 'string' || !root.trim()) fail('a canonical repository path is required');
  let output;
  try {
    output = run('git', ['-C', root, 'tag', '--list'], {
      encoding: 'utf8', timeout: 10_000, maxBuffer: maximumBytes,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    fail('cannot read local tags (Git is unavailable, the checkout is invalid, or the command failed/timed out)');
  }
  if (typeof output !== 'string' || Buffer.byteLength(output, 'utf8') > maximumBytes) {
    fail('unexpected local tag catalog output');
  }
  output = output.replace(/\r\n/g, '\n');
  if (!output) fail('the local tag catalog is empty');
  const names = output.split('\n');
  if (names.at(-1) === '') names.pop();
  // Git emits one ref name per line. Reject control characters, whitespace or
  // duplicate names rather than silently accepting a corrupted command result.
  if (names.some((name) => !name || /[\x00-\x20\x7f]/.test(name)) || new Set(names).size !== names.length) {
    fail('malformed local tag catalog output');
  }
  const tags = names.filter((name) => semverTag.test(name));
  if (!tags.length) fail('the local tag catalog contains no SemVer release tags');
  return tags;
}

// Compare the complete tracked working tree, including staged changes. A source
// version constant or a missing Unreleased note cannot hide a post-tag change.
// Untracked files are outside this Git comparison and are not certified here.
export function isReleaseTree(root, tag, run = execFileSync) {
  if (typeof root !== 'string' || !root.trim()) fail('a canonical repository path is required');
  if (typeof tag !== 'string' || tag.trim() !== tag || !stableTag.test(tag)) {
    fail('the release-tree comparison requires a stable vX.Y.Z tag');
  }
  try {
    run('git', ['-C', root, 'diff', '--quiet', '--no-ext-diff', '--no-textconv', tag, '--'], {
      encoding: 'utf8', timeout: 10_000, maxBuffer: maximumBytes,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Suppress Git's optional index refresh so this check remains read-only.
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
    return true;
  } catch (error) {
    if (error?.status === 1 && !error.signal && !error.killed &&
        (error.code === undefined || error.code === null || error.code === 1)) return false;
    fail('cannot compare the canonical tracked tree with its release tag (Git failed or timed out)');
  }
}
