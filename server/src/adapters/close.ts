// Close CRM — the down-funnel source of record for meetings, closes, deal
// names, and revenue. Attribution joins on the `outbound_agency` custom field
// (name configurable via CLOSE_AGENCY_FIELD). Wins with no value land in the
// unattributed bucket (deals.agency_id = null) — never silently dropped.
import { getJson, rateLimiter } from "../http.js";
import { config } from "../config.js";

const BASE = "https://api.close.com/api/v1";
const limit = rateLimiter(5, 1000);

const auth = () => ({
  Authorization: `Basic ${Buffer.from(`${config.closeApiKey}:`).toString("base64")}`,
  "Content-Type": "application/json"
});

async function get<T>(path: string): Promise<T> {
  await limit();
  return getJson<T>(`${BASE}${path}`, { headers: auth() });
}

export interface CloseDeal {
  closeOpportunityId: string;
  closeLeadId: string;
  agencyCode: string | null;
  dealName: string;
  value: number;
  mrr: number;
  status: "open" | "won" | "lost";
  wonAt: string | null;
}

export interface CloseMeeting {
  closeActivityId: string;
  closeLeadId: string;
  agencyCode: string | null;
  bookedAt: string;
  scheduledFor: string | null;
  outcome: "booked" | "showed" | "no_show" | "rescheduled" | "cancelled";
  leadName: string | null;
}

// Custom fields appear on Close objects as "custom.cf_<id>" OR, via the
// field-name lookup, we resolve the id once and cache it.
let agencyFieldId: string | null = null;
async function resolveAgencyFieldId(): Promise<string | null> {
  if (agencyFieldId) return agencyFieldId;
  for (const kind of ["lead", "opportunity"]) {
    const r = await get<{ data?: Array<{ id: string; name: string }> }>(
      `/custom_field/${kind}/`
    ).catch(() => ({ data: [] as Array<{ id: string; name: string }> }));
    const f = (r.data ?? []).find(f => f.name === config.closeAgencyField);
    if (f) { agencyFieldId = f.id; return f.id; }
  }
  return null;
}

const readAgencyCode = (obj: Record<string, unknown>, fieldId: string | null): string | null => {
  if (fieldId && obj[`custom.${fieldId}`] != null) return String(obj[`custom.${fieldId}`]);
  const custom = obj.custom as Record<string, unknown> | undefined;
  if (custom && custom[config.closeAgencyField] != null) return String(custom[config.closeAgencyField]);
  return null;
};

export async function fetchCloseDeals(sinceISO: string): Promise<CloseDeal[]> {
  if (!config.closeApiKey) return [];
  const fieldId = await resolveAgencyFieldId();
  const out: CloseDeal[] = [];
  let skip = 0;
  for (;;) {
    const r = await get<{ data?: Array<Record<string, unknown>>; has_more?: boolean }>(
      `/opportunity/?_limit=100&_skip=${skip}&date_updated__gte=${sinceISO}`
    );
    for (const o of r.data ?? []) {
      const status = String(o.status_type ?? "").toLowerCase();
      out.push({
        closeOpportunityId: String(o.id),
        closeLeadId: String(o.lead_id ?? ""),
        agencyCode: readAgencyCode(o, fieldId),
        dealName: String(o.lead_name ?? o.note ?? "Unnamed deal"),
        value: Number(o.value ?? 0) / 100, // Close stores cents
        mrr: String(o.value_period ?? "") === "monthly" ? Number(o.value ?? 0) / 100 : 0,
        status: status === "won" ? "won" : status === "lost" ? "lost" : "open",
        wonAt: (o.date_won as string | null) ?? null
      });
    }
    if (!r.has_more) break;
    skip += 100;
  }
  // Opportunities may carry the code on the parent lead instead — resolve those.
  const missing = out.filter(d => !d.agencyCode);
  const leadIds = [...new Set(missing.map(d => d.closeLeadId))].slice(0, 300);
  const leadCode = new Map<string, string | null>();
  for (const id of leadIds) {
    const lead = await get<Record<string, unknown>>(`/lead/${id}/`).catch(() => null);
    leadCode.set(id, lead ? readAgencyCode(lead, fieldId) : null);
  }
  for (const d of missing) d.agencyCode = leadCode.get(d.closeLeadId) ?? null;
  return out;
}

export async function fetchCloseMeetings(sinceISO: string): Promise<CloseMeeting[]> {
  if (!config.closeApiKey) return [];
  const fieldId = await resolveAgencyFieldId();
  const out: CloseMeeting[] = [];
  let skip = 0;
  for (;;) {
    const r = await get<{ data?: Array<Record<string, unknown>>; has_more?: boolean }>(
      `/activity/meeting/?_limit=100&_skip=${skip}&date_created__gte=${sinceISO}`
    );
    for (const m of r.data ?? []) {
      const status = String(m.status ?? "").toLowerCase();
      out.push({
        closeActivityId: String(m.id),
        closeLeadId: String(m.lead_id ?? ""),
        agencyCode: readAgencyCode(m, fieldId),
        bookedAt: String(m.date_created ?? new Date().toISOString()),
        scheduledFor: (m.starts_at as string | null) ?? null,
        outcome:
          status === "completed" ? "showed" :
          status.includes("no") && status.includes("show") ? "no_show" :
          status === "canceled" || status === "cancelled" ? "cancelled" :
          status === "rescheduled" ? "rescheduled" : "booked",
        leadName: (m.lead_name as string | null) ?? null
      });
    }
    if (!r.has_more) break;
    skip += 100;
  }
  // Meetings rarely carry custom fields — resolve agency via the parent lead.
  const leadIds = [...new Set(out.filter(m => !m.agencyCode).map(m => m.closeLeadId))].slice(0, 300);
  const leadCode = new Map<string, string | null>();
  for (const id of leadIds) {
    const lead = await get<Record<string, unknown>>(`/lead/${id}/`).catch(() => null);
    leadCode.set(id, lead ? readAgencyCode(lead, fieldId) : null);
  }
  for (const m of out) if (!m.agencyCode) m.agencyCode = leadCode.get(m.closeLeadId) ?? null;
  return out;
}
