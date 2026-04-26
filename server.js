const express = require("express");
const fs = require("fs");
const http = require("http");
const os = require("os");
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

const JWT_SECRET = crypto.randomBytes(32).toString("hex");

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
  let dir = req.query.dir || os.homedir();

  // Resolve and safety-check the path
  dir = path.resolve(dir);

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

    res.json({ dir, entries });
  } catch (err) {
    res.status(403).json({ error: "permission denied" });
  }
});

app.get("/download", requireAuth, (req, res) => {
  const filePath = req.query.path;

  if (!filePath) {
    return res.status(400).send("missing path");
  }

  if (!fs.existsSync(filePath)) {
    return res.status(404).send("file not found");
  }

  const stat = fs.statSync(filePath);

  if (!stat.isFile()) {
    return res.status(400).send("not a file");
  }

  return res.download(filePath);
});

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
      jwt.verify(token, JWT_SECRET);
      callback(true);
    } catch (err) {
      callback(false, 401, "Unauthorized");
    }
  }
});

wss.on("connection", (ws) => {
  const shell = process.env.SHELL || "/bin/bash";

  const ptyProcess = pty.spawn(shell, [], {
    name: "xterm-256color",
    cols: 100,
    rows: 30,
    cwd: process.env.HOME || os.homedir(),
    env: createTerminalEnv()
  });

  ptyProcess.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: "output",
          data
        })
      );
    }
  });

  ws.on("message", (message) => {
    let msg;

    try {
      msg = JSON.parse(message.toString());
    } catch (err) {
      return;
    }

    if (msg.type === "input") {
      ptyProcess.write(msg.data);
    }

    if (msg.type === "resize") {
      ptyProcess.resize(msg.cols, msg.rows);
    }
  });

  const terminate = () => {
    try {
      ptyProcess.kill();
    } catch (err) {
      // ignore
    }
  };

  ws.on("close", terminate);
  ws.on("error", terminate);
});

server.listen(PORT, "0.0.0.0", () => {
  // eslint-disable-next-line no-console
  console.log(`Web Linux Console running at http://0.0.0.0:${PORT}`);
});
