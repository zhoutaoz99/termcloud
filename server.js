const express = require("express");
const fs = require("fs");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
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

function createTerminalEnv() {
  const fallbackLocale = process.env.TERMCLOUD_UTF8_LOCALE || getDefaultUtf8Locale();
  const env = {
    ...process.env,
    TERM: "xterm-256color",
    COLORTERM: process.env.COLORTERM || "truecolor"
  };
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
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// auth middleware
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const token = authHeader.slice(7);
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: "unauthorized" });
  }
}

// ── login endpoint ──
app.post("/api/login", (req, res) => {
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
  res.json({ token });
});

// ── protected API routes ──
app.get("/api/files", requireAuth, (req, res) => {
  let dir = req.query.dir || USER_WORK_DIR;

  // Resolve and safety-check the path
  dir = path.resolve(dir);

  if (!isPathWithinUserDir(dir)) {
    return res.status(403).json({ error: "access denied: path outside work directory" });
  }

  if (!fs.existsSync(dir)) {
    return res.status(404).json({ error: "directory not found" });
  }

  const stat = fs.statSync(dir);
  if (!stat.isDirectory()) {
    return res.status(400).json({ error: "not a directory" });
  }

  try {
    const entries = fs
      .readdirSync(dir)
      .filter((name) => !name.startsWith("."))
      .map((name) => {
        const fullPath = path.join(dir, name);
        try {
          const s = fs.statSync(fullPath);
          return {
            name,
            isFile: s.isFile(),
            isDirectory: s.isDirectory(),
            size: s.isFile() ? s.size : null
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    res.json({ dir, entries, workDir: USER_WORK_DIR });
  } catch (err) {
    res.status(403).json({ error: "permission denied" });
  }
});

app.delete("/api/files", requireAuth, (req, res) => {
  const filePath = req.query.path;

  if (!filePath) {
    return res.status(400).json({ error: "missing path" });
  }

  const resolved = path.resolve(filePath);

  if (!isPathWithinUserDir(resolved)) {
    return res.status(403).json({ error: "access denied: path outside work directory" });
  }

  if (!fs.existsSync(resolved)) {
    return res.status(404).json({ error: "file not found" });
  }

  try {
    fs.rmSync(resolved, { recursive: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/download", requireAuth, (req, res) => {
  const filePath = req.query.path;

  if (!filePath) {
    return res.status(400).send("missing path");
  }

  const resolved = path.resolve(filePath);

  if (!isPathWithinUserDir(resolved)) {
    return res.status(403).send("access denied: path outside work directory");
  }

  if (!fs.existsSync(resolved)) {
    return res.status(404).send("file not found");
  }

  const stat = fs.statSync(resolved);

  if (!stat.isFile()) {
    return res.status(400).send("not a file");
  }

  return res.download(resolved);
});

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
    pty: ptyProcess,
    buffer: [],
    bufferSize: 0,
    clients: new Set(),
    exited: false
  };

  ptyProcess.onData((data) => {
    session.buffer.push(data);
    session.bufferSize += data.length;
    while (session.bufferSize > 1048576 && session.buffer.length > 1) {
      session.bufferSize -= session.buffer.shift().length;
    }

    for (const ws of session.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "output", data }));
      }
    }
  });

  ptyProcess.onExit(() => {
    session.exited = true;
    sessions.delete(username);
    for (const ws of session.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(4001, "process exited");
      }
    }
  });

  sessions.set(username, session);
  return session;
}

// ── WebSocket with auth ──
const wss = new WebSocket.Server({
  server,
  path: "/ws/terminal",
  verifyClient: (info, callback) => {
    const url = new URL(info.req.url, "http://localhost");
    const token = url.searchParams.get("token");
    if (!token) {
      return callback(false, 401, "Unauthorized");
    }
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      info.req.user = decoded;
      callback(true);
    } catch (err) {
      callback(false, 401, "Unauthorized");
    }
  }
});

wss.on("connection", (ws, req) => {
  const username = req.user.username;
  const session = getOrCreateSession(username);

  session.clients.add(ws);

  const isResuming = session.buffer.length > 0;
  ws.send(JSON.stringify({ type: "connected", resuming: isResuming }));

  if (session.buffer.length > 0) {
    ws.send(JSON.stringify({ type: "output", data: session.buffer.join("") }));
  }

  ws.on("message", (message) => {
    if (session.exited) return;

    let msg;
    try {
      msg = JSON.parse(message.toString());
    } catch (err) {
      return;
    }

    if (msg.type === "input") {
      session.pty.write(msg.data);
    }

    if (msg.type === "resize") {
      try {
        session.pty.resize(msg.cols, msg.rows);
      } catch (err) {
        // fd may have closed between messages
      }
    }
  });

  ws.on("close", () => {
    session.clients.delete(ws);
  });

  ws.on("error", () => {
    session.clients.delete(ws);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  // eslint-disable-next-line no-console
  console.log(`Web Linux Console running at http://0.0.0.0:${PORT}`);
});
