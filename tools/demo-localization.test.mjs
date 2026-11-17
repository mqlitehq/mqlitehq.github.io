import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../assets/demo.js', import.meta.url), 'utf8');
const catalog = JSON.parse(await readFile(new URL('../i18n/zh-CN/interface.json', import.meta.url), 'utf8')).strings;

function literal(name, opening, closing) {
  const match = source.match(new RegExp(`  var ${name} = (${opening}[\\s\\S]*?\\n  ${closing});`));
  assert.ok(match, `demo ${name} literal must remain available for localization checks`);
  return vm.runInNewContext(`(${match[1]})`, {}, { timeout: 1000 });
}

const steps = literal('steps', '\\[', '\\]');
const translations = literal('stateTranslations', '\\{', '\\}');
const valueKeys = ['auditState', 'fulfillmentState', 'auditAction', 'fulfillmentAction'];

test('every animated state and action has a Chinese translation without fallback', () => {
  const used = new Set(steps.flatMap((step) => valueKeys.map((key) => step[key])));
  assert.deepEqual(Object.keys(translations).sort(), [...used].sort());
  for (const value of used) {
    assert.match(translations[value], /\p{Script=Han}/u, `${value} needs Chinese text`);
    assert.notEqual(translations[value], value);
    assert.deepEqual(translations[value].match(/\d+/g), value.match(/\d+/g), `${value} must retain its sequence or delivery count`);
  }
});

test('state labels explain the state in Chinese while retaining exact wire values', () => {
  const stateNames = { active: '就绪', locked: '已锁定', scheduled: '待调度' };
  for (const [english, chinese] of Object.entries(translations)) {
    const state = english.split(' · ')[0];
    if (state in stateNames) {
      assert.ok(chinese.startsWith(`${stateNames[state]}（${state}）`), `${english} must retain the canonical state value after the Chinese term`);
    }
  }
  assert.match(translations['complete ✓'], /完成（Complete）/);
  assert.match(translations['abandon + delay'], /放弃（Abandon）.*延迟重投/);
  assert.match(translations['copy removed · queue remains'], /副本已删除.*队列保留/);
});

test('static diagram roles and operations retain their English technical terms', () => {
  const terms = {
    publisher: 'publisher',
    'implicit topic': 'implicit topic',
    'subscription queue': 'subscription queue',
    'fan-out': 'fan-out',
    publish: 'Publish',
    receive: 'Receive',
    'audit worker': 'worker',
    'fulfillment worker': 'worker',
    'independent settlement': 'settlement'
  };
  for (const [key, term] of Object.entries(terms)) {
    assert.match(catalog[key], /\p{Script=Han}/u, `${key} needs Chinese text`);
    assert.ok(catalog[key].includes(`（${term}）`), `${key} must retain ${term}`);
  }
  for (const name of ['order.created', 'events', 'audit', 'fulfillment', 'message_id order-42']) {
    assert.equal(catalog[name], name, `example identifier ${name} must not be translated`);
  }
});

test('translated transcript preserves claim, delayed retry and independent settlement semantics', () => {
  const claim = catalog['changes its copy from active to locked and increments'];
  assert.match(claim, /就绪（active）.*已锁定（locked）/);
  const retry = catalog['abandons with delay, moving its copy locked → scheduled without incrementing the count.'];
  assert.match(retry, /Abandon/);
  assert.match(retry, /已锁定（locked）.*待调度（scheduled）/);
  assert.match(retry, /不增加.*计数/);
  assert.match(catalog['completes, so only its message copy is removed; the subscription remains. Below the delivery limit,'], /Complete.*只删除.*副本.*订阅.*保留/);
  assert.match(catalog['The retry completes, so that message copy is removed too; both subscriptions remain. Delivery is at-least-once, so handlers must remain idempotent.'], /至少一次（at-least-once）.*幂等/);
});
