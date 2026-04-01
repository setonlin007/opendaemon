/**
 * Self-signed certificate generator for HTTPS.
 * Generates once and caches to data/tls/ directory.
 */

import { execSync } from "child_process";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { getProjectRoot } from "./config.mjs";

const TLS_DIR = join(getProjectRoot(), "data", "tls");
const KEY_PATH = join(TLS_DIR, "key.pem");
const CERT_PATH = join(TLS_DIR, "cert.pem");

export function ensureCert() {
  if (existsSync(KEY_PATH) && existsSync(CERT_PATH)) {
    return { key: readFileSync(KEY_PATH), cert: readFileSync(CERT_PATH) };
  }

  mkdirSync(TLS_DIR, { recursive: true });

  execSync(
    `openssl req -x509 -newkey rsa:2048 -keyout "${KEY_PATH}" -out "${CERT_PATH}" -days 3650 -nodes -subj "/CN=OpenDaemon"`,
    { stdio: "ignore" }
  );

  console.log("[tls] self-signed certificate generated");
  return { key: readFileSync(KEY_PATH), cert: readFileSync(CERT_PATH) };
}
