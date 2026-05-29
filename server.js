const express = require("express");
const fs = require("fs");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const compression = require("compression");
const WebSocket = require("ws");
const pty = require("node-pty");
const jwt = require("jsonwebtoken");

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;

// ── config loading ──
const CONFIG_PATH = path.join(__dirname, "config.json");

if (!fs.existsSync(CONFIG_PATH)) {
  console.error("config.json not found. Please create it with username and password.");
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));

if (typeof config.username !== "string" || typeof config.password !== "string") {
  console.error("config.json must contain username and password strings.");
  process.exit(1);
}

const USER_WORK_DIR = (() => {
  const preferred = path.join("/data/users", config.username);
  try {
    if (!fs.existsSync(preferred)) {
      fs.mkdirSync(preferred, { recursive: true });
    }
    return preferred;
  } catch {
    // /data not writable (e.g. macOS read-only root), fallback to home dir
    const fallback = path.join(require("os").homedir(), ".termcloud-data", "users", config.username);
    if (!fs.existsSync(fallback)) {
      fs.mkdirSync(fallback, { recursive: true });
    }
    console.warn(`Cannot create ${preferred}, using fallback: ${fallback}`);
    return fallback;
  }
})();

function isPathWithinUserDir(resolvedPath) {
  const normalized = path.resolve(resolvedPath);
  return normalized === USER_WORK_DIR || normalized.startsWith(USER_WORK_DIR + path.sep);
}

const JWT_SECRET_PATH = path.join(__dirname, ".jwt_secret");
let JWT_SECRET;
if (fs.existsSync(JWT_SECRET_PATH)) {
  JWT_SECRET = fs.readFileSync(JWT_SECRET_PATH, "utf8").trim();
} else {
  JWT_SECRET = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(JWT_SECRET_PATH, JWT_SECRET);
}

function isUtf8Locale(value) {
  return typeof value === "string" && /utf-?8/i.test(value);
}

function getDefaultUtf8Locale() {
  return process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8";
}

const CLAUDE_CONFIG_FILE = path.join(USER_WORK_DIR, ".claude_code_config.json");

function isClaudeConfigured() {
  return fs.existsSync(CLAUDE_CONFIG_FILE);
}

function getClaudeConfig() {
  if (!fs.existsSync(CLAUDE_CONFIG_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(CLAUDE_CONFIG_FILE, "utf8"));
  } catch {
    return {};
  }
}

function createTerminalEnv() {
  const fallbackLocale = process.env.TERMCLOUD_UTF8_LOCALE || getDefaultUtf8Locale();
  const env = {
    ...process.env,
    TERM: "xterm-256color",
    COLORTERM: process.env.COLORTERM || "truecolor",
    HOME: USER_WORK_DIR
  };

  if (isClaudeConfigured()) {
    const cfg = getClaudeConfig();
    if (cfg.baseUrl) env.ANTHROPIC_BASE_URL = cfg.baseUrl;
    if (cfg.authToken) env.ANTHROPIC_AUTH_TOKEN = cfg.authToken;
    env.ANTHROPIC_API_KEY = "";
    if (cfg.model) env.ANTHROPIC_MODEL = cfg.model;
    if (cfg.haikuModel) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = cfg.haikuModel;
    if (cfg.effort) env.CLAUDE_CODE_EFFORT_LEVEL = cfg.effort;
  }

  const activeLocale = env.LC_ALL || env.LC_CTYPE || env.LANG;

  if (!isUtf8Locale(activeLocale)) {
    env.LANG = fallbackLocale;
    env.LC_CTYPE = fallbackLocale;
    if (env.LC_ALL) {
      env.LC_ALL = fallbackLocale;
    }
  }

  return env;
}

// ── middleware ──
app.use(compression());
app.use(express.static(path.join(__dirname, "public"), {
  maxAge: "7d",
  etag: true,
  immutable: true,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith(".woff2")) {
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    }
  }
}));

// auth middleware
function requireAuth(req, res, next) {
  let token = null;

  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    token = authHeader.slice(7);
  } else if (req.query && req.query.token) {
    token = req.query.token;
  }

  if (!token) {
    return res.status(401).json({ error: "unauthorized" });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: "unauthorized" });
  }
}

// ── login rate limiter ──
const loginAttempts = new Map();
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW = 60000; // 1 minute

function checkLoginRate(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  let entry = loginAttempts.get(ip);

  if (entry && now - entry.windowStart > RATE_LIMIT_WINDOW) {
    entry = null;
  }
  if (!entry) {
    entry = { windowStart: now, count: 0 };
    loginAttempts.set(ip, entry);
  }

  entry.count++;
  if (entry.count > RATE_LIMIT_MAX) {
    return res.status(429).json({ error: "too many attempts, try again later" });
  }

  next();
}

// Cleanup stale rate-limit entries every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT_WINDOW;
  for (const [ip, entry] of loginAttempts) {
    if (entry.windowStart < cutoff) loginAttempts.delete(ip);
  }
}, 300000).unref();

// ── login endpoint ──
app.post("/api/login", express.json(), checkLoginRate, (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: "username and password required" });
  }

  if (username !== config.username) {
    return res.status(401).json({ error: "invalid credentials" });
  }

  if (password !== config.password) {
    return res.status(401).json({ error: "invalid credentials" });
  }

  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: "24h" });
  res.json({ token, claudeConfigured: isClaudeConfigured() });
});

// ── Claude Code config endpoints ──
app.get("/api/claude-config", requireAuth, (req, res) => {
  const cfg = getClaudeConfig();
  res.json({
    configured: isClaudeConfigured(),
    baseUrl: cfg.baseUrl || "",
    authToken: cfg.authToken || "",
    model: cfg.model || "",
    haikuModel: cfg.haikuModel || "",
    effort: cfg.effort || ""
  });
});

app.post("/api/claude-config", requireAuth, express.json(), (req, res) => {
  const { baseUrl, authToken, model, haikuModel, effort } = req.body;
  if (!baseUrl || typeof baseUrl !== "string" || !baseUrl.trim()) {
    return res.status(400).json({ error: "ANTHROPIC_BASE_URL is required" });
  }
  if (!authToken || typeof authToken !== "string" || !authToken.trim()) {
    return res.status(400).json({ error: "ANTHROPIC_AUTH_TOKEN is required" });
  }

  try {
    const cfg = {
      baseUrl: baseUrl.trim(),
      authToken: authToken.trim(),
      model: (model && model.trim()) || "",
      haikuModel: (haikuModel && haikuModel.trim()) || "",
      effort: (effort && effort.trim()) || "max"
    };
    fs.writeFileSync(CLAUDE_CONFIG_FILE, JSON.stringify(cfg, null, 2));

    const bashrcPath = path.join(USER_WORK_DIR, ".bashrc");
    const envLines = [
      "",
      "# Claude Code configuration",
      `export ANTHROPIC_BASE_URL="${cfg.baseUrl}"`,
      `export ANTHROPIC_AUTH_TOKEN="${cfg.authToken}"`,
      'export ANTHROPIC_API_KEY=""',
      cfg.model ? `export ANTHROPIC_MODEL="${cfg.model}"` : "",
      cfg.haikuModel ? `export ANTHROPIC_DEFAULT_HAIKU_MODEL="${cfg.haikuModel}"` : "",
      `export CLAUDE_CODE_EFFORT_LEVEL="${cfg.effort}"`
    ].filter(Boolean).join("\n");

    let bashrc = "";
    if (fs.existsSync(bashrcPath)) {
      bashrc = fs.readFileSync(bashrcPath, "utf8");
      bashrc = bashrc.replace(/\n*# Claude Code configuration\n.*/s, "");
    }
    fs.writeFileSync(bashrcPath, bashrc + envLines + "\n");

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to save configuration: " + err.message });
  }
});

// ── protected API routes ──
app.get("/api/files", requireAuth, async (req, res) => {
  let dir = req.query.dir || USER_WORK_DIR;
  dir = path.resolve(dir);

  if (!isPathWithinUserDir(dir)) {
    return res.status(403).json({ error: "access denied: path outside work directory" });
  }

  let stat;
  try {
    stat = await fs.promises.stat(dir);
  } catch {
    return res.status(404).json({ error: "directory not found" });
  }

  if (!stat.isDirectory()) {
    return res.status(400).json({ error: "not a directory" });
  }

  try {
    const dirents = await fs.promises.readdir(dir, { withFileTypes: true });
    const entries = await Promise.all(
      dirents
        .filter((d) => !d.name.startsWith("."))
        .map(async (d) => {
          const isFile = d.isFile();
          const isDirectory = d.isDirectory();
          let size = null;
          if (isFile) {
            try {
              const s = await fs.promises.stat(path.join(dir, d.name));
              size = s.size;
            } catch {
              return null;
            }
          }
          return { name: d.name, isFile, isDirectory, size };
        })
    );
    res.json({ dir, entries: entries.filter(Boolean), workDir: USER_WORK_DIR });
  } catch (err) {
    res.status(403).json({ error: "permission denied" });
  }
});

app.delete("/api/files", requireAuth, async (req, res) => {
  const filePath = req.query.path;

  if (!filePath) {
    return res.status(400).json({ error: "missing path" });
  }

  const resolved = path.resolve(filePath);

  if (!isPathWithinUserDir(resolved)) {
    return res.status(403).json({ error: "access denied: path outside work directory" });
  }

  try {
    await fs.promises.stat(resolved);
  } catch {
    return res.status(404).json({ error: "file not found" });
  }

  try {
    await fs.promises.rm(resolved, { recursive: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/download", requireAuth, async (req, res) => {
  const filePath = req.query.path;

  if (!filePath) {
    return res.status(400).send("missing path");
  }

  const resolved = path.resolve(filePath);

  if (!isPathWithinUserDir(resolved)) {
    return res.status(403).send("access denied: path outside work directory");
  }

  let stat;
  try {
    stat = await fs.promises.stat(resolved);
  } catch {
    return res.status(404).send("file not found");
  }

  if (!stat.isFile()) {
    return res.status(400).send("not a file");
  }

  return res.download(resolved);
});

// ── ring buffer ──
class RingBuffer {
  constructor(maxSize) {
    this.maxSize = maxSize;
    this.chunks = [];
    this.startIdx = 0;
    this.totalSize = 0;
  }

  push(data) {
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
    this.chunks.push(chunk);
    this.totalSize += chunk.length;
    this._evict();
  }

  _evict() {
    while (this.totalSize > this.maxSize && this.chunks.length - this.startIdx > 1) {
      this.totalSize -= this.chunks[this.startIdx].length;
      this.startIdx++;
      if (this.startIdx > 1024) {
        this.chunks = this.chunks.slice(this.startIdx);
        this.startIdx = 0;
      }
    }
  }

  *iterChunks() {
    for (let i = this.startIdx; i < this.chunks.length; i++) {
      yield this.chunks[i];
    }
  }

  get length() { return this.chunks.length - this.startIdx; }
  get size() { return this.totalSize; }
}

// ── binary protocol helpers ──
const MSG_OUTPUT = 0x01;
const MSG_INPUT = 0x02;
const MSG_RESIZE = 0x03;
const MSG_CONNECTED = 0x04;
const MSG_BATCH_OUTPUT = 0x05;

function getPositiveIntEnv(name, fallback) {
  const value = Number.parseInt(process.env[name], 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const REPLAY_BUFFER_BYTES = getPositiveIntEnv("TERMCLOUD_REPLAY_BUFFER_BYTES", 1024 * 1024);
const REPLAY_FRAME_BYTES = getPositiveIntEnv("TERMCLOUD_REPLAY_FRAME_BYTES", 128 * 1024);
const WS_BACKPRESSURE_LIMIT_BYTES = getPositiveIntEnv("TERMCLOUD_WS_BACKPRESSURE_LIMIT_BYTES", 4 * 1024 * 1024);
const WS_COMPRESSION_THRESHOLD_BYTES = getPositiveIntEnv("TERMCLOUD_WS_COMPRESSION_THRESHOLD_BYTES", 1024);
const SESSION_IDLE_TIMEOUT_MS = getPositiveIntEnv("TERMCLOUD_SESSION_IDLE_TIMEOUT_MS", 10 * 60 * 1000);

function toPayloadBuffer(data) {
  return Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
}

function encodeOutput(data) {
  const payload = toPayloadBuffer(data);
  const frame = Buffer.alloc(1 + payload.length);
  frame[0] = MSG_OUTPUT;
  payload.copy(frame, 1);
  return frame;
}

function encodeBatchOutput(chunks) {
  const bufs = chunks.map(toPayloadBuffer);
  const totalLen = bufs.reduce((sum, b) => sum + b.length, 0);
  const frame = Buffer.alloc(1 + totalLen);
  frame[0] = MSG_BATCH_OUTPUT;
  let offset = 1;
  for (const b of bufs) {
    b.copy(frame, offset);
    offset += b.length;
  }
  return frame;
}

// ── terminal session management ──
const sessions = new Map();

function getOrCreateSession(username) {
  const existing = sessions.get(username);
  if (existing && !existing.exited) return existing;

  const shell = process.env.SHELL || "/bin/bash";
  const ptyProcess = pty.spawn(shell, [], {
    name: "xterm-256color",
    cols: 100,
    rows: 30,
    cwd: USER_WORK_DIR,
    env: createTerminalEnv()
  });

  const session = {
    username,
    pty: ptyProcess,
    buffer: new RingBuffer(REPLAY_BUFFER_BYTES),
    clients: new Set(),
    exited: false,
    batchAccumulator: [],
    batchPending: false,
    idleTimer: null
  };

  // Strip DA (Device Attributes) responses so they don't leak as visible text.
  // xterm.js sends \x1b[c (Primary DA) on startup; macOS PTY responds with
  // \x1b[/1;2c (VT102-style with '/' intermediate), which xterm.js doesn't consume.
  const DA_RESPONSE_RE = /\x1b\[[\x20-\x2f]*[\x30-\x3f]*c/g;

  ptyProcess.onData((data) => {
    data = data.replace(DA_RESPONSE_RE, "");
    if (!data) return;

    const chunk = Buffer.from(data, "utf8");
    session.buffer.push(chunk);

    if (session.clients.size === 0) return;

    if (!session.batchPending) {
      session.batchPending = true;
      session.batchAccumulator = [];
    }
    session.batchAccumulator.push(chunk);
    startBatchFlush();
  });

  ptyProcess.onExit(() => {
    session.exited = true;
    cancelSessionIdleCleanup(session);
    if (sessions.get(username) === session) {
      sessions.delete(username);
    }
    for (const ws of session.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(4001, "process exited");
      }
    }
  });

  sessions.set(username, session);
  return session;
}

function clearPendingBatch(session) {
  session.batchPending = false;
  session.batchAccumulator = [];
}

function cancelSessionIdleCleanup(session) {
  if (!session.idleTimer) return;
  clearTimeout(session.idleTimer);
  session.idleTimer = null;
}

function scheduleSessionIdleCleanup(session) {
  if (session.exited || session.clients.size > 0 || session.idleTimer) return;

  clearPendingBatch(session);

  session.idleTimer = setTimeout(() => {
    session.idleTimer = null;
    if (session.exited || session.clients.size > 0) return;

    session.exited = true;
    clearPendingBatch(session);
    if (sessions.get(session.username) === session) {
      sessions.delete(session.username);
    }

    try {
      session.pty.kill();
    } catch {
      // PTY may already be closed.
    }
  }, SESSION_IDLE_TIMEOUT_MS);
  session.idleTimer.unref();
}

function detachClient(session, ws) {
  const removed = session.clients.delete(ws);
  if (!removed) return;

  if (session.clients.size === 0) {
    scheduleSessionIdleCleanup(session);
  }
}

function closeSlowClient(session, ws) {
  detachClient(session, ws);
  try {
    ws.close(4002, "client too slow");
  } catch {
    ws.terminate();
  }
}

function sendFrameToClient(session, ws, frame) {
  if (ws.readyState !== WebSocket.OPEN) {
    detachClient(session, ws);
    return false;
  }

  if (ws.bufferedAmount + frame.length > WS_BACKPRESSURE_LIMIT_BYTES) {
    closeSlowClient(session, ws);
    return false;
  }

  ws.send(frame, (err) => {
    if (err) detachClient(session, ws);
  });
  return true;
}

function sendReplayBuffer(session, ws) {
  let batch = [];
  let batchSize = 0;

  const flush = () => {
    if (batch.length === 0) return true;
    const frame = batch.length === 1 ? encodeOutput(batch[0]) : encodeBatchOutput(batch);
    batch = [];
    batchSize = 0;
    return sendFrameToClient(session, ws, frame);
  };

  for (const chunk of session.buffer.iterChunks()) {
    if (batchSize > 0 && batchSize + chunk.length > REPLAY_FRAME_BYTES) {
      if (!flush()) return;
    }
    batch.push(chunk);
    batchSize += chunk.length;
  }

  flush();
}

// ── batch flush (16ms ≈ 60Hz) ──
let batchFlushTimer = null;

function startBatchFlush() {
  if (batchFlushTimer) return;
  batchFlushTimer = setInterval(() => {
    for (const session of sessions.values()) {
      if (!session.batchPending) continue;

      const acc = session.batchAccumulator;
      clearPendingBatch(session);

      if (acc.length === 0 || session.clients.size === 0) continue;

      const frame = acc.length === 1
        ? encodeOutput(acc[0])
        : encodeBatchOutput(acc);

      for (const ws of session.clients) {
        sendFrameToClient(session, ws, frame);
      }
    }

    const hasPendingWork = [...sessions.values()].some(
      (session) => session.batchPending && session.clients.size > 0
    );
    if (!hasPendingWork) {
      clearInterval(batchFlushTimer);
      batchFlushTimer = null;
    }
  }, 16);
}

// ── WebSocket with auth ──
const wss = new WebSocket.Server({
  server,
  path: "/ws/terminal",
  perMessageDeflate: {
    zlibDeflateOptions: { level: 1, memLevel: 3 },
    serverNoContextTakeover: true,
    clientNoContextTakeover: true,
    concurrencyLimit: 2,
    threshold: WS_COMPRESSION_THRESHOLD_BYTES
  },
  verifyClient: (info, callback) => {
    const url = new URL(info.req.url, "http://localhost");
    const token = url.searchParams.get("token");
    if (!token) {
      return callback(false, 401, "Unauthorized");
    }
    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (err) {
      return callback(false, 401, "Unauthorized");
    }
    info.req.user = decoded;
    return callback(true);
  }
});

wss.on("connection", (ws, req) => {
  const username = req.user.username;
  let session;

  try {
    session = getOrCreateSession(username);
  } catch (err) {
    console.error("Failed to start terminal session:", err);
    if (ws.readyState === WebSocket.OPEN) {
      const message = `\r\nFailed to start terminal session: ${err.message || "unknown error"}\r\n`;
      ws.send(encodeOutput(message), () => {
        ws.close(4004, "terminal unavailable");
      });
    } else {
      ws.terminate();
    }
    return;
  }

  session.clients.add(ws);
  cancelSessionIdleCleanup(session);

  const isResuming = session.buffer.length > 0;
  const connectedFrame = Buffer.alloc(2);
  connectedFrame[0] = MSG_CONNECTED;
  connectedFrame[1] = isResuming ? 0x01 : 0x00;
  ws.send(connectedFrame);

  if (session.buffer.length > 0) {
    sendReplayBuffer(session, ws);
  }

  ws.on("message", (message) => {
    if (session.exited) return;

    const buf = Buffer.from(message);
    if (buf.length < 1) return;

    const msgType = buf[0];

    if (msgType === MSG_INPUT) {
      session.pty.write(buf.toString("utf8", 1));
    }

    if (msgType === MSG_RESIZE && buf.length >= 5) {
      try {
        const cols = buf.readUInt16LE(1);
        const rows = buf.readUInt16LE(3);
        session.pty.resize(cols, rows);
      } catch (err) {
        // fd may have closed between messages
      }
    }
  });

  ws.on("close", () => {
    detachClient(session, ws);
  });

  ws.on("error", () => {
    detachClient(session, ws);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  // eslint-disable-next-line no-console
  console.log(`Web Linux Console running at http://0.0.0.0:${PORT}`);
});
