import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const workflow = readFileSync(resolve(here, '../.github/workflows/site.yml'), 'utf8');
const antiRot = workflow.split('\n  anti-rot:\n')[1].split('\n  deploy:\n')[0];
const deployment = workflow.split('\n  deploy:\n')[1];
const deploymentCondition = /^    if: (.+)$/m.exec(deployment)?.[1];

// Evaluate only the simple expression subset shared by GitHub Actions and JS.
// Reject new syntax instead of accidentally treating an unknown guard as safe.
function mayDeploy(condition, github) {
  const unknown = condition.replace(
    /github\.(?:ref|event_name)|'[^'\\]*'|==|!=|&&|\|\||[()]|\s+/g,
    '',
  );
  assert.equal(unknown, '', 'unsupported deployment-condition syntax');
  const value = runInNewContext(condition, { github: Object.freeze({ ...github }) }, { timeout: 100 });
  assert.equal(typeof value, 'boolean', 'deployment condition must be boolean');
  return value;
}

function checkDeploymentMatrix(condition) {
  for (const event of ['push', 'workflow_dispatch', 'schedule', 'pull_request',
    'pull_request_target', 'repository_dispatch', 'workflow_run', 'release', 'delete']) {
    for (const ref of ['refs/heads/main', 'refs/heads/feature', 'refs/tags/v9.9.9', 'refs/pull/18/merge']) {
      const expected = ref === 'refs/heads/main' && ['push', 'workflow_dispatch'].includes(event);
      assert.equal(mayDeploy(condition, { ref, event_name: event }), expected, `${event} on ${ref}`);
    }
  }
}

test('hourly freshness checks use the normal validation path and never skip it for a schedule', () => {
  const triggers = workflow.split('\npermissions:\n')[0];
  assert.match(triggers, /\n  schedule:\n    - cron: '17 \* \* \* \*'/);
  assert.match(triggers, /\n  push:\n    branches: \[main\]/);
  assert.match(triggers, /\n  pull_request:\n/);
  assert.match(triggers, /\n  workflow_dispatch:\n/);
  assert.doesNotMatch(antiRot, /^\s+if:/m);
  for (const command of ['node --test *.test.mjs',
    'npx playwright test --config playwright.config.mjs',
    'node build.mjs ../mqlite-src --check', 'sh tools/package-site.sh _site']) {
    assert.ok(antiRot.includes(command), command);
  }
});

test('canonical freshness check reads main without retained checkout credentials or write permissions', () => {
  assert.match(workflow, /\npermissions:\n  contents: read\n/);
  assert.match(antiRot, /repository: mqlitehq\/mqlite\n          ref: main\n          path: mqlite-src\n          fetch-depth: 0\n          fetch-tags: true\n          persist-credentials: false/);
  assert.equal((antiRot.match(/persist-credentials: false/g) ?? []).length, 2);
  assert.doesNotMatch(antiRot, /\b(?:contents|actions|pages|id-token): write\b/);
  assert.doesNotMatch(antiRot, /secrets\./);
});

test('the actual deploy guard permits only existing main push and manual publication', () => {
  assert.ok(deploymentCondition, 'missing deploy condition');
  checkDeploymentMatrix(deploymentCondition);
});

test('the event matrix rejects both the former schedule-publishing guard and missing branch restriction', () => {
  assert.throws(() => checkDeploymentMatrix(
    "github.ref == 'refs/heads/main' && github.event_name != 'pull_request'",
  ), /schedule on refs\/heads\/main/);
  assert.throws(() => checkDeploymentMatrix(
    "github.event_name == 'push' || github.event_name == 'workflow_dispatch'",
  ), /push on refs\/heads\/feature/);
});
