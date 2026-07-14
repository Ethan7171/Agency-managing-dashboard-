// Per-agency sync: pull campaigns, daily metrics, leads, threads, and a
// deliverability snapshot from the agency's platform, normalized into the
// unified schema. Runs on the pg-boss schedule; also invoked with a backfill
// window right after onboarding.
import { q } from "../db/pool.js";
import { adapterFor, Platform, Creds } from "../adapters/index.js";
import { readSecret } from "../vault.js";
import { config } from "../config.js";
import { classifyReply } from "../services/classify.js";

const domainOf = (email?: string | null) =>
  email && email.includes("@") ? email.split("@")[1].toLowerCase() : null;

export async function syncAgency(agencyId: string, backfillDays?: number): Promise<void> {
  const conn = (await q(
    `select c.*, a.status agency_status from connections c
     join agencies a on a.id = c.agency_id
     where c.agency_id=$1 and c.active order by c.created_at desc limit 1`, [agencyId])).rows[0] as any;
  if (!conn) return;
  if (conn.agency_status === "paused" || conn.agency_status === "archived") return;
  if (conn.sync_status === "demo" || config.demoMode) return; // seeded data only

  const log = (await q<{ id: string }>(
    `insert into sync_log (agency_id, connection_id, job) values ($1,$2,'sync:agency') returning id`,
    [agencyId, conn.id])).rows[0];

  try {
    const apiKey = await readSecret(conn.secret_id);
    const creds: Creds = { apiKey, instanceUrl: conn.instance_url ?? undefined };
    const adapter = adapterFor(conn.platform as Platform);
    const days = backfillDays ?? 3; // routine syncs re-pull a short overlap window
    const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
    const until = new Date().toISOString().slice(0, 10);
    let rows = 0;

    // 1. campaigns
    const campaigns = await adapter.fetchCampaigns(creds);
    const campaignIdByPlatformId = new Map<string, string>();
    for (const c of campaigns) {
      const r = await q<{ id: string }>(
        `insert into campaigns (agency_id, connection_id, platform_campaign_id, name, status)
         values ($1,$2,$3,$4,$5)
         on conflict (connection_id, platform_campaign_id)
         do update set name=excluded.name, status=excluded.status
         returning id`,
        [agencyId, conn.id, c.platformCampaignId, c.name, c.status ?? null]);
      campaignIdByPlatformId.set(c.platformCampaignId, r.rows[0].id);
    }

    // 2. daily metrics (idempotent upsert on campaign+date)
    for (const m of await adapter.fetchDailyMetrics(creds, since, until)) {
      const cid = campaignIdByPlatformId.get(m.platformCampaignId);
      if (!cid) continue;
      await q(
        `insert into daily_metrics (agency_id, campaign_id, date, emails_sent, delivered, bounced,
           opens, replies, positive_replies, unsubscribes, spam_complaints)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         on conflict (campaign_id, date) do update set
           emails_sent=excluded.emails_sent, delivered=excluded.delivered, bounced=excluded.bounced,
           opens=excluded.opens, replies=excluded.replies, positive_replies=excluded.positive_replies,
           unsubscribes=excluded.unsubscribes, spam_complaints=excluded.spam_complaints`,
        [agencyId, cid, m.date, m.emailsSent, m.delivered, m.bounced, m.opens,
         m.replies, m.positiveReplies, m.unsubscribes, m.spamComplaints]);
      rows++;
    }

    // 3. leads (company powers the collision detector)
    for (const l of await adapter.fetchLeads(creds, since)) {
      await q(
        `insert into leads (agency_id, platform_lead_id, email, company, company_domain,
           status, interest_status, last_activity_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8)
         on conflict (agency_id, platform_lead_id) do update set
           status=excluded.status,
           interest_status=coalesce(excluded.interest_status, leads.interest_status),
           last_activity_at=excluded.last_activity_at`,
        [agencyId, l.platformLeadId, l.email ?? null, l.company ?? null,
         domainOf(l.email), l.status ?? null, l.interestStatus ?? null, l.lastActivityAt ?? null]);
      rows++;
    }

    // 4. threads (+ AI sentiment where the platform didn't label)
    for (const t of await adapter.fetchThreads(creds, 100)) {
      let ai: string | null = null;
      if (!t.interestStatus) {
        const inbound = t.messages.filter(m => m.direction === "inbound").map(m => m.body).join("\n").trim();
        if (inbound) ai = await classifyReply(inbound);
      }
      await q(
        `insert into threads_cache (agency_id, platform_thread_id, lead_email, lead_company,
           subject, snippet, interest_status, ai_sentiment, messages, deep_link, last_message_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         on conflict (agency_id, platform_thread_id) do update set
           snippet=excluded.snippet, interest_status=coalesce(excluded.interest_status, threads_cache.interest_status),
           ai_sentiment=coalesce(excluded.ai_sentiment, threads_cache.ai_sentiment),
           messages=excluded.messages, last_message_at=excluded.last_message_at`,
        [agencyId, t.platformThreadId, t.leadEmail ?? null, t.leadCompany ?? null,
         t.subject ?? null, t.snippet ?? null, t.interestStatus ?? null, ai,
         JSON.stringify(t.messages), t.deepLink ?? null, t.lastMessageAt ?? null]);
      rows++;
    }

    // 5. deliverability snapshot for today
    const d = await adapter.fetchDeliverability(creds);
    if (d) {
      await q(
        `insert into deliverability_snapshots (agency_id, date, bounce_rate, spam_rate, inbox_placement, domain_health)
         values ($1, current_date, $2, $3, $4, $5)
         on conflict (agency_id, date) do update set
           bounce_rate=excluded.bounce_rate, spam_rate=excluded.spam_rate,
           inbox_placement=excluded.inbox_placement, domain_health=excluded.domain_health`,
        [agencyId, d.bounceRate, d.spamRate, d.inboxPlacement ?? null,
         d.domainHealth ? JSON.stringify(d.domainHealth) : null]);
    }

    await q(`update connections set last_synced_at=now(), sync_status='ok', last_error=null where id=$1`, [conn.id]);
    await q(`update sync_log set finished_at=now(), status='ok', rows_written=$2 where id=$1`, [log.id, rows]);
  } catch (e) {
    const msg = (e as Error).message;
    await q(`update connections set sync_status='error', last_error=$2 where id=$1`, [conn.id, msg]);
    await q(`update sync_log set finished_at=now(), status='error', error=$2 where id=$1`, [log.id, msg]);
    throw e; // let pg-boss retry with backoff
  }
}
