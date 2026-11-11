import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AlmaMock } from '../mock/dist/alma-mock.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const web = resolve(root, 'web');
const mock = new AlmaMock();
await mock.start();
let paused = false;
let reads = 0;
const answer = mock.answer.bind(mock);
mock.answer = async (socket, frame, key) => {
  if (paused) return;
  const request = JSON.parse(new TextDecoder().decode(frame.b));
  if (request.method === 'pane.read') {
    reads += 1;
    mock.paneText.set('w1:p1', 'recovery-check 中文 \ue0a0 \u{f0766} update ' + reads);
  }
  return answer(socket, frame, key);
};
const link = 'alma://connect?u=' + encodeURIComponent(mock.url) + '&k=mock-connect-code-0123456789abcdef&e2e=1';
const controls = '<aside style="position:fixed;top:0;left:0;right:0;z-index:9999;background:#fff;color:#111;padding:8px;font:14px system-ui">' +
'<label>Test pairing <input aria-label="Test pairing" readonly style="width:45%" value="' + link.replaceAll('&', '&amp;') + '"></label>' +
'<form method="post" target="check-status" style="display:inline">' +
'<button formaction="/check/pause">Pause replies</button> <button formaction="/check/resume">Resume replies</button> <button formaction="/check/drop">Drop connection</button>' +
'</form><iframe name="check-status" title="Test status" style="height:32px;width:190px;border:0;vertical-align:middle"></iframe></aside>';
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  if (request.method === 'POST' && path.startsWith('/check/')) {
    if (path === '/check/pause') paused = true;
    if (path === '/check/resume') paused = false;
    if (path === '/check/drop') for (const connection of mock.connections) connection.destroy();
    response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }).end(paused ? 'Replies paused' : 'Replies enabled');
    return;
  }
  if (path.startsWith('/api/')) { response.writeHead(404).end(); return; }
  const file = resolve(web, path === '/' ? 'index.html' : '.' + path);
  if (!file.startsWith(web + sep)) {
    response.writeHead(404).end(); return;
  }
  try {
    let data = await readFile(file);
    if (file.endsWith('index.html')) data = Buffer.from(data.toString().replace('<body>', '<body style="padding-top:80px">' + controls));
    response.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' }).end(data);
  } catch { response.writeHead(404).end(); }
});
server.listen(7343, '127.0.0.1', () => console.log('Recovery check: http://127.0.0.1:7343/'));
async function stop() { server.close(); await mock.stop(); process.exit(); }
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
