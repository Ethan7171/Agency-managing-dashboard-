// Email Bison adapter.
// - API-first; full API access is included in the plan (no tier gate).
// - Auth: API key + a per-account dedicated instance URL (e.g. https://send.acme.com)
//   — both stored per connection; the key in the vault, the URL on the row.
// - Rate limit ~10 req/s -> local limiter + shared 429 backoff.
// Email Bison is the least publicly documented of the three platforms; field
// mapping is isolated here and expected to need a small tune against a real
// account. A community emailbison-cli/MCP exists but core ingestion stays REST.
import {
  Creds, DeliverabilityInfo, NormalizedCampaign, NormalizedDailyMetric,
  NormalizedLead, NormalizedThread, PlatformAdapter, day, n
} from "./types.js";
import { getJson, rateLimiter } from "../http.js";

const limit = rateLimiter(10, 1000);

const base = (creds: Creds) => {
  if (!creds.instanceUrl) throw new Error("Email Bison connection requires an instance URL");
  return `${creds.instanceUrl.replace(/\/+$/, "")}/api`;
};
const auth = (key: string) => ({ Authorization: `Bearer ${key}`, Accept: "application/json" });

async function get<T>(creds: Creds, path: string): Promise<T> {
  await limit();
  return getJson<T>(`${base(creds)}${path}`, { headers: auth(creds.apiKey) });
}

type EBCampaign = { id: number | string; name: string; status?: string };

export const emailbison: PlatformAdapter = {
  platform: "emailbison",

  async testConnection(creds) {
    try {
      const r = await get<{ data?: EBCampaign[] }>(creds, "/campaigns");
      return { ok: true, message: `Connected to ${creds.instanceUrl}. ${r.data?.length ?? 0} campaign(s) visible.` };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  },

  async fetchCampaigns(creds) {
    const r = await get<{ data?: EBCampaign[] }>(creds, "/campaigns");
    return (r.data ?? []).map(c => ({ platformCampaignId: String(c.id), name: c.name, status: c.status }));
  },

  async fetchDailyMetrics(creds, sinceISO, untilISO) {
    const campaigns = await this.fetchCampaigns(creds);
    const out: NormalizedDailyMetric[] = [];
    for (const c of campaigns) {
      const r = await get<{ data?: Array<Record<string, unknown>> }>(
        creds, `/campaigns/${c.platformCampaignId}/stats?start_date=${sinceISO}&end_date=${untilISO}&group_by=day`
      ).catch(() => ({ data: [] as Array<Record<string, unknown>> }));
      for (const row of r.data ?? []) {
        const date = (row.date ?? row.day) as string | undefined;
        if (!date) continue;
        const sent = n(row.sent ?? row.emails_sent), bounced = n(row.bounced ?? row.bounces);
        out.push({
          platformCampaignId: c.platformCampaignId,
          date: day(date),
          emailsSent: sent,
          delivered: n(row.delivered) || Math.max(0, sent - bounced),
          bounced,
          opens: n(row.opened ?? row.opens),
          replies: n(row.replied ?? row.replies),
          positiveReplies: n(row.interested ?? row.positive_replies),
          unsubscribes: n(row.unsubscribed ?? row.unsubscribes),
          spamComplaints: n(row.spam_complaints ?? row.spam)
        });
      }
    }
    return out;
  },

  async fetchLeads(creds, _sinceISO) {
    const r = await get<{ data?: Array<Record<string, unknown>> }>(creds, "/leads?per_page=500")
      .catch(() => ({ data: [] as Array<Record<string, unknown>> }));
    return (r.data ?? []).map(l => ({
      platformLeadId: String(l.id ?? l.email ?? ""),
      email: l.email as string | undefined,
      company: (l.company ?? l.company_name) as string | undefined,
      status: String(l.status ?? ""),
      interestStatus: (l.interest_status ?? l.classification) as string | undefined,
      lastActivityAt: (l.updated_at ?? l.last_activity_at) as string | undefined
    })).filter(l => l.platformLeadId);
  },

  async fetchThreads(creds, limitN) {
    const r = await get<{ data?: Array<Record<string, unknown>> }>(
      creds, `/replies?per_page=${Math.min(limitN, 100)}`
    ).catch(() => ({ data: [] as Array<Record<string, unknown>> }));
    return (r.data ?? []).map((t): NormalizedThread => ({
      platformThreadId: String(t.id ?? t.thread_id ?? ""),
      leadEmail: (t.lead_email ?? t.from_email) as string | undefined,
      leadCompany: t.company as string | undefined,
      subject: t.subject as string | undefined,
      snippet: String(t.preview ?? t.body ?? "").slice(0, 160),
      interestStatus: (t.interest_status ?? t.classification) as string | undefined,
      lastMessageAt: (t.received_at ?? t.created_at) as string | undefined,
      messages: [{
        from: String(t.from_email ?? ""),
        direction: "inbound",
        at: (t.received_at ?? t.created_at) as string | undefined,
        body: String(t.body ?? t.preview ?? "")
      }]
    })).filter(t => t.platformThreadId);
  },

  async fetchDeliverability(creds): Promise<DeliverabilityInfo | null> {
    const r = await get<Record<string, unknown>>(creds, "/stats/overview").catch(() => null);
    if (!r) return null;
    const sent = n((r as any).sent), bounced = n((r as any).bounced), spam = n((r as any).spam_complaints);
    return { bounceRate: sent ? bounced / sent : 0, spamRate: sent ? spam / sent : 0, domainHealth: r };
  }
};
