#!/usr/bin/env node

/**
 * WPS Agentspace + ACP (Agent Client Protocol) adapter.
 *
 * Usage:
 *   npx woa-acp login                              # OAuth login to WPS
 *   npx woa-acp claude-code                         # Start with Claude Code
 *   npx woa-acp codex                               # Start with Codex
 *   npx woa-acp start -- <command> [args...]        # Start with custom agent
 */

import { AcpAgent } from "./src/acp-agent.js";
import { FeedbackIpcServer } from "./src/feedback-ipc.js";
import { WpsGateway, type WpsInboundMessage, type OutboundContext } from "./src/gateway.js";
import { loadAccount, saveAccount, resolveWsUrl } from "./src/config.js";
import { loginCloudOAuth } from "./src/auth.js";

const BUILTIN_AGENTS: Record<string, { command: string }> = {
  "claude-code": { command: "claude-agent-acp" },
  codex: { command: "codex-acp" },
};

const command = process.argv[2];

function extractFlag(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && idx + 1 < process.argv.length) {
    return process.argv[idx + 1];
  }
  return undefined;
}

const modelId = extractFlag("--model");
const appId = extractFlag("--app-id");

function log(msg: string) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[woa-acp ${ts}] ${msg}`);
}

async function doLogin(): Promise<void> {
  const result = await loginCloudOAuth(appId);
  const account = {
    wpsSid: result.wpsSid,
    appId,
    deviceUuid: crypto.randomUUID(),
    deviceName: `${result.currentUser ?? "User"}的ACP助理`,
    currentUser: result.currentUser,
  };
  saveAccount(account);
  console.log("\n✅ 凭证已保存到 ~/.openclaw/openclaw.json");
}

async function startAgent(acpCommand: string, acpArgs: string[] = []) {
  let userAborted = false;
  process.on("SIGINT", () => { userAborted = true; });
  process.on("SIGTERM", () => { userAborted = true; });

  const account = loadAccount();
  if (!account) {
    console.error("❌ 未找到 WPS 账号凭证，请先运行: npx woa-acp login");
    process.exit(1);
  }

  log(`用户: ${account.currentUser ?? "unknown"}, appId: ${account.appId ?? "(默认)"}`);

  const feedbackIpc = new FeedbackIpcServer();
  const feedbackPort = await feedbackIpc.start();
  log(`feedback IPC on port ${feedbackPort}`);

  const agent = new AcpAgent({
    command: acpCommand,
    args: acpArgs,
    excludeMcpServers: ["relay-mcp"],
    feedbackBridge: feedbackIpc,
    env: { WPS_FEEDBACK_PORT: String(feedbackPort) },
    model: modelId,
  });

  const wsUrl = resolveWsUrl(account.appId);
  log(`WebSocket: ${wsUrl}`);

  const contextMap = new Map<string, OutboundContext>();
  const processingChats = new Set<string>();

  const gateway = new WpsGateway({
    wsUrl,
    wpsSid: account.wpsSid,
    deviceUuid: account.deviceUuid,
    deviceName: account.deviceName,
    onMessage: async (message: WpsInboundMessage) => {
      if (userAborted) return;

      const content = message.content?.trim();
      if (!content) return;

      const chatId = message.session_id || message.chat_id || "default";

      if (processingChats.has(chatId)) {
        // Already processing a message for this chat — deliver as feedback reply
        if (feedbackIpc.deliverReply(chatId, content)) {
          log(`delivered reply from chatId=${chatId}`);
        } else {
          log(`queued message from chatId=${chatId} (agent busy)`);
        }
        return;
      }

      const context: OutboundContext = {
        chatId,
        sessionId: message.session_id,
        messageId: message.message_id,
      };
      contextMap.set(chatId, context);

      log(`processing message from chatId=${chatId}: "${content.slice(0, 50)}"`);

      feedbackIpc.setSendCallback(async (_userId: string, text: string) => {
        const ctx = contextMap.get(chatId) ?? context;
        await gateway.sendMessage(ctx, text);
      });

      processingChats.add(chatId);
      try {
        const response = await agent.chat({
          conversationId: chatId,
          text: content,
        });

        if (feedbackIpc.wasFeedbackUsed(chatId)) {
          feedbackIpc.resetFeedbackUsed(chatId);
          const hasContent = !!(response.text?.trim() || response.media);
          if (!hasContent) {
            log(`feedback was used for chatId=${chatId}, skipping empty final response`);
            return;
          }
          log(`feedback was used for chatId=${chatId}, but agent returned additional content — sending`);
        }

        if (response.text) {
          await gateway.sendMessage(context, response.text);
          log(`sent response to chatId=${chatId}: "${response.text.slice(0, 50)}"`);
        }
      } catch (err) {
        log(`error processing message: ${err}`);
      } finally {
        processingChats.delete(chatId);
      }
    },
    onError: (code) => {
      log(`gateway fatal error: ${code}`);
      userAborted = true;
    },
  });

  const onExit = () => {
    log("正在停止...");
    userAborted = true;
    agent.dispose();
    gateway.dispose();
    feedbackIpc.close();
  };
  process.on("SIGINT", onExit);
  process.on("SIGTERM", onExit);

  log("gateway starting...");
  await gateway.start();

  onExit();
}

async function main() {
  if (command === "login") {
    await doLogin();
    return;
  }

  if (command === "start") {
    const ddIndex = process.argv.indexOf("--");
    if (ddIndex === -1 || ddIndex + 1 >= process.argv.length) {
      console.error("错误: 请在 -- 后指定 ACP agent 启动命令");
      console.error("示例: npx woa-acp start -- codex-acp");
      process.exit(1);
    }
    const [acpCommand, ...acpArgs] = process.argv.slice(ddIndex + 1);
    await startAgent(acpCommand, acpArgs);
    return;
  }

  if (command && command in BUILTIN_AGENTS) {
    const { command: acpCommand } = BUILTIN_AGENTS[command];
    await startAgent(acpCommand);
    return;
  }

  console.log(`woa-acp — WPS 数字员工 + ACP 适配器

用法:
  npx woa-acp login                            OAuth 登录 WPS 账号
  npx woa-acp claude-code                       使用 Claude Code
  npx woa-acp codex                             使用 Codex
  npx woa-acp start -- <command> [args...]      使用自定义 agent

选项:
  --app-id <id>                                 数字员工 app_id
  --model <model>                               指定模型 (如 claude-3.5-sonnet)

示例:
  npx woa-acp login --app-id myapp123
  npx woa-acp start -- node ./my-agent.js`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
