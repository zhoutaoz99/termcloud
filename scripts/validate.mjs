import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function run(cmd, args) {
  const result = spawnSync(cmd, args, { cwd: rootDir, stdio: 'pipe', encoding: 'utf8' });
  assert(result.status === 0, `${cmd} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`);
}

run('node', ['--check', 'server.js']);

const html = fs.readFileSync(path.join(rootDir, 'public', 'index.html'), 'utf8');
assert(html.includes('/ws/terminal'), 'index.html must connect to /ws/terminal');
assert(html.includes('download?path='), 'index.html must include download action');

const server = fs.readFileSync(path.join(rootDir, 'server.js'), 'utf8');
assert(server.includes('app.get("/download"'), 'server.js must expose /download endpoint');
assert(server.includes('new WebSocket.Server'), 'server.js must create websocket server');

console.log('Validation passed.');
