// Thin API client. Every call is same-origin /api — no keys in the browser, ever.
export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    ...init
  });
  if (res.status === 401) { window.dispatchEvent(new Event("flax:unauthorized")); throw new ApiError(401, "unauthorized"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as any).error ?? `HTTP ${res.status}`);
  return data as T;
}

export const get = <T>(path: string) => call<T>(path);
export const post = <T>(path: string, body?: unknown) =>
  call<T>(path, { method: "POST", body: body == null ? undefined : JSON.stringify(body) });
export const put = <T>(path: string, body: unknown) =>
  call<T>(path, { method: "PUT", body: JSON.stringify(body) });
export const patch = <T>(path: string, body: unknown) =>
  call<T>(path, { method: "PATCH", body: JSON.stringify(body) });

export interface Rollup {
  agency_id: string; name: string; agency_code: string; status: string;
  platform: string | null; sync_status: string | null; last_synced_at: string | null;
  emails_sent: number; delivered: number; bounced: number; bounce_rate: number;
  spam_rate: number; opens: number; open_rate: number; replies: number; reply_rate: number;
  positive_replies: number; positive_reply_rate: number; unsubscribes: number;
  meetings_booked: number; showed: number; no_shows: number; show_rate: number;
  closes: number; deal_value: number; mrr_won: number; spend: number; roi: number | null; roi30: number | null;
  cost_per_positive_reply: number | null; cost_per_meeting: number | null; cost_per_close: number | null;
  verdict: "keep" | "watch" | "cut" | "no_data";
  send_trend: number[]; positive_trend: number[];
  spam_complaints: number;
}

export const money = (v: number | null | undefined) =>
  v == null ? "—" : `$${Math.round(Number(v)).toLocaleString("en-US")}`;
export const pct = (v: number | null | undefined, dp = 1) =>
  v == null ? "—" : `${(Number(v) * 100).toFixed(dp)}%`;
export const roiFmt = (v: number | null | undefined) =>
  v == null ? "—" : `${Number(v).toFixed(2)}×`;
export const ago = (iso: string | null | undefined) => {
  if (!iso) return "never";
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  if (m < 1440) return `${Math.floor(m / 60)}h ago`;
  return `${Math.floor(m / 1440)}d ago`;
};
