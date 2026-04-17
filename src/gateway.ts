import WebSocket from "ws";

export type WpsInboundMessage = {
  role?: string;
  type?: string;
  content?: string;
  session_id?: string;
  chat_id?: string;
  message_id?: string;
  timestamp?: number;
  device_uuid?: string;
  device_name?: string;
};

export type WpsWsMessage = {
  event: "message" | "error" | "init";
  data: WpsInboundMessage;
};

export type OutboundContext = {
  chatId: string;
  sessionId?: string;
  messageId?: string;
};

export type GatewayOptions = {
  wsUrl: string;
  wpsSid: string;
  deviceUuid: string;
  deviceName: string;
  onMessage: (message: WpsInboundMessage) => void | Promise<void>;
  onError?: (error: string) => void;
  log?: (msg: string) => void;
};

const HEARTBEAT_INTERVAL_MS = 10_000;
const RECONNECT_FIXED_PHASE_MS = 10 * 60 * 1000;
const RECONNECT_FIXED_INTERVAL_MS = 20_000;
const RECONNECT_BASE_MS = 5_000;
const RECONNECT_MAX_MS = 60 * 60 * 1000;
const RECONNECT_GIVE_UP_MS = 7 * 24 * 60 * 60 * 1000;
const SEND_WAIT_OPEN_MS = 30_000;

function toJson(event: string, data: Record<string, unknown>): string {
  return JSON.stringify({ event, data });
}

/**
 * Standalone WPS Agentspace WebSocket gateway.
 * Handles connection, heartbeat, reconnection, and message dispatch.
 */
export class WpsGateway {
  private ws: WebSocket | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private backoffAttempt = 0;
  private reconnectStartedAt = 0;
  private permanentClose = false;
  private disposed = false;

  private readonly log: (msg: string) => void;

  constructor(private readonly opts: GatewayOptions) {
    this.log = opts.log ?? ((msg) => {
      const ts = new Date().toISOString().slice(11, 23);
      console.log(`[wps-gateway ${ts}] ${msg}`);
    });
  }

  /**
   * Start the gateway. Returns a promise that resolves when disposed.
   */
  start(): Promise<void> {
    this.connect();
    return new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (this.disposed) {
          clearInterval(check);
          resolve();
        }
      }, 1000);
    });
  }

  /**
   * Send a text message back to WPS Agentspace.
   */
  async sendMessage(context: OutboundContext, text: string): Promise<void> {
    const ws = this.ws;
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      this.log("cannot send: ws not connected");
      return;
    }

    if (ws.readyState !== WebSocket.OPEN) {
      await this.waitOpen(ws);
    }

    ws.send(toJson("message", {
      role: "assistant",
      type: "answer",
      content: text,
      session_id: context.sessionId ?? "",
      chat_id: context.chatId ?? "",
      message_id: context.messageId ?? "",
      timestamp: Date.now(),
      device_uuid: this.opts.deviceUuid,
      device_name: this.opts.deviceName,
    }));
  }

  dispose(): void {
    this.disposed = true;
    this.permanentClose = true;
    this.stopHeartbeat();
    this.stopReconnect();
    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState !== WebSocket.CLOSED) {
        this.ws.close();
      }
      this.ws = null;
    }
  }

  private connect(): void {
    const { wsUrl, wpsSid, deviceUuid, deviceName } = this.opts;

    const origin = this.resolveOrigin(wsUrl);
    const ws = new WebSocket(wsUrl, {
      headers: {
        Cookie: `wps_sid=${wpsSid}`,
        Origin: origin,
        "User-Agent": "WpsAcp/0.1.0",
      },
    });
    this.ws = ws;

    ws.on("open", () => {
      if (ws !== this.ws) return;
      this.log("connected");
      ws.send(toJson("init", {
        timestamp: Date.now(),
        device_uuid: deviceUuid,
        device_name: deviceName,
      }));

      this.stopHeartbeat();
      this.heartbeat = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(toJson("ping", {
          device_uuid: deviceUuid,
          device_name: deviceName,
          timestamp: Date.now(),
        }));
      }, HEARTBEAT_INTERVAL_MS);

      this.stopReconnect();
    });

    ws.on("message", (rawData: WebSocket.RawData) => {
      this.handleRawMessage(rawData);
    });

    ws.on("error", (err: unknown) => {
      this.log(`ws error: ${String(err)}`);
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    });

    ws.on("close", (code: number) => {
      this.log(`ws closed (code=${code})`);
      this.stopHeartbeat();
      ws.removeAllListeners();
      if (this.ws === ws) this.ws = null;
      this.scheduleReconnect();
    });
  }

  private handleRawMessage(rawData: WebSocket.RawData): void {
    const raw = rawData instanceof Buffer ? rawData.toString("utf8") : String(rawData);
    let parsed: WpsWsMessage;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    const { event, data } = parsed;

    if (event === "init") {
      this.log("init acknowledged by server");
    } else if (event === "error") {
      const code = (data as Record<string, unknown>)?.code as string | undefined;
      const FATAL = ["USER_NO_APP_PERMISSION", "USER_NO_OPENCLAW_PERMISSION", "OPENCLAW_NOT_CONFIGURED", "NOT_OPENCLAW_APP", "NOT_LOGIN"];
      if (code && FATAL.includes(code)) {
        this.log(`fatal error: ${code}, stopping`);
        this.opts.onError?.(code);
        this.dispose();
        return;
      }
      this.log(`server error: ${code ?? JSON.stringify(data)}`);
    } else if (event === "message") {
      const { content, role } = data || {};
      if (role === "assistant") {
        this.log(`ignoring own assistant message echo`);
        return;
      }
      if (content?.trim()) {
        this.log(`inbound: role=${role ?? "user"}, content="${content.slice(0, 80)}"`);
        void Promise.resolve(this.opts.onMessage(data)).catch((err) => {
          this.log(`onMessage error: ${String(err)}`);
        });
      }
    }
  }

  private resolveOrigin(wsUrl: string): string {
    try {
      const parsed = new URL(wsUrl);
      const scheme = parsed.protocol === "wss:" ? "https:" : "http:";
      return `${scheme}//${parsed.host}`;
    } catch {
      return "https://agentspace.wps.cn";
    }
  }

  private waitOpen(ws: WebSocket): Promise<void> {
    if (ws.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("ws open timeout")), SEND_WAIT_OPEN_MS);
      const onOpen = () => { clearTimeout(timer); resolve(); };
      const onClose = () => { clearTimeout(timer); reject(new Error("ws closed")); };
      ws.once("open", onOpen);
      ws.once("close", onClose);
    });
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  private stopReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempt = 0;
    this.backoffAttempt = 0;
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.permanentClose) return;

    if (!this.reconnectStartedAt) {
      this.reconnectStartedAt = Date.now();
    }
    if (Date.now() - this.reconnectStartedAt >= RECONNECT_GIVE_UP_MS) {
      this.log("reconnect stopped after 7 days");
      this.permanentClose = true;
      return;
    }

    this.reconnectAttempt++;
    const delay = this.getBackoffDelay();
    this.log(`reconnect #${this.reconnectAttempt} in ${Math.round(delay / 1000)}s`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.disposed || this.permanentClose) return;
      if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
      this.log("reconnecting...");
      this.connect();
    }, delay);
  }

  private getBackoffDelay(): number {
    const elapsed = Date.now() - this.reconnectStartedAt;
    if (elapsed < RECONNECT_FIXED_PHASE_MS) {
      return RECONNECT_FIXED_INTERVAL_MS;
    }
    this.backoffAttempt++;
    const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, this.backoffAttempt), RECONNECT_MAX_MS);
    const jitter = 0.8 + Math.random() * 0.4;
    return Math.round(delay * jitter);
  }
}
