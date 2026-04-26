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
assert(html.includes('@xterm/addon-unicode11'), 'index.html must load xterm unicode width addon');
assert(html.includes('terminal.unicode.activeVersion = "11"'), 'index.html must enable Unicode 11 width handling');
assert(html.includes('font-variant-ligatures: none'), 'index.html must disable terminal font ligatures');
assert(html.includes('rescaleOverlappingGlyphs: true'), 'index.html must prevent wide punctuation glyph overlap');

const server = fs.readFileSync(path.join(rootDir, 'server.js'), 'utf8');
assert(server.includes('app.get("/download"'), 'server.js must expose /download endpoint');
assert(server.includes('new WebSocket.Server'), 'server.js must create websocket server');
assert(server.includes('createTerminalEnv'), 'server.js must normalize terminal environment');
assert(server.includes('LC_CTYPE'), 'server.js must set UTF-8 character width locale for the pty');
assert(!server.includes('writeFileSync(CONFIG_PATH'), 'server.js must not rewrite config.json');
assert(!server.includes('config.jwtSecret'), 'server.js must not read jwtSecret from config.json');

console.log('Validation passed.');
