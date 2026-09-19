import test from 'node:test';
import assert from 'node:assert/strict';
import { Bypass, Client, inputs, expression, LIST } from '../src/runtime.js';
import { fakeFetch, initial } from './fixture.js';

const env = { INPUT_CF_ACCOUNT_ID: 'a'.repeat(32), INPUT_CF_ZONE_ID: 'b'.repeat(32), INPUT_CF_API_TOKEN: 'test-secret' };
function setup(extra = {}, options = {}) {
  const state = initial(); const saved = [];
  const fetcher = fakeFetch(state, options);
  const action = new Bypass({ ...inputs(env), ...extra }, { client: new Client('test-secret', fetcher), fetcher, save: value => saved.push(structuredClone(value)), wait: async () => {} });
  return { state, action, saved };
}

test('strict input validation and safe defaults', () => {
  assert.equal(inputs(env).disable, false); assert.equal(inputs(env).bic, false);
  for (const [name, value] of [['HOSTNAME', '*.example.com'], ['HOSTNAME', 'a" or true'], ['PATH_PREFIX', '/a?query'], ['PATH_PREFIX', '/a\\b'], ['DISABLE_BOT_FIGHT_MODE', 'yes'], ['BFM_PROPAGATION_DELAY', '301']]) {
    assert.throws(() => inputs({ ...env, [`INPUT_${name}`]: value }));
  }
  assert.equal(inputs({ ...env, INPUT_HOSTNAME: 'Admin.Example.com' }).hostname, 'admin.example.com');
});

test('scope always includes list and exact IP, plus optional hostname and path', () => {
  const rule = expression({ hostname: 'admin.example.com', path: '/api/' }, '2001:db8::1');
  assert.equal(rule, `(ip.src in $${LIST}) and (ip.src eq 2001:db8::1) and (http.host eq "admin.example.com") and (starts_with(http.request.uri.path, "/api/"))`);
  assert.throws(() => expression({}, 'true or ip.src'));
});

test('HTTP 200 success:false fails without logging server bodies or token', async () => {
  const client = new Client('super-secret', async () => Response.json({ success: false, errors: [{ message: 'response-secret' }] }));
  await assert.rejects(client.request('GET', '/anything'), error => !/secret/.test(error.message) && /failed/.test(error.message));
});

test('lifecycle preserves foreign entries and restores BFM FIRST, idempotent cleanup', async () => {
  const { state, action, saved } = setup({ disable: true, bic: true, hostname: 'admin.example.com', path: '/api/' });
  state.paginate = true;
  await action.run();
  assert.equal(state.bfm.fight_mode, false);
  assert.deepEqual(state.rules[1].action_parameters.products, ['bic']);
  assert.ok(saved.some(value => value.restorePending && value.bfm.fight_mode));
  const before = state.calls.length;
  await action.cleanup();
  assert.equal(state.calls[before].path.endsWith('/bot_management'), true);
  assert.equal(state.calls[before].body.fight_mode, true);
  assert.deepEqual(state.bfm, { fight_mode: true, enable_js: false });
  assert.deepEqual(state.items.map(item => item.id), ['foreign']);
  assert.deepEqual(state.rules.map(rule => rule.id), ['foreign-rule']);
  const count = state.calls.length; await action.cleanup(); assert.equal(state.calls.length, count);
  assert.ok(!state.calls.some(call => call.method === 'PUT' && call.path.endsWith('/items')));
});

test('default mode never touches BFM and never skips BIC', async () => {
  const { state, action } = setup(); await action.run();
  assert.equal(state.rules[1].action_parameters.products, undefined);
  assert.ok(!state.calls.some(call => call.path.endsWith('/bot_management')));
  await action.cleanup();
});

test('first use creates list and entrypoint; retains empty reusable list', async () => {
  const { state, action } = setup(); state.listExists = false; state.entryExists = false; state.rules = []; state.items = [];
  await action.run(); await action.cleanup();
  assert.equal(state.listExists, true); assert.equal(state.entryExists, true); assert.equal(state.items.length, 0); assert.equal(state.rules.length, 0);
});

test('preexisting IP and subnet are rejected without borrowing or deleting', async () => {
  for (const ip of ['203.0.113.7', '203.0.113.0/24']) {
    const { state, action } = setup(); state.items.push({ id: 'preexisting', ip, comment: 'someone else' });
    await assert.rejects(action.run(), /already present/);
    assert.equal(state.items.length, 2); assert.ok(!state.calls.some(call => call.method !== 'GET'));
  }
});

test('IPv6 normalization recognizes preexisting runner', async () => {
  const { state, action } = setup(); state.ip = '2001:db8::1'; state.items.push({ id: 'preexisting', ip: '2001:0db8:0000:0000:0000:0000:0000:0001', comment: 'other' });
  await assert.rejects(action.run(), /already present/);
});

test('legacy broad list rule fails closed before any writes', async () => {
  const { state, action } = setup(); state.rules.push({ id: 'old', expression: `ip.src in $${LIST}`, action: 'skip' });
  await assert.rejects(action.run(), /broad rule/); assert.ok(state.calls.every(call => call.method === 'GET'));
});

test('BFM already off refuses overlapping job and removes owned resources', async () => {
  const { state, action } = setup({ disable: true }); state.bfm.fight_mode = false;
  await assert.rejects(action.run(), /already be enabled/);
  assert.equal(state.bfm.fight_mode, false); assert.equal(state.items.length, 1); assert.equal(state.rules.length, 1);
});

test('partial rule creation failure removes only owned item', async () => {
  const { state, action } = setup({}, { fail: call => call.method === 'POST' && call.path.endsWith('/rules') });
  await assert.rejects(action.run(), /failed/); assert.equal(state.items.length, 1); assert.equal(state.rules.length, 1);
});

test('lost IP append and rule creation responses recover by unique ownership', async () => {
  for (const endpoint of ['/items', '/rules']) {
    const { state, action } = setup({}, { lost: call => call.method === 'POST' && call.path.endsWith(endpoint) });
    await assert.rejects(action.run(), /failed or timed out/); assert.equal(state.items.length, 1); assert.equal(state.rules.length, 1);
    await action.cleanup();
  }
});

test('lost BFM disable response restores snapshot', async () => {
  const { state, action } = setup({ disable: true }, { lost: call => call.method === 'PUT' && call.body.fight_mode === false });
  await assert.rejects(action.run(), /failed or timed out/); assert.equal(state.bfm.fight_mode, true);
  assert.equal(state.items.length, 1); assert.equal(state.rules.length, 1);
});

test('BFM restore failure does not prevent rule/IP cleanup, retry retains snapshot', async () => {
  let failRestore = true;
  const { state, action } = setup({ disable: true }, { fail: call => failRestore && call.method === 'PUT' && call.body.fight_mode === true });
  await action.run(); await assert.rejects(action.cleanup(), /BFM restore failed/);
  assert.equal(state.items.length, 1); assert.equal(state.rules.length, 1); assert.equal(action.state.restorePending, true);
  failRestore = false; await action.cleanup(); assert.equal(state.bfm.fight_mode, true);
});

test('BFM readback mismatch fails and restores before returning', async () => {
  const { state, action } = setup({ disable: true });
  const original = action.api.bind(action);
  action.api = async (...args) => {
    const result = await original(...args);
    if (args[0] === 'PUT' && args[2]?.fight_mode === false) state.bfm.fight_mode = true;
    return result;
  };
  await assert.rejects(action.run(), /verification/); assert.equal(state.bfm.fight_mode, true); assert.equal(state.items.length, 1);
});

test('modified owned rule is not deleted, but IP cleanup still runs', async () => {
  const { state, action } = setup(); await action.run(); state.rules[1].expression = 'true';
  await assert.rejects(action.cleanup(), /rule cleanup failed/);
  assert.equal(state.rules.length, 2); assert.equal(state.items.length, 1); assert.equal(action.state.rulePending, true);
});

test('ownership comment with wrong IP is not accepted or deleted', async () => {
  const { state, action } = setup();
  const api = action.api.bind(action);
  action.api = async (...args) => {
    const result = await api(...args);
    if (args[0] === 'POST' && args[1].endsWith('/items')) state.items[1].ip = '192.0.2.123';
    return result;
  };
  await assert.rejects(action.run(), /Could not verify owned runner IP/);
  assert.equal(state.items.length, 2); assert.equal(action.state.itemPending, true);
});

test('known async operation persists before polling and resumes during cleanup', async () => {
  const { state, action, saved } = setup();
  const api = action.api.bind(action); let polls = 0;
  action.api = async (...args) => {
    const result = await api(...args);
    if (args[1].includes('/bulk_operations/') && ++polls <= 30) result.result.status = 'pending';
    return result;
  };
  await assert.rejects(action.run(), /timed out/);
  assert.ok(saved.some(value => value.operation?.id === 'op' && value.operation.kind === 'append'));
  assert.equal(state.items.length, 1); assert.equal(action.state.operation, null); assert.equal(action.state.itemPending, false);
});

test('unknown async append outcome remains an error rather than false cleanup success', async () => {
  const { action } = setup({}, { fail: call => call.method === 'POST' && call.path.endsWith('/items') });
  await assert.rejects(action.run(), /cleanup incomplete/);
  assert.equal(action.state.itemPending, true);
  await assert.rejects(action.cleanup(), /owned IP cleanup failed/);
});

test('terminal failed bulk operation still removes partial owned items', async () => {
  const { state, action } = setup(); const api = action.api.bind(action); let failed = false;
  action.api = async (...args) => {
    const result = await api(...args);
    if (args[1].includes('/bulk_operations/') && !failed) { failed = true; result.result.status = 'failed'; }
    return result;
  };
  await assert.rejects(action.run(), /operation failed/);
  assert.equal(state.items.length, 1); assert.equal(action.state.itemPending, false); assert.equal(action.state.operation, null);
});
