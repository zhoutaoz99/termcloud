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

run('npx', ['tsc', '--noEmit']);

const html = fs.readFileSync(path.join(rootDir, 'public', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(rootDir, 'public', 'style.css'), 'utf8');
const client = fs.readFileSync(path.join(rootDir, 'src', 'client', 'main.ts'), 'utf8');

// HTML structure checks
assert(html.includes('/vendor/addon-unicode11'), 'index.html must load xterm unicode width addon');
assert(html.includes('<script defer src="/client.js"></script>'), 'index.html must reference bundled client script');
assert(client.includes('/ws/terminal'), 'client main.ts must connect to /ws/terminal');

// Client TS checks (moved from inline JS)
assert(client.includes('download?path='), 'client main.ts must include download action');
assert(client.includes('terminal.unicode.activeVersion = "11"'), 'client main.ts must enable Unicode 11 width handling');
assert(client.includes('rescaleOverlappingGlyphs: true'), 'client main.ts must prevent wide punctuation glyph overlap');
assert(client.includes('allowProposedApi: true'), 'client main.ts must set allowProposedApi: true for xterm Unicode11 addon');
assert(client.includes('binaryType = "arraybuffer"'), 'client main.ts must use binary WebSocket protocol');
assert(client.includes('MSG_OUTPUT'), 'client main.ts must define binary protocol constants');

// CSS checks
assert(css.includes('font-variant-ligatures: none'), 'style.css must disable terminal font ligatures');
assert(css.includes('font-family: "TermMono"'), 'style.css must declare the TermMono unicode-range @font-face family');
assert(!css.includes('unicode-range: U+2E80'), 'CJK @font-face must NOT declare unicode-range (it must act as catch-all for TermMono)');
assert(css.includes('local("Sarasa Mono SC")'), 'CJK @font-face must prioritize CJK monospace fonts for correct glyph width');

// vendor files must exist
for (const vendorFile of ['xterm.js', 'xterm.css', 'addon-fit.js', 'addon-unicode11.js']) {
  const vp = path.join(rootDir, 'public', 'vendor', vendorFile);
  assert(fs.existsSync(vp), `public/vendor/${vendorFile} must exist`);
}

// bundled client output must exist
assert(fs.existsSync(path.join(rootDir, 'public', 'client.js')), 'public/client.js must exist (run npm run build:client)');

const server = fs.readFileSync(path.join(rootDir, 'src', 'server.ts'), 'utf8');
assert(server.includes('app.get("/download"'), 'server.ts must expose /download endpoint');
assert(server.includes('new WebSocket.Server'), 'server.ts must create websocket server');
assert(server.includes('createTerminalEnv'), 'server.ts must normalize terminal environment');
assert(server.includes('LC_CTYPE'), 'server.ts must set UTF-8 character width locale for the pty');
assert(!server.includes('writeFileSync(CONFIG_PATH'), 'server.ts must not rewrite config.json');
assert(!server.includes('config.jwtSecret'), 'server.ts must not read jwtSecret from config.json');
assert(server.includes('perMessageDeflate'), 'server.ts must enable WebSocket compression');
assert(server.includes('compression()'), 'server.ts must enable HTTP compression middleware');
assert(server.includes('class RingBuffer'), 'server.ts must implement ring buffer');
assert(server.includes('setInterval'), 'server.ts must implement batch flush timer');
assert(server.includes('fs.promises'), 'server.ts must use async fs operations');

console.log('Validation passed.');
