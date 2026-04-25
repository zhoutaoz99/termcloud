# Web Linux Console (Minimal)

一个最小化的 Web 控制台：在 Linux 服务器本机启动 Node.js 服务，通过浏览器访问终端并执行本机命令。

## 功能

- 浏览器终端输入命令并在本机执行
- 支持 TUI 程序（vim/top/htop/less/tmux）
- 支持通过 `/download?path=...` 下载服务器文件

## 技术架构

```text
Browser -> xterm.js -> WebSocket -> Node.js -> node-pty -> /bin/bash
Browser -> HTTP GET /download -> Node.js -> 本机文件
```

## 快速开始

```bash
npm install
npm start
```

默认监听 `0.0.0.0:3000`，访问：

```text
http://<server-ip>:3000
```

## 项目结构

```text
.
├── package.json
├── server.js
└── public/
    └── index.html
```

## 本地校验

```bash
npm test
```

CI 会在每次 push / pull request 自动执行同样的校验流程（见 `.github/workflows/ci.yml`）。

该命令不依赖第三方包安装完成，主要检查：

- `server.js` 语法可通过 `node --check`
- 前端页面包含终端 WebSocket 路径与下载入口
- 后端包含 `/download` 路由与 WebSocket 服务初始化

## Nginx 反向代理（示例）

```nginx
server {
    listen 80;
    server_name console.example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
    }

    location /ws/terminal {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

## systemd（示例）

```ini
[Unit]
Description=Web Linux Console
After=network.target

[Service]
WorkingDirectory=/opt/web-linux-console
ExecStart=/usr/bin/node /opt/web-linux-console/server.js
Restart=always
RestartSec=3
Environment=PORT=3000

[Install]
WantedBy=multi-user.target
```

## 注意

本项目是最小原型，不包含认证、权限控制、审计、多租户隔离、访问白名单等安全能力，不建议直接暴露公网长期使用。
