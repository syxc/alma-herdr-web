import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AlmaTunnel } from '../web/dist/alma.js';
import { openAlmaRemote, createTab, createWorkspace } from '../web/dist/api.js';

for (const method of ['workspace.create', 'tab.create']) {
  test(method + ' uses the Alma RPC tunnel and reports refusal', async t => {
    const calls = [];
    let status = 200;
    t.mock.method(AlmaTunnel.prototype, 'connect', async () => {});
    t.mock.method(AlmaTunnel.prototype, 'request', async (verb, path, body, headers) => {
      calls.push({ verb, path, payload: JSON.parse(new TextDecoder().decode(body)), headers });
      return { status, headers: {}, body: new TextEncoder().encode(JSON.stringify(
        status === 200 ? { result: {} } : { error: { message: 'creation refused' } }
      )) };
    });
    await openAlmaRemote({ relay: 'https://relay.example', code: 'test-only' });
    const create = () => method === 'tab.create'
      ? createTab('w1', '/project', 'acceptance')
      : createWorkspace('/project', 'acceptance');
    assert.equal(await create(), null);
    assert.deepEqual(calls[0], {
      verb: 'POST',
      path: '/api/herdr/rpc',
      payload: { method, params: {
        ...(method === 'tab.create' ? { workspace_id: 'w1' } : {}),
        cwd: '/project', label: 'acceptance', focus: true
      } },
      headers: { 'content-type': 'application/json' }
    });
    status = 403;
    assert.equal(await create(), 'creation refused');
  });
}
