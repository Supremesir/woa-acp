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
- If the result contains a user message (not "__WAITING__"), continue the conversation with that message.
- If the result is "__WAITING__", it means the user hasn't replied YET but the connection timed out.
  You MUST call interactive_feedback AGAIN immediately with the SAME summary to continue waiting.
  Keep retrying as long as you get "__WAITING__" — up to 10 retries (about 10 minutes total).
- Only end the task when you get an actual empty string "" (not "__WAITING__"), which means the real timeout expired.

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
 * We do NOT register wps-feedback here — it is passed through the ACP
 * session's mcpServers to avoid duplicate instances that interfere
 * with each other's pending feedback state.
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

  // Also disable wps-feedback in project config to prevent Cursor from
  // loading a second instance alongside the one from the ACP session.
  const fbEntry = existing["wps-feedback"] as Record<string, unknown> | undefined;
  if (fbEntry && fbEntry.disabled !== true) {
    existing["wps-feedback"] = { ...fbEntry, disabled: true };
    changed = true;
  }

  if (changed) {
    fs.mkdirSync(cursorDir, { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({ mcpServers: existing }, null, 2) + "\n",
    );
    log(`wrote .cursor/mcp.json — disabled: ${[...names, ...(fbEntry ? ["wps-feedback"] : [])].join(", ")}`);
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
    const feedbackPort = parseInt(options.env?.WPS_FEEDBACK_PORT || "19836", 10);

    // Disable conflicting MCPs via project .cursor/mcp.json.
    // We also disable any project-level wps-feedback to ensure only the
    // ACP-session instance runs (prevents duplicate instances).
    const disableList = [...(options.excludeMcpServers ?? [])];
    if (!disableList.includes("weixin-feedback")) {
      disableList.push("weixin-feedback");
    }
    disableMcpServers(cwd, disableList);

    const excludeSet = new Set(disableList);
    const onlySet = options.onlyMcpServers ? new Set(options.onlyMcpServers) : undefined;

    // Register wps-feedback in the GLOBAL ~/.cursor/mcp.json (same as
    // weixin-feedback).  MCPs loaded from global config appear to get
    // a much longer tool-call timeout from Cursor CLI than MCPs passed
    // through the ACP session's mcpServers (which has a ~60s default).
    if (options.feedbackBridge) {
      ensureGlobalMcpEntry("wps-feedback", {
        command: "node",
        args: [feedbackServerPath],
        env: { WPS_FEEDBACK_PORT: String(feedbackPort) },
        timeout: 600,
      });
    }

    // Build server list — now includes wps-feedback from global config.
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
