import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkCurrentVersionClaims, checkReviewBaseline } from './site-audit.mjs';

const facts = { sourceVersion: '0.4.2', latestRelease: 'v0.4.2', goVersion: '1.21', brokerPort: '6754', schemaVersion: '7' };
const index = { releaseReview: { reviewedValue: 'v0.4.2', reason: 'Reviewed stable deployment references and exact image pins.' },
  defaultReview: { values: { goVersion: '1.21', brokerPort: '6754', schemaVersion: '7' }, reason: 'Reviewed defaults, floor, illustrations and examples.' } };

test('a version preceding latest supported release cannot escape the declaration check', () => {
  const text = '<p>source v0.4.2; latest supported release v0.4.2</p><p>This page describes <b>v9.9.9</b>, the latest supported release.</p>';
  assert.throws(() => checkCurrentVersionClaims(new Map([['retention.html', text]]), facts), /retention.html: stale supported release v9.9.9/);
});

test('Chinese pages and machine-readable summaries receive the same current-fact checks', () => {
  for (const file of ['zh-CN/deployment.html', 'zh-CN/llms.txt']) {
    assert.throws(() => checkCurrentVersionClaims(new Map([[file, '源码版本：v0.4.2。最新受支持版本：v0.1.0。']]), facts), /stale supported release/);
    assert.throws(() => checkCurrentVersionClaims(new Map([[file, '源码 v0.1.0。最新受支持版本：v0.4.2。']]), facts), /stale source version/);
  }
  checkCurrentVersionClaims(new Map([['zh-CN/agents.html', '源版本 v0.4.2。最新受支持版本是 v0.4.2。']]), facts);
});

test('unreleased source and released baseline can differ without rewriting historical versions', () => {
  checkCurrentVersionClaims(new Map([['operations.html', 'source v0.5.0 with unreleased changes. Latest supported release: v0.4.2. v0.2.0 used schema 2.'],
    ['zh-CN/operations.html', '源码 v0.5.0（含未发布变更）。最新受支持版本：v0.4.2。v0.2.0 使用 schema 2。']]), { ...facts, sourceVersion: '0.5.0' });
  checkReviewBaseline(index, { ...facts, sourceVersion: '0.5.0' });
});

test('freshly generated banners cannot hide an unreviewed stable release or changed defaults', () => {
  assert.throws(() => checkReviewBaseline(index, { ...facts, latestRelease: 'v0.5.0' }), /release checklist was not reviewed/);
  for (const [field, value] of [['goVersion', '1.25'], ['brokerPort', '16754'], ['schemaVersion', '8']]) {
    assert.throws(() => checkReviewBaseline(index, { ...facts, [field]: value }), /review all indexed default\/floor examples/);
  }
});
