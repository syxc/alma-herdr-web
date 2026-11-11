/**
 * A stand in for the herdr server.
 *
 * It reproduces the parts of the protocol the agent depends on: one request
 * per connection, a long lived connection for event subscriptions, and the
 * event names herdr emits.
 */
import { createServer, type Socket } from 'node:net';
import { unlinkSync } from 'node:fs';

interface MockRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

const SNAPSHOT = {
  version: '0.9.5-mock',
  protocol: 22,
  focused_workspace_id: 'w1',
  focused_tab_id: 'w1:t1',
  focused_pane_id: 'w1:p1',
  workspaces: [
    {
      workspace_id: 'w1',
      label: 'demo',
      number: 1,
      agent_status: 'working',
      focused: true,
      active_tab_id: 'w1:t1',
      pane_count: 1,
      tab_count: 1
    }
  ],
  tabs: [
    {
      tab_id: 'w1:t1',
      workspace_id: 'w1',
      label: '1',
      number: 1,
      agent_status: 'working',
      focused: true,
      pane_count: 1
    }
  ],
  panes: [
    {
      pane_id: 'w1:p1',
      workspace_id: 'w1',
      tab_id: 'w1:t1',
      agent: 'claude',
      display_agent: null,
      agent_status: 'working',
      agent_session: { source: 'claude', agent: 'claude', kind: 'id', value: 'sess-1' },
      cwd: '/tmp/demo',
      foreground_cwd: '/tmp/demo',
      terminal_title: 'claude',
      terminal_title_stripped: 'claude',
      title: null,
      label: null,
      focused: true,
      revision: 3,
      scroll: { offset_from_bottom: 0, max_offset_from_bottom: 0, viewport_rows: 40 }
    }
  ],
  layouts: [],
  agents: [
    {
      pane_id: 'w1:p1',
      workspace_id: 'w1',
      tab_id: 'w1:t1',
      name: 'claude',
      agent: 'claude',
      display_agent: null,
      agent_status: 'working',
      agent_session: { source: 'claude', agent: 'claude', kind: 'id', value: 'sess-1' },
      cwd: '/tmp/demo',
      title: null,
      terminal_title_stripped: 'claude',
      focused: true,
      state_change_seq: 2,
      completion_seq: null
    }
  ]
};

const SCREEN = [
  '',
  '\u001b[0m\u001b[1m\u001b[38;5;6m/tmp/demo\u001b[0m via \u001b[0m\u001b[1m\u001b[38;5;2mnode v24\u001b[0m',
  '\u001b[0m\u001b[38;5;2m\u276f\u001b[0m \u001b[0m\u001b[38;5;1mhello\u001b[0m',
  ''
].join('\r\n');

export class HerdrMock {
  private readonly socketPath: string;
  private server: ReturnType<typeof createServer> | null = null;
  private readonly subscribers = new Set<Socket>();
  readonly requests: MockRequest[] = [];

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        unlinkSync(this.socketPath);
      } catch {
        // the socket does not exist yet
      }
      const server = createServer(socket => this.onConnection(socket));
      this.server = server;
      server.on('error', reject);
      server.listen(this.socketPath, () => resolve());
    });
  }

  stop(): Promise<void> {
    return new Promise(resolve => {
      for (const socket of this.subscribers) {
        socket.destroy();
      }
      this.subscribers.clear();
      if (this.server === null) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
      this.server = null;
    });
  }

  /**
   * Pushes an event to every open subscription.
   */
  emit(type: string, data: Record<string, unknown>): void {
    const payload = JSON.stringify({ event: type, data }) + '\n';
    for (const socket of this.subscribers) {
      socket.write(payload);
    }
  }

  private onConnection(socket: Socket): void {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      buffer += chunk;
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.substring(0, index).trim();
        buffer = buffer.substring(index + 1);
        if (line.length > 0) {
          this.onRequest(socket, JSON.parse(line) as MockRequest);
        }
        index = buffer.indexOf('\n');
      }
    });
    socket.on('error', () => {
      this.subscribers.delete(socket);
    });
  }

  private onRequest(socket: Socket, request: MockRequest): void {
    this.requests.push(request);
    if (request.method === 'events.subscribe') {
      socket.write(JSON.stringify({ id: request.id, result: { type: 'subscription_started' } }) + '\n');
      this.subscribers.add(socket);
      socket.on('close', () => this.subscribers.delete(socket));
      return;
    }
    socket.write(JSON.stringify({ id: request.id, result: this.resultFor(request) }) + '\n');
    socket.end();
  }

  private resultFor(request: MockRequest): Record<string, unknown> {
    switch (request.method) {
      case 'session.snapshot':
        return { type: 'session_snapshot', snapshot: SNAPSHOT };
      case 'pane.read':
        return {
          type: 'pane_read',
          read: {
            pane_id: request.params['pane_id'],
            workspace_id: 'w1',
            tab_id: 'w1:t1',
            source: request.params['source'],
            format: request.params['format'],
            text: SCREEN,
            revision: 3,
            truncated: false
          }
        };
      default:
        return { type: 'ok' };
    }
  }
}

async function main(): Promise<void> {
  const path = process.env['HERDR_MOCK_SOCKET'] ?? '/tmp/herdr-mock.sock';
  const mock = new HerdrMock(path);
  await mock.start();
  console.log('[herdr-mock] listening on ' + path);
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('herdr-mock.js')) {
  void main();
}
