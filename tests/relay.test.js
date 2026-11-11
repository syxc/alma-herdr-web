import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

import { RelayAgent } from '../agent/dist/relay.js';
import { forwardedHeaders } from '../agent/dist/bridge.js';
import { deriveToken, newConnectCode, sha256Hex } from '../agent/dist/identity.js';
import { RelayMock } from '../mock/dist/relay-mock.js';
import { E2EClientSession, E2E_PATH } from '../web/dist/e2e.js';
import { RemoteTunnel } from '../web/dist/tunnel.js';

function waitFor(predicate, label = 'condition', timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error('timed out waiting for ' + label));
        return;
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

async function startStack() {
  const localWss = new WebSocketServer({ noServer: true });
  const connections = new Set();
  const local = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, path: request.url }));
  });
  local.on('connection', socket => {
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
  });
  local.on('upgrade', (request, socket, head) => {
    localWss.handleUpgrade(request, socket, head, (ws) => {
      ws.on('message', (data) => ws.send('echo:' + data.toString('utf8')));
    });
  });
  const localPort = await listen(local);

  const relay = new RelayMock();
  await relay.start();
  const code = newConnectCode();
  const token = deriveToken(code);
  const agent = new RelayAgent({ host: '127.0.0.1', port: localPort }, hexToBytes(code));
  agent.connect(relay.url, token);
  await waitFor(() => relay.framesOfKind('register').length === 1, 'the agent to register');
  return { local, localPort, relay, agent, code, token, connections };
}

test('forwarding keeps application headers and removes hop and body-encoding headers', () => {
  assert.deepEqual(forwardedHeaders({
    'Content-Type': 'application/json', Cookie: 'mock-session', 'X-Multi': ['a', 'b'],
    Connection: 'keep-alive', Upgrade: 'websocket', Host: 'relay.example.com',
    'Content-Length': '100', 'Content-Encoding': 'gzip', Missing: undefined
  }), { 'content-type': 'application/json', cookie: 'mock-session', 'x-multi': 'a, b' });
});

test('the routing token is derived from the connect code', () => {
  const code = newConnectCode();
  const token = deriveToken(code);
  assert.match(token, /^[A-Za-z0-9_-]{16,128}$/);
  assert.notEqual(token, code);
  assert.equal(deriveToken(code), token);
  assert.equal(sha256Hex('x').length, 64);
});

test('the relay only hands out the static client, never the API', async () => {
  const stack = await startStack();
  try {
    stack.relay.push({ t: 'hreq', id: 'r1', method: 'GET', path: '/api/state', headers: {} });
    await waitFor(() => stack.relay.framesOfKind('hres').length === 1, 'the response head');
    assert.equal(stack.relay.framesOfKind('hres')[0].status, 403);

    stack.relay.push({ t: 'hreq', id: 'r2', method: 'GET', path: '/style.css', headers: {} });
    await waitFor(() => stack.relay.framesOfKind('hres').length === 2, 'the static response');
    assert.equal(stack.relay.framesOfKind('hres')[1].status, 200);
  } finally {
    stack.agent.disconnect();
    for (const connection of stack.connections) {
      connection.destroy();
    }
    await stack.relay.stop();
    await new Promise((resolve) => stack.local.close(resolve));
  }
});

test('a plain websocket bridge is refused', async () => {
  const stack = await startStack();
  try {
    stack.relay.push({ t: 'wopen', id: 'w1', path: '/api/events' });
    await waitFor(() => stack.relay.framesOfKind('werr').length === 1, 'the refusal');
    assert.match(stack.relay.framesOfKind('werr')[0].message, /encryption/);
  } finally {
    stack.agent.disconnect();
    for (const connection of stack.connections) {
      connection.destroy();
    }
    await stack.relay.stop();
    await new Promise((resolve) => stack.local.close(resolve));
  }
});

test('the desktop opens the encrypted socket for the relay', async () => {
  const stack = await startStack();
  try {
    stack.relay.push({ t: 'wopen', id: 'w9', path: E2E_PATH });
    await waitFor(() => stack.relay.framesOfKind('wopened').length === 1, 'the socket to be opened');
    assert.equal(stack.relay.framesOfKind('wopened')[0].id, 'w9');
  } finally {
    stack.agent.disconnect();
    for (const connection of stack.connections) {
      connection.destroy();
    }
    await stack.relay.stop();
    await new Promise((resolve) => stack.local.close(resolve));
  }
});

test('the encrypted channel carries requests and streams', async () => {
  const stack = await startStack();
  const socket = new WebSocket('ws://127.0.0.1:' + stack.relay.url.replace('http://', '').split(':')[1] + '/c/' + stack.token + E2E_PATH);
  const frames = [];
  const pending = new Map();
  let counter = 0;
  const session = new E2EClientSession({
    psk: hexToBytes(stack.code),
    send: text => socket.send(text),
    onAppFrame: frame => {
      frames.push(frame);
      const id = frame.id;
      if (id === undefined || !pending.has(id)) {
        return;
      }
      if (id === 'r1' && frame.t !== 'res') {
        return;
      }
      if (id === 's1' && frame.t !== 'wsmsg') {
        return;
      }
      pending.get(id)(frame);
      pending.delete(id);
    },
    onError: message => {
      throw new Error(message);
    },
    onReady: () => undefined
  });

  try {
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve);
      socket.addEventListener('error', reject);
    });
    socket.addEventListener('message', event => {
      void session.receive(String(event.data));
    });
    await session.start();
    await waitFor(() => session.ready, 'the handshake to finish');

    const answer = new Promise(resolve => {
      pending.set('r1', resolve);
    });
    await session.sendApp({ t: 'req', id: 'r1', method: 'GET', path: '/api/state' });
    const response = await answer;
    assert.equal(response.t, 'res');
    assert.equal(response.status, 200);
    const body = JSON.parse(Buffer.from(response.body, 'base64').toString('utf8'));
    assert.equal(body.path, '/api/state');

    const streamed = new Promise(resolve => {
      pending.set('s1', resolve);
    });
    await session.sendApp({ t: 'wsopen', id: 's1', path: '/api/events' });
    await waitFor(() => frames.some(frame => frame.t === 'wsopened'), 'the stream to open');
    await session.sendApp({ t: 'wsmsg', id: 's1', data: Buffer.from('hello').toString('base64') });
    const echoed = await streamed;
    assert.equal(Buffer.from(echoed.data, 'base64').toString('utf8'), 'echo:hello');
  } finally {
    socket.close();
    stack.agent.disconnect();
    for (const connection of stack.connections) {
      connection.destroy();
    }
    await stack.relay.stop();
    await new Promise((resolve) => stack.local.close(resolve));
  }
});

test('closing the event stream keeps the tunnel open for requests', async () => {
  const stack = await startStack();
  const tunnel = new RemoteTunnel({
    relay: stack.relay.url,
    token: stack.token,
    code: stack.code
  });
  try {
    await tunnel.connect();
    const before = await tunnel.request('GET', '/api/state');
    assert.equal(before.status, 200);

    // The page opens the event stream again whenever the backend changes.
    // That must not take the requests down with it.
    const closeFirst = await tunnel.openStream('/api/events', () => undefined);
    closeFirst();
    const closeSecond = await tunnel.openStream('/api/events', () => undefined);
    closeSecond();

    const after = await tunnel.request('GET', '/api/state');
    assert.equal(after.status, 200);
    const body = JSON.parse(Buffer.from(after.body, 'base64').toString('utf8'));
    assert.equal(body.path, '/api/state');
  } finally {
    tunnel.close();
    stack.agent.disconnect();
    for (const connection of stack.connections) {
      connection.destroy();
    }
    await stack.relay.stop();
    await new Promise((resolve) => stack.local.close(resolve));
  }
});

test('the client works without crypto.subtle', async () => {
  const stack = await startStack();
  const socket = new WebSocket('ws://127.0.0.1:' + stack.relay.url.replace('http://', '').split(':')[1] + '/c/' + stack.token + E2E_PATH);
  const pending = new Map();
  let counter = 0;
  let counterSeen = 0;
  const session = new E2EClientSession({
    psk: hexToBytes(stack.code),
    send: text => socket.send(text),
    onAppFrame: frame => {
      const id = frame.id;
      if (id === undefined || !pending.has(id)) {
        return;
      }
      pending.get(id)(frame);
      pending.delete(id);
    },
    onError: message => {
      throw new Error(message);
    },
    onReady: () => undefined
  });

  // A plain HTTP page has no crypto.subtle, so the client has to fall back
  // to the pure JavaScript implementation. The property lives on the
  // prototype, so it is shadowed on the instance and taken away again after.
  const prototype = Object.getPrototypeOf(globalThis.crypto);
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'subtle');
  Object.defineProperty(globalThis.crypto, 'subtle', { value: undefined, configurable: true });
  try {
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve);
      socket.addEventListener('error', reject);
    });
    socket.addEventListener('message', event => {
      void session.receive(String(event.data));
    });
    await session.start();
    await waitFor(() => session.ready, 'the handshake to finish');

    const answer = new Promise(resolve => {
      pending.set('r1', resolve);
    });
    await session.sendApp({ t: 'req', id: 'r1', method: 'GET', path: '/api/state' });
    const response = await answer;
    assert.equal(response.t, 'res');
    assert.equal(response.status, 200);
    const body = JSON.parse(Buffer.from(response.body, 'base64').toString('utf8'));
    assert.equal(body.path, '/api/state');
  } finally {
    delete globalThis.crypto.subtle;
    if (descriptor !== undefined) {
      Object.defineProperty(prototype, 'subtle', descriptor);
    }
    socket.close();
    stack.agent.disconnect();
    for (const connection of stack.connections) {
      connection.destroy();
    }
    await stack.relay.stop();
    await new Promise((resolve) => stack.local.close(resolve));
  }
});

test('a wrong pairing code is rejected', async () => {
  const stack = await startStack();
  const port = stack.relay.url.replace('http://', '').split(':')[1];
  const socket = new WebSocket('ws://127.0.0.1:' + port + '/c/' + stack.token + E2E_PATH);
  let failure = '';
  const session = new E2EClientSession({
    psk: hexToBytes(newConnectCode()),
    send: text => socket.send(text),
    onAppFrame: () => undefined,
    onError: message => {
      failure = message;
    },
    onReady: () => undefined
  });
  try {
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve);
      socket.addEventListener('error', reject);
    });
    socket.addEventListener('message', event => {
      void session.receive(String(event.data));
    });
    await session.start();
    await waitFor(() => failure.length > 0, 'the rejection');
    assert.match(failure, /mismatch/);
  } finally {
    socket.close();
    stack.agent.disconnect();
    for (const connection of stack.connections) {
      connection.destroy();
    }
    await stack.relay.stop();
    await new Promise((resolve) => stack.local.close(resolve));
  }
});
