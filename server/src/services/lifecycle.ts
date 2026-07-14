// Agency lifecycle: pause / resume / archive / purge.
// Archive (default cut): stop syncs, revoke key from vault, cancel scheduled
// jobs, freeze a lifetime summary — ALL DATA RETAINED. Reversible in the sense
// that the record and history stay; reactivating requires a new key.
// Purge: irreversible cascading hard delete across every dependent table.
import { q, pool } from "../db/pool.js";
import { revokeSecret } from "../vault.js";
import { audit } from "./audit.js";
import { agencyRollup } from "./rollup.js";

export async function pauseAgency(id: string): Promise<void> {
  await q(`update agencies set status='paused', updated_at=now() where id=$1`, [id]);
  await q(`update connections set sync_status='paused' where agency_id=$1`, [id]);
  await audit("pause", "agency", id);
}

export async function resumeAgency(id: string): Promise<void> {
  await q(`update agencies set status='active', updated_at=now() where id=$1`, [id]);
  await q(`update connections set sync_status='pending' where agency_id=$1 and active`, [id]);
  await audit("resume", "agency", id);
}

export async function archiveAgency(id: string): Promise<{ lifetime: unknown }> {
  const all = await agencyRollup(0, true);
  const lifetime = all.find(r => r.agency_id === id) ?? null;
  const conns = await q<{ id: string; secret_id: string | null }>(
    `select id, secret_id from connections where agency_id=$1`, [id]);
  for (const c of conns.rows) await revokeSecret(c.secret_id); // no orphaned credentials
  await q(`update connections set active=false, sync_status='paused', secret_id=null where agency_id=$1`, [id]);
  await q(`update agencies set status='archived', archived_at=now(),
           lifetime_summary=$2, updated_at=now() where id=$1`,
    [id, lifetime ? JSON.stringify(lifetime) : null]);
  await audit("archive", "agency", id, { lifetime });
  return { lifetime };
}

export interface PurgePreview {
  agency: { id: string; name: string; agency_code: string };
  counts: Record<string, number>;
}

export async function purgePreview(id: string): Promise<PurgePreview> {
  const a = (await q(`select id, name, agency_code from agencies where id=$1`, [id])).rows[0];
  if (!a) throw new Error("agency not found");
  const tables = ["connections","campaigns","daily_metrics","leads","meetings","deals","spend",
                  "deliverability_snapshots","alerts","threads_cache","sync_log"];
  const counts: Record<string, number> = {};
  for (const t of tables) {
    const r = await q<{ c: string }>(`select count(*) c from ${t} where agency_id=$1`, [id]);
    counts[t] = Number(r.rows[0].c);
  }
  return { agency: a as PurgePreview["agency"], counts };
}

export async function purgeAgency(id: string, confirmName: string): Promise<void> {
  const a = (await q(`select name, agency_code from agencies where id=$1`, [id])).rows[0];
  if (!a) throw new Error("agency not found");
  if (confirmName.trim() !== a.name) throw new Error("confirmation name does not match — purge aborted");
  const conns = await q<{ secret_id: string | null }>(
    `select secret_id from connections where agency_id=$1`, [id]);
  for (const c of conns.rows) await revokeSecret(c.secret_id);
  const client = await pool.connect();
  try {
    await client.query("begin");
    // ON DELETE CASCADE removes every dependent row in one statement.
    await client.query(`delete from agencies where id=$1`, [id]);
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
  await audit("purge", "agency", id, { name: a.name, agency_code: a.agency_code });
}
