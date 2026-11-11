import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as turn } from 'node:timers/promises';
import { AlmaMock } from '../mock/dist/alma-mock.js';

import * as pairing from '../web/dist/pairing.js';
import { AlmaTunnel } from '../web/dist/alma.js';

function storage(t) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const data = new Map();
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: key => data.delete(key)
  } });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'sessionStorage', original);
    else delete globalThis.sessionStorage;
  });
  return data;
}

test('pairing survives reload in this tab and can be explicitly forgotten', async t => {
  storage(t);
  const expected = { kind: 'alma', relay: 'https://relay.example.com', code: 'mock-reload-code' };
  pairing.savePairing(expected);
  const reloaded = await import('../web/dist/pairing.js?reload');
  assert.deepEqual(reloaded.readSavedPairing(), expected);
  reloaded.forgetPairing();
  assert.equal(pairing.readSavedPairing(), null);
  pairing.savePairing({ kind: 'herdr', payload: { relay: 'https://relay.example.com', token: 'mock-token', code: 'mock-code' } });
  assert.equal(reloaded.readSavedPairing()?.kind, 'herdr');
});

test('malformed pairing input cannot abort startup', () => {
  for (const value of ['#pair=invalid!', '?broken=%', '{', 'not a pairing link']) {
    assert.equal(pairing.readPairing(value), null);
  }
});

test('a silent desktop times out instead of keeping the terminal read pending forever', async t => {
  const mock = new AlmaMock();
  await mock.start();
  const tunnel = new AlmaTunnel({ relay: mock.url, code: mock.code });
  t.after(async () => { tunnel.close(); await mock.stop(); });
  await tunnel.connect();
  const received = Promise.withResolvers();
  t.mock.method(mock, 'answer', async () => { received.resolve(); });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = tunnel.request('POST', '/api/herdr/rpc', new TextEncoder().encode('{}'));
  const outcome = pending.then(() => 'success', error => error.message);
  await received.promise;
  t.mock.timers.tick(15000);
  const observed = await Promise.race([outcome, turn().then(() => 'still pending')]);
  assert.match(observed, /timed out/);
  assert.equal(tunnel.pending.size, 0);
  t.mock.timers.reset();
});
