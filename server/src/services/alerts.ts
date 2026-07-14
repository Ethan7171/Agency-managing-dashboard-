// Every alert lands in the alerts table (in-app alert center) and, unless the
// agency is paused/archived, is pushed to Slack. Fingerprints dedupe so a
// standing condition doesn't re-fire every agent run.
import { q } from "../db/pool.js";
import { postSlack } from "./slack.js";

export type Severity = "info" | "warning" | "critical";

export async function raiseAlert(opts: {
  agencyId: string | null;
  type: string;
  severity: Severity;
  message: string;
  fingerprint: string;      // e.g. "bounce:agencyId:2026-07-11"
  slackChannelId?: string | null;
  notify?: boolean;
}): Promise<boolean> {
  const { rows } = await q(
    `insert into alerts (agency_id, type, severity, message, fingerprint)
     values ($1,$2,$3,$4,$5)
     on conflict (fingerprint) do nothing
     returning id`,
    [opts.agencyId, opts.type, opts.severity, opts.message, opts.fingerprint]
  );
  const isNew = rows.length > 0;
  if (isNew && (opts.notify ?? true)) {
    const icon = opts.severity === "critical" ? "🔴" : opts.severity === "warning" ? "🟠" : "🔵";
    await postSlack(`${icon} *${opts.type}* — ${opts.message}`, opts.slackChannelId);
  }
  return isNew;
}
