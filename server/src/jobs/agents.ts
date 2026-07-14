// The standing monitoring agents. Each is a scheduled job with explicit rules
// that writes to the alerts table and escalates to Slack. Fingerprints keep
// them from re-firing the same condition every run.
import { q } from "../db/pool.js";
import { raiseAlert } from "../services/alerts.js";
import { agencyRollup } from "../services/rollup.js";

const today = () => new Date().toISOString().slice(0, 10);

type AgencyRow = {
  id: string; name: string; slack_channel_id: string | null;
  sla_daily_sends: number; threshold_bounce_rate: string; threshold_spam_rate: string;
  sla_no_positive_days: number;
};

const activeAgencies = async (): Promise<AgencyRow[]> =>
  (await q(`select id, name, slack_channel_id, sla_daily_sends, threshold_bounce_rate,
            threshold_spam_rate, sla_no_positive_days
            from agencies where status in ('active','trial')`)).rows as AgencyRow[];

// 1. Sync health — a broken connector must be loud, not silent.
export async function syncHealthAgent(): Promise<void> {
  const rows = (await q(
    `select a.id, a.name, a.slack_channel_id, c.sync_status, c.last_synced_at, c.last_error
     from agencies a
     join connections c on c.agency_id = a.id and c.active
     where a.status in ('active','trial') and c.sync_status <> 'demo'`)).rows as any[];
  for (const r of rows) {
    const stale = !r.last_synced_at || Date.now() - new Date(r.last_synced_at).getTime() > 2 * 3600e3;
    if (r.sync_status === "error") {
      await raiseAlert({
        agencyId: r.id, type: "sync_error", severity: "critical",
        message: `${r.name}: connector error — ${String(r.last_error ?? "unknown").slice(0, 200)}`,
        fingerprint: `sync_error:${r.id}:${today()}`, slackChannelId: r.slack_channel_id
      });
    } else if (stale) {
      await raiseAlert({
        agencyId: r.id, type: "sync_stale", severity: "warning",
        message: `${r.name}: data is stale — last successful sync ${r.last_synced_at ?? "never"}.`,
        fingerprint: `sync_stale:${r.id}:${today()}`, slackChannelId: r.slack_channel_id
      });
    }
  }
}

// 2. Deliverability watchdog — our oversight check that each vendor is keeping
// sending quality high. Degraded sending burns prospects pitched on Flax's
// behalf; catch it before the agency does.
export async function deliverabilityAgent(): Promise<void> {
  for (const a of await activeAgencies()) {
    const m = (await q(
      `select coalesce(sum(emails_sent),0) sent, coalesce(sum(bounced),0) bounced,
              coalesce(sum(spam_complaints),0) spam
       from daily_metrics where agency_id=$1 and date >= current_date - 7`, [a.id])).rows[0] as any;
    const sent = Number(m.sent);
    if (sent < 50) continue; // not enough volume to judge
    const bounceRate = Number(m.bounced) / sent;
    const spamRate = Number(m.spam) / sent;
    if (bounceRate > Number(a.threshold_bounce_rate)) {
      await raiseAlert({
        agencyId: a.id, type: "bounce_rate", severity: bounceRate > Number(a.threshold_bounce_rate) * 1.7 ? "critical" : "warning",
        message: `${a.name}: 7-day bounce rate ${(bounceRate * 100).toFixed(1)}% exceeds threshold ${(Number(a.threshold_bounce_rate) * 100).toFixed(1)}%.`,
        fingerprint: `bounce:${a.id}:${today()}`, slackChannelId: a.slack_channel_id
      });
    }
    if (spamRate > Number(a.threshold_spam_rate)) {
      await raiseAlert({
        agencyId: a.id, type: "spam_rate", severity: "critical",
        message: `${a.name}: spam-complaint rate ${(spamRate * 100).toFixed(2)}% exceeds threshold ${(Number(a.threshold_spam_rate) * 100).toFixed(2)}%.`,
        fingerprint: `spam:${a.id}:${today()}`, slackChannelId: a.slack_channel_id
      });
    }
    // sending dropped to ~zero unexpectedly
    const recent = (await q(
      `select coalesce(sum(emails_sent),0) s from daily_metrics
       where agency_id=$1 and date >= current_date - 2`, [a.id])).rows[0] as any;
    const baseline = (await q(
      `select coalesce(sum(emails_sent),0)/12.0 s from daily_metrics
       where agency_id=$1 and date >= current_date - 14 and date < current_date - 2`, [a.id])).rows[0] as any;
    if (Number(baseline.s) > 100 && Number(recent.s) < Number(baseline.s) * 0.1) {
      await raiseAlert({
        agencyId: a.id, type: "sending_stopped", severity: "critical",
        message: `${a.name}: sending collapsed — last 48h volume is <10% of their own 2-week baseline.`,
        fingerprint: `sending_stopped:${a.id}:${today()}`, slackChannelId: a.slack_channel_id
      });
    }
  }
}

// 3. Performance / SLA agent — below committed volume, positive-reply drought,
// or reply-rate collapse vs the agency's own baseline.
export async function slaAgent(): Promise<void> {
  for (const a of await activeAgencies()) {
    if (a.sla_daily_sends > 0) {
      const r = (await q(
        `select coalesce(avg(day_sent),0) avg_sent from (
           select date, sum(emails_sent) day_sent from daily_metrics
           where agency_id=$1 and date >= current_date - 7 group by date) t`, [a.id])).rows[0] as any;
      if (Number(r.avg_sent) < a.sla_daily_sends * 0.8) {
        await raiseAlert({
          agencyId: a.id, type: "sla_volume", severity: "warning",
          message: `${a.name}: averaging ${Math.round(Number(r.avg_sent))} sends/day over 7d, below committed ${a.sla_daily_sends}.`,
          fingerprint: `sla_volume:${a.id}:${today()}`, slackChannelId: a.slack_channel_id
        });
      }
    }
    const pos = (await q(
      `select max(date) last_pos from daily_metrics where agency_id=$1 and positive_replies > 0`, [a.id])).rows[0] as any;
    const daysSince = pos.last_pos ? Math.floor((Date.now() - new Date(pos.last_pos).getTime()) / 864e5) : null;
    if (daysSince != null && daysSince >= a.sla_no_positive_days) {
      await raiseAlert({
        agencyId: a.id, type: "positive_drought", severity: "warning",
        message: `${a.name}: no positive replies in ${daysSince} days (SLA: ${a.sla_no_positive_days}).`,
        fingerprint: `pos_drought:${a.id}:${today()}`, slackChannelId: a.slack_channel_id
      });
    }
    const rr = (await q(
      `select
        (select case when sum(delivered)>0 then sum(replies)::float/sum(delivered) else 0 end
         from daily_metrics where agency_id=$1 and date >= current_date - 7) recent,
        (select case when sum(delivered)>0 then sum(replies)::float/sum(delivered) else 0 end
         from daily_metrics where agency_id=$1 and date >= current_date - 35 and date < current_date - 7) baseline`,
      [a.id])).rows[0] as any;
    if (Number(rr.baseline) > 0.01 && Number(rr.recent) < Number(rr.baseline) * 0.4) {
      await raiseAlert({
        agencyId: a.id, type: "reply_collapse", severity: "warning",
        message: `${a.name}: reply rate collapsed to ${(Number(rr.recent) * 100).toFixed(2)}% vs their own ${(Number(rr.baseline) * 100).toFixed(2)}% baseline.`,
        fingerprint: `reply_collapse:${a.id}:${today()}`, slackChannelId: a.slack_channel_id
      });
    }
  }
}

// 4. Collision detector — two agencies emailing the same brand damages the
// prospect relationship and Flax's name in-market. Flag immediately.
export async function collisionAgent(): Promise<void> {
  const rows = (await q(
    `select coalesce(nullif(company_domain,''), lower(company)) k,
            array_agg(distinct a.name) agencies, array_agg(distinct a.id::text) ids,
            max(l.company) company
     from leads l join agencies a on a.id = l.agency_id
     where a.status in ('active','trial') and (l.company is not null or l.company_domain is not null)
     group by 1 having count(distinct l.agency_id) > 1`)).rows as any[];
  for (const r of rows) {
    await raiseAlert({
      agencyId: null, type: "lead_collision", severity: "critical",
      message: `Collision: ${r.company ?? r.k} is being emailed by ${r.agencies.join(" AND ")}. Deconflict now.`,
      fingerprint: `collision:${r.k}`
    });
  }
}
