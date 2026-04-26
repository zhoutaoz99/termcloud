const express = require("express");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const WebSocket = require("ws");
const pty = require("node-pty");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/ws/terminal" });

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/files", (req, res) => {
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

app.get("/download", (req, res) => {
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

wss.on("connection", (ws) => {
  const shell = process.env.SHELL || "/bin/bash";

  const ptyProcess = pty.spawn(shell, [], {
    name: "xterm-256color",
    cols: 100,
    rows: 30,
    cwd: process.env.HOME || os.homedir(),
    env: process.env
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
