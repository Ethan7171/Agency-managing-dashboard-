// Envelope encryption for third-party credentials.
// The DB stores AES-256-GCM ciphertext only; the master key lives exclusively
// in the MASTER_KEY env var (Railway secret). Decryption happens in server
// memory at the moment of an outbound API call and the plaintext is never
// logged, never returned by any route, and never sent to the frontend.
import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";
import { q } from "./db/pool.js";
import { config } from "./config.js";

export async function storeSecret(label: string, plaintext: string): Promise<string> {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", config.masterKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const { rows } = await q<{ id: string }>(
    `insert into vault_secrets (label, ciphertext, iv, auth_tag) values ($1,$2,$3,$4) returning id`,
    [label, ciphertext, iv, tag]
  );
  return rows[0].id;
}

export async function readSecret(id: string): Promise<string> {
  const { rows } = await q<{ ciphertext: Buffer; iv: Buffer; auth_tag: Buffer; revoked_at: Date | null }>(
    `select ciphertext, iv, auth_tag, revoked_at from vault_secrets where id=$1`, [id]
  );
  if (!rows[0]) throw new Error("secret not found");
  if (rows[0].revoked_at) throw new Error("secret revoked");
  const d = createDecipheriv("aes-256-gcm", config.masterKey(), rows[0].iv);
  d.setAuthTag(rows[0].auth_tag);
  return Buffer.concat([d.update(rows[0].ciphertext), d.final()]).toString("utf8");
}

// Revoke = zero the ciphertext AND mark revoked; the key material is unrecoverable.
export async function revokeSecret(id: string | null): Promise<void> {
  if (!id) return;
  await q(`update vault_secrets set ciphertext=''::bytea, iv=''::bytea, auth_tag=''::bytea,
           revoked_at=now() where id=$1 and revoked_at is null`, [id]);
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
