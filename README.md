# woa-acp

WPS Office AI (Agentspace) + ACP 适配器 — 将 WPS 数字员工平台接入 Cursor CLI、Claude Code、Codex 等 ACP Agent。

> **致谢：** 本项目的网关协议和认证流程参考了 [OpenClaw](https://github.com/openclaw/openclaw) 的 Agentspace 通道插件。
>
> **姊妹项目：** 如需将 AI Agent 接入微信，请查看 [wechat-acp](https://github.com/user/wechat-acp)。两个项目架构相同，共享相同的 ACP 适配层设计和 MCP Feedback 追问机制。

## 架构

```
WPS 数字员工平台 (agentspace.wps.cn)
        ↕ WebSocket
    woa-acp 适配器
        ↕ ACP (Agent Client Protocol)
  Cursor CLI / Claude Code / Codex
```

## 快速开始

### 从 tgz 安装（同事分发）

```bash
npm install -g woa-acp-0.2.0.tgz
```

### 1. 登录 WPS 账号

```bash
# 自建数字员工（必须传入你的 app_id）
woa-acp login --app-id AK20260313XXXXXX

# 默认官方数字员工
woa-acp login
```

> **重要：** `app_id` 是你在 [WPS 数字员工开发平台](https://agentspace.wps.cn) 创建的数字员工标识。每个人的 app_id 不同，请从平台获取自己的。

### 2. 启动

```bash
# Cursor CLI (ACP 模式)
woa-acp start -- agent acp

# Claude Code
woa-acp claude-code

# Codex
woa-acp codex

# 自定义 Agent
woa-acp start -- node ./my-agent.js
```

### 可选参数

| 参数 | 说明 |
|------|------|
| `--app-id <id>` | 数字员工 app_id |
| `--model <model>` | 指定模型（如 `claude-3.5-sonnet`） |

## 追问模式 (Feedback)

一次请求内多轮对话，无需额外计费：

```
用户: "帮我写一个排序算法"
  → AI 回复 + "💬 追问模式已开启，10 分钟内回复可继续当前对话"
用户: "用快速排序实现"
  → AI 在同一轮继续回复...
```

### 超时防护（双重保险）

| 层级 | 机制 | 说明 |
|------|------|------|
| 1 | `mcp-timeout-hook.cjs` | 预加载脚本 patch MCP SDK 的 60s 默认超时为 10 分钟 |
| 2 | `__WAITING__` 轮询 | 若 Hook 未生效，MCP server 返回 `__WAITING__`，agent 自动重试 |

启动时通过 `node --require mcp-timeout-hook.cjs wps-feedback-server.cjs` 加载 Hook。

## 消息发送

当前通过 WebSocket 发送**纯文本**消息（支持 Markdown 格式）。Agentspace 前端会自动渲染 URL 链接和 Markdown。

> **注意：** 图片/文件的原生发送需要 WPS REST API + `storage_key`（应用级别的 SecretKey 授权），目前未实现。如需在 Agentspace 中展示图片，可在文本中直接包含公开可访问的图片 URL。

## 配合截图 MCP 使用（可选）

在 `~/.cursor/mcp.json` 中添加截图 MCP，Agent 就能截取屏幕或窗口：

```json
{
  "mcpServers": {
    "screenshot-server": {
      "command": "npx",
      "args": ["-y", "universal-screenshot-mcp"],
      "autoApprove": ["take_screenshot", "take_system_screenshot"]
    }
  }
}
```

推荐使用 [universal-screenshot-mcp](https://github.com/sethbang/mcp-screenshot-server)（跨平台，支持窗口/全屏/区域截图，Windows 高 DPI 兼容）。

Agent 可通过 `take_system_screenshot` 截图：
- `mode: "window"` + `windowName` — 截取指定窗口
- `mode: "fullscreen"` — 截取所有显示器（可通过 `display: 1` 指定单个）
- `mode: "region"` — 截取指定坐标区域

## MCP 管理

启动时自动：

- 在全局 `~/.cursor/mcp.json` 中注册 `wps-feedback` MCP（含 timeout hook、autoApprove）
- 在项目 `.cursor/mcp.json` 中禁用冲突的 `relay-mcp`、`weixin-feedback`、`wechat-feedback`
- 全局配置中的其他 MCP（如截图 MCP）自动传入 ACP 会话

## 凭证存储

凭证位于 `~/.openclaw/openclaw.json`，与 OpenClaw 官方插件格式兼容。`wps_sid` 使用 AES-256-GCM 加密，密钥从 `app_id` 派生。

## 开发

```bash
npm install
npm run typecheck
npm run build

# 本地开发（使用 pnpm）
pnpm run login -- --app-id YOUR_APP_ID
pnpm start
```

### 打包分发

```bash
npm run build
npm pack
# 生成 woa-acp-0.2.0.tgz
```

## 协议

MIT
