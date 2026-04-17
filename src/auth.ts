import { createServer } from "node:http";
import fs from "node:fs";
import crypto from "node:crypto";
import { execSync } from "node:child_process";

const PORT = 11791;
const REDIRECT_URI = `http://localhost:${PORT}/oauth-callback`;
const LOGIN_CALLBACK_URL = "https://agentspace.wps.cn/v7/devhub/users/login_callback";
const LOGIN_URL_ENDPOINT = "https://agentspace.wps.cn/v7/devhub/users/login_url";
const USER_TOKEN_URL = "https://agentspace.wps.cn/v7/devhub/users/user_token";

const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

const SUCCESS_HTML = `<!DOCTYPE html><html><body style="display:flex;justify-content:center;align-items:center;height:100vh;font-family:sans-serif"><h2>✅ 登录成功，可以关闭此页面</h2></body></html>`;

function log(msg: string) {
  console.log(`[auth] ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isWSL(): boolean {
  if (process.platform !== "linux") return false;
  try {
    const ver = fs.readFileSync("/proc/version", "utf8").toLowerCase();
    return ver.includes("microsoft") || ver.includes("wsl");
  } catch {
    return false;
  }
}

function canOpenBrowser(): boolean {
  if (isWSL()) return false;
  if (process.env.SSH_CLIENT || process.env.SSH_TTY) return false;
  if (process.platform === "win32" || process.platform === "darwin") return true;
  try {
    execSync("which xdg-open", { stdio: "pipe" });
    return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  } catch {
    return false;
  }
}

function openBrowser(url: string): boolean {
  try {
    if (process.platform === "win32") {
      execSync(`start "" "${url}"`, { stdio: "ignore" });
    } else if (process.platform === "darwin") {
      execSync(`open "${url}"`, { stdio: "ignore" });
    } else {
      execSync(`xdg-open "${url}"`, { stdio: "ignore" });
    }
    return true;
  } catch {
    return false;
  }
}

async function getUserInfo(token: string): Promise<{ nickname?: string; user_id?: string } | null> {
  try {
    const res = await fetch("https://agentspace.wps.cn/v7/devhub/users/current", {
      headers: {
        accept: "application/json",
        cookie: `wps_sid=${token}`,
        Referer: "https://agentspace.wps.cn/agents",
      },
    });
    if (!res.ok) return null;
    const body = await res.json() as { data?: { nickname?: string; user_id?: string } };
    return body.data ?? null;
  } catch {
    return null;
  }
}

export type LoginResult = {
  wpsSid: string;
  currentUser?: string;
};

/**
 * Cloud-server OAuth: POST login_url to get a code + browser URL, then
 * poll user_token until the user finishes logging in.
 */
export async function loginCloudOAuth(appId?: string): Promise<LoginResult> {
  const state = crypto.randomUUID();

  const loginBody: Record<string, string> = { state };
  if (appId) loginBody.app_id = appId;

  log("请求登录地址...");
  const loginRes = await fetch(LOGIN_URL_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(loginBody),
  });

  if (!loginRes.ok) {
    throw new Error(`获取登录地址失败: ${await loginRes.text()}`);
  }

  const loginData = await loginRes.json() as {
    data?: { code?: string; url?: string; app_id?: string };
  };

  const code = loginData?.data?.code?.trim();
  const authUrl = loginData?.data?.url?.trim();
  const respAppId = loginData?.data?.app_id?.trim();

  if (!code || !authUrl) {
    throw new Error("获取登录地址未返回有效数据");
  }

  console.log("\n请在浏览器中打开以下链接，使用 WPS 账号登录：");
  console.log(`\n  ${authUrl}\n`);

  if (canOpenBrowser()) {
    log("正在打开浏览器...");
    openBrowser(authUrl);
  } else {
    log("无法自动打开浏览器，请手动复制上方链接");
  }

  log("等待登录授权（每 5 秒轮询，最多 5 分钟）...");

  const effectiveAppId = respAppId || appId || "";
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(USER_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app_id: effectiveAppId, code, state }),
      });

      if (res.ok) {
        const data = await res.json() as { data?: { token?: string } };
        const token = data?.data?.token?.trim();
        if (token) {
          const userInfo = await getUserInfo(token);
          log(`登录成功！欢迎 ${userInfo?.nickname ?? "用户"}`);
          return {
            wpsSid: token,
            currentUser: userInfo?.nickname,
          };
        }
      }
    } catch {
      // retry
    }
    process.stdout.write(".");
    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error("等待授权超时（5 分钟）");
}

/**
 * Local OAuth: start a localhost callback server, open login_callback URL
 * in the browser, wait for redirect with code.
 */
export async function loginLocalOAuth(appId?: string): Promise<LoginResult> {
  const state = crypto.randomUUID();
  const authUrl = new URL(LOGIN_CALLBACK_URL);
  if (appId) authUrl.searchParams.set("app_id", appId);
  authUrl.searchParams.set("cb", REDIRECT_URI);
  authUrl.searchParams.set("state", state);

  const callbackPromise = new Promise<{ code: string; state: string }>((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error("等待 OAuth 回调超时"));
    }, POLL_TIMEOUT_MS);

    const server = createServer((req, res) => {
      if (!req.url?.startsWith("/oauth-callback")) {
        res.writeHead(404);
        res.end();
        return;
      }
      const url = new URL(req.url, `http://localhost:${PORT}`);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(SUCCESS_HTML);
      clearTimeout(timeout);
      server.close();
      resolve({
        code: url.searchParams.get("code") || "",
        state: url.searchParams.get("state") || "",
      });
    });

    server.listen(PORT, "127.0.0.1");
  });

  console.log("\n请在浏览器中打开以下链接完成授权：");
  console.log(`\n  ${authUrl.toString()}\n`);

  if (canOpenBrowser()) {
    openBrowser(authUrl.toString());
  }

  const callback = await callbackPromise;
  if (callback.state !== state) {
    throw new Error("state 不匹配");
  }

  const effectiveAppId = appId || "";
  const res = await fetch(USER_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: effectiveAppId, code: callback.code, state }),
  });

  if (!res.ok) throw new Error(`Token 交换失败: ${await res.text()}`);

  const data = await res.json() as { data?: { token?: string } };
  const token = data?.data?.token?.trim();
  if (!token) throw new Error("Token 交换未返回有效凭证");

  const userInfo = await getUserInfo(token);
  log(`登录成功！欢迎 ${userInfo?.nickname ?? "用户"}`);

  return {
    wpsSid: token,
    currentUser: userInfo?.nickname,
  };
}
