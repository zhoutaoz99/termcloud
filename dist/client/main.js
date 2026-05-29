"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// ── auth helpers ──
function getToken() {
    return localStorage.getItem("token");
}
function setToken(token) {
    localStorage.setItem("token", token);
}
function clearToken() {
    localStorage.removeItem("token");
}
function showLogin() {
    const loginOverlay = document.getElementById("login-overlay");
    loginOverlay.style.display = "flex";
    document.getElementById("claude-config-overlay").style.display = "none";
    document.getElementById("app-container").style.display = "none";
}
function showClaudeConfig() {
    document.getElementById("login-overlay").style.display = "none";
    document.getElementById("claude-config-overlay").style.display = "flex";
    document.getElementById("app-container").style.display = "none";
    document.getElementById("cc-base-url").focus();
}
// ── Claude Config button (in sidebar footer) ──
document.getElementById("claude-config-btn").addEventListener("click", () => {
    document.getElementById("claude-config-overlay").style.display = "flex";
    document.getElementById("app-container").style.display = "none";
    document.getElementById("claude-config-error").textContent = "";
    fetchWithAuth("/api/claude-config")
        .then((r) => r.json())
        .then((data) => {
        if (data.baseUrl)
            document.getElementById("cc-base-url").value = data.baseUrl;
        if (data.authToken)
            document.getElementById("cc-auth-token").value = data.authToken;
        if (data.model)
            document.getElementById("cc-model").value = data.model;
        else
            document.getElementById("cc-model").value = "";
        if (data.haikuModel)
            document.getElementById("cc-haiku-model").value = data.haikuModel;
        else
            document.getElementById("cc-haiku-model").value = "";
        if (data.effort)
            document.getElementById("cc-effort").value = data.effort;
    })
        .catch(() => { });
    document.getElementById("cc-base-url").focus();
});
// ── Plugin install button ──
document.getElementById("plugin-install-btn").addEventListener("click", () => {
    document.getElementById("plugin-overlay").style.display = "flex";
});
function closePluginOverlay() {
    document.getElementById("plugin-overlay").style.display = "none";
}
document.querySelectorAll(".plugin-install-action").forEach((btn) => {
    btn.addEventListener("click", () => {
        const cmd = btn.getAttribute("data-cmd");
        if (!cmd || !socket || socket.readyState !== WebSocket.OPEN)
            return;
        const payload = textEncode(cmd + "\n");
        const frame = new Uint8Array(1 + payload.length);
        frame[0] = MSG_INPUT;
        frame.set(payload, 1);
        socket.send(frame.buffer);
        document.getElementById("plugin-overlay").style.display = "none";
    });
});
// ── connection status ──
function setConnectionStatus(text, state) {
    const status = document.getElementById("connection-status");
    const label = document.getElementById("connection-status-text");
    if (!status || !label)
        return;
    status.className = `connection-status is-${state}`;
    label.textContent = text;
}
// ── send input to terminal ──
function sendToTerminal(cmd) {
    if (!socket || socket.readyState !== WebSocket.OPEN)
        return;
    const payload = textEncode(cmd + "\n");
    const frame = new Uint8Array(1 + payload.length);
    frame[0] = MSG_INPUT;
    frame.set(payload, 1);
    socket.send(frame.buffer);
}
// ── show app ──
function showApp() {
    document.getElementById("login-overlay").style.display = "none";
    document.getElementById("claude-config-overlay").style.display = "none";
    document.getElementById("app-container").style.display = "flex";
    initTerminal();
    loadFiles("");
}
// ── login form handler ──
function handleLogin(event) {
    event.preventDefault();
    const username = document.getElementById("login-username").value;
    const password = document.getElementById("login-password").value;
    const errorEl = document.getElementById("login-error");
    errorEl.textContent = "";
    fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password })
    })
        .then((r) => r.json())
        .then((data) => {
        if (data.token) {
            setToken(data.token);
            if (!data.claudeConfigured) {
                showClaudeConfig();
            }
            else {
                showApp();
            }
        }
        else {
            errorEl.textContent = data.error || "登录失败";
        }
    })
        .catch(() => {
        errorEl.textContent = "网络错误";
    });
}
// ── Claude Code config form handler ──
function handleClaudeConfig(event) {
    event.preventDefault();
    const baseUrl = document.getElementById("cc-base-url").value.trim();
    const authToken = document.getElementById("cc-auth-token").value.trim();
    const model = document.getElementById("cc-model").value.trim();
    const haikuModel = document.getElementById("cc-haiku-model").value.trim();
    const effort = document.getElementById("cc-effort").value.trim();
    const errorEl = document.getElementById("claude-config-error");
    errorEl.textContent = "";
    fetchWithAuth("/api/claude-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseUrl, authToken, model, haikuModel, effort })
    })
        .then((r) => r.json())
        .then((data) => {
        if (data.ok) {
            pendingCmd = "source ~/.bashrc";
            showApp();
            if (socket && socket.readyState === WebSocket.OPEN) {
                setTimeout(() => { sendToTerminal(pendingCmd); pendingCmd = null; }, 500);
            }
        }
        else {
            errorEl.textContent = data.error || "保存失败";
        }
    })
        .catch(() => {
        errorEl.textContent = "网络错误";
    });
}
function skipClaudeConfig() {
    showApp();
}
function fetchWithAuth(url, options) {
    const token = getToken();
    const headers = {
        ...options?.headers,
        Authorization: "Bearer " + token
    };
    return fetch(url, { ...options, headers }).then((r) => {
        if (r.status === 401) {
            clearToken();
            showLogin();
            throw new Error("unauthorized");
        }
        return r;
    });
}
// ── terminal setup ──
const MSG_OUTPUT = 0x01;
const MSG_INPUT = 0x02;
const MSG_RESIZE = 0x03;
const MSG_CONNECTED = 0x04;
const MSG_BATCH_OUTPUT = 0x05;
let terminalInitialized = false;
let socket = null;
let pendingCmd = null;
const terminalFontFamily = '"TermMono", monospace';
const textDecode = "TextDecoder" in window
    ? (() => {
        const td = new TextDecoder();
        return (data) => td.decode(data);
    })()
    : (data) => {
        // Fallback for very old browsers
        let s = "";
        const view = new Uint8Array(data);
        for (let i = 0; i < view.length; i++) {
            s += String.fromCharCode(view[i]);
        }
        return s;
    };
function textEncode(s) {
    if ("TextEncoder" in window) {
        return new TextEncoder().encode(s);
    }
    // Fallback
    const view = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) {
        view[i] = s.charCodeAt(i);
    }
    return view;
}
// write batching: collect output and flush once per animation frame
let writeBuffer = [];
let writeFlushScheduled = false;
function flushWriteBuffer() {
    if (writeBuffer.length > 0) {
        terminal.write(writeBuffer.join(""));
        writeBuffer = [];
    }
    writeFlushScheduled = false;
}
function pushOutput(data) {
    writeBuffer.push(data);
    if (!writeFlushScheduled) {
        writeFlushScheduled = true;
        requestAnimationFrame(flushWriteBuffer);
    }
}
const terminal = new Terminal({
    allowProposedApi: true,
    cursorBlink: true,
    fontSize: 14,
    fontFamily: terminalFontFamily,
    letterSpacing: 0,
    lineHeight: 1.2,
    rescaleOverlappingGlyphs: true,
    scrollback: 5000,
    theme: { background: "#111111" }
});
const fitAddon = new FitAddon.FitAddon();
terminal.loadAddon(fitAddon);
if (typeof Unicode11Addon !== "undefined") {
    terminal.loadAddon(new Unicode11Addon.Unicode11Addon());
    terminal.unicode.activeVersion = "11";
}
function initTerminal() {
    if (terminalInitialized)
        return;
    terminalInitialized = true;
    terminal.open(document.getElementById("terminal"));
    fitAddon.fit();
    terminal.focus();
    refitTerminalAfterFontsLoad();
    connectWebSocket();
}
function connectWebSocket() {
    setConnectionStatus("连接中", "connecting");
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const token = getToken();
    socket = new WebSocket(`${protocol}//${location.host}/ws/terminal?token=${token}`);
    socket.binaryType = "arraybuffer";
    socket.onopen = () => {
        setConnectionStatus("已连接", "connected");
        const dims = fitAddon.proposeDimensions();
        if (dims) {
            sendResize(dims.cols, dims.rows);
        }
        if (pendingCmd) {
            setTimeout(() => { sendToTerminal(pendingCmd); pendingCmd = null; }, 500);
        }
    };
    socket.onmessage = (event) => {
        const view = new Uint8Array(event.data);
        if (view.length < 1)
            return;
        const msgType = view[0];
        const payload = textDecode(view.buffer.slice(view.byteOffset + 1, view.byteOffset + view.length));
        if (msgType === MSG_CONNECTED) {
            const resuming = view.length > 1 && view[1] === 0x01;
            if (!resuming) {
                terminal.writeln("Connected to Linux server\r\n");
            }
            return;
        }
        if (msgType === MSG_OUTPUT || msgType === MSG_BATCH_OUTPUT) {
            pushOutput(payload);
        }
    };
    socket.onclose = (event) => {
        if (event.code === 4004) {
            setConnectionStatus("连接错误", "error");
            terminal.writeln("\r\nTerminal unavailable. Check server logs.");
        }
        else if (event.code === 4001 || event.code === 4003) {
            setConnectionStatus("未连接", "idle");
            clearToken();
            showLogin();
        }
        else {
            setConnectionStatus("重连中", "connecting");
            terminal.writeln("\r\nConnection lost, reconnecting...");
            setTimeout(() => {
                if (getToken())
                    connectWebSocket();
            }, 2000);
        }
    };
    socket.onerror = () => {
        setConnectionStatus("连接错误", "error");
        terminal.writeln("\r\nConnection error");
    };
}
// Register once — not inside connectWebSocket, to avoid listener accumulation on reconnection
terminal.onData((data) => {
    if (socket && socket.readyState === WebSocket.OPEN) {
        const payload = textEncode(data);
        const frame = new Uint8Array(1 + payload.length);
        frame[0] = MSG_INPUT;
        frame.set(payload, 1);
        socket.send(frame.buffer);
    }
});
function sendResize(cols, rows) {
    if (!socket || socket.readyState !== WebSocket.OPEN)
        return;
    const frame = new Uint8Array([MSG_RESIZE, cols & 0xFF, cols >> 8, rows & 0xFF, rows >> 8]);
    socket.send(frame.buffer);
}
function fitTerminal() {
    fitAddon.fit();
    const dims = fitAddon.proposeDimensions();
    if (dims) {
        sendResize(dims.cols, dims.rows);
    }
}
function refitTerminalAfterFontsLoad() {
    if (!document.fonts || !document.fonts.load)
        return;
    // Force-activate both unicode-range @font-face blocks for "TermMono"
    // before xterm.js measures the cell width, so the CJK @font-face
    // takes effect from the first render.
    const probes = [
        document.fonts.load('14px "TermMono"', "Aa"),
        document.fonts.load('14px "TermMono"', "中，。：（）")
    ];
    Promise.allSettled(probes).then(() => {
        fitTerminal();
        terminal.refresh(0, terminal.rows - 1);
    });
}
window.addEventListener("resize", fitTerminal);
// ── file browser ──
let currentDir = "";
let loadFilesAbort = null;
function loadFiles(dir) {
    if (loadFilesAbort)
        loadFilesAbort.abort();
    loadFilesAbort = new AbortController();
    const { signal } = loadFilesAbort;
    const listEl = document.getElementById("file-list");
    listEl.innerHTML = '<div class="file-list-loading">加载中...</div>';
    fetchWithAuth(`/api/files?dir=${encodeURIComponent(dir)}`, { signal })
        .then((r) => r.json())
        .then((data) => {
        currentDir = data.dir;
        document.getElementById("current-path").textContent = data.dir;
        const fragment = document.createDocumentFragment();
        if (data.dir !== data.workDir) {
            fragment.appendChild(createFileItemParent(pathDir(data.dir)));
        }
        const sorted = data.entries.sort((a, b) => {
            if (a.isDirectory !== b.isDirectory)
                return a.isDirectory ? -1 : 1;
            return a.name.localeCompare(b.name);
        });
        for (const entry of sorted) {
            const fullPath = `${data.dir}/${entry.name}`.replace(/\/+/g, "/");
            fragment.appendChild(createFileItem(entry, fullPath, data.dir));
        }
        listEl.replaceChildren(fragment.hasChildNodes() ? fragment : createEmptyMessage("空目录"));
    })
        .catch((err) => {
        if (err.name === "AbortError")
            return;
        listEl.replaceChildren(createEmptyMessage("加载失败"));
    });
}
function createEmptyMessage(text) {
    const div = document.createElement("div");
    div.className = "file-list-loading";
    div.textContent = text;
    return div;
}
function createFileItemParent(parentDir) {
    const item = document.createElement("div");
    item.className = "file-item is-parent";
    item.innerHTML = '<span class="icon">↰</span><span class="name">..</span>';
    item.addEventListener("click", () => navigateTo(parentDir));
    return item;
}
function createFileItem(entry, fullPath, _parentDir) {
    const item = document.createElement("div");
    item.className = `file-item ${entry.isDirectory ? "is-dir" : "is-file"}`;
    const icon = document.createElement("span");
    icon.className = "icon";
    icon.textContent = entry.isDirectory ? "▸" : "•";
    item.appendChild(icon);
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = entry.name;
    item.appendChild(name);
    if (entry.isDirectory) {
        item.addEventListener("click", () => navigateTo(fullPath));
    }
    else {
        item.addEventListener("click", () => navigateTo(pathDir(fullPath)));
        const meta = document.createElement("span");
        meta.className = "file-meta";
        meta.textContent = formatBytes(entry.size);
        item.appendChild(meta);
        const deleteBtn = document.createElement("button");
        deleteBtn.className = "delete-btn";
        deleteBtn.title = "删除";
        deleteBtn.textContent = "✕";
        deleteBtn.addEventListener("click", (e) => { e.stopPropagation(); deleteItem(fullPath); });
        item.appendChild(deleteBtn);
        const downloadBtn = document.createElement("button");
        downloadBtn.className = "download-btn";
        downloadBtn.title = "下载";
        downloadBtn.textContent = "⬇";
        downloadBtn.addEventListener("click", (e) => { e.stopPropagation(); downloadItem(fullPath); });
        item.appendChild(downloadBtn);
    }
    return item;
}
function formatBytes(bytes) {
    if (bytes == null || !Number.isFinite(bytes) || bytes < 0)
        return "";
    if (bytes < 1024)
        return `${bytes} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let value = bytes / 1024;
    let unit = units[0];
    for (let i = 1; i < units.length && value >= 1024; i++) {
        value /= 1024;
        unit = units[i];
    }
    return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}
function navigateTo(dir) {
    loadFiles(dir);
}
function refreshFiles() {
    loadFiles(currentDir);
}
document.getElementById("refresh-btn").addEventListener("click", refreshFiles);
function downloadItem(fullPath) {
    const a = document.createElement("a");
    a.href = `/download?path=${encodeURIComponent(fullPath)}&token=${encodeURIComponent(getToken())}`;
    a.download = fullPath.split("/").pop();
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}
function deleteItem(fullPath) {
    const name = fullPath.split("/").pop();
    if (!confirm(`确定删除 ${name} 吗？`))
        return;
    fetchWithAuth(`/api/files?path=${encodeURIComponent(fullPath)}`, { method: "DELETE" })
        .then((r) => {
        if (!r.ok)
            return r.json().then((e) => { throw new Error(e.error); });
        loadFiles(currentDir);
    })
        .catch((err) => {
        alert("删除失败: " + err.message);
    });
}
function pathDir(fullPath) {
    const idx = fullPath.lastIndexOf("/");
    return idx > 0 ? fullPath.substring(0, idx) : "/";
}
// ── form event bindings ──
document.getElementById("login-form").addEventListener("submit", handleLogin);
document.getElementById("claude-config-form").addEventListener("submit", handleClaudeConfig);
document.querySelector(".poe-skip-btn").addEventListener("click", skipClaudeConfig);
document.querySelector(".plugin-close-btn").addEventListener("click", closePluginOverlay);
// ── startup: check existing token ──
(() => {
    const token = getToken();
    if (token) {
        fetchWithAuth("/api/claude-config")
            .then((r) => r.json())
            .then((data) => {
            if (data.configured) {
                showApp();
            }
            else {
                showClaudeConfig();
            }
        })
            .catch(() => showLogin());
    }
    else {
        showLogin();
    }
})();
