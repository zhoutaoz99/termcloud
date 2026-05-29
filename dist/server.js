"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const fs_1 = __importDefault(require("fs"));
const http_1 = __importDefault(require("http"));
const path_1 = __importDefault(require("path"));
const crypto_1 = __importDefault(require("crypto"));
const os_1 = __importDefault(require("os"));
const compression_1 = __importDefault(require("compression"));
const ws_1 = __importDefault(require("ws"));
const pty = __importStar(require("node-pty"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const app = (0, express_1.default)();
const server = http_1.default.createServer(app);
const PORT = parseInt(process.env.PORT, 10) || 3000;
// ── config loading ──
const CONFIG_PATH = (() => {
    // In Docker, prefer /data/config.json (persistent volume)
    const dockerPath = "/data/config.json";
    try {
        if (fs_1.default.existsSync(dockerPath))
            return dockerPath;
    }
    catch { /* ignore */ }
    return path_1.default.join(__dirname, "..", "config.json");
})();
if (!fs_1.default.existsSync(CONFIG_PATH)) {
    console.error("config.json not found. Please create it with users array.");
    process.exit(1);
}
const config = JSON.parse(fs_1.default.readFileSync(CONFIG_PATH, "utf8"));
if (!Array.isArray(config.users) || config.users.length === 0) {
    console.error("config.json must contain a non-empty 'users' array.");
    process.exit(1);
}
const usersMap = new Map();
for (const entry of config.users) {
    if (typeof entry.username !== "string" || typeof entry.password !== "string" ||
        !entry.username || !entry.password) {
        console.error("Each user entry must have non-empty username and password strings.");
        process.exit(1);
    }
    if (usersMap.has(entry.username)) {
        console.error(`Duplicate username in config: ${entry.username}`);
        process.exit(1);
    }
    usersMap.set(entry.username, entry.password);
}
if (usersMap.size === 0) {
    console.error("config.json must contain at least one user.");
    process.exit(1);
}
console.log(`Loaded ${usersMap.size} user(s): ${[...usersMap.keys()].join(", ")}`);
// ── per-user work directory ──
const userWorkDirCache = new Map();
function getUserWorkDir(username) {
    const cached = userWorkDirCache.get(username);
    if (cached)
        return cached;
    const preferred = path_1.default.join("/data/users", username);
    try {
        if (!fs_1.default.existsSync(preferred)) {
            fs_1.default.mkdirSync(preferred, { recursive: true });
        }
        userWorkDirCache.set(username, preferred);
        return preferred;
    }
    catch {
        const fallback = path_1.default.join(os_1.default.homedir(), ".termcloud-data", "users", username);
        if (!fs_1.default.existsSync(fallback)) {
            fs_1.default.mkdirSync(fallback, { recursive: true });
        }
        console.warn(`Cannot create ${preferred}, using fallback: ${fallback}`);
        userWorkDirCache.set(username, fallback);
        return fallback;
    }
}
function isPathWithinUserDir(resolvedPath, username) {
    const userDir = getUserWorkDir(username);
    const normalized = path_1.default.resolve(resolvedPath);
    return normalized === userDir || normalized.startsWith(userDir + path_1.default.sep);
}
const JWT_SECRET_PATH = path_1.default.join(__dirname, "..", ".jwt_secret");
let JWT_SECRET;
if (fs_1.default.existsSync(JWT_SECRET_PATH)) {
    JWT_SECRET = fs_1.default.readFileSync(JWT_SECRET_PATH, "utf8").trim();
}
else {
    JWT_SECRET = crypto_1.default.randomBytes(32).toString("hex");
    fs_1.default.writeFileSync(JWT_SECRET_PATH, JWT_SECRET);
}
function isUtf8Locale(value) {
    return typeof value === "string" && /utf-?8/i.test(value);
}
function getDefaultUtf8Locale() {
    return process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8";
}
function getClaudeConfigPath(username) {
    return path_1.default.join(getUserWorkDir(username), ".claude_code_config.json");
}
function isClaudeConfigured(username) {
    return fs_1.default.existsSync(getClaudeConfigPath(username));
}
function getClaudeConfig(username) {
    const configPath = getClaudeConfigPath(username);
    if (!fs_1.default.existsSync(configPath))
        return {};
    try {
        return JSON.parse(fs_1.default.readFileSync(configPath, "utf8"));
    }
    catch {
        return {};
    }
}
function createTerminalEnv(username) {
    const userDir = getUserWorkDir(username);
    const fallbackLocale = process.env.TERMCLOUD_UTF8_LOCALE || getDefaultUtf8Locale();
    const env = {
        ...process.env,
        TERM: "xterm-256color",
        COLORTERM: process.env.COLORTERM || "truecolor",
        HOME: userDir
    };
    if (isClaudeConfigured(username)) {
        const cfg = getClaudeConfig(username);
        if (cfg.baseUrl)
            env.ANTHROPIC_BASE_URL = cfg.baseUrl;
        if (cfg.authToken)
            env.ANTHROPIC_AUTH_TOKEN = cfg.authToken;
        env.ANTHROPIC_API_KEY = "";
        if (cfg.model)
            env.ANTHROPIC_MODEL = cfg.model;
        if (cfg.haikuModel)
            env.ANTHROPIC_DEFAULT_HAIKU_MODEL = cfg.haikuModel;
        if (cfg.effort)
            env.CLAUDE_CODE_EFFORT_LEVEL = cfg.effort;
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
app.use((0, compression_1.default)());
app.use(express_1.default.static(path_1.default.join(__dirname, "..", "public"), {
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
    }
    else if (req.query && req.query.token) {
        token = req.query.token;
    }
    if (!token) {
        res.status(401).json({ error: "unauthorized" });
        return;
    }
    try {
        const decoded = jsonwebtoken_1.default.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    }
    catch {
        res.status(401).json({ error: "unauthorized" });
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
        entry = undefined;
    }
    if (!entry) {
        entry = { windowStart: now, count: 0 };
        loginAttempts.set(ip, entry);
    }
    entry.count++;
    if (entry.count > RATE_LIMIT_MAX) {
        res.status(429).json({ error: "too many attempts, try again later" });
        return;
    }
    next();
}
// Cleanup stale rate-limit entries every 5 minutes
setInterval(() => {
    const cutoff = Date.now() - RATE_LIMIT_WINDOW;
    for (const [ip, entry] of loginAttempts) {
        if (entry.windowStart < cutoff)
            loginAttempts.delete(ip);
    }
}, 300000).unref();
// ── login endpoint ──
app.post("/api/login", express_1.default.json(), checkLoginRate, (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        res.status(400).json({ error: "username and password required" });
        return;
    }
    const storedPassword = usersMap.get(username);
    if (!storedPassword) {
        res.status(401).json({ error: "invalid credentials" });
        return;
    }
    if (password !== storedPassword) {
        res.status(401).json({ error: "invalid credentials" });
        return;
    }
    const token = jsonwebtoken_1.default.sign({ username }, JWT_SECRET, { expiresIn: "24h" });
    res.json({ token, claudeConfigured: isClaudeConfigured(username) });
});
// ── Claude Code config endpoints ──
app.get("/api/claude-config", requireAuth, (req, res) => {
    const username = req.user.username;
    const cfg = getClaudeConfig(username);
    res.json({
        configured: isClaudeConfigured(username),
        baseUrl: cfg.baseUrl || "",
        authToken: cfg.authToken || "",
        model: cfg.model || "",
        haikuModel: cfg.haikuModel || "",
        effort: cfg.effort || ""
    });
});
app.post("/api/claude-config", requireAuth, express_1.default.json(), (req, res) => {
    const username = req.user.username;
    const { baseUrl, authToken, model, haikuModel, effort } = req.body;
    if (!baseUrl || typeof baseUrl !== "string" || !baseUrl.trim()) {
        res.status(400).json({ error: "ANTHROPIC_BASE_URL is required" });
        return;
    }
    if (!authToken || typeof authToken !== "string" || !authToken.trim()) {
        res.status(400).json({ error: "ANTHROPIC_AUTH_TOKEN is required" });
        return;
    }
    try {
        const userDir = getUserWorkDir(username);
        const cfg = {
            baseUrl: baseUrl.trim(),
            authToken: authToken.trim(),
            model: (model && model.trim()) || "",
            haikuModel: (haikuModel && haikuModel.trim()) || "",
            effort: (effort && effort.trim()) || "max"
        };
        fs_1.default.writeFileSync(getClaudeConfigPath(username), JSON.stringify(cfg, null, 2));
        const bashrcPath = path_1.default.join(userDir, ".bashrc");
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
        if (fs_1.default.existsSync(bashrcPath)) {
            bashrc = fs_1.default.readFileSync(bashrcPath, "utf8");
            bashrc = bashrc.replace(/\n*# Claude Code configuration\n.*/s, "");
        }
        fs_1.default.writeFileSync(bashrcPath, bashrc + envLines + "\n");
        res.json({ ok: true });
    }
    catch (err) {
        res.status(500).json({ error: "Failed to save configuration: " + err.message });
    }
});
// ── protected API routes ──
app.get("/api/files", requireAuth, async (req, res) => {
    const username = req.user.username;
    const userDir = getUserWorkDir(username);
    let dir = req.query.dir || userDir;
    dir = path_1.default.resolve(dir);
    if (!isPathWithinUserDir(dir, username)) {
        res.status(403).json({ error: "access denied: path outside work directory" });
        return;
    }
    let stat;
    try {
        stat = await fs_1.default.promises.stat(dir);
    }
    catch {
        res.status(404).json({ error: "directory not found" });
        return;
    }
    if (!stat.isDirectory()) {
        res.status(400).json({ error: "not a directory" });
        return;
    }
    try {
        const dirents = await fs_1.default.promises.readdir(dir, { withFileTypes: true });
        const entries = await Promise.all(dirents
            .filter((d) => !d.name.startsWith("."))
            .map(async (d) => {
            const isFile = d.isFile();
            const isDirectory = d.isDirectory();
            let size = null;
            if (isFile) {
                try {
                    const s = await fs_1.default.promises.stat(path_1.default.join(dir, d.name));
                    size = s.size;
                }
                catch {
                    return null;
                }
            }
            return { name: d.name, isFile, isDirectory, size };
        }));
        res.json({ dir, entries: entries.filter(Boolean), workDir: userDir });
    }
    catch {
        res.status(403).json({ error: "permission denied" });
    }
});
app.delete("/api/files", requireAuth, async (req, res) => {
    const username = req.user.username;
    const filePath = req.query.path;
    if (!filePath) {
        res.status(400).json({ error: "missing path" });
        return;
    }
    const resolved = path_1.default.resolve(filePath);
    if (!isPathWithinUserDir(resolved, username)) {
        res.status(403).json({ error: "access denied: path outside work directory" });
        return;
    }
    try {
        await fs_1.default.promises.stat(resolved);
    }
    catch {
        res.status(404).json({ error: "file not found" });
        return;
    }
    try {
        await fs_1.default.promises.rm(resolved, { recursive: true });
        res.json({ ok: true });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
app.get("/download", requireAuth, async (req, res) => {
    const username = req.user.username;
    const filePath = req.query.path;
    if (!filePath) {
        res.status(400).send("missing path");
        return;
    }
    const resolved = path_1.default.resolve(filePath);
    if (!isPathWithinUserDir(resolved, username)) {
        res.status(403).send("access denied: path outside work directory");
        return;
    }
    let stat;
    try {
        stat = await fs_1.default.promises.stat(resolved);
    }
    catch {
        res.status(404).send("file not found");
        return;
    }
    if (!stat.isFile()) {
        res.status(400).send("not a file");
        return;
    }
    return res.download(resolved);
});
// ── ring buffer ──
class RingBuffer {
    maxSize;
    chunks;
    startIdx;
    totalSize;
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
    if (existing && !existing.exited)
        return existing;
    const userDir = getUserWorkDir(username);
    const shell = process.env.SHELL || "/bin/bash";
    const ptyProcess = pty.spawn(shell, [], {
        name: "xterm-256color",
        cols: 100,
        rows: 30,
        cwd: userDir,
        env: createTerminalEnv(username)
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
        if (!data)
            return;
        const chunk = Buffer.from(data, "utf8");
        session.buffer.push(chunk);
        if (session.clients.size === 0)
            return;
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
            if (ws.readyState === ws_1.default.OPEN) {
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
    if (!session.idleTimer)
        return;
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
}
function scheduleSessionIdleCleanup(session) {
    if (session.exited || session.clients.size > 0 || session.idleTimer)
        return;
    clearPendingBatch(session);
    session.idleTimer = setTimeout(() => {
        session.idleTimer = null;
        if (session.exited || session.clients.size > 0)
            return;
        session.exited = true;
        clearPendingBatch(session);
        if (sessions.get(session.username) === session) {
            sessions.delete(session.username);
        }
        try {
            session.pty.kill();
        }
        catch {
            // PTY may already be closed.
        }
    }, SESSION_IDLE_TIMEOUT_MS);
    session.idleTimer.unref();
}
function detachClient(session, ws) {
    const removed = session.clients.delete(ws);
    if (!removed)
        return;
    if (session.clients.size === 0) {
        scheduleSessionIdleCleanup(session);
    }
}
function closeSlowClient(session, ws) {
    detachClient(session, ws);
    try {
        ws.close(4002, "client too slow");
    }
    catch {
        ws.terminate();
    }
}
function sendFrameToClient(session, ws, frame) {
    if (ws.readyState !== ws_1.default.OPEN) {
        detachClient(session, ws);
        return false;
    }
    if (ws.bufferedAmount + frame.length > WS_BACKPRESSURE_LIMIT_BYTES) {
        closeSlowClient(session, ws);
        return false;
    }
    ws.send(frame, (err) => {
        if (err)
            detachClient(session, ws);
    });
    return true;
}
function sendReplayBuffer(session, ws) {
    let batch = [];
    let batchSize = 0;
    const flush = () => {
        if (batch.length === 0)
            return true;
        const frame = batch.length === 1 ? encodeOutput(batch[0]) : encodeBatchOutput(batch);
        batch = [];
        batchSize = 0;
        return sendFrameToClient(session, ws, frame);
    };
    for (const chunk of session.buffer.iterChunks()) {
        if (batchSize > 0 && batchSize + chunk.length > REPLAY_FRAME_BYTES) {
            if (!flush())
                return;
        }
        batch.push(chunk);
        batchSize += chunk.length;
    }
    flush();
}
// ── batch flush (16ms ≈ 60Hz) ──
let batchFlushTimer = null;
function startBatchFlush() {
    if (batchFlushTimer)
        return;
    batchFlushTimer = setInterval(() => {
        for (const session of sessions.values()) {
            if (!session.batchPending)
                continue;
            const acc = session.batchAccumulator;
            clearPendingBatch(session);
            if (acc.length === 0 || session.clients.size === 0)
                continue;
            const frame = acc.length === 1
                ? encodeOutput(acc[0])
                : encodeBatchOutput(acc);
            for (const ws of session.clients) {
                sendFrameToClient(session, ws, frame);
            }
        }
        const hasPendingWork = [...sessions.values()].some((session) => session.batchPending && session.clients.size > 0);
        if (!hasPendingWork) {
            clearInterval(batchFlushTimer);
            batchFlushTimer = null;
        }
    }, 16);
}
// ── WebSocket with auth ──
const wss = new ws_1.default.Server({
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
            decoded = jsonwebtoken_1.default.verify(token, JWT_SECRET);
        }
        catch {
            return callback(false, 401, "Unauthorized");
        }
        info.req.user = decoded;
        return callback(true);
    }
});
wss.on("connection", (ws, req) => {
    const username = (req.user).username;
    let session;
    try {
        session = getOrCreateSession(username);
    }
    catch (err) {
        console.error("Failed to start terminal session:", err);
        if (ws.readyState === ws_1.default.OPEN) {
            const message = `\r\nFailed to start terminal session: ${err.message || "unknown error"}\r\n`;
            ws.send(encodeOutput(message), () => {
                ws.close(4004, "terminal unavailable");
            });
        }
        else {
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
        if (session.exited)
            return;
        const buf = Buffer.from(message);
        if (buf.length < 1)
            return;
        const msgType = buf[0];
        if (msgType === MSG_INPUT) {
            session.pty.write(buf.toString("utf8", 1));
        }
        if (msgType === MSG_RESIZE && buf.length >= 5) {
            try {
                const cols = buf.readUInt16LE(1);
                const rows = buf.readUInt16LE(3);
                session.pty.resize(cols, rows);
            }
            catch {
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
    console.log(`Web Linux Console running at http://0.0.0.0:${PORT}`);
});
