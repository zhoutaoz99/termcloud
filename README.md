# Web Linux Console

一个基于 Web 的 Linux 终端控制台：在 Linux 服务器本机启动 Node.js 服务，通过浏览器访问终端并执行本机命令，同时提供文件管理功能。

## 功能

### 终端

- 浏览器终端通过 xterm.js 连接本机 PTY，支持 TUI 程序（vim / top / htop / less / tmux）
- 终端输出批量回放：重连时自动回放缓冲区内容（上限 1MB），无需重新执行命令
- 断线自动重连（2 秒间隔）
- 窗口自适应缩放，自动同步终端尺寸到 PTY
- Unicode 11 宽度处理，CJK 等宽字体回退链，确保 Markdown 表格在等宽终端中对齐
- 终端字体禁用连字（ligatures），支持字形重叠矫正
- 客户端输出批量写入（requestAnimationFrame 合并），减少渲染开销

### 文件管理

- 侧边栏文件浏览器：列出目录、导航子目录、返回上级
- 文件/目录排序：目录在前，按名称字母排序
- 点号开头的隐藏文件自动过滤
- 文件下载：直接 URL 导航（`GET /download`），浏览器原生流式写入磁盘，不占用内存
- 文件/目录删除：带确认弹窗
- 快速点击目录时自动取消前一个未完成的请求（AbortController），避免并发冲突

### 多用户与隔离

- 支持配置多个用户，每个用户拥有独立的 shell 环境（独立 PTY 进程、HOME 目录、`.bashrc`、环境变量）
- `admin` 用户可在 Web UI 中维护公共环境变量，所有用户的新终端会默认继承公共变量
- 每个用户的 Claude Code 配置独立存储，互不影响
- 用户文件空间隔离：路径遍历保护（`isPathWithinUserDir`），API 拒绝访问其他用户的工作目录

### 认证与安全

- JWT 登录认证（token 24 小时过期）
- 登录接口 IP 速率限制：每 IP 每分钟最多 5 次尝试，防止暴力破解和 DoS
- 所有 API 和 WebSocket 连接均需携带 token

### 性能优化

- 二进制 WebSocket 协议（6 种消息类型），比文本 JSON 协议更紧凑
- 服务端输出批量发送（16ms / 60Hz 定时器），减少 WebSocket 帧数
- WebSocket perMessageDeflate 压缩（level 1，64 字节阈值）
- HTTP gzip 压缩（compression 中间件）
- 静态资源缓存（vendor 文件 7 天，字体文件 1 年，ETag）
- `fs.promises.readdir({ withFileTypes: true })` 替代逐条 `stat()`，目录列表系统调用从 N+1 降为 1
- 侧边栏不可见时不调度自动刷新定时器
- vendor JS 脚本使用 `defer` 加载，不阻塞登录表单首次渲染
- 批量刷新定时器按需启停：无活跃会话时停止 60Hz 空轮询

## 技术架构

```text
Browser -> xterm.js -> WebSocket (binary) -> Node.js -> node-pty -> /bin/bash
Browser -> HTTP (JWT) -> Node.js -> 文件系统 API
```

## 快速开始

```bash
npm install
npm start
```

### macOS 本地开发

如果本地运行时报 `Failed to start terminal session: posix_spawnp failed`，通常是 `node-pty` 原生模块的安装产物不可用。先确保已安装 Xcode Command Line Tools：

```bash
xcode-select --install
```

然后从源码重编 `node-pty`：

```bash
npm rebuild node-pty --build-from-source
```

如果是全新安装，也可以直接强制源码安装依赖：

```bash
npm_config_build_from_source=true npm ci
```

默认监听 `0.0.0.0:3000`，访问：

```text
http://<server-ip>:3000
```

登录凭据配置在 `config.json` 中，支持多用户：

```json
{
  "users": [
    { "username": "alice", "password": "pass1" },
    { "username": "bob", "password": "pass2" }
  ]
}
```

用户名为 `admin` 的账号会获得管理员入口，可配置公共环境变量。公共变量保存到数据目录的 `public_env.json`，格式按 `KEY=VALUE` 逐行输入；用户自己的 Claude Code 配置会覆盖同名公共默认值。

### 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 服务监听端口 | `3000` |
| `TERMCLOUD_UTF8_LOCALE` | PTY 的 UTF-8 locale | `en_US.UTF-8` (macOS) / `C.UTF-8` (Linux) |
| `TERMCLOUD_REPLAY_BUFFER_BYTES` | 终端重连回放缓冲区上限 | `1048576` |
| `TERMCLOUD_REPLAY_FRAME_BYTES` | 重连回放单帧目标大小 | `131072` |
| `TERMCLOUD_WS_BACKPRESSURE_LIMIT_BYTES` | 单客户端 WebSocket 待发送缓冲上限 | `4194304` |
| `TERMCLOUD_WS_COMPRESSION_THRESHOLD_BYTES` | WebSocket 压缩阈值 | `1024` |
| `TERMCLOUD_SESSION_IDLE_TIMEOUT_MS` | 无客户端 PTY 空闲回收时间 | `600000` |

### Docker 部署

使用 Docker Compose 一键部署：

```bash
# 使用默认凭据（admin/admin）
docker-compose up -d

# 配置用户（格式：user1:pass1,user2:pass2）
USERS=alice:pass1,bob:pass2 docker-compose up -d
```

访问 `http://<server-ip>:3000` 即可使用。

**环境变量：**

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `USERS` | 用户配置，格式 `user1:pass1,user2:pass2` | `admin:admin` |
| `PORT` | 宿主机映射端口 | `3000` |
| `TERMCLOUD_REPLAY_BUFFER_BYTES` | 终端重连回放缓冲区上限 | `262144` |
| `TERMCLOUD_REPLAY_FRAME_BYTES` | 重连回放单帧目标大小 | `65536` |
| `TERMCLOUD_WS_BACKPRESSURE_LIMIT_BYTES` | 单客户端 WebSocket 待发送缓冲上限 | `1048576` |
| `TERMCLOUD_WS_COMPRESSION_THRESHOLD_BYTES` | WebSocket 压缩阈值 | `2048` |
| `TERMCLOUD_SESSION_IDLE_TIMEOUT_MS` | 无客户端 PTY 空闲回收时间 | `180000` |

**数据持久化：** 用户文件存储在 Docker volume `termcloud-data` 中，删除容器不会丢失数据。

**常用命令：**

```bash
# 查看日志
docker-compose logs -f

# 停止服务
docker-compose down

# 停止并删除数据
docker-compose down -v

# 重新构建（代码更新后）
docker-compose up -d --build
```

### 开发模式

```bash
npm run dev
```

使用 concurrently 同时启动 nodemon（服务端热重载）和 browser-sync（前端文件变更自动刷新）。

## 项目结构

```text
.
├── config.json              # 多用户凭据配置（已 gitignore）
├── .jwt_secret              # JWT 签名密钥（自动生成，已 gitignore）
├── package.json
├── server.js                # 后端：Express + WebSocket + node-pty
├── docker-compose.yml       # Docker Compose 编排
├── Dockerfile               # Docker 镜像构建
├── docker-entrypoint.sh     # 容器入口脚本（从环境变量生成多用户 config.json）
├── scripts/
│   └── validate.mjs         # CI 校验脚本
└── public/
    ├── index.html           # 前端：xterm.js 终端 + 文件管理器
    ├── style.css            # 样式：暗色主题 + 等宽字体配置
    └── vendor/              # 本地 vendor 文件（无 CDN 依赖）
        ├── xterm.js
        ├── xterm.css
        ├── addon-fit.js
        └── addon-unicode11.js
```

## 本地校验

```bash
npm test
```

CI 会在每次 push / pull request 自动执行同样的校验流程（见 `.github/workflows/ci.yml`）。

该命令不依赖第三方包安装完成，主要检查：

- `server.js` 语法可通过 `node --check`
- 前端页面包含终端 WebSocket 路径、下载入口、Unicode 宽度处理、binary 协议
- 后端包含 `/download` 路由、WebSocket 服务、RingBuffer、批量刷新、UTF-8 locale 处理
- 所有 vendor 文件存在

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

## 常见问题

### `posix_spawnp failed`（node-pty 启动报错）

**现象**：浏览器打开终端时服务端报错 `Error: posix_spawnp failed`。

**原因**：`node-pty` 的预编译二进制文件与当前 Node.js 版本不兼容（常见于升级 Node 后或使用较新版本如 v25+）。

**解决**：从源码重新编译 node-pty：

```bash
cd node_modules/node-pty && npx node-gyp rebuild && cd ../..
```

### `EADDRINUSE: address already in use`

**现象**：启动时报错 `Error: listen EADDRINUSE: address already in use 0.0.0.0:3000`。

**原因**：端口 3000 被之前的进程占用。

**解决**：

```bash
lsof -ti:3000 | xargs kill -9
```

## 注意

本项目支持多用户场景，每个用户拥有独立的 shell 环境和文件空间。访问控制通过 JWT 认证和 IP 速率限制实现。不建议直接暴露公网长期使用，如需公网部署建议配合 Nginx 反向代理和 HTTPS。
