// Smartlead adapter.
// - Requires the agency's workspace to be on Pro plan or above (API access).
// - Auth: api_key appended as a query param on every request. Because of that,
//   these calls are STRICTLY server-side and every log line passes through
//   redact() so the key never lands in logs.
// - Rate limit: ~10 requests per 2 seconds -> local limiter + 429 backoff.
// Endpoint paths follow the public Smartlead API docs; if Smartlead renames a
// path, this file is the only place to touch.
import {
  Creds, DeliverabilityInfo, NormalizedCampaign, NormalizedDailyMetric,
  NormalizedLead, NormalizedThread, PlatformAdapter, day, n
} from "./types.js";
import { getJson, rateLimiter } from "../http.js";

const BASE = "https://server.smartlead.ai/api/v1";
const limit = rateLimiter(10, 2000);

const u = (path: string, key: string, params: Record<string, string> = {}) => {
  const sp = new URLSearchParams({ ...params, api_key: key });
  return `${BASE}${path}?${sp.toString()}`;
};

async function get<T>(path: string, key: string, params: Record<string, string> = {}): Promise<T> {
  await limit();
  return getJson<T>(u(path, key, params));
}

type SLCampaign = { id: number | string; name: string; status?: string };
type SLDayStat = {
  date?: string; created_at?: string; sent_count?: unknown; delivered_count?: unknown;
  bounce_count?: unknown; open_count?: unknown; reply_count?: unknown;
  positive_reply_count?: unknown; unsubscribed_count?: unknown; spam_count?: unknown;
};

export const smartlead: PlatformAdapter = {
  platform: "smartlead",

  async testConnection(creds) {
    try {
      const campaigns = await get<SLCampaign[]>("/campaigns", creds.apiKey);
      return { ok: true, message: `Connected. ${campaigns.length} campaign(s) visible.` };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  },

  async fetchCampaigns(creds) {
    const campaigns = await get<SLCampaign[]>("/campaigns", creds.apiKey);
    return campaigns.map(c => ({ platformCampaignId: String(c.id), name: c.name, status: c.status }));
  },

  async fetchDailyMetrics(creds, sinceISO, untilISO) {
    const campaigns = await this.fetchCampaigns(creds);
    const out: NormalizedDailyMetric[] = [];
    for (const c of campaigns) {
      // Day-wise analytics per campaign.
      const stats = await get<{ data?: SLDayStat[] } | SLDayStat[]>(
        `/campaigns/${c.platformCampaignId}/analytics-by-date`, creds.apiKey,
        { start_date: sinceISO, end_date: untilISO }
      );
      const rows = Array.isArray(stats) ? stats : stats.data ?? [];
      for (const r of rows) {
        const date = r.date ?? r.created_at;
        if (!date) continue;
        out.push({
          platformCampaignId: c.platformCampaignId,
          date: day(date),
          emailsSent: n(r.sent_count),
          delivered: n(r.delivered_count) || Math.max(0, n(r.sent_count) - n(r.bounce_count)),
          bounced: n(r.bounce_count),
          opens: n(r.open_count),
          replies: n(r.reply_count),
          positiveReplies: n(r.positive_reply_count),
          unsubscribes: n(r.unsubscribed_count),
          spamComplaints: n(r.spam_count)
        });
      }
    }
    return out;
  },

  async fetchLeads(creds, _sinceISO) {
    const campaigns = await this.fetchCampaigns(creds);
    const out: NormalizedLead[] = [];
    for (const c of campaigns) {
      const res = await get<{ data?: Array<{ lead?: Record<string, unknown>; status?: string }> }>(
        `/campaigns/${c.platformCampaignId}/leads`, creds.apiKey, { limit: "500" }
      );
      for (const row of res.data ?? []) {
        const lead = (row.lead ?? row) as Record<string, unknown>;
        out.push({
          platformLeadId: String(lead.id ?? lead.email ?? ""),
          email: lead.email as string | undefined,
          company: (lead.company_name ?? lead.company) as string | undefined,
          status: row.status,
          interestStatus: (lead.lead_category ?? lead.category) as string | undefined,
          lastActivityAt: lead.updated_at as string | undefined
        });
      }
    }
    return out.filter(l => l.platformLeadId);
  },

  async fetchThreads(creds, limitN) {
    // Master inbox: replied conversations across the workspace.
    const res = await get<{ data?: Array<Record<string, unknown>> }>(
      "/master-inbox/conversations", creds.apiKey,
      { limit: String(limitN), filter: "replied" }
    ).catch(() => ({ data: [] as Array<Record<string, unknown>> }));
    return (res.data ?? []).map((t): NormalizedThread => ({
      platformThreadId: String(t.id ?? t.thread_id ?? ""),
      leadEmail: t.lead_email as string | undefined,
      leadCompany: t.company_name as string | undefined,
      subject: t.subject as string | undefined,
      snippet: (t.preview ?? t.snippet) as string | undefined,
      interestStatus: (t.lead_category ?? t.category) as string | undefined,
      lastMessageAt: (t.last_reply_at ?? t.updated_at) as string | undefined,
      messages: Array.isArray(t.messages)
        ? (t.messages as Array<Record<string, unknown>>).map(m => ({
            from: String(m.from ?? ""),
            direction: (m.type === "SENT" ? "outbound" : "inbound") as "outbound" | "inbound",
            at: m.time as string | undefined,
            body: String(m.email_body ?? m.body ?? "")
          }))
        : []
    })).filter(t => t.platformThreadId);
  },

  async fetchDeliverability(creds): Promise<DeliverabilityInfo | null> {
    // Email health by domain and sender account, incl. bounce data.
    const res = await get<Record<string, unknown>>(
      "/analytics/mailbox/overall-stats", creds.apiKey
    ).catch(() => null);
    if (!res) return null;
    const sent = n((res as any).sent_count ?? (res as any).total_sent);
    const bounced = n((res as any).bounce_count ?? (res as any).total_bounced);
    const spam = n((res as any).spam_count ?? (res as any).total_spam);
    return {
      bounceRate: sent ? bounced / sent : 0,
      spamRate: sent ? spam / sent : 0,
      domainHealth: (res as any).domain_wise_health ?? (res as any).data ?? res
    };
  }
};
