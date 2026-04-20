import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Agent, ChatRequest, ChatResponse, FeedbackBridge } from "./agent-interface.js";
import type { McpServer, SessionId } from "@agentclientprotocol/sdk";

import { fileURLToPath } from "node:url";

import type { AcpAgentOptions } from "./types.js";
import { AcpConnection } from "./acp-connection.js";
import { convertRequestToContentBlocks } from "./content-converter.js";
import { ResponseCollector } from "./response-collector.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function log(msg: string) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[acp ${ts}] ${msg}`);
}

const FEEDBACK_SYSTEM_INSTRUCTION = `[SYSTEM] You are communicating with a user through WPS Agentspace (数字员工平台), not an IDE.
After completing your response, you MUST call the "interactive_feedback" tool (from wps-feedback MCP server).
Pass your ENTIRE response text as the "summary" parameter — do NOT summarize or truncate.
This tool sends your response to the WPS user and waits for their reply.

HANDLING THE RESULT:
- If the result contains a user message, continue the conversation with that message.
- If the result is "__WAITING__", call interactive_feedback AGAIN immediately with the SAME summary to continue waiting.
- If the result is empty string "", the user chose not to reply — end the task normally.
- The tool may take several minutes to return while waiting for the user. This is normal — do NOT treat slow return as an error.

SENDING IMAGES/MEDIA:
Agentspace renders Markdown and URLs. To include an image or file in your response:
  - Markdown image: ![description](https://example.com/image.png)
  - Direct URL on its own line: https://example.com/file.pdf
  - Local file marker: [WOA_IMAGE:/absolute/path/to/image.png]
  - Local file marker: [WOA_FILE:/absolute/path/to/file.pdf]
If you use the screenshot MCP to capture a screenshot, include the saved file path using the [WOA_IMAGE:path] marker.
You can use take_system_screenshot with mode "window" + windowName to capture a specific window, or mode "fullscreen" for the entire screen.
Example: After calling take_system_screenshot, include [WOA_IMAGE:path/to/saved/screenshot.png] in your summary.

CRITICAL RULES:
- Do NOT call relay_interactive_feedback — it does not exist here. Use interactive_feedback only.
- Keep responses concise. Markdown is supported.`;

type RawMcpEntry = {
  command?: string;
  args?: string[];
  disabled?: boolean;
  env?: Record<string, string>;
};

/**
 * Write project .cursor/mcp.json to disable conflicting MCP servers.
 * wps-feedback is NOT disabled here — it lives in global config with
 * timeout:600 and we want Cursor CLI to discover it directly.
 */
function disableMcpServers(cwd: string, names: string[]): void {
  if (names.length === 0) return;

  const cursorDir = path.join(cwd, ".cursor");
  const configPath = path.join(cursorDir, "mcp.json");

  let existing: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
    existing = raw?.mcpServers ?? {};
  } catch {
    // start fresh
  }

  let changed = false;
  for (const name of names) {
    const cur = existing[name] as Record<string, unknown> | undefined;
    if (!cur || cur.disabled !== true) {
      existing[name] = {
        ...(cur ?? { command: "echo", args: ["disabled"] }),
        disabled: true,
      };
      changed = true;
    }
  }

  if (changed) {
    fs.mkdirSync(cursorDir, { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({ mcpServers: existing }, null, 2) + "\n",
    );
    log(`wrote .cursor/mcp.json — disabled: ${names.join(", ")}`);
  }
}

/**
 * Ensure an MCP server entry exists in the global ~/.cursor/mcp.json.
 * If the entry already exists but has a different command/args, it is updated.
 */
function ensureGlobalMcpEntry(name: string, entry: Record<string, unknown>): void {
  const globalConfigPath = path.join(os.homedir(), ".cursor", "mcp.json");
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(fs.readFileSync(globalConfigPath, "utf8"));
  } catch {
    // start fresh
  }
  const servers = (raw.mcpServers ?? {}) as Record<string, unknown>;
  const existing = servers[name] as Record<string, unknown> | undefined;

  const needsUpdate =
    !existing ||
    existing.command !== entry.command ||
    JSON.stringify(existing.args) !== JSON.stringify(entry.args) ||
    JSON.stringify(existing.env) !== JSON.stringify(entry.env);

  if (needsUpdate) {
    servers[name] = { ...entry, disabled: false };
    raw.mcpServers = servers;
    fs.mkdirSync(path.dirname(globalConfigPath), { recursive: true });
    fs.writeFileSync(globalConfigPath, JSON.stringify(raw, null, 2) + "\n");
    log(`registered ${name} in global ~/.cursor/mcp.json`);
  }
}

function buildMcpServerList(
  excludeNames: Set<string>,
  onlyNames?: Set<string>,
): McpServer[] {
  const globalConfigPath = path.join(os.homedir(), ".cursor", "mcp.json");
  let rawServers: Record<string, RawMcpEntry> = {};
  try {
    const data = JSON.parse(fs.readFileSync(globalConfigPath, "utf8"));
    rawServers = data?.mcpServers ?? {};
  } catch {
    // no global config
  }

  const servers: McpServer[] = [];
  for (const [name, entry] of Object.entries(rawServers)) {
    if (onlyNames && !onlyNames.has(name)) continue;
    if (excludeNames.has(name)) continue;
    if (entry.disabled) continue;
    if (!entry.command) continue;

    const env = Object.entries(entry.env ?? {}).map(([k, v]) => ({
      name: k,
      value: v,
    }));

    servers.push({ name, command: entry.command, args: entry.args ?? [], env });
  }

  return servers;
}

export class AcpAgent implements Agent {
  private connection: AcpConnection;
  private sessions = new Map<string, SessionId>();
  private options: AcpAgentOptions;
  private feedbackBridge?: FeedbackBridge;
  private mcpServers: McpServer[];

  constructor(options: AcpAgentOptions) {
    this.options = options;
    this.feedbackBridge = options.feedbackBridge;
    const cwd = options.cwd ?? process.cwd();

    const feedbackServerPath = path.resolve(__dirname, "..", "wps-feedback-server.cjs");
    const timeoutHookPath = path.resolve(__dirname, "..", "mcp-timeout-hook.cjs");
    const feedbackPort = parseInt(options.env?.WPS_FEEDBACK_PORT || "19836", 10);

    const disableList = [...(options.excludeMcpServers ?? [])];
    for (const name of ["weixin-feedback", "wechat-feedback"]) {
      if (!disableList.includes(name)) disableList.push(name);
    }
    disableMcpServers(cwd, disableList);

    if (options.feedbackBridge) {
      ensureGlobalMcpEntry("wps-feedback", {
        command: "node",
        args: ["--require", timeoutHookPath, feedbackServerPath],
        env: {
          WPS_FEEDBACK_PORT: String(feedbackPort),
          MCP_REQUEST_TIMEOUT_MS: "600000",
        },
        timeout: 600,
        autoApprove: ["interactive_feedback"],
      });
    }

    // Exclude wps-feedback from ACP-provided server list so Cursor CLI
    // discovers it from ~/.cursor/mcp.json directly (with timeout:600).
    const excludeSet = new Set([...disableList, "wps-feedback"]);
    const onlySet = options.onlyMcpServers ? new Set(options.onlyMcpServers) : undefined;
    this.mcpServers = buildMcpServerList(excludeSet, onlySet);

    log(`MCP servers: ${this.mcpServers.map((s) => s.name).join(", ") || "(none)"}`);

    this.connection = new AcpConnection(options, () => {
      log("subprocess exited, clearing session cache");
      this.sessions.clear();
    });
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const conn = await this.connection.ensureReady();
    const sessionId = await this.getOrCreateSession(request.conversationId, conn);

    const blocks = await convertRequestToContentBlocks(request);
    if (blocks.length === 0) return { text: "" };

    if (this.feedbackBridge) {
      blocks.unshift({ type: "text", text: FEEDBACK_SYSTEM_INSTRUCTION });
    }

    const preview = request.text?.slice(0, 50) || (request.media ? `[${request.media.type}]` : "");
    log(`prompt: "${preview}" (session=${sessionId})`);

    this.feedbackBridge?.setActiveUser(request.conversationId);

    const collector = new ResponseCollector();
    this.connection.registerCollector(sessionId, collector);
    try {
      await conn.prompt({ sessionId, prompt: blocks });
    } finally {
      this.connection.unregisterCollector(sessionId);
      this.feedbackBridge?.clearActiveUser(request.conversationId);
    }

    const response = await collector.toResponse();
    log(`response: ${response.text?.slice(0, 80) ?? "[no text]"}${response.media ? " +media" : ""}`);
    return response;
  }

  private async getOrCreateSession(
    conversationId: string,
    conn: Awaited<ReturnType<AcpConnection["ensureReady"]>>,
  ): Promise<SessionId> {
    const existing = this.sessions.get(conversationId);
    if (existing) return existing;

    log(`creating new session for conversation=${conversationId}`);
    log(`  cwd: ${this.options.cwd ?? process.cwd()}`);
    log(`  mcpServers: ${JSON.stringify(this.mcpServers.map(s => s.name))}`);
    let res;
    try {
      res = await conn.newSession({
        cwd: this.options.cwd ?? process.cwd(),
        mcpServers: this.mcpServers,
      });
    } catch (err) {
      log(`newSession failed: ${err}`);
      throw err;
    }
    log(`session created: ${res.sessionId}`);

    if (this.options.model) {
      try {
        await conn.unstable_setSessionModel({
          sessionId: res.sessionId,
          modelId: this.options.model,
        });
        log(`model set: ${this.options.model}`);
      } catch (err) {
        log(`failed to set model: ${err}`);
      }
    }

    this.sessions.set(conversationId, res.sessionId);
    return res.sessionId;
  }

  clearSession(conversationId: string): void {
    const sessionId = this.sessions.get(conversationId);
    if (sessionId) {
      log(`clearing session for conversation=${conversationId}`);
      this.connection.unregisterCollector(sessionId);
      this.sessions.delete(conversationId);
    }
  }

  dispose(): void {
    this.sessions.clear();
    this.connection.dispose();
  }
}
