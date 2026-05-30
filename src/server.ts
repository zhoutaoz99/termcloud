import express from "express";
import fs from "fs";
import http from "http";
import path from "path";
import crypto from "crypto";
import os from "os";
import compression from "compression";
import WebSocket from "ws";
import * as pty from "node-pty";
import jwt from "jsonwebtoken";

const app = express();
const server = http.createServer(app);

const PORT = parseInt(process.env.PORT!, 10) || 3000;

// ── interfaces ──
interface ClaudeConfig {
  baseUrl?: string;
  authToken?: string;
  model?: string;
  haikuModel?: string;
  effort?: string;
}

interface EnvVariable {
  name: string;
  value: string;
}

interface PublicEnvConfig {
  variables: EnvVariable[];
}

interface AuthenticatedRequest extends express.Request {
  user?: { username: string };
}

interface LoginRateEntry {
  windowStart: number;
  count: number;
}

interface TerminalSession {
  username: string;
  pty: pty.IPty;
  buffer: RingBuffer;
  clients: Set<WebSocket>;
  exited: boolean;
  batchAccumulator: Buffer[];
  batchPending: boolean;
  idleTimer: NodeJS.Timeout | null;
}

// ── config loading ──
const CONFIG_PATH = path.join(__dirname, "..", "config.json");

if (!fs.existsSync(CONFIG_PATH)) {
  console.error("config.json not found. Please create it with users array.");
  process.exit(1);
}

interface UserEntry {
  username: string;
  password: string;
}

interface UserConfig {
  users: UserEntry[];
}

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as UserConfig;

if (!Array.isArray(config.users) || config.users.length === 0) {
  console.error("config.json must contain a non-empty 'users' array.");
  process.exit(1);
}

const usersMap = new Map<string, string>();

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

// ── data directories ──
let dataRootCache: string | null = null;
const userWorkDirCache = new Map<string, string>();

function getDataRootDir(): string {
  if (dataRootCache) return dataRootCache;

  const preferred = "/data";
  try {
    if (!fs.existsSync(preferred)) {
      fs.mkdirSync(preferred, { recursive: true });
    }
    fs.accessSync(preferred, fs.constants.W_OK);
    dataRootCache = preferred;
    return preferred;
  } catch {
    const fallback = path.join(os.homedir(), ".termcloud-data");
    if (!fs.existsSync(fallback)) {
      fs.mkdirSync(fallback, { recursive: true });
    }
    fs.accessSync(fallback, fs.constants.W_OK);
    console.warn(`Cannot create ${preferred}, using fallback: ${fallback}`);
    dataRootCache = fallback;
    return fallback;
  }
}

function getUserWorkDir(username: string): string {
  const cached = userWorkDirCache.get(username);
  if (cached) return cached;

  const preferred = path.join(getDataRootDir(), "users", username);
  try {
    if (!fs.existsSync(preferred)) {
      fs.mkdirSync(preferred, { recursive: true });
    }
    userWorkDirCache.set(username, preferred);
    return preferred;
  } catch {
    const fallback = path.join(os.homedir(), ".termcloud-data", "users", username);
    if (!fs.existsSync(fallback)) {
      fs.mkdirSync(fallback, { recursive: true });
    }
    console.warn(`Cannot create ${preferred}, using fallback: ${fallback}`);
    userWorkDirCache.set(username, fallback);
    return fallback;
  }
}

function isPathWithinUserDir(resolvedPath: string, username: string): boolean {
  const userDir = getUserWorkDir(username);
  const normalized = path.resolve(resolvedPath);
  return normalized === userDir || normalized.startsWith(userDir + path.sep);
}

const JWT_SECRET_PATH = path.join(__dirname, "..", ".jwt_secret");
let JWT_SECRET: string;
if (fs.existsSync(JWT_SECRET_PATH)) {
  JWT_SECRET = fs.readFileSync(JWT_SECRET_PATH, "utf8").trim();
} else {
  JWT_SECRET = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(JWT_SECRET_PATH, JWT_SECRET);
}

function isUtf8Locale(value: string | undefined): boolean {
  return typeof value === "string" && /utf-?8/i.test(value);
}

function getDefaultUtf8Locale(): string {
  return process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8";
}

function isAdminUser(username: string): boolean {
  return username === "admin" && usersMap.has(username);
}

function getClaudeConfigPath(username: string): string {
  return path.join(getUserWorkDir(username), ".claude_code_config.json");
}

function isClaudeConfigured(username: string): boolean {
  return fs.existsSync(getClaudeConfigPath(username));
}

function getClaudeConfig(username: string): ClaudeConfig {
  const configPath = getClaudeConfigPath(username);
  if (!fs.existsSync(configPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8")) as ClaudeConfig;
  } catch {
    return {};
  }
}

const PUBLIC_ENV_PATH = path.join(getDataRootDir(), "public_env.json");
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_PUBLIC_ENV_NAMES = new Set(["HOME", "TERM", "COLORTERM", "PWD", "OLDPWD"]);

class PublicEnvValidationError extends Error {}

function assertPublicEnvName(name: string, line?: number): void {
  if (!ENV_NAME_RE.test(name)) {
    throw new PublicEnvValidationError(`${line ? `Line ${line}: ` : ""}invalid environment variable name '${name}'`);
  }
  if (RESERVED_PUBLIC_ENV_NAMES.has(name)) {
    throw new PublicEnvValidationError(`${line ? `Line ${line}: ` : ""}${name} is managed by TermCloud`);
  }
}

function assertPublicEnvValue(value: string, name: string, line?: number): void {
  if (/[\0\r\n]/.test(value)) {
    throw new PublicEnvValidationError(`${line ? `Line ${line}: ` : ""}${name} value cannot contain newlines or null bytes`);
  }
}

function unquotePublicEnvValue(value: string, name: string, line: number): string {
  if (!value) return "";
  const first = value[0];
  const last = value[value.length - 1];
  if (first !== "\"" && first !== "'") return value;
  if (last !== first || value.length < 2) {
    throw new PublicEnvValidationError(`Line ${line}: ${name} has an unterminated quoted value`);
  }
  if (first === "'") return value.slice(1, -1);
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "string") {
      throw new Error("not a string");
    }
    return parsed;
  } catch {
    throw new PublicEnvValidationError(`Line ${line}: ${name} has an invalid quoted value`);
  }
}

function parsePublicEnvText(text: string): EnvVariable[] {
  const variables: EnvVariable[] = [];
  const seen = new Set<string>();

  text.split(/\r?\n/).forEach((rawLine, index) => {
    const lineNumber = index + 1;
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) return;

    const assignment = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
    const separator = assignment.indexOf("=");
    if (separator <= 0) {
      throw new PublicEnvValidationError(`Line ${lineNumber}: expected KEY=VALUE`);
    }

    const name = assignment.slice(0, separator).trim();
    const value = unquotePublicEnvValue(assignment.slice(separator + 1).trim(), name, lineNumber);
    assertPublicEnvName(name, lineNumber);
    assertPublicEnvValue(value, name, lineNumber);
    if (seen.has(name)) {
      throw new PublicEnvValidationError(`Line ${lineNumber}: duplicate variable '${name}'`);
    }
    seen.add(name);
    variables.push({ name, value });
  });

  return variables;
}

function formatPublicEnvValue(value: string): string {
  if (value === "" || /[\s"'#]/.test(value)) {
    return JSON.stringify(value);
  }
  return value;
}

function publicEnvToText(variables: EnvVariable[]): string {
  return variables.map((variable) => `${variable.name}=${formatPublicEnvValue(variable.value)}`).join("\n");
}

function normalizeStoredPublicEnvVariables(raw: unknown): EnvVariable[] {
  if (!raw || typeof raw !== "object") return [];
  const maybeVariables = (raw as Partial<PublicEnvConfig>).variables;
  if (!Array.isArray(maybeVariables)) return [];

  const variables: EnvVariable[] = [];
  const seen = new Set<string>();
  for (const entry of maybeVariables) {
    if (!entry || typeof entry !== "object") continue;
    const name = (entry as Partial<EnvVariable>).name;
    const value = (entry as Partial<EnvVariable>).value;
    if (typeof name !== "string" || typeof value !== "string") continue;
    if (!ENV_NAME_RE.test(name) || RESERVED_PUBLIC_ENV_NAMES.has(name) || seen.has(name)) continue;
    if (/[\0\r\n]/.test(value)) continue;
    seen.add(name);
    variables.push({ name, value });
  }
  return variables;
}

function getPublicEnvVariables(): EnvVariable[] {
  if (!fs.existsSync(PUBLIC_ENV_PATH)) return [];
  try {
    return normalizeStoredPublicEnvVariables(JSON.parse(fs.readFileSync(PUBLIC_ENV_PATH, "utf8")) as unknown);
  } catch {
    return [];
  }
}

function getPublicEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const variable of getPublicEnvVariables()) {
    env[variable.name] = variable.value;
  }
  return env;
}

function savePublicEnvVariables(variables: EnvVariable[]): void {
  fs.writeFileSync(PUBLIC_ENV_PATH, JSON.stringify({ variables }, null, 2));
}

function hasPublicClaudeDefaults(): boolean {
  const env = getPublicEnv();
  return Boolean(env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY);
}

function isEffectiveClaudeConfigured(username: string): boolean {
  return isClaudeConfigured(username) || hasPublicClaudeDefaults();
}

function applyClaudeConfigToEnv(env: NodeJS.ProcessEnv, cfg: ClaudeConfig): void {
  if (cfg.baseUrl) env.ANTHROPIC_BASE_URL = cfg.baseUrl;
  if (cfg.authToken) env.ANTHROPIC_AUTH_TOKEN = cfg.authToken;
  env.ANTHROPIC_API_KEY = "";
  if (cfg.model) env.ANTHROPIC_MODEL = cfg.model;
  if (cfg.haikuModel) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = cfg.haikuModel;
  if (cfg.effort) env.CLAUDE_CODE_EFFORT_LEVEL = cfg.effort;
}

function quoteForBash(value: string): string {
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

function createTerminalEnv(username: string): NodeJS.ProcessEnv {
  const userDir = getUserWorkDir(username);
  const fallbackLocale = process.env.TERMCLOUD_UTF8_LOCALE || getDefaultUtf8Locale();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...getPublicEnv(),
    TERM: "xterm-256color",
    COLORTERM: process.env.COLORTERM || "truecolor",
    HOME: userDir
  };

  if (isClaudeConfigured(username)) {
    applyClaudeConfigToEnv(env, getClaudeConfig(username));
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
app.use(express.static(path.join(__dirname, "..", "public"), {
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
function requireAuth(req: AuthenticatedRequest, res: express.Response, next: express.NextFunction): void {
  let token: string | null = null;

  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    token = authHeader.slice(7);
  } else if (req.query && req.query.token) {
    token = req.query.token as string;
  }

  if (!token) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { username: string };
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ error: "unauthorized" });
  }
}

function requireAdmin(req: AuthenticatedRequest, res: express.Response, next: express.NextFunction): void {
  const username = req.user?.username;
  if (!username || !isAdminUser(username)) {
    res.status(403).json({ error: "admin required" });
    return;
  }
  next();
}

// ── login rate limiter ──
const loginAttempts = new Map<string, LoginRateEntry>();
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW = 60000; // 1 minute

function checkLoginRate(req: express.Request, res: express.Response, next: express.NextFunction): void {
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
    if (entry.windowStart < cutoff) loginAttempts.delete(ip);
  }
}, 300000).unref();

// ── login endpoint ──
app.post("/api/login", express.json(), checkLoginRate, (req: express.Request, res: express.Response) => {
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

  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: "24h" });
  res.json({
    token,
    username,
    isAdmin: isAdminUser(username),
    claudeConfigured: isEffectiveClaudeConfigured(username)
  });
});

// ── Claude Code config endpoints ──
app.get("/api/claude-config", requireAuth, (req: AuthenticatedRequest, res: express.Response) => {
  const username = req.user!.username;
  const cfg = getClaudeConfig(username);
  res.json({
    username,
    isAdmin: isAdminUser(username),
    configured: isEffectiveClaudeConfigured(username),
    userConfigured: isClaudeConfigured(username),
    usingPublicDefaults: !isClaudeConfigured(username) && hasPublicClaudeDefaults(),
    baseUrl: cfg.baseUrl || "",
    authToken: cfg.authToken || "",
    model: cfg.model || "",
    haikuModel: cfg.haikuModel || "",
    effort: cfg.effort || ""
  });
});

app.post("/api/claude-config", requireAuth, express.json(), (req: AuthenticatedRequest, res: express.Response) => {
  const username = req.user!.username;
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
    const cfg: ClaudeConfig = {
      baseUrl: baseUrl.trim(),
      authToken: authToken.trim(),
      model: (model && model.trim()) || "",
      haikuModel: (haikuModel && haikuModel.trim()) || "",
      effort: (effort && effort.trim()) || "max"
    };
    fs.writeFileSync(getClaudeConfigPath(username), JSON.stringify(cfg, null, 2));

    const bashrcPath = path.join(userDir, ".bashrc");
    const envLines = [
      "",
      "# Claude Code configuration",
      `export ANTHROPIC_BASE_URL=${quoteForBash(cfg.baseUrl || "")}`,
      `export ANTHROPIC_AUTH_TOKEN=${quoteForBash(cfg.authToken || "")}`,
      'export ANTHROPIC_API_KEY=""',
      cfg.model ? `export ANTHROPIC_MODEL=${quoteForBash(cfg.model)}` : "",
      cfg.haikuModel ? `export ANTHROPIC_DEFAULT_HAIKU_MODEL=${quoteForBash(cfg.haikuModel)}` : "",
      `export CLAUDE_CODE_EFFORT_LEVEL=${quoteForBash(cfg.effort || "max")}`
    ].filter(Boolean).join("\n");

    let bashrc = "";
    if (fs.existsSync(bashrcPath)) {
      bashrc = fs.readFileSync(bashrcPath, "utf8");
      bashrc = bashrc.replace(/\n*# Claude Code configuration\n.*/s, "");
    }
    fs.writeFileSync(bashrcPath, bashrc + envLines + "\n");

    res.json({ ok: true });
  } catch (err: unknown) {
    res.status(500).json({ error: "Failed to save configuration: " + (err as Error).message });
  }
});

// ── public environment variable endpoints ──
app.get("/api/public-env", requireAuth, requireAdmin, (_req: AuthenticatedRequest, res: express.Response) => {
  const variables = getPublicEnvVariables();
  res.json({ variables, text: publicEnvToText(variables) });
});

app.post("/api/public-env", requireAuth, requireAdmin, express.json(), (req: AuthenticatedRequest, res: express.Response) => {
  const text = req.body?.text;
  if (typeof text !== "string") {
    res.status(400).json({ error: "text is required" });
    return;
  }

  try {
    const variables = parsePublicEnvText(text);
    savePublicEnvVariables(variables);
    res.json({ ok: true, variables, text: publicEnvToText(variables) });
  } catch (err: unknown) {
    const status = err instanceof PublicEnvValidationError ? 400 : 500;
    res.status(status).json({ error: (err as Error).message || "Failed to save public environment" });
  }
});

// ── protected API routes ──
app.get("/api/files", requireAuth, async (req: AuthenticatedRequest, res: express.Response) => {
  const username = req.user!.username;
  const userDir = getUserWorkDir(username);
  let dir = (req.query.dir as string) || userDir;
  dir = path.resolve(dir);

  if (!isPathWithinUserDir(dir, username)) {
    res.status(403).json({ error: "access denied: path outside work directory" });
    return;
  }

  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(dir);
  } catch {
    res.status(404).json({ error: "directory not found" });
    return;
  }

  if (!stat.isDirectory()) {
    res.status(400).json({ error: "not a directory" });
    return;
  }

  try {
    const dirents = await fs.promises.readdir(dir, { withFileTypes: true });
    const entries = await Promise.all(
      dirents
        .filter((d) => !d.name.startsWith("."))
        .map(async (d) => {
          const isFile = d.isFile();
          const isDirectory = d.isDirectory();
          let size: number | null = null;
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
    res.json({ dir, entries: entries.filter(Boolean), workDir: userDir });
  } catch {
    res.status(403).json({ error: "permission denied" });
  }
});

app.delete("/api/files", requireAuth, async (req: AuthenticatedRequest, res: express.Response) => {
  const username = req.user!.username;
  const filePath = req.query.path as string;

  if (!filePath) {
    res.status(400).json({ error: "missing path" });
    return;
  }

  const resolved = path.resolve(filePath);

  if (!isPathWithinUserDir(resolved, username)) {
    res.status(403).json({ error: "access denied: path outside work directory" });
    return;
  }

  try {
    await fs.promises.stat(resolved);
  } catch {
    res.status(404).json({ error: "file not found" });
    return;
  }

  try {
    await fs.promises.rm(resolved, { recursive: true });
    res.json({ ok: true });
  } catch (err: unknown) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get("/download", requireAuth, async (req: AuthenticatedRequest, res: express.Response) => {
  const username = req.user!.username;
  const filePath = req.query.path as string;

  if (!filePath) {
    res.status(400).send("missing path");
    return;
  }

  const resolved = path.resolve(filePath);

  if (!isPathWithinUserDir(resolved, username)) {
    res.status(403).send("access denied: path outside work directory");
    return;
  }

  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(resolved);
  } catch {
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
  maxSize: number;
  chunks: Buffer[];
  startIdx: number;
  totalSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
    this.chunks = [];
    this.startIdx = 0;
    this.totalSize = 0;
  }

  push(data: Buffer | string): void {
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
    this.chunks.push(chunk);
    this.totalSize += chunk.length;
    this._evict();
  }

  _evict(): void {
    while (this.totalSize > this.maxSize && this.chunks.length - this.startIdx > 1) {
      this.totalSize -= this.chunks[this.startIdx].length;
      this.startIdx++;
      if (this.startIdx > 1024) {
        this.chunks = this.chunks.slice(this.startIdx);
        this.startIdx = 0;
      }
    }
  }

  *iterChunks(): Generator<Buffer> {
    for (let i = this.startIdx; i < this.chunks.length; i++) {
      yield this.chunks[i];
    }
  }

  get length(): number { return this.chunks.length - this.startIdx; }
  get size(): number { return this.totalSize; }
}

// ── binary protocol helpers ──
const MSG_OUTPUT = 0x01;
const MSG_INPUT = 0x02;
const MSG_RESIZE = 0x03;
const MSG_CONNECTED = 0x04;
const MSG_BATCH_OUTPUT = 0x05;

function getPositiveIntEnv(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name]!, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const REPLAY_BUFFER_BYTES = getPositiveIntEnv("TERMCLOUD_REPLAY_BUFFER_BYTES", 1024 * 1024);
const REPLAY_FRAME_BYTES = getPositiveIntEnv("TERMCLOUD_REPLAY_FRAME_BYTES", 128 * 1024);
const WS_BACKPRESSURE_LIMIT_BYTES = getPositiveIntEnv("TERMCLOUD_WS_BACKPRESSURE_LIMIT_BYTES", 4 * 1024 * 1024);
const WS_COMPRESSION_THRESHOLD_BYTES = getPositiveIntEnv("TERMCLOUD_WS_COMPRESSION_THRESHOLD_BYTES", 1024);
const SESSION_IDLE_TIMEOUT_MS = getPositiveIntEnv("TERMCLOUD_SESSION_IDLE_TIMEOUT_MS", 10 * 60 * 1000);

function toPayloadBuffer(data: Buffer | string): Buffer {
  return Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
}

function encodeOutput(data: Buffer | string): Buffer {
  const payload = toPayloadBuffer(data);
  const frame = Buffer.alloc(1 + payload.length);
  frame[0] = MSG_OUTPUT;
  payload.copy(frame, 1);
  return frame;
}

function encodeBatchOutput(chunks: (Buffer | string)[]): Buffer {
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
const sessions = new Map<string, TerminalSession>();

function getOrCreateSession(username: string): TerminalSession {
  const existing = sessions.get(username);
  if (existing && !existing.exited) return existing;

  const userDir = getUserWorkDir(username);
  const shell = process.env.SHELL || "/bin/bash";
  const ptyProcess = pty.spawn(shell, [], {
    name: "xterm-256color",
    cols: 100,
    rows: 30,
    cwd: userDir,
    env: createTerminalEnv(username)
  });

  const session: TerminalSession = {
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

  ptyProcess.onData((data: string) => {
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

function clearPendingBatch(session: TerminalSession): void {
  session.batchPending = false;
  session.batchAccumulator = [];
}

function cancelSessionIdleCleanup(session: TerminalSession): void {
  if (!session.idleTimer) return;
  clearTimeout(session.idleTimer);
  session.idleTimer = null;
}

function scheduleSessionIdleCleanup(session: TerminalSession): void {
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

function detachClient(session: TerminalSession, ws: WebSocket): void {
  const removed = session.clients.delete(ws);
  if (!removed) return;

  if (session.clients.size === 0) {
    scheduleSessionIdleCleanup(session);
  }
}

function closeSlowClient(session: TerminalSession, ws: WebSocket): void {
  detachClient(session, ws);
  try {
    ws.close(4002, "client too slow");
  } catch {
    ws.terminate();
  }
}

function sendFrameToClient(session: TerminalSession, ws: WebSocket, frame: Buffer): boolean {
  if (ws.readyState !== WebSocket.OPEN) {
    detachClient(session, ws);
    return false;
  }

  if (ws.bufferedAmount + frame.length > WS_BACKPRESSURE_LIMIT_BYTES) {
    closeSlowClient(session, ws);
    return false;
  }

  ws.send(frame, (err?: Error) => {
    if (err) detachClient(session, ws);
  });
  return true;
}

function sendReplayBuffer(session: TerminalSession, ws: WebSocket): void {
  let batch: Buffer[] = [];
  let batchSize = 0;

  const flush = (): boolean => {
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
let batchFlushTimer: NodeJS.Timeout | null = null;

function startBatchFlush(): void {
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
      clearInterval(batchFlushTimer!);
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
    const url = new URL(info.req.url!, "http://localhost");
    const token = url.searchParams.get("token");
    if (!token) {
      return callback(false, 401, "Unauthorized");
    }
    let decoded: jwt.JwtPayload;
    try {
      decoded = jwt.verify(token, JWT_SECRET) as jwt.JwtPayload;
    } catch {
      return callback(false, 401, "Unauthorized");
    }
    (info.req as unknown as { user: jwt.JwtPayload }).user = decoded;
    return callback(true);
  }
});

wss.on("connection", (ws, req) => {
  const username = ((req as unknown as { user: { username: string } }).user).username;
  let session: TerminalSession;

  try {
    session = getOrCreateSession(username);
  } catch (err: unknown) {
    console.error("Failed to start terminal session:", err);
    if (ws.readyState === WebSocket.OPEN) {
      const message = `\r\nFailed to start terminal session: ${(err as Error).message || "unknown error"}\r\n`;
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

  ws.on("message", (message: WebSocket.Data) => {
    if (session.exited) return;

    const buf = Buffer.from(message as ArrayBuffer);
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
      } catch {
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
