// Every platform is normalized into these shapes at ingest. The rest of the
// app never sees a platform-specific field.

export type Platform = "smartlead" | "instantly" | "emailbison";

export interface Creds {
  apiKey: string;
  instanceUrl?: string; // Email Bison per-account instance, e.g. https://send.acme.com
}

export interface NormalizedCampaign {
  platformCampaignId: string;
  name: string;
  status?: string;
}

export interface NormalizedDailyMetric {
  platformCampaignId: string;
  date: string; // YYYY-MM-DD
  emailsSent: number;
  delivered: number;
  bounced: number;
  opens: number;
  replies: number;
  positiveReplies: number;
  unsubscribes: number;
  spamComplaints: number;
}

export interface NormalizedLead {
  platformLeadId: string;
  email?: string;
  company?: string;
  status?: string;
  interestStatus?: string;
  firstContactedAt?: string;
  lastActivityAt?: string;
}

export interface NormalizedThreadMessage {
  from: string;
  direction: "outbound" | "inbound";
  at?: string;
  body: string;
}

export interface NormalizedThread {
  platformThreadId: string;
  leadEmail?: string;
  leadCompany?: string;
  subject?: string;
  snippet?: string;
  interestStatus?: string;
  deepLink?: string;
  lastMessageAt?: string;
  messages: NormalizedThreadMessage[];
}

export interface DeliverabilityInfo {
  bounceRate: number;         // 0..1
  spamRate: number;           // 0..1
  inboxPlacement?: number;    // 0..1 if exposed
  domainHealth?: unknown;     // raw per-domain/account health payload
}

export interface PlatformAdapter {
  platform: Platform;
  testConnection(creds: Creds): Promise<{ ok: boolean; message: string }>;
  fetchCampaigns(creds: Creds): Promise<NormalizedCampaign[]>;
  fetchDailyMetrics(creds: Creds, sinceISO: string, untilISO: string): Promise<NormalizedDailyMetric[]>;
  fetchLeads(creds: Creds, sinceISO: string): Promise<NormalizedLead[]>;
  fetchThreads(creds: Creds, limit: number): Promise<NormalizedThread[]>;
  fetchDeliverability(creds: Creds): Promise<DeliverabilityInfo | null>;
}

export const day = (d: Date | string) => new Date(d).toISOString().slice(0, 10);
export const n = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};
