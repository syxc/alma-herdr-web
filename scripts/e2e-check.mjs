/**
 * End to end check against a running relay.
 *
 * Usage: node scripts/e2e-check.mjs [relayUrl]
 *
 * It reads the pairing details from the local agent, opens the encrypted
 * tunnel through the relay and reads a pane, types into it and reads it back.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';

import { E2EClientSession, E2E_PATH } from '../web/dist/e2e.js';

async function main() {
  const identity = JSON.parse(
    await readFile(join(homedir(), '.config', 'alma-herdr-web', 'relay.json'), 'utf8')
  );
  const relay = process.argv[2] ?? identity.relayUrl;
  const code = identity.code;
  const token = identity.token;

  function hexToBytes(hex) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    }
    return bytes;
  }

  const url = relay.replace(/^http/, 'ws') + '/c/' + token + E2E_PATH;
  console.log('connecting to the relay');

  const socket = new WebSocket(url);
  const pending = new Map();
  let counter = 0;

  const session = new E2EClientSession({
    psk: hexToBytes(code),
    send: text => socket.send(text),
    onAppFrame: frame => {
      const id = frame.id;
      if (id === undefined || !pending.has(id)) {
        return;
      }
      pending.get(id)(frame);
      pending.delete(id);
    },
    onError: () => {
      console.error('e2e handshake failed');
      process.exitCode = 1;
    },
    onReady: () => console.log('handshake done')
  });

  await new Promise((resolve, reject) => {
    socket.on('open', resolve);
    socket.on('error', reject);
  });
  socket.on('message', data => void session.receive(String(data)));

  await session.start();
  const deadline = Date.now() + 8000;
  while (!session.ready && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (!session.ready) {
    console.error('the handshake never completed');
    process.exit(1);
  }

  async function request(method, path, body) {
    const id = 'r' + (++counter);
    const answer = new Promise(resolve => pending.set(id, resolve));
    await session.sendApp({
      t: 'req',
      id,
      method,
      path,
      headers: {},
      body: body === undefined ? undefined : Buffer.from(body).toString('base64')
    });
    return answer;
  }

  const state = await request('GET', '/api/state');
  const snapshot = JSON.parse(Buffer.from(state.body, 'base64').toString('utf8'));
  const panes = snapshot.state?.panes ?? [];
  console.log('panes: ' + panes.length);
  if (panes.length === 0) {
    console.error('no pane to drive');
    process.exit(1);
  }
  const pane = panes[0];
  console.log('using the first pane');

  const marker = 'e2e-' + Date.now();
  const sent = await request('POST', '/api/pane/text', JSON.stringify({
    pane_id: pane.pane_id,
    text: 'echo ' + marker
  }));
  console.log('send_text: ' + sent.status);

  await new Promise(resolve => setTimeout(resolve, 1200));

  const read = await request('GET', '/api/pane/read?pane=' + encodeURIComponent(pane.pane_id) + '&source=visible&format=ansi&lines=0');
  const text = JSON.parse(Buffer.from(read.body, 'base64').toString('utf8'));
  const visible = String(text.result?.read?.text ?? text.read?.text ?? '');
  console.log('pane output contains marker: ' + visible.includes(marker));
  if (!visible.includes(marker)) {
    console.error('the pane did not echo the check marker');
    process.exit(1);
  }

  socket.close();
  console.log('E2E OK: read and input both work through the relay');
}

main().catch(() => {
  console.error('E2E check failed');
  process.exit(1);
});
