import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import { decryptWpsSid, encryptWpsSid } from "./crypto-utils.js";

const DEFAULT_WS_URL = "wss://agentspace.wps.cn/v7/devhub/ws/openClaw/chat";

export type WpsAccount = {
  wpsSid: string;
  appId?: string;
  deviceUuid: string;
  deviceName: string;
  currentUser?: string;
};

type StoredAccount = {
  token?: string;
  wps_sid?: string;
  device_uuid?: string;
  device_name?: string;
  app_id?: string;
  currentUser?: string;
  enabled?: boolean;
};

type OpenClawConfig = {
  channels?: {
    agentspace?: {
      accounts?: Record<string, StoredAccount>;
    };
  };
};

function getConfigPath(): string {
  return path.join(os.homedir(), ".openclaw", "openclaw.json");
}

/**
 * Read the WPS account from ~/.openclaw/openclaw.json (compatible with
 * the official OpenClaw agentspace plugin).
 */
export function loadAccount(accountId = "default"): WpsAccount | null {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) return null;

  let cfg: OpenClawConfig;
  try {
    cfg = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch {
    return null;
  }

  const stored = cfg.channels?.agentspace?.accounts?.[accountId];
  if (!stored) return null;

  let wpsSid: string | undefined;
  if (stored.token) {
    try {
      wpsSid = decryptWpsSid(stored.token, stored.app_id);
    } catch {
      wpsSid = stored.wps_sid;
    }
  } else {
    wpsSid = stored.wps_sid;
  }

  if (!wpsSid?.trim()) return null;

  return {
    wpsSid,
    appId: stored.app_id,
    deviceUuid: stored.device_uuid || crypto.randomUUID(),
    deviceName: stored.device_name || `${stored.currentUser ?? "User"}的ACP助理`,
    currentUser: stored.currentUser,
  };
}

/**
 * Save a WPS account to ~/.openclaw/openclaw.json.
 */
export function saveAccount(
  account: WpsAccount,
  accountId = "default",
): void {
  const configPath = getConfigPath();
  let cfg: Record<string, unknown> = {};
  try {
    cfg = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch {
    // start fresh
  }

  const channels = (cfg.channels ?? {}) as Record<string, unknown>;
  const agentspace = (channels.agentspace ?? {}) as Record<string, unknown>;
  const accounts = (agentspace.accounts ?? {}) as Record<string, StoredAccount>;

  const encryptedToken = encryptWpsSid(account.wpsSid, account.appId);

  accounts[accountId] = {
    enabled: true,
    token: encryptedToken,
    app_id: account.appId,
    device_uuid: account.deviceUuid,
    device_name: account.deviceName,
    currentUser: account.currentUser,
  };

  agentspace.accounts = accounts;
  channels.agentspace = agentspace;
  cfg.channels = channels;

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
}

export function resolveWsUrl(appId?: string): string {
  if (appId) {
    return `wss://agentspace.wps.cn/v7/devhub/ws/${appId}/chat`;
  }
  return DEFAULT_WS_URL;
}
