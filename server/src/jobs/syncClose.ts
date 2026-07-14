// Close sync — the down-funnel truth. Joins on agency_code; anything without
// a code lands in the unattributed bucket (deals.agency_id = null).
import { q } from "../db/pool.js";
import { fetchCloseDeals, fetchCloseMeetings } from "../adapters/close.js";
import { config } from "../config.js";

export async function syncClose(): Promise<void> {
  if (!config.closeApiKey || config.demoMode) return;
  const log = (await q<{ id: string }>(
    `insert into sync_log (job) values ('sync:close') returning id`)).rows[0];
  try {
    const since = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);
    const codeToAgency = new Map<string, string>();
    for (const a of (await q<{ id: string; agency_code: string }>(
      `select id, agency_code from agencies`)).rows) {
      codeToAgency.set(a.agency_code.toLowerCase(), a.id);
    }
    let rows = 0;

    for (const d of await fetchCloseDeals(since)) {
      const agencyId = d.agencyCode ? codeToAgency.get(d.agencyCode.toLowerCase()) ?? null : null;
      await q(
        `insert into deals (agency_id, close_opportunity_id, deal_name, value, recurring_value_mrr, status, won_at)
         values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (close_opportunity_id) do update set
           agency_id=excluded.agency_id, deal_name=excluded.deal_name, value=excluded.value,
           recurring_value_mrr=excluded.recurring_value_mrr, status=excluded.status, won_at=excluded.won_at`,
        [agencyId, d.closeOpportunityId, d.dealName, d.value, d.mrr, d.status, d.wonAt]);
      rows++;
    }

    for (const m of await fetchCloseMeetings(since)) {
      const agencyId = m.agencyCode ? codeToAgency.get(m.agencyCode.toLowerCase()) ?? null : null;
      if (!agencyId) continue; // meetings without attribution aren't billable events; deals bucket covers revenue
      await q(
        `insert into meetings (agency_id, close_activity_id, booked_at, scheduled_for, outcome, source, lead_name)
         values ($1,$2,$3,$4,$5,'close',$6)
         on conflict (close_activity_id) do update set
           scheduled_for=excluded.scheduled_for, outcome=excluded.outcome, lead_name=excluded.lead_name`,
        [agencyId, m.closeActivityId, m.bookedAt, m.scheduledFor, m.outcome, m.leadName]);
      rows++;
    }
    await q(`update sync_log set finished_at=now(), status='ok', rows_written=$2 where id=$1`, [log.id, rows]);
  } catch (e) {
    await q(`update sync_log set finished_at=now(), status='error', error=$2 where id=$1`,
      [log.id, (e as Error).message]);
    throw e;
  }
}
