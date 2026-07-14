// Daily digest: portfolio ROI, per-agency one-liners, biggest movers, and
// anything red. Posted to Slack each morning; also served as JSON at
// /api/digest/daily for the n8n workflow.
import { q } from "../db/pool.js";
import { agencyRollup } from "../services/rollup.js";
import { momDeltas } from "../services/rollup.js";
import { postSlack } from "../services/slack.js";

const money = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

export async function buildDigest(): Promise<{ text: string; json: unknown }> {
  const rows = await agencyRollup(30);
  const active = rows.filter(r => r.status === "active" || r.status === "trial");
  const spend = active.reduce((s, r) => s + r.spend, 0);
  const mrr = active.reduce((s, r) => s + r.mrr_won, 0);
  const portfolioRoi = spend > 0 ? mrr / spend : null;

  const reds = (await q(
    `select type, severity, message from alerts
     where severity='critical' and acknowledged_at is null and not muted
       and created_at >= now() - interval '24 hours'
     order by created_at desc limit 8`)).rows as any[];

  const movers: string[] = [];
  for (const r of active) {
    const d = await momDeltas(r.agency_id);
    if (d.positive.delta != null && Math.abs(d.positive.delta) > 0.4 && d.positive.previous >= 5) {
      movers.push(`${r.name} positive replies ${d.positive.delta > 0 ? "▲" : "▼"} ${pct(Math.abs(d.positive.delta))} MoM`);
    }
  }

  const lines = [
    `*Flax Outbound — Daily Digest* (trailing 30d)`,
    `Portfolio: ${money(mrr)} MRR won / ${money(spend)} spend → ROI ${portfolioRoi == null ? "—" : portfolioRoi.toFixed(2) + "×"} · ${active.length} active agencies`,
    ``,
    ...active.map(r => {
      const flag = r.verdict === "keep" ? "🟢" : r.verdict === "watch" ? "🟡" : r.verdict === "cut" ? "🔴" : "⚪";
      return `${flag} *${r.name}* — ${r.emails_sent.toLocaleString()} sent · ${pct(r.positive_reply_rate)} positive · ${r.meetings_booked} booked · ${r.closes} closed · ${money(r.mrr_won)} MRR · ROI ${r.roi == null ? "—" : r.roi.toFixed(2) + "×"}`;
    })
  ];
  if (movers.length) lines.push(``, `*Movers:* ${movers.join(" · ")}`);
  if (reds.length) lines.push(``, `*Red flags (24h):*`, ...reds.map(r => `🔴 ${r.message}`));

  return {
    text: lines.join("\n"),
    json: { generated_at: new Date().toISOString(), portfolio: { spend, mrr_won: mrr, roi: portfolioRoi }, agencies: rows, red_alerts: reds, movers }
  };
}

export async function dailyDigestAgent(): Promise<void> {
  const { text } = await buildDigest();
  await postSlack(text);
}
