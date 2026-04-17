import type { ChildProcess } from "node:child_process";
import spawn from "cross-spawn";
import { PassThrough, Readable, Writable } from "node:stream";

import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk";
import type { SessionId } from "@agentclientprotocol/sdk";

import type { AcpAgentOptions } from "./types.js";
import { ResponseCollector } from "./response-collector.js";

function log(msg: string) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[acp ${ts}] ${msg}`);
}

function describeToolCall(update: {
  title?: string | null;
  kind?: string | null;
  toolCallId?: string;
  rawInput?: unknown;
}): string {
  const base = update.title ?? update.kind ?? update.toolCallId ?? "tool";
  if (base.startsWith("MCP") && update.rawInput && typeof update.rawInput === "object") {
    const input = update.rawInput as Record<string, unknown>;
    const serverName = input.server_name ?? input.serverName ?? "";
    const toolName = input.tool_name ?? input.toolName ?? input.name ?? "";
    if (serverName || toolName) {
      return `MCP: ${serverName}${serverName && toolName ? "/" : ""}${toolName}`;
    }
  }
  return base;
}

export class AcpConnection {
  private process: ChildProcess | null = null;
  private connection: ClientSideConnection | null = null;
  private ready = false;
  private collectors = new Map<SessionId, ResponseCollector>();
  private activeSessionId: SessionId | null = null;
  private onExit?: () => void;

  constructor(private options: AcpAgentOptions, onExit?: () => void) {
    this.onExit = onExit;
  }

  registerCollector(sessionId: SessionId, collector: ResponseCollector): void {
    this.collectors.set(sessionId, collector);
    this.activeSessionId = sessionId;
  }

  unregisterCollector(sessionId: SessionId): void {
    this.collectors.delete(sessionId);
    if (this.activeSessionId === sessionId) {
      this.activeSessionId = null;
    }
  }

  async ensureReady(): Promise<ClientSideConnection> {
    if (this.ready && this.connection) {
      return this.connection;
    }

    const args = this.options.args ?? [];
    log(`spawning: ${this.options.command} ${args.join(" ")}`);

    const proc = spawn(this.options.command, args, {
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env, ...this.options.env },
      cwd: this.options.cwd,
    });
    this.process = proc;

    proc.on("exit", (code) => {
      log(`subprocess exited (code=${code})`);
      this.ready = false;
      this.connection = null;
      this.process = null;
      this.onExit?.();
    });

    const sdkInput = new PassThrough();
    let lineBuffer = "";

    proc.stdout!.on("data", (chunk: Buffer) => {
      sdkInput.push(chunk);

      lineBuffer += chunk.toString("utf8");
      let idx: number;
      while ((idx = lineBuffer.indexOf("\n")) !== -1) {
        const line = lineBuffer.slice(0, idx).trim();
        lineBuffer = lineBuffer.slice(idx + 1);
        if (line) this.handleRawLine(line, proc);
      }
    });
    proc.stdout!.on("end", () => sdkInput.push(null));
    proc.stdout!.on("error", (err) => sdkInput.destroy(err));

    const writable = Writable.toWeb(proc.stdin!) as WritableStream<Uint8Array>;
    const readable = Readable.toWeb(sdkInput) as ReadableStream<Uint8Array>;
    const stream = ndJsonStream(writable, readable);

    const conn = new ClientSideConnection((_agent) => ({
      sessionUpdate: async (params) => {
        const update = params.update;
        switch (update.sessionUpdate) {
          case "tool_call": {
            const desc = describeToolCall(update);
            log(`tool_call: ${desc} (${update.status ?? "started"}) [id=${update.toolCallId}]`);
            if (update.rawInput) {
              const snippet = JSON.stringify(update.rawInput).slice(0, 200);
              log(`  rawInput: ${snippet}`);
            }
            break;
          }
          case "tool_call_update": {
            if (update.status) {
              const desc = describeToolCall(update);
              log(`tool_call_update: ${desc} → ${update.status} [id=${update.toolCallId}]`);
            }
            break;
          }
          case "agent_thought_chunk":
            if (update.content.type === "text") {
              log(`thinking: ${update.content.text.slice(0, 100)}`);
            }
            break;
        }
        const collector = this.collectors.get(params.sessionId);
        if (collector) {
          collector.handleUpdate(params);
        }
      },
      requestPermission: async (params) => {
        const firstOption = params.options[0];
        log(
          `permission: auto-approved "${firstOption?.name ?? "allow"}" (${firstOption?.optionId ?? "unknown"})`,
        );
        return {
          outcome: {
            outcome: "selected" as const,
            optionId: firstOption?.optionId ?? "allow",
          },
        };
      },
    }), stream);

    log("initializing connection...");
    await conn.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: "woa-acp", version: "0.2.0" },
      clientCapabilities: {},
    });
    log("connection initialized");

    this.connection = conn;
    this.ready = true;
    return conn;
  }

  private handleRawLine(line: string, proc: ChildProcess): void {
    let msg: { jsonrpc?: string; method?: string; id?: unknown; params?: Record<string, unknown> };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.jsonrpc !== "2.0" || !msg.method) return;

    if (msg.method === "cursor/generate_image") {
      const params = msg.params as {
        toolCallId?: string;
        description?: string;
        filePath?: string;
      } | undefined;

      log(`cursor/generate_image: description="${params?.description ?? ""}" filePath="${params?.filePath ?? ""}"`);

      const filePath = params?.filePath;
      if (filePath) {
        const collector = this.activeSessionId
          ? this.collectors.get(this.activeSessionId)
          : [...this.collectors.values()].at(0);
        collector?.setGeneratedImage(filePath);
      }

      if (msg.id != null && proc.stdin) {
        const response = JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            outcome: filePath
              ? { outcome: "generated", filePath }
              : { outcome: "rejected", reason: "no filePath provided" },
          },
        });
        proc.stdin.write(response + "\n");
      }
    }
  }

  dispose(): void {
    this.ready = false;
    this.collectors.clear();
    this.activeSessionId = null;
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this.connection = null;
  }
}
