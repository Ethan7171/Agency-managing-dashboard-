// The leaderboard math. ROI model (documented in README):
//   ROI(window) = new MRR won in window / spend allocated to window
// Spend is entered per month; a window's spend = sum of daily-prorated monthly
// spend across the window, so a 7d window costs ~7/30 of the retainer.
// Lifetime ROI = cumulative MRR won / cumulative spend.
import { q } from "../db/pool.js";

export interface AgencyRollup {
  agency_id: string;
  name: string;
  agency_code: string;
  status: string;
  platform: string | null;
  sync_status: string | null;
  last_synced_at: string | null;
  slack_channel_id: string | null;
  emails_sent: number;
  delivered: number;
  bounced: number;
  bounce_rate: number;
  spam_complaints: number;
  spam_rate: number;
  opens: number;
  open_rate: number;
  replies: number;
  reply_rate: number;
  positive_replies: number;
  positive_reply_rate: number;
  unsubscribes: number;
  meetings_booked: number;
  showed: number;
  no_shows: number;
  show_rate: number;
  closes: number;
  deal_value: number;
  mrr_won: number;
  spend: number;
  roi: number | null;
  roi30: number | null;
  cost_per_positive_reply: number | null;
  cost_per_meeting: number | null;
  cost_per_close: number | null;
  verdict: "keep" | "watch" | "cut" | "no_data";
  send_trend: number[];
  positive_trend: number[];
}

const ROLLUP_SQL = `
with params as (select $1::int as win),
m as (
  select agency_id,
    coalesce(sum(emails_sent),0) sent, coalesce(sum(delivered),0) delivered,
    coalesce(sum(bounced),0) bounced, coalesce(sum(opens),0) opens,
    coalesce(sum(replies),0) replies, coalesce(sum(positive_replies),0) positive,
    coalesce(sum(unsubscribes),0) unsubs, coalesce(sum(spam_complaints),0) spam
  from daily_metrics, params
  where ($1 = 0 or date >= current_date - (select win from params))
  group by agency_id
),
mt as (
  select agency_id,
    count(*) filter (where outcome in ('booked','showed','no_show','rescheduled')) booked,
    count(*) filter (where outcome='showed') showed,
    count(*) filter (where outcome='no_show') no_shows
  from meetings, params
  where ($1 = 0 or booked_at >= now() - make_interval(days => (select win from params)))
  group by agency_id
),
d as (
  select agency_id,
    count(*) filter (where status='won') closes,
    coalesce(sum(value) filter (where status='won'),0) deal_value,
    coalesce(sum(recurring_value_mrr) filter (where status='won'),0) mrr_won
  from deals, params
  where agency_id is not null
    and ($1 = 0 or (won_at is not null and won_at >= now() - make_interval(days => (select win from params))))
  group by agency_id
),
-- daily-prorated spend over the window: each month's spend contributes
-- (overlap days between that month and the window) / (days in month)
sp2 as (
  select agency_id,
    sum(case when (select win from params) = 0 then total_spend
         else total_spend
              / greatest(1, extract(day from (period + interval '1 month' - interval '1 day'))::numeric)
              * greatest(0, least((period + interval '1 month' - interval '1 day')::date, current_date)
                          - greatest(period, current_date - (select win from params)) + 1)
         end) spend
  from spend, params
  group by agency_id
),
-- fixed trailing-30d ROI inputs: the verdict must not change with the display window
d30 as (
  select agency_id, coalesce(sum(recurring_value_mrr),0) mrr30
  from deals
  where status = 'won' and agency_id is not null and won_at >= now() - interval '30 days'
  group by agency_id
),
s30 as (
  select agency_id,
    sum(total_spend
        / greatest(1, extract(day from (period + interval '1 month' - interval '1 day'))::numeric)
        * greatest(0, least((period + interval '1 month' - interval '1 day')::date, current_date)
                    - greatest(period, current_date - 30) + 1)) spend30
  from spend
  group by agency_id
),
trend as (
  select agency_id,
    array_agg(coalesce(sent,0) order by d) send_trend,
    array_agg(coalesce(pos,0) order by d) positive_trend
  from (
    select a.id agency_id, g.d::date d,
      (select sum(emails_sent) from daily_metrics dm where dm.agency_id=a.id and dm.date=g.d::date) sent,
      (select sum(positive_replies) from daily_metrics dm where dm.agency_id=a.id and dm.date=g.d::date) pos
    from agencies a cross join generate_series(current_date - 13, current_date, interval '1 day') g(d)
  ) t group by agency_id
)
select a.id agency_id, a.name, a.agency_code, a.status,
  a.roi_keep_threshold, a.roi_cut_threshold, a.slack_channel_id,
  c.platform, c.sync_status, c.last_synced_at,
  coalesce(m.sent,0)::int emails_sent, coalesce(m.delivered,0)::int delivered,
  coalesce(m.bounced,0)::int bounced, coalesce(m.opens,0)::int opens,
  coalesce(m.replies,0)::int replies, coalesce(m.positive,0)::int positive_replies,
  coalesce(m.unsubs,0)::int unsubscribes, coalesce(m.spam,0)::int spam_complaints,
  coalesce(mt.booked,0)::int meetings_booked, coalesce(mt.showed,0)::int showed,
  coalesce(mt.no_shows,0)::int no_shows,
  coalesce(d.closes,0)::int closes, coalesce(d.deal_value,0)::numeric deal_value,
  coalesce(d.mrr_won,0)::numeric mrr_won, coalesce(sp2.spend,0)::numeric spend,
  coalesce(d30.mrr30,0)::numeric mrr30, coalesce(s30.spend30,0)::numeric spend30,
  coalesce(trend.send_trend, '{}') send_trend,
  coalesce(trend.positive_trend, '{}') positive_trend
from agencies a
left join lateral (
  select platform, sync_status, last_synced_at from connections
  where agency_id=a.id and active order by created_at desc limit 1
) c on true
left join m on m.agency_id=a.id
left join mt on mt.agency_id=a.id
left join d on d.agency_id=a.id
left join sp2 on sp2.agency_id=a.id
left join d30 on d30.agency_id=a.id
left join s30 on s30.agency_id=a.id
left join trend on trend.agency_id=a.id
where ($2::boolean or a.status <> 'archived')
order by case when coalesce(sp2.spend,0) > 0 then coalesce(d.mrr_won,0)/sp2.spend else -1 end desc`;

export async function agencyRollup(windowDays: 0 | 7 | 30, includeArchived = false): Promise<AgencyRollup[]> {
  const { rows } = await q(ROLLUP_SQL, [windowDays, includeArchived]);
  return rows.map((r: any) => {
    const sent = Number(r.emails_sent), delivered = Number(r.delivered);
    const spend = Number(r.spend), mrr = Number(r.mrr_won);
    const roi = spend > 0 ? mrr / spend : null;
    const pos = Number(r.positive_replies), booked = Number(r.meetings_booked), closes = Number(r.closes);
    // Verdict is always judged on the trailing 30 days, whatever the display window.
    const spend30 = Number(r.spend30), mrr30 = Number(r.mrr30);
    const roi30 = spend30 > 0 ? mrr30 / spend30 : null;
    const verdict: AgencyRollup["verdict"] =
      r.status === "archived" ? "no_data"
      : roi30 == null ? "no_data"
      : roi30 >= Number(r.roi_keep_threshold) ? "keep"
      : roi30 < Number(r.roi_cut_threshold) ? "cut" : "watch";
    return {
      agency_id: r.agency_id, name: r.name, agency_code: r.agency_code, status: r.status,
      platform: r.platform, sync_status: r.sync_status, last_synced_at: r.last_synced_at,
      slack_channel_id: r.slack_channel_id,
      emails_sent: sent, delivered, bounced: Number(r.bounced),
      bounce_rate: sent ? Number(r.bounced) / sent : 0,
      spam_complaints: Number(r.spam_complaints),
      spam_rate: sent ? Number(r.spam_complaints) / sent : 0,
      opens: Number(r.opens), open_rate: delivered ? Number(r.opens) / delivered : 0,
      replies: Number(r.replies), reply_rate: delivered ? Number(r.replies) / delivered : 0,
      positive_replies: pos, positive_reply_rate: delivered ? pos / delivered : 0,
      unsubscribes: Number(r.unsubscribes),
      meetings_booked: booked, showed: Number(r.showed), no_shows: Number(r.no_shows),
      show_rate: booked ? Number(r.showed) / booked : 0,
      closes, deal_value: Number(r.deal_value), mrr_won: mrr, spend,
      roi, roi30,
      cost_per_positive_reply: pos && spend ? spend / pos : null,
      cost_per_meeting: booked && spend ? spend / booked : null,
      cost_per_close: closes && spend ? spend / closes : null,
      verdict,
      send_trend: (r.send_trend ?? []).map(Number),
      positive_trend: (r.positive_trend ?? []).map(Number)
    };
  });
}

// MoM deltas: compare this calendar month to last for the headline metrics.
export async function momDeltas(agencyId: string) {
  const { rows } = await q(`
    with cur as (
      select coalesce(sum(emails_sent),0) sent, coalesce(sum(replies),0) replies,
             coalesce(sum(positive_replies),0) positive
      from daily_metrics where agency_id=$1 and date >= date_trunc('month', current_date)),
    prev as (
      select coalesce(sum(emails_sent),0) sent, coalesce(sum(replies),0) replies,
             coalesce(sum(positive_replies),0) positive
      from daily_metrics where agency_id=$1
        and date >= date_trunc('month', current_date) - interval '1 month'
        and date < date_trunc('month', current_date)),
    dcur as (select coalesce(sum(recurring_value_mrr),0) mrr, count(*) closes from deals
             where agency_id=$1 and status='won' and won_at >= date_trunc('month', current_date)),
    dprev as (select coalesce(sum(recurring_value_mrr),0) mrr, count(*) closes from deals
             where agency_id=$1 and status='won'
               and won_at >= date_trunc('month', current_date) - interval '1 month'
               and won_at < date_trunc('month', current_date)),
    scur as (select coalesce(sum(total_spend),0) spend from spend
             where agency_id=$1 and period = date_trunc('month', current_date)::date),
    sprev as (select coalesce(sum(total_spend),0) spend from spend
             where agency_id=$1 and period = (date_trunc('month', current_date) - interval '1 month')::date)
    select cur.sent cur_sent, prev.sent prev_sent, cur.replies cur_replies, prev.replies prev_replies,
           cur.positive cur_positive, prev.positive prev_positive,
           dcur.mrr cur_mrr, dprev.mrr prev_mrr, dcur.closes cur_closes, dprev.closes prev_closes,
           scur.spend cur_spend, sprev.spend prev_spend
    from cur, prev, dcur, dprev, scur, sprev`, [agencyId]);
  const r: any = rows[0] ?? {};
  const delta = (c: number, p: number) => (p > 0 ? (c - p) / p : null);
  const numify = (x: any) => Number(x ?? 0);
  const curRoi = numify(r.cur_spend) > 0 ? numify(r.cur_mrr) / numify(r.cur_spend) : null;
  const prevRoi = numify(r.prev_spend) > 0 ? numify(r.prev_mrr) / numify(r.prev_spend) : null;
  return {
    sent: { current: numify(r.cur_sent), previous: numify(r.prev_sent), delta: delta(numify(r.cur_sent), numify(r.prev_sent)) },
    replies: { current: numify(r.cur_replies), previous: numify(r.prev_replies), delta: delta(numify(r.cur_replies), numify(r.prev_replies)) },
    positive: { current: numify(r.cur_positive), previous: numify(r.prev_positive), delta: delta(numify(r.cur_positive), numify(r.prev_positive)) },
    mrr: { current: numify(r.cur_mrr), previous: numify(r.prev_mrr), delta: delta(numify(r.cur_mrr), numify(r.prev_mrr)) },
    closes: { current: numify(r.cur_closes), previous: numify(r.prev_closes), delta: delta(numify(r.cur_closes), numify(r.prev_closes)) },
    spend: { current: numify(r.cur_spend), previous: numify(r.prev_spend), delta: delta(numify(r.cur_spend), numify(r.prev_spend)) },
    roi: { current: curRoi, previous: prevRoi, delta: curRoi != null && prevRoi ? (curRoi - prevRoi) / prevRoi : null }
  };
}
