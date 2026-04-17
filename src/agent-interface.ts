/**
 * Agent interface — any AI backend that can handle a chat message.
 * Copied from wechat-sdk for standalone use.
 */

export interface Agent {
  chat(request: ChatRequest): Promise<ChatResponse>;
  clearSession?(conversationId: string): void;
}

export interface ChatRequest {
  conversationId: string;
  text: string;
  media?: {
    type: "image" | "audio" | "video" | "file";
    filePath: string;
    mimeType: string;
    fileName?: string;
  };
}

export interface ChatResponse {
  text?: string;
  media?: {
    type: "image" | "video" | "file";
    url: string;
    fileName?: string;
  };
}

export type FeedbackMedia = {
  filePath: string;
  mimeType: string;
};

export interface FeedbackBridge {
  setActiveUser(userId: string): void;
  clearActiveUser(userId: string): void;
  deliverReply(userId: string, text: string, media?: FeedbackMedia): boolean;
  wasFeedbackUsed(conversationId: string): boolean;
  resetFeedbackUsed(conversationId: string): void;
  setSendCallback(fn: (userId: string, text: string) => Promise<void>): void;
  getPort(): number;
  start(): Promise<number>;
  close(): void;
}
