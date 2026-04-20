import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import type { FeedbackBridge, FeedbackMedia } from "./agent-interface.js";

const FEEDBACK_PORT = parseInt(process.env.WPS_FEEDBACK_PORT || "19836", 10);
const FEEDBACK_TIMEOUT_MS = parseInt(
  process.env.WPS_FEEDBACK_TIMEOUT_MS || "600000",
  10,
);
/** Per-HTTP-request poll interval. Must be shorter than Cursor CLI's 60s MCP timeout. */
const POLL_INTERVAL_MS = parseInt(
  process.env.WPS_FEEDBACK_POLL_MS || "50000",
  10,
);

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
  ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
  ".pdf": "application/pdf", ".zip": "application/zip",
  ".txt": "text/plain", ".json": "application/json",
};

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
  /** Buffered reply for late piggyback (user replied between poll cycles). */
  bufferedReply?: FeedbackReply;
};

export class FeedbackIpcServer implements FeedbackBridge {
  private server: http.Server | null = null;
  private port = 0;
  private activeUserId: string | null = null;
  private pending = new Map<string, PendingFeedback>();
  private usedConversations = new Set<string>();
  /** token -> absolute local path (media file serving) */
  private mediaFiles = new Map<string, string>();

  private sendCallback:
    | ((userId: string, text: string) => Promise<void>)
    | null = null;

  getPort(): number {
    return this.port;
  }

  setSendCallback(fn: (userId: string, text: string) => Promise<void>): void {
    this.sendCallback = fn;
  }

  /**
   * Register a local file for HTTP serving and return its URL.
   * The file is served at /media/<token>/<filename>.
   */
  registerMediaFile(localPath: string): string {
    const token = crypto.randomBytes(8).toString("hex");
    this.mediaFiles.set(token, localPath);
    const filename = encodeURIComponent(path.basename(localPath));
    const url = `http://127.0.0.1:${this.port}/media/${token}/${filename}`;
    log(`registered media: ${localPath} → ${url}`);
    return url;
  }

  /**
   * Process text and convert local file markers to served HTTP URLs.
   * Handles [WOA_IMAGE:path], [WOA_FILE:path], [WOA_VIDEO:path] markers.
   */
  processMediaMarkers(text: string): string {
    return text.replace(
      /\[(?:WOA|WECHAT|WEIXIN)_(IMAGE|VIDEO|FILE):([^\]]+)\]/g,
      (_match, _kind: string, rawPath: string) => {
        const filePath = rawPath.trim();
        try {
          if (fs.statSync(filePath).isFile()) {
            return this.registerMediaFile(filePath);
          }
        } catch { /* file not found */ }
        return filePath;
      },
    );
  }

  private handleMediaRequest(urlPath: string, res: http.ServerResponse): void {
    const parts = urlPath.replace(/^\/media\//, "").split("/");
    const token = parts[0];
    const localPath = this.mediaFiles.get(token ?? "");
    if (!localPath) {
      res.writeHead(404); res.end("not found"); return;
    }
    try {
      const stat = fs.statSync(localPath);
      const ext = path.extname(localPath).toLowerCase();
      const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
      res.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": stat.size,
        "Cache-Control": "public, max-age=3600",
      });
      fs.createReadStream(localPath).pipe(res);
    } catch {
      res.writeHead(404); res.end("file not found");
    }
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
    log(`deliverReply: delivered to user=${userId} (${entry.subscribers.length} subscriber(s)), text="${text.slice(0, 50)}"${media ? ` +media(${media.mimeType})` : ""}`);
    const reply: FeedbackReply = { text, media };
    for (const sub of entry.subscribers) {
      sub(reply);
    }
    entry.subscribers = [];
    entry.bufferedReply = reply;
    setTimeout(() => {
      const cur = this.pending.get(userId);
      if (cur === entry) this.pending.delete(userId);
    }, 120_000);
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
        if (req.method === "GET" && req.url?.startsWith("/media/")) {
          this.handleMediaRequest(req.url, res);
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
      if (existing.bufferedReply) {
        const reply = existing.bufferedReply;
        this.pending.delete(userId);
        log(`returning buffered reply for user=${userId}: "${reply.text.slice(0, 50)}"`);
        const responseBody: Record<string, unknown> = { reply: reply.text };
        if (reply.media) responseBody.media = reply.media;
        res.writeHead(200);
        res.end(JSON.stringify(responseBody));
        return;
      }

      const age = Math.round((Date.now() - existing.createdAt) / 1000);
      log(`piggyback on existing pending for user=${userId} (age=${age}s, subs=${existing.subscribers.length}→${existing.subscribers.length + 1})`);

      const reply = await this.raceWithPoll(
        new Promise<FeedbackReply>((resolve) => {
          existing.subscribers.push(resolve);
        }),
      );

      log(
        reply.text
          ? `got reply (piggyback) user=${userId}: "${reply.text.slice(0, 50)}"`
          : `poll timeout (piggyback) user=${userId}`,
      );

      const responseBody: Record<string, unknown> = { reply: reply.text };
      if (reply.media) responseBody.media = reply.media;
      res.writeHead(200);
      res.end(JSON.stringify(responseBody));
      return;
    }

    log(`feedback for user=${userId} (${(summary?.length ?? 0)} chars)`);

    const replyPromise = new Promise<FeedbackReply>((resolve) => {
      const timeout = setTimeout(() => {
        const entry = this.pending.get(userId);
        if (entry && !entry.bufferedReply) {
          this.pending.delete(userId);
          log(`full timeout for user=${userId} (${entry.subscribers.length} subscriber(s))`);
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

    const reply = await this.raceWithPoll(replyPromise);
    log(
      reply.text
        ? `got reply from user=${userId}: "${reply.text.slice(0, 50)}"${reply.media ? " +media" : ""}`
        : `poll timeout for user=${userId}`,
    );

    const responseBody: Record<string, unknown> = { reply: reply.text };
    if (reply.media) responseBody.media = reply.media;
    res.writeHead(200);
    res.end(JSON.stringify(responseBody));
  }

  /**
   * Race a reply promise against POLL_INTERVAL_MS.  If the poll timer wins,
   * return an empty reply so the MCP server can return __WAITING__ before
   * Cursor CLI's 60s timeout.  The underlying pending survives.
   */
  private raceWithPoll(replyP: Promise<FeedbackReply>): Promise<FeedbackReply> {
    return Promise.race([
      replyP,
      new Promise<FeedbackReply>((resolve) =>
        setTimeout(() => resolve({ text: "" }), POLL_INTERVAL_MS),
      ),
    ]);
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
