// Single internal Flax login (v1). Session = HMAC-signed cookie derived from
// MASTER_KEY; no session table needed. RBAC for agency-scoped logins is
// scaffolded in the schema (audit_log.actor) and can be layered on later.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { config } from "../config.js";

const sign = (payload: string) =>
  createHmac("sha256", config.masterKey()).update(payload).digest("hex");

export function makeSession(): string {
  const payload = JSON.stringify({ u: "flax_admin", exp: Date.now() + 7 * 864e5 });
  const b64 = Buffer.from(payload).toString("base64url");
  return `${b64}.${sign(b64)}`;
}

export function verifySession(token: string | undefined): boolean {
  if (!token || !token.includes(".")) return false;
  const [b64, sig] = token.split(".");
  const expected = sign(b64);
  try {
    if (!timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"))) return false;
  } catch { return false; }
  const payload = JSON.parse(Buffer.from(b64, "base64url").toString());
  return payload.exp > Date.now();
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (verifySession(req.cookies?.flax_session)) { next(); return; }
  res.status(401).json({ error: "unauthorized" });
}
