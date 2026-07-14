// pg-boss job registration: queues, schedules, retry policy.
// Mission-critical ingestion lives here (reliable, retryable); n8n sits on top
// for the notification layer only.
import PgBoss from "pg-boss";
import { q } from "../db/pool.js";
import { config } from "../config.js";
import { syncAgency } from "./syncAgency.js";
import { syncClose } from "./syncClose.js";
import { syncHealthAgent, deliverabilityAgent, slaAgent, collisionAgent } from "./agents.js";
import { dailyDigestAgent } from "./digest.js";

export const QUEUES = {
  syncAgency: "sync-agency",
  syncAll: "sync-all",
  syncClose: "sync-close",
  agentSyncHealth: "agent-sync-health",
  agentDeliverability: "agent-deliverability",
  agentSla: "agent-sla",
  agentCollision: "agent-collision",
  agentDigest: "agent-digest"
} as const;

let boss: PgBoss | null = null;

export async function getBoss(): Promise<PgBoss> {
  if (boss) return boss;
  boss = new PgBoss({ connectionString: config.databaseUrl(), max: 4 });
  boss.on("error", e => console.error("pg-boss:", e.message));
  await boss.start();
  for (const name of Object.values(QUEUES)) {
    await boss.createQueue(name, { name, retryLimit: 5, retryDelay: 30, retryBackoff: true });
  }
  return boss;
}

export async function enqueueSync(agencyId: string, backfillDays?: number): Promise<void> {
  const b = await getBoss();
  await b.send(QUEUES.syncAgency, { agencyId, backfillDays }, { retryLimit: 5, retryBackoff: true });
}

export async function startWorker(): Promise<void> {
  const b = await getBoss();

  await b.work<{ agencyId: string; backfillDays?: number }>(QUEUES.syncAgency, async ([job]) => {
    await syncAgency(job.data.agencyId, job.data.backfillDays);
  });

  await b.work(QUEUES.syncAll, async () => {
    const rows = (await q(
      `select distinct agency_id from connections c
       join agencies a on a.id=c.agency_id
       where c.active and a.status in ('active','trial') and c.sync_status <> 'demo'`)).rows as any[];
    for (const r of rows) await enqueueSync(r.agency_id);
    await b.send(QUEUES.syncClose, {});
  });

  await b.work(QUEUES.syncClose, async () => syncClose());
  await b.work(QUEUES.agentSyncHealth, async () => syncHealthAgent());
  await b.work(QUEUES.agentDeliverability, async () => deliverabilityAgent());
  await b.work(QUEUES.agentSla, async () => slaAgent());
  await b.work(QUEUES.agentCollision, async () => collisionAgent());
  await b.work(QUEUES.agentDigest, async () => dailyDigestAgent());

  await b.schedule(QUEUES.syncAll, config.syncCron);                 // every 30 min (default)
  await b.schedule(QUEUES.agentSyncHealth, "*/15 * * * *");          // every 15 min
  await b.schedule(QUEUES.agentDeliverability, "10 * * * *");        // hourly
  await b.schedule(QUEUES.agentSla, "0 8 * * *");                    // daily 08:00 UTC
  await b.schedule(QUEUES.agentCollision, "20 * * * *");             // hourly
  await b.schedule(QUEUES.agentDigest, "0 7 * * *");                 // daily 07:00 UTC

  console.log("worker: queues registered, schedules set");
}
