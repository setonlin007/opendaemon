/**
 * AES-256-GCM key 加密
 * 密钥派生：HMAC-SHA256(daemon auth password, "vf-key-v1")
 * 单用户场景够用；多用户改用每用户独立 salt。
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "crypto";

const DERIVATION_SALT = "vf-key-v1";

function deriveKey(secret) {
  return createHmac("sha256", secret).update(DERIVATION_SALT).digest(); // 32 bytes
}

/**
 * 加密：返回 { cipher, iv } 两个 Buffer，分别落 BLOB column
 */
export function encryptKey(plaintext, derivationSecret) {
  if (!plaintext) throw new Error("plaintext required");
  if (!derivationSecret) throw new Error("derivation secret required");
  const key = deriveKey(derivationSecret);
  const iv = randomBytes(12); // GCM 推荐 12 字节
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);
  const tag = cipher.getAuthTag();
  // cipher = encrypted + tag（16 bytes 尾接）
  return { cipher: Buffer.concat([enc, tag]), iv };
}

export function decryptKey({ key_cipher, key_iv }, derivationSecret) {
  if (!key_cipher || !key_iv) throw new Error("cipher and iv required");
  const key = deriveKey(derivationSecret);
  const tag = key_cipher.slice(-16);
  const ciphertext = key_cipher.slice(0, -16);
  const decipher = createDecipheriv("aes-256-gcm", key, key_iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return dec.toString("utf8");
}

/**
 * 给 stdout 脱敏用：扫描 sk-xxx 前缀替换为 sk-***
 */
export function redactKeysInText(text) {
  return text
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-***")
    .replace(/Bearer\s+[A-Za-z0-9_-]+/g, "Bearer ***");
}
