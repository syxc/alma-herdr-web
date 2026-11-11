import { request as httpRequest } from 'node:http';
import WebSocket from 'ws';

/** Where the local bridge lives. */
export interface LocalTarget {
  host: string;
  port: number;
}

export interface LocalResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

/** Headers that describe a single hop and must not be forwarded. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'content-encoding',
  'host'
]);

export function forwardedHeaders(headers: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !HOP_BY_HOP.has(name.toLowerCase())) {
      result[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
    }
  }
  return result;
}

export function localRequest(
  target: LocalTarget,
  method: string,
  path: string,
  headers: Record<string, string>,
  body: Buffer | undefined
): Promise<LocalResponse> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: target.host,
        port: target.port,
        method,
        path,
        headers
      },
      response => {
        const chunks: Buffer[] = [];
        const responseHeaders = forwardedHeaders(response.headers);
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 200,
            headers: responseHeaders,
            body: Buffer.concat(chunks)
          });
        });
        response.on('error', reject);
      }
    );
    request.on('error', reject);
    if (body !== undefined) {
      request.write(body);
    }
    request.end();
  });
}

export interface LocalSocketHandlers {
  onOpen: () => void;
  onMessage: (data: Buffer, isBinary: boolean) => void;
  onClose: (code: number, reason: string) => void;
  onError: (message: string) => void;
}

/**
 * Opens a WebSocket on the local bridge, used for the event stream.
 */
export function openLocalSocket(
  target: LocalTarget,
  path: string,
  handlers: LocalSocketHandlers
): WebSocket {
  const socket = new WebSocket('ws://' + target.host + ':' + target.port + path);
  socket.on('open', () => handlers.onOpen());
  socket.on('message', (data: Buffer, isBinary: boolean) => handlers.onMessage(data, isBinary));
  socket.on('close', (code: number, reason: Buffer) => handlers.onClose(code, reason.toString('utf8')));
  socket.on('error', (error: Error) => handlers.onError(error.message));
  return socket;
}
