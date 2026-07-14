// Full-history CSV export for an agency — also the "export before delete" file.
import { q } from "../db/pool.js";
import { agencyRollup } from "./rollup.js";

const esc = (v: unknown) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = (rows: Record<string, unknown>[], cols: string[]) =>
  [cols.join(","), ...rows.map(r => cols.map(c => esc(r[c])).join(","))].join("\n");

export async function exportAgencyCsv(agencyId: string): Promise<{ filename: string; body: string }> {
  const a = (await q(`select * from agencies where id=$1`, [agencyId])).rows[0];
  if (!a) throw new Error("agency not found");
  const all = await agencyRollup(0, true);
  const summary = all.find(r => r.agency_id === agencyId);

  const metrics = (await q(
    `select date, sum(emails_sent) emails_sent, sum(delivered) delivered, sum(bounced) bounced,
            sum(opens) opens, sum(replies) replies, sum(positive_replies) positive_replies,
            sum(unsubscribes) unsubscribes, sum(spam_complaints) spam_complaints
     from daily_metrics where agency_id=$1 group by date order by date`, [agencyId])).rows;
  const meetings = (await q(
    `select booked_at, scheduled_for, outcome, lead_name from meetings where agency_id=$1 order by booked_at`, [agencyId])).rows;
  const deals = (await q(
    `select deal_name, value, recurring_value_mrr, status, won_at from deals where agency_id=$1 order by created_at`, [agencyId])).rows;
  const spend = (await q(
    `select period, retainer, per_meeting_fee, per_close_fee, total_spend, notes from spend where agency_id=$1 order by period`, [agencyId])).rows;

  const parts: string[] = [];
  parts.push(`# Flax Labs — Agency export: ${a.name} (${a.agency_code}) — generated ${new Date().toISOString()}`);
  if (summary) {
    parts.push("\n## Lifetime summary");
    parts.push(csv([summary as unknown as Record<string, unknown>],
      ["emails_sent","delivered","replies","positive_replies","meetings_booked","showed","no_shows","closes","deal_value","mrr_won","spend","roi"]));
  }
  parts.push("\n## Daily metrics");
  parts.push(csv(metrics, ["date","emails_sent","delivered","bounced","opens","replies","positive_replies","unsubscribes","spam_complaints"]));
  parts.push("\n## Meetings");
  parts.push(csv(meetings, ["booked_at","scheduled_for","outcome","lead_name"]));
  parts.push("\n## Deals");
  parts.push(csv(deals, ["deal_name","value","recurring_value_mrr","status","won_at"]));
  parts.push("\n## Spend");
  parts.push(csv(spend, ["period","retainer","per_meeting_fee","per_close_fee","total_spend","notes"]));

  return {
    filename: `flax-${String(a.agency_code).toLowerCase()}-export-${new Date().toISOString().slice(0,10)}.csv`,
    body: parts.join("\n")
  };
}
