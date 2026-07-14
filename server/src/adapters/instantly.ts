// Instantly adapter — API V2 only (V1 is deprecated).
// - Requires Hypergrowth plan or above for API access.
// - Auth: Bearer token. Instantly keys are scoped and revocable: each agency
//   issues Flax a dedicated READ-ONLY key so a leak is contained per vendor.
// - Interest-status totals (interested / meeting booked / meeting completed /
//   closed) are pulled and stored on leads to cross-check Close attribution.
import {
  Creds, DeliverabilityInfo, NormalizedCampaign, NormalizedDailyMetric,
  NormalizedLead, NormalizedThread, PlatformAdapter, day, n
} from "./types.js";
import { fetchWithRetry, getJson, rateLimiter } from "../http.js";

const BASE = "https://api.instantly.ai/api/v2";
const limit = rateLimiter(10, 1000);

const auth = (key: string) => ({ Authorization: `Bearer ${key}`, "Content-Type": "application/json" });

async function get<T>(path: string, key: string): Promise<T> {
  await limit();
  return getJson<T>(`${BASE}${path}`, { headers: auth(key) });
}
async function post<T>(path: string, key: string, body: unknown): Promise<T> {
  await limit();
  const res = await fetchWithRetry(`${BASE}${path}`, {
    method: "POST", headers: auth(key), body: JSON.stringify(body)
  });
  return res.json() as Promise<T>;
}

type ICampaign = { id: string; name: string; status?: number | string };

const INTEREST: Record<string, string> = {
  "1": "interested", "2": "meeting_booked", "3": "meeting_completed", "4": "closed",
  "-1": "not_interested", "-2": "wrong_person", "-3": "lost"
};

export const instantly: PlatformAdapter = {
  platform: "instantly",

  async testConnection(creds) {
    try {
      const r = await get<{ items?: ICampaign[] }>("/campaigns?limit=10", creds.apiKey);
      return { ok: true, message: `Connected. ${r.items?.length ?? 0}+ campaign(s) visible.` };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  },

  async fetchCampaigns(creds) {
    const items: ICampaign[] = [];
    let starting_after: string | undefined;
    do {
      const r = await get<{ items?: ICampaign[]; next_starting_after?: string }>(
        `/campaigns?limit=100${starting_after ? `&starting_after=${starting_after}` : ""}`, creds.apiKey
      );
      items.push(...(r.items ?? []));
      starting_after = r.next_starting_after;
    } while (starting_after);
    return items.map(c => ({ platformCampaignId: c.id, name: c.name, status: String(c.status ?? "") }));
  },

  async fetchDailyMetrics(creds, sinceISO, untilISO) {
    const campaigns = await this.fetchCampaigns(creds);
    const out: NormalizedDailyMetric[] = [];
    for (const c of campaigns) {
      const rows = await get<Array<Record<string, unknown>>>(
        `/campaigns/analytics/daily?campaign_id=${c.platformCampaignId}&start_date=${sinceISO}&end_date=${untilISO}`,
        creds.apiKey
      ).catch(() => [] as Array<Record<string, unknown>>);
      for (const r of rows) {
        const date = (r.date ?? r.day) as string | undefined;
        if (!date) continue;
        const sent = n(r.sent), bounced = n(r.bounced);
        out.push({
          platformCampaignId: c.platformCampaignId,
          date: day(date),
          emailsSent: sent,
          delivered: Math.max(0, sent - bounced),
          bounced,
          opens: n(r.opened),
          replies: n(r.replies ?? r.replied),
          positiveReplies: n(r.opportunities ?? r.interested),
          unsubscribes: n(r.unsubscribed),
          spamComplaints: n(r.spam ?? r.spam_complaints)
        });
      }
    }
    return out;
  },

  async fetchLeads(creds, _sinceISO) {
    const out: NormalizedLead[] = [];
    let starting_after: string | undefined;
    do {
      const r = await post<{ items?: Array<Record<string, unknown>>; next_starting_after?: string }>(
        "/leads/list", creds.apiKey, { limit: 100, starting_after }
      );
      for (const l of r.items ?? []) {
        out.push({
          platformLeadId: String(l.id ?? ""),
          email: l.email as string | undefined,
          company: (l.company_name ?? l.company) as string | undefined,
          status: String(l.status ?? ""),
          interestStatus: INTEREST[String(l.lt_interest_status ?? "")] ?? undefined,
          lastActivityAt: (l.timestamp_last_contact ?? l.timestamp_updated) as string | undefined
        });
      }
      starting_after = r.next_starting_after;
    } while (starting_after && out.length < 5000);
    return out.filter(l => l.platformLeadId);
  },

  async fetchThreads(creds, limitN) {
    const r = await get<{ items?: Array<Record<string, unknown>> }>(
      `/emails?limit=${Math.min(limitN, 100)}&email_type=received`, creds.apiKey
    ).catch(() => ({ items: [] as Array<Record<string, unknown>> }));
    const byThread = new Map<string, NormalizedThread>();
    for (const m of r.items ?? []) {
      const tid = String(m.thread_id ?? m.id ?? "");
      if (!tid) continue;
      const t = byThread.get(tid) ?? {
        platformThreadId: tid,
        leadEmail: (m.from_address_email ?? m.lead) as string | undefined,
        subject: m.subject as string | undefined,
        snippet: undefined as string | undefined,
        interestStatus: INTEREST[String(m.i_status ?? "")],
        lastMessageAt: m.timestamp_email as string | undefined,
        messages: [] as NormalizedThread["messages"]
      };
      const body = typeof m.body === "object" && m.body ? String((m.body as any).text ?? "") : String(m.body ?? "");
      t.messages.push({
        from: String(m.from_address_email ?? ""),
        direction: m.ue_type === 1 ? "outbound" : "inbound",
        at: m.timestamp_email as string | undefined,
        body
      });
      t.snippet = t.snippet ?? body.slice(0, 160);
      byThread.set(tid, t);
    }
    return [...byThread.values()];
  },

  async fetchDeliverability(creds): Promise<DeliverabilityInfo | null> {
    const r = await get<Record<string, unknown>>(
      "/campaigns/analytics/overview", creds.apiKey
    ).catch(() => null);
    if (!r) return null;
    const sent = n((r as any).sent ?? (r as any).emails_sent_count);
    const bounced = n((r as any).bounced ?? (r as any).bounced_count);
    return { bounceRate: sent ? bounced / sent : 0, spamRate: 0, domainHealth: r };
  }
};
