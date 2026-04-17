import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const SALT_LENGTH = 16;
const DEFAULT_KEY_SOURCE = "openclaw_agentspace";

function deriveKey(appId: string, salt: Buffer): Buffer {
  const keySource = appId || DEFAULT_KEY_SOURCE;
  return scryptSync(keySource, salt, KEY_LENGTH);
}

export function encryptWpsSid(wpsSid: string, appId?: string): string {
  if (!wpsSid) throw new Error("wpsSid cannot be empty");

  const salt = randomBytes(SALT_LENGTH);
  const key = deriveKey(appId || DEFAULT_KEY_SOURCE, salt);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(wpsSid, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag();

  return `${salt.toString("hex")}:${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted}`;
}

export function decryptWpsSid(encryptedToken: string, appId?: string): string {
  if (!encryptedToken) throw new Error("encryptedToken cannot be empty");

  const parts = encryptedToken.split(":");
  if (parts.length !== 4) {
    throw new Error("Invalid encrypted token format");
  }

  const [saltHex, ivHex, authTagHex, encryptedData] = parts;
  const salt = Buffer.from(saltHex, "hex");
  const key = deriveKey(appId || DEFAULT_KEY_SOURCE, salt);
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encryptedData, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}
