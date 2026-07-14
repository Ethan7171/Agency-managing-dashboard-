import { Router } from "express";
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { q } from "../db/pool.js";
import { config } from "../config.js";
import { makeSession, requireAuth } from "../middleware/auth.js";
import { storeSecret, readSecret, revokeSecret, sha256 } from "../vault.js";
import { adapterFor, Platform } from "../adapters/index.js";
import { agencyRollup, momDeltas } from "../services/rollup.js";
import { pauseAgency, resumeAgency, archiveAgency, purgePreview, purgeAgency } from "../services/lifecycle.js";
import { exportAgencyCsv } from "../services/exporter.js";
import { audit } from "../services/audit.js";
import { buildDigest } from "../jobs/digest.js";
import { enqueueSync } from "../jobs/index.js";
import { syncAgency } from "../jobs/syncAgency.js";

// All handlers are async. Express 4 doesn't catch rejected promises, so a
// thrown route error would crash the process — this proxy wraps every handler
// registered on the router in Promise.resolve().catch(next).
const baseRouter = Router();
type Handler = (...args: unknown[]) => unknown;
const wrapAsync = (h: Handler): Handler =>
  (req: unknown, res: unknown, next: unknown) =>
    Promise.resolve(h(req, res, next)).catch(next as (e: unknown) => void);
export const api: Router = new Proxy(baseRouter, {
  get(target, prop, receiver) {
    if (["get", "post", "put", "patch", "delete"].includes(prop as string)) {
      return (path: string, ...handlers: Handler[]) =>
        (target as unknown as Record<string, Handler>)[prop as string](
          path, ...handlers.map(h => (typeof h === "function" ? wrapAsync(h) : h)));
    }
    const v = Reflect.get(target, prop, receiver);
    return typeof v === "function" ? (v as Handler).bind(target) : v;
  }
}) as Router;

/* ---------------- auth ---------------- */
api.post("/auth/login", (req, res) => {
  const given = String(req.body?.password ?? "");
  const want = config.adminPassword();
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(want).digest();
  if (!timingSafeEqual(a, b)) { res.status(401).json({ error: "wrong password" }); return; }
  res.cookie("flax_session", makeSession(), {
    httpOnly: true, sameSite: "lax", secure: config.appBaseUrl.startsWith("https"), maxAge: 7 * 864e5
  });
  res.json({ ok: true });
});
api.post("/auth/logout", (_req, res) => { res.clearCookie("flax_session"); res.json({ ok: true }); });

/* ------------- webhooks (token-authed, NOT session-authed) -------------
   Each connection gets its own inbound URL: /api/webhooks/:connectionId/:token
   The token is generated at connect time; only its sha256 is stored. Payloads
   from the internet are validated: token must match, body must be sane JSON,
   and only whitelisted event shapes touch the DB. */
api.post("/webhooks/:connectionId/:token", async (req, res) => {
  const { connectionId, token } = req.params;
  const conn = (await q(
    `select id, agency_id, webhook_token_hash from connections where id=$1 and active`, [connectionId])).rows[0] as any;
  if (!conn?.webhook_token_hash || sha256(token) !== conn.webhook_token_hash) {
    res.status(401).json({ error: "invalid webhook token" }); return;
  }
  const body = req.body as Record<string, unknown>;
  if (!body || typeof body !== "object") { res.status(400).json({ error: "bad payload" }); return; }
  const event = String(body.event_type ?? body.event ?? body.type ?? "").toLowerCase();
  // Whitelist: reply / bounce style events only; anything else is acknowledged and dropped.
  if (/(reply|replied)/.test(event)) {
    const email = String((body as any).lead_email ?? (body as any).email ?? "");
    await q(
      `insert into alerts (agency_id, type, severity, message, fingerprint)
       values ($1,'realtime_reply','info',$2,$3) on conflict (fingerprint) do nothing`,
      [conn.agency_id, `Real-time reply${email ? ` from ${email}` : ""} — sync queued.`,
       `rt_reply:${conn.id}:${sha256(JSON.stringify(body)).slice(0, 16)}`]);
    await enqueueSync(conn.agency_id); // pull the fresh thread promptly
  } else if (/(bounce|bounced|spam)/.test(event)) {
    await enqueueSync(conn.agency_id);
  }
  res.json({ ok: true });
});

/* ---------------- everything below requires the Flax session ---------------- */
api.use(requireAuth);

/* ---------------- rollup / overview ---------------- */
api.get("/rollup", async (req, res) => {
  const win = req.query.window === "7" ? 7 : req.query.window === "all" ? 0 : 30;
  res.json(await agencyRollup(win as 0 | 7 | 30, req.query.archived === "true"));
});

api.get("/digest/daily", async (_req, res) => {
  const d = await buildDigest();
  res.json(d.json);
});
api.get("/digest/daily.txt", async (_req, res) => {
  const d = await buildDigest();
  res.type("text/plain").send(d.text);
});

/* ---------------- agencies ---------------- */
api.get("/agencies", async (_req, res) => {
  res.json((await q(`select * from agencies order by status, name`)).rows);
});

api.get("/agencies/:id", async (req, res) => {
  const a = (await q(`select * from agencies where id=$1`, [req.params.id])).rows[0];
  if (!a) { res.status(404).json({ error: "not found" }); return; }
  const conns = (await q(
    `select id, platform, instance_url, scope, active, last_synced_at, sync_status, last_error, created_at
     from connections where agency_id=$1 order by created_at desc`, [req.params.id])).rows;
  res.json({ ...a, connections: conns });
});

api.post("/agencies", async (req, res) => {
  const { name, agency_code, primary_contact, slack_channel_id, notes,
          sla_daily_sends, threshold_bounce_rate, roi_keep_threshold, roi_cut_threshold } = req.body ?? {};
  if (!name || !agency_code) { res.status(400).json({ error: "name and agency_code are required" }); return; }
  if (!/^[a-z0-9_-]{2,32}$/i.test(agency_code)) {
    res.status(400).json({ error: "agency_code must be 2–32 chars, letters/numbers/dash/underscore" }); return;
  }
  try {
    const r = await q(
      `insert into agencies (name, agency_code, primary_contact, slack_channel_id, notes,
         sla_daily_sends, threshold_bounce_rate, roi_keep_threshold, roi_cut_threshold, status)
       values ($1,$2,$3,$4,$5,coalesce($6,0),coalesce($7,0.03),coalesce($8,2.0),coalesce($9,1.0),'trial')
       returning *`,
      [name, agency_code, primary_contact ?? null, slack_channel_id ?? null, notes ?? null,
       sla_daily_sends, threshold_bounce_rate, roi_keep_threshold, roi_cut_threshold]);
    await audit("create", "agency", r.rows[0].id, { name, agency_code });
    res.json(r.rows[0]);
  } catch (e) {
    if (String((e as Error).message).includes("agencies_agency_code_key")) {
      res.status(409).json({ error: "that agency_code is already in use" }); return;
    }
    throw e;
  }
});

api.patch("/agencies/:id", async (req, res) => {
  const allowed = ["name","primary_contact","slack_channel_id","notes","sla_daily_sends",
    "threshold_bounce_rate","threshold_spam_rate","sla_no_positive_days",
    "roi_keep_threshold","roi_cut_threshold","status"];
  const sets: string[] = []; const vals: unknown[] = [req.params.id];
  for (const k of allowed) if (k in (req.body ?? {})) { vals.push(req.body[k]); sets.push(`${k}=$${vals.length}`); }
  if (!sets.length) { res.status(400).json({ error: "nothing to update" }); return; }
  const r = await q(`update agencies set ${sets.join(", ")}, updated_at=now() where id=$1 returning *`, vals);
  await audit("update", "agency", req.params.id, req.body);
  res.json(r.rows[0]);
});

/* lifecycle */
api.post("/agencies/:id/pause", async (req, res) => { await pauseAgency(req.params.id); res.json({ ok: true }); });
api.post("/agencies/:id/resume", async (req, res) => { await resumeAgency(req.params.id); res.json({ ok: true }); });
api.post("/agencies/:id/archive", async (req, res) => {
  const r = await archiveAgency(req.params.id);
  res.json({ ok: true, lifetime: r.lifetime,
    reminder: "The read-only key has been revoked in our vault. Also revoke it on the agency's side so no credential is left standing." });
});
api.get("/agencies/:id/purge-preview", async (req, res) => res.json(await purgePreview(req.params.id)));
api.post("/agencies/:id/purge", async (req, res) => {
  try {
    await purgeAgency(req.params.id, String(req.body?.confirm_name ?? ""));
    res.json({ ok: true, reminder: "All data purged. Revoke the key on the agency's side as well." });
  } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});
api.get("/agencies/:id/export.csv", async (req, res) => {
  const { filename, body } = await exportAgencyCsv(req.params.id);
  await audit("export", "agency", req.params.id);
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.type("text/csv").send(body);
});

/* ---------------- connections (vault-backed) ---------------- */
api.post("/connections/test", async (req, res) => {
  // Test WITHOUT storing — powers the green check in the add flow.
  const { platform, api_key, instance_url } = req.body ?? {};
  if (!platform || !api_key) { res.status(400).json({ error: "platform and api_key required" }); return; }
  const result = await adapterFor(platform as Platform)
    .testConnection({ apiKey: String(api_key), instanceUrl: instance_url || undefined });
  res.json(result);
});

api.post("/agencies/:id/connections", async (req, res) => {
  const { platform, api_key, instance_url } = req.body ?? {};
  if (!platform || !api_key) { res.status(400).json({ error: "platform and api_key required" }); return; }
  if (platform === "emailbison" && !instance_url) {
    res.status(400).json({ error: "Email Bison requires the account's instance URL" }); return;
  }
  const test = await adapterFor(platform as Platform)
    .testConnection({ apiKey: String(api_key), instanceUrl: instance_url || undefined });
  if (!test.ok) { res.status(400).json({ error: `Connection test failed: ${test.message}` }); return; }

  const agency = (await q(`select agency_code, name from agencies where id=$1`, [req.params.id])).rows[0] as any;
  if (!agency) { res.status(404).json({ error: "agency not found" }); return; }

  // Platform swap keeps agency_id and full history: old connections are
  // deactivated (their campaigns/metrics remain), the new one takes over.
  const old = (await q(`select id, secret_id from connections where agency_id=$1 and active`, [req.params.id])).rows as any[];
  for (const o of old) { await revokeSecret(o.secret_id); }
  await q(`update connections set active=false, sync_status='paused', secret_id=null where agency_id=$1 and active`, [req.params.id]);

  const secretId = await storeSecret(`${agency.agency_code}:${platform}`, String(api_key));
  const webhookToken = randomBytes(24).toString("hex");
  const r = await q(
    `insert into connections (agency_id, platform, secret_id, instance_url, webhook_token_hash)
     values ($1,$2,$3,$4,$5) returning id, platform, instance_url, sync_status, created_at`,
    [req.params.id, platform, secretId, instance_url ?? null, sha256(webhookToken)]);
  await q(`update agencies set status = case when status='trial' then 'active' else status end where id=$1`, [req.params.id]);
  await audit("connect", "connection", r.rows[0].id, { platform, agency: agency.name });

  // Backfill so the agency doesn't start from an empty chart.
  await enqueueSync(req.params.id, config.backfillDays).catch(() => syncAgency(req.params.id, config.backfillDays));

  res.json({
    ...r.rows[0],
    test_message: test.message,
    backfill_days: config.backfillDays,
    // Shown ONCE. Only the hash is stored.
    webhook_url: `${config.appBaseUrl}/api/webhooks/${r.rows[0].id}/${webhookToken}`
  });
});

api.post("/connections/:id/rotate-key", async (req, res) => {
  const { api_key } = req.body ?? {};
  const conn = (await q(`select * from connections where id=$1`, [req.params.id])).rows[0] as any;
  if (!conn) { res.status(404).json({ error: "not found" }); return; }
  const test = await adapterFor(conn.platform as Platform)
    .testConnection({ apiKey: String(api_key), instanceUrl: conn.instance_url ?? undefined });
  if (!test.ok) { res.status(400).json({ error: `New key failed: ${test.message}` }); return; }
  await revokeSecret(conn.secret_id);
  const secretId = await storeSecret(`rotated:${conn.id}`, String(api_key));
  await q(`update connections set secret_id=$2, sync_status='pending', last_error=null where id=$1`,
    [req.params.id, secretId]);
  await audit("rotate_key", "connection", req.params.id);
  res.json({ ok: true, message: test.message });
});

api.post("/connections/:id/test", async (req, res) => {
  const conn = (await q(`select * from connections where id=$1`, [req.params.id])).rows[0] as any;
  if (!conn) { res.status(404).json({ error: "not found" }); return; }
  if (conn.sync_status === "demo") { res.json({ ok: true, message: "Demo connection — always green." }); return; }
  if (!conn.secret_id) { res.json({ ok: false, message: "No credential on file (revoked or never set)." }); return; }
  const key = await readSecret(conn.secret_id);
  res.json(await adapterFor(conn.platform as Platform)
    .testConnection({ apiKey: key, instanceUrl: conn.instance_url ?? undefined }));
});

api.post("/agencies/:id/sync-now", async (req, res) => {
  await enqueueSync(req.params.id).catch(() => syncAgency(req.params.id));
  res.json({ ok: true });
});

/* ---------------- metrics / deep-dive ---------------- */
api.get("/agencies/:id/metrics", async (req, res) => {
  const days = Math.min(365, Number(req.query.days ?? 90));
  const rows = (await q(
    `select date, sum(emails_sent)::int emails_sent, sum(delivered)::int delivered,
            sum(bounced)::int bounced, sum(opens)::int opens, sum(replies)::int replies,
            sum(positive_replies)::int positive_replies, sum(unsubscribes)::int unsubscribes,
            sum(spam_complaints)::int spam_complaints
     from daily_metrics where agency_id=$1 and date >= current_date - $2::int
     group by date order by date`, [req.params.id, days])).rows;
  res.json(rows);
});

api.get("/agencies/:id/mom", async (req, res) => res.json(await momDeltas(req.params.id)));

api.get("/agencies/:id/funnel", async (req, res) => {
  const all = await agencyRollup(Number(req.query.window ?? 30) as 0 | 7 | 30, true);
  res.json(all.find(r => r.agency_id === req.params.id) ?? null);
});

api.get("/agencies/:id/campaigns", async (req, res) => {
  res.json((await q(
    `select c.id, c.name, c.status,
       coalesce(sum(m.emails_sent),0)::int sent, coalesce(sum(m.replies),0)::int replies,
       coalesce(sum(m.positive_replies),0)::int positive
     from campaigns c left join daily_metrics m on m.campaign_id=c.id
     where c.agency_id=$1 group by c.id order by sent desc`, [req.params.id])).rows);
});

api.get("/agencies/:id/deliverability", async (req, res) => {
  res.json((await q(
    `select date, bounce_rate, spam_rate, inbox_placement, domain_health, blacklist_hits
     from deliverability_snapshots where agency_id=$1 order by date desc limit 60`, [req.params.id])).rows);
});

api.get("/agencies/:id/deals", async (req, res) => {
  res.json((await q(
    `select deal_name, value, recurring_value_mrr, status, won_at from deals
     where agency_id=$1 order by coalesce(won_at, created_at) desc limit 100`, [req.params.id])).rows);
});

api.get("/agencies/:id/meetings", async (req, res) => {
  res.json((await q(
    `select booked_at, scheduled_for, outcome, lead_name from meetings
     where agency_id=$1 order by booked_at desc limit 200`, [req.params.id])).rows);
});

api.get("/deals/unattributed", async (_req, res) => {
  res.json((await q(
    `select id, deal_name, value, recurring_value_mrr, status, won_at, close_opportunity_id
     from deals where agency_id is null order by coalesce(won_at, created_at) desc`)).rows);
});
api.post("/deals/:id/attribute", async (req, res) => {
  const { agency_id } = req.body ?? {};
  await q(`update deals set agency_id=$2 where id=$1`, [req.params.id, agency_id || null]);
  await audit("attribute", "deal", req.params.id, { agency_id });
  res.json({ ok: true });
});

/* ---------------- spend ---------------- */
api.get("/agencies/:id/spend", async (req, res) => {
  res.json((await q(`select * from spend where agency_id=$1 order by period desc`, [req.params.id])).rows);
});
api.put("/agencies/:id/spend", async (req, res) => {
  const { period, retainer = 0, per_meeting_fee = 0, per_close_fee = 0, total_spend, notes } = req.body ?? {};
  if (!period) { res.status(400).json({ error: "period (YYYY-MM-01) required" }); return; }
  const total = total_spend ?? Number(retainer) + Number(per_meeting_fee) + Number(per_close_fee);
  const r = await q(
    `insert into spend (agency_id, period, retainer, per_meeting_fee, per_close_fee, total_spend, notes)
     values ($1,$2,$3,$4,$5,$6,$7)
     on conflict (agency_id, period) do update set retainer=excluded.retainer,
       per_meeting_fee=excluded.per_meeting_fee, per_close_fee=excluded.per_close_fee,
       total_spend=excluded.total_spend, notes=excluded.notes
     returning *`,
    [req.params.id, period, retainer, per_meeting_fee, per_close_fee, total, notes ?? null]);
  await audit("spend_upsert", "spend", r.rows[0].id, req.body);
  res.json(r.rows[0]);
});

/* ---------------- alerts ---------------- */
api.get("/alerts", async (req, res) => {
  const showAll = req.query.all === "true";
  res.json((await q(
    `select al.*, a.name agency_name from alerts al
     left join agencies a on a.id = al.agency_id
     where ($1 or (al.acknowledged_at is null and not al.muted))
     order by case al.severity when 'critical' then 0 when 'warning' then 1 else 2 end, al.created_at desc
     limit 300`, [showAll])).rows);
});
api.post("/alerts/:id/ack", async (req, res) => {
  await q(`update alerts set acknowledged_at=now() where id=$1`, [req.params.id]); res.json({ ok: true });
});
api.post("/alerts/:id/mute", async (req, res) => {
  await q(`update alerts set muted=true where id=$1`, [req.params.id]); res.json({ ok: true });
});

/* ---------------- threads / inbox ---------------- */
api.get("/threads", async (req, res) => {
  const { agency_id, filter } = req.query;
  const cond: string[] = []; const vals: unknown[] = [];
  if (agency_id) { vals.push(agency_id); cond.push(`t.agency_id=$${vals.length}`); }
  if (filter === "positive") cond.push(`(t.interest_status in ('positive','interested','meeting_booked','booked') or t.ai_sentiment='positive')`);
  if (filter === "booked") cond.push(`t.interest_status in ('meeting_booked','booked','meeting_completed')`);
  res.json((await q(
    `select t.*, a.name agency_name from threads_cache t
     join agencies a on a.id=t.agency_id
     ${cond.length ? "where " + cond.join(" and ") : ""}
     order by t.last_message_at desc nulls last limit 200`, vals)).rows);
});

/* ---------------- leads / journey ---------------- */
api.get("/leads", async (req, res) => {
  const search = String(req.query.search ?? "").trim();
  const vals: unknown[] = []; let where = "";
  if (search) { vals.push(`%${search.toLowerCase()}%`); where = `where lower(coalesce(l.company,'')) like $1 or lower(coalesce(l.email,'')) like $1`; }
  res.json((await q(
    `select l.id, l.email, l.company, l.status, l.interest_status, l.first_contacted_at,
            l.last_activity_at, a.name agency_name, a.id agency_id
     from leads l join agencies a on a.id=l.agency_id ${where}
     order by l.last_activity_at desc nulls last limit 100`, vals)).rows);
});

api.get("/leads/:id/journey", async (req, res) => {
  const lead = (await q(
    `select l.*, a.name agency_name from leads l join agencies a on a.id=l.agency_id where l.id=$1`,
    [req.params.id])).rows[0] as any;
  if (!lead) { res.status(404).json({ error: "not found" }); return; }
  const meetings = (await q(
    `select booked_at, scheduled_for, outcome, lead_name from meetings
     where lead_id=$1 or (agency_id=$2 and lead_name ilike '%' || coalesce($3,'') || '%' and $3 is not null)
     order by booked_at`, [lead.id, lead.agency_id, lead.company])).rows;
  const threads = (await q(
    `select subject, snippet, interest_status, ai_sentiment, last_message_at from threads_cache
     where agency_id=$1 and (lead_email=$2 or lead_company=$3)
     order by last_message_at`, [lead.agency_id, lead.email, lead.company])).rows;
  const deals = lead.company ? (await q(
    `select deal_name, value, recurring_value_mrr, status, won_at from deals
     where agency_id=$1 and deal_name ilike '%' || $2 || '%'`, [lead.agency_id, lead.company])).rows : [];
  res.json({ lead, meetings, threads, deals });
});

/* ---------------- audit + sync log ---------------- */
api.get("/audit", async (_req, res) => {
  res.json((await q(`select * from audit_log order by created_at desc limit 200`)).rows);
});
api.get("/sync-log", async (_req, res) => {
  res.json((await q(
    `select s.*, a.name agency_name from sync_log s left join agencies a on a.id=s.agency_id
     order by s.started_at desc limit 100`)).rows);
});
