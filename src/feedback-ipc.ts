import http from "node:http";

import type { FeedbackBridge, FeedbackMedia } from "./agent-interface.js";

const FEEDBACK_PORT = parseInt(process.env.WPS_FEEDBACK_PORT || "19836", 10);
const FEEDBACK_TIMEOUT_MS = parseInt(
  process.env.WPS_FEEDBACK_TIMEOUT_MS || "600000",
  10,
);

function log(msg: string) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[feedback-ipc ${ts}] ${msg}`);
}

type FeedbackReply = {
  text: string;
  media?: FeedbackMedia;
};

type PendingFeedback = {
  subscribers: Array<(reply: FeedbackReply) => void>;
  timeout: ReturnType<typeof setTimeout>;
  createdAt: number;
};

export class FeedbackIpcServer implements FeedbackBridge {
  private server: http.Server | null = null;
  private port = 0;
  private activeUserId: string | null = null;
  private pending = new Map<string, PendingFeedback>();
  private usedConversations = new Set<string>();

  private sendCallback:
    | ((userId: string, text: string) => Promise<void>)
    | null = null;

  getPort(): number {
    return this.port;
  }

  setSendCallback(fn: (userId: string, text: string) => Promise<void>): void {
    this.sendCallback = fn;
  }

  setActiveUser(userId: string): void {
    log(`setActiveUser: ${userId}`);
    this.activeUserId = userId;
  }

  clearActiveUser(userId: string): void {
    log(`clearActiveUser: ${userId}`);
    if (this.activeUserId === userId) {
      this.activeUserId = null;
    }
  }

  deliverReply(userId: string, text: string, media?: FeedbackMedia): boolean {
    const entry = this.pending.get(userId);
    if (!entry) {
      log(`deliverReply: no pending feedback for user=${userId}`);
      return false;
    }
    clearTimeout(entry.timeout);
    this.pending.delete(userId);
    log(`deliverReply: delivered to user=${userId} (${entry.subscribers.length} subscriber(s)), text="${text.slice(0, 50)}"${media ? ` +media(${media.mimeType})` : ""}`);
    for (const sub of entry.subscribers) {
      sub({ text, media });
    }
    return true;
  }

  wasFeedbackUsed(conversationId: string): boolean {
    return this.usedConversations.has(conversationId);
  }

  resetFeedbackUsed(conversationId: string): void {
    this.usedConversations.delete(conversationId);
  }

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        if (req.method === "POST" && req.url === "/feedback") {
          let body = "";
          req.on("data", (chunk: Buffer) => (body += chunk.toString()));
          req.on("end", () => {
            this.handleFeedbackRequest(body, res).catch((err) => {
              log(`feedback handler error: ${err}`);
              res.writeHead(500);
              res.end(JSON.stringify({ reply: "", error: String(err) }));
            });
          });
          return;
        }
        res.writeHead(404);
        res.end("not found");
      });

      server.listen(FEEDBACK_PORT, "127.0.0.1", () => {
        const addr = server.address();
        if (typeof addr === "object" && addr) {
          this.port = addr.port;
        }
        this.server = server;
        log(`listening on 127.0.0.1:${this.port}`);
        resolve(this.port);
      });

      server.on("error", reject);
    });
  }

  private async handleFeedbackRequest(
    rawBody: string,
    res: http.ServerResponse,
  ): Promise<void> {
    const { summary } = JSON.parse(rawBody) as { summary?: string };
    const userId = this.activeUserId;

    if (!userId) {
      log("no active user — returning empty reply");
      res.writeHead(200);
      res.end(JSON.stringify({ reply: "" }));
      return;
    }

    this.usedConversations.add(userId);

    const existing = this.pending.get(userId);
    if (existing) {
      // Cursor CLI timed out the previous MCP tool call (~60s) but the user
      // hasn't replied yet.  The agent retried interactive_feedback, which
      // sends a new HTTP request here.  Instead of creating a new pending
      // (which would cancel the existing one), we "piggyback" — subscribe
      // to the same pending and wait for the user's actual reply.
      const age = Math.round((Date.now() - existing.createdAt) / 1000);
      log(`piggyback on existing pending for user=${userId} (age=${age}s, subs=${existing.subscribers.length}→${existing.subscribers.length + 1})`);

      const reply = await new Promise<FeedbackReply>((resolve) => {
        existing.subscribers.push(resolve);
      });

      log(
        reply.text
          ? `got reply (piggyback) user=${userId}: "${reply.text.slice(0, 50)}"`
          : `timeout (piggyback) user=${userId}`,
      );

      const responseBody: Record<string, unknown> = { reply: reply.text };
      if (reply.media) responseBody.media = reply.media;
      res.writeHead(200);
      res.end(JSON.stringify(responseBody));
      return;
    }

    // First request for this userId — create the pending and send summary.
    log(`feedback for user=${userId} (${(summary?.length ?? 0)} chars)`);

    const replyPromise = new Promise<FeedbackReply>((resolve) => {
      const timeout = setTimeout(() => {
        const entry = this.pending.get(userId);
        if (entry) {
          this.pending.delete(userId);
          log(`timeout waiting for reply from user=${userId} (${entry.subscribers.length} subscriber(s))`);
          for (const sub of entry.subscribers) sub({ text: "" });
        }
      }, FEEDBACK_TIMEOUT_MS);

      this.pending.set(userId, {
        subscribers: [resolve],
        timeout,
        createdAt: Date.now(),
      });
    });

    if (this.sendCallback && summary) {
      try {
        const timeoutMins = Math.round(FEEDBACK_TIMEOUT_MS / 60_000);
        const hint = `💬 追问模式已开启，${timeoutMins} 分钟内回复可继续当前对话`;
        const text = `${summary}\n\n---\n> ${hint}`;
        await this.sendCallback(userId, text);
        log(`sent summary to WPS user=${userId}`);
      } catch (err) {
        log(`failed to send summary: ${err}`);
      }
    }

    const reply = await replyPromise;
    log(
      reply.text
        ? `got reply from user=${userId}: "${reply.text.slice(0, 50)}"${reply.media ? " +media" : ""}`
        : `timeout for user=${userId}`,
    );

    const responseBody: Record<string, unknown> = { reply: reply.text };
    if (reply.media) responseBody.media = reply.media;
    res.writeHead(200);
    res.end(JSON.stringify(responseBody));
  }

  close(): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timeout);
      for (const sub of entry.subscribers) sub({ text: "" });
    }
    this.pending.clear();
    this.server?.close();
    this.server = null;
  }
}
