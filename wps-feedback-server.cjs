#!/usr/bin/env node
"use strict";

/**
 * MCP server for WPS Agentspace interactive feedback.
 *
 * Spawned as a subprocess by Cursor CLI. Communicates with the main process
 * (woa-acp) via HTTP on localhost. The port is read from the
 * WPS_FEEDBACK_PORT environment variable.
 */

const fs = require("node:fs");
const http = require("node:http");
const readline = require("node:readline");

const FEEDBACK_PORT = parseInt(process.env.WPS_FEEDBACK_PORT || "19836", 10);
const FEEDBACK_TIMEOUT_MS = parseInt(
  process.env.WPS_FEEDBACK_TIMEOUT_MS || "600000",
  10,
);

function logErr(msg) {
  process.stderr.write(`[wps-feedback-mcp] ${msg}\n`);
}

logErr(`started, port=${FEEDBACK_PORT}, timeout=${FEEDBACK_TIMEOUT_MS}ms`);

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function postToIpc(urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: FEEDBACK_PORT,
        path: urlPath,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
        timeout: FEEDBACK_TIMEOUT_MS + 30_000,
      },
      (res) => {
        let chunks = "";
        res.on("data", (c) => (chunks += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(chunks));
          } catch {
            resolve({ reply: "" });
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      resolve({ reply: "" });
    });
    req.write(data);
    req.end();
  });
}

async function handleToolCall(msg) {
  const name = msg.params?.name;
  logErr(`tool_call: name=${name}, id=${msg.id}`);

  if (name !== "interactive_feedback") {
    logErr(`unknown tool: ${name}`);
    sendError(msg.id, -32601, "Unknown tool: " + name);
    return;
  }

  const summary = msg.params?.arguments?.summary || "";
  logErr(`interactive_feedback called, summary length=${summary.length}`);

  if (!FEEDBACK_PORT) {
    logErr("ERROR: WPS_FEEDBACK_PORT not configured");
    sendResult(msg.id, {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            interactive_feedback: "",
            error: "WPS_FEEDBACK_PORT not configured",
          }),
        },
      ],
    });
    return;
  }

  try {
    logErr(`posting to IPC http://127.0.0.1:${FEEDBACK_PORT}/feedback ...`);
    const result = await postToIpc("/feedback", { summary });
    logErr(`IPC replied: ${JSON.stringify(result).slice(0, 200)}`);

    const replyText = result.reply || "";

    const content = [
      {
        type: "text",
        text: JSON.stringify({
          interactive_feedback: replyText || "__WAITING__",
        }),
      },
    ];

    if (result.media && result.media.filePath) {
      try {
        const fileData = fs.readFileSync(result.media.filePath);
        const base64 = fileData.toString("base64");
        const mimeType = result.media.mimeType || "image/png";
        content.push({ type: "image", data: base64, mimeType });
        logErr(`attached media: ${result.media.filePath} (${mimeType}, ${fileData.length} bytes)`);
      } catch (mediaErr) {
        logErr(`failed to read media file: ${mediaErr.message || mediaErr}`);
      }
    }

    sendResult(msg.id, { content });
  } catch (err) {
    logErr(`IPC error: ${err.message || err}`);
    sendResult(msg.id, {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            interactive_feedback: "__WAITING__",
            error: String(err.message || err),
          }),
        },
      ],
    });
  }
}

function handleMessage(msg) {
  if (!msg.method) return;
  logErr(`recv: method=${msg.method}, id=${msg.id ?? "notification"}`);
  if (msg.id === undefined || msg.id === null) return;

  switch (msg.method) {
    case "initialize":
      logErr("handling initialize");
      sendResult(msg.id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "wps-feedback-mcp", version: "1.0.0" },
      });
      break;

    case "ping":
      sendResult(msg.id, {});
      break;

    case "tools/list":
      sendResult(msg.id, {
        tools: [
          {
            name: "interactive_feedback",
            description:
              "Send your complete output to the WPS Agentspace user and wait for their reply. " +
              "Use this after completing a task to get user feedback for multi-turn conversation. " +
              "CRITICAL: You MUST paste your ENTIRE raw output into the summary parameter.",
            inputSchema: {
              type: "object",
              properties: {
                summary: {
                  type: "string",
                  description:
                    "Your ENTIRE raw output verbatim. Copy-paste ALL text you produced " +
                    "during this task WITHOUT any summarization or condensation.",
                },
              },
              required: ["summary"],
            },
          },
        ],
      });
      break;

    case "tools/call":
      handleToolCall(msg);
      break;

    default:
      sendError(msg.id, -32601, "Method not found: " + msg.method);
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  try {
    handleMessage(JSON.parse(line));
  } catch {
    /* malformed JSON */
  }
});
rl.on("close", () => process.exit(0));
