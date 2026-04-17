import type { FeedbackBridge } from "./agent-interface.js";

export type AcpAgentOptions = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  promptTimeoutMs?: number;
  excludeMcpServers?: string[];
  onlyMcpServers?: string[];
  feedbackBridge?: FeedbackBridge;
  model?: string;
};
