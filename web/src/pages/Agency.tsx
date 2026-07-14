// Agency Deep-Dive: full funnel, trends, MoM, deliverability, campaigns,
// meetings/deals, spend, and lifecycle actions.
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { get, post, patch, money, pct, roiFmt, ago, Rollup } from "../api";
import { Badge, Metric, Modal, Empty, deltaText } from "../components/ui";

type Mom = Record<string, { current: number | null; previous: number | null; delta: number | null }>;

export default function Agency() {
  const { id } = useParams();
  const nav = useNavigate();
  const [agency, setAgency] = useState<any>(null);
  const [funnel, setFunnel] = useState<Rollup | null>(null);
  const [metrics, setMetrics] = useState<any[]>([]);
  const [mom, setMom] = useState<Mom | null>(null);
  const [campaigns, setCampaigns] = useState<any[]>([]);
  const [deals, setDeals] = useState<any[]>([]);
  const [meetings, setMeetings] = useState<any[]>([]);
  const [modal, setModal] = useState<"archive" | "purge" | "thresholds" | null>(null);
  const [purgeInfo, setPurgeInfo] = useState<any>(null);
  const [confirmName, setConfirmName] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  const load = useCallback(() => {
    get<any>(`/agencies/${id}`).then(setAgency);
    get<Rollup | null>(`/agencies/${id}/funnel?window=30`).then(setFunnel);
    get<any[]>(`/agencies/${id}/metrics?days=90`).then(setMetrics);
    get<Mom>(`/agencies/${id}/mom`).then(setMom);
    get<any[]>(`/agencies/${id}/campaigns`).then(setCampaigns);
    get<any[]>(`/agencies/${id}/deals`).then(setDeals);
    get<any[]>(`/agencies/${id}/meetings`).then(setMeetings);
  }, [id]);
  useEffect(load, [load]);

  if (!agency || !funnel) return <Empty>Loading…</Empty>;
  const conn = agency.connections?.find((c: any) => c.active);
  const f = funnel;

  const funnelStages = [
    { k: "Sent", v: f.emails_sent }, { k: "Delivered", v: f.delivered },
    { k: "Replied", v: f.replies }, { k: "Positive", v: f.positive_replies },
    { k: "Booked", v: f.meetings_booked }, { k: "Showed", v: f.showed }, { k: "Closed", v: f.closes }
  ];
  const maxStage = Math.max(...funnelStages.map(s => s.v), 1);

  const act = async (path: string, body?: unknown) => {
    setBusy(true);
    try {
      const r = await post<any>(path, body);
      setNote(r.reminder ?? "");
      setModal(null); setConfirmName("");
      if (path.endsWith("/purge")) { nav("/"); return; }
      load();
    } catch (e) { alert((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <>
      <div className="pagehead">
        <div>
          <div className="eyebrow"><Link to="/">Portfolio</Link> / Agency</div>
          <h1>{agency.name} <em>· {agency.agency_code}</em></h1>
          <div className="row" style={{ marginTop: 8 }}>
            <Badge kind={f.verdict === "no_data" ? "gray" : f.verdict}>{f.verdict}</Badge>
            <Badge kind="gray">{agency.status}</Badge>
            {conn && <Badge kind="iris">{conn.platform}</Badge>}
            <span className="freshness">{conn?.sync_status === "demo" ? "demo data" : `synced ${ago(conn?.last_synced_at)}`}</span>
          </div>
        </div>
        <div className="row">
          <button className="btn" onClick={() => post(`/agencies/${id}/sync-now`).then(() => setNote("Sync queued."))}>Sync now</button>
          <a className="btn" href={`/api/agencies/${id}/export.csv`}>Export CSV</a>
          <button className="btn" onClick={() => setModal("thresholds")}>Thresholds</button>
          {agency.status === "paused"
            ? <button className="btn" onClick={() => act(`/agencies/${id}/resume`)}>Resume</button>
            : <button className="btn" onClick={() => act(`/agencies/${id}/pause`)}>Pause</button>}
          {agency.status !== "archived" &&
            <button className="btn danger" onClick={() => setModal("archive")}>Archive</button>}
          <button className="btn danger" onClick={async () => {
            setPurgeInfo(await get(`/agencies/${id}/purge-preview`)); setModal("purge");
          }}>Purge…</button>
        </div>
      </div>
      {note && <div className="card" style={{ marginBottom: 16, borderColor: "var(--iris)", background: "var(--iris-wash)" }}>{note}</div>}
      {agency.status === "archived" && agency.lifetime_summary && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h2>Frozen lifetime summary</h2>
          <div className="mut">Archived {new Date(agency.archived_at).toLocaleDateString()}. Key revoked; history retained read-only.</div>
        </div>
      )}

      <div className="grid c4" style={{ marginBottom: 18 }}>
        <Metric k="ROI (30d)" v={roiFmt(f.roi)} d={mom ? deltaText(mom.roi?.delta) : undefined}
          dir={mom?.roi?.delta == null ? undefined : mom.roi.delta >= 0 ? "up" : "down"} />
        <Metric k="MRR won (30d)" v={money(f.mrr_won)} d={mom ? deltaText(mom.mrr?.delta) : undefined}
          dir={mom?.mrr?.delta == null ? undefined : mom.mrr.delta >= 0 ? "up" : "down"} />
        <Metric k="Cost / meeting" v={money(f.cost_per_meeting)} d={`${money(f.cost_per_positive_reply)} / positive reply`} />
        <Metric k="Spend (30d)" v={money(f.spend)} d={mom ? deltaText(mom.spend?.delta) : undefined} />
      </div>

      <div className="split" style={{ marginBottom: 18 }}>
        <div className="card">
          <h2>Sending &amp; replies — 90 days</h2>
          <ResponsiveContainer width="100%" height={230}>
            <AreaChart data={metrics} margin={{ top: 6, right: 8, left: -16, bottom: 0 }}>
              <defs>
                <linearGradient id="gSent" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#4B3FD6" stopOpacity={0.25} />
                  <stop offset="100%" stopColor="#4B3FD6" stopOpacity={0.02} />
                </linearGradient>
                <linearGradient id="gPos" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#0E7C4A" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="#0E7C4A" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="#EFEDE8" vertical={false} />
              <XAxis dataKey="date" tick={{ fontSize: 10, fontFamily: "Spline Sans Mono" }}
                tickFormatter={(d: string) => d.slice(5)} minTickGap={40} />
              <YAxis tick={{ fontSize: 10, fontFamily: "Spline Sans Mono" }} />
              <Tooltip contentStyle={{ fontSize: 12, borderRadius: 10, border: "1px solid #E8E5DF" }} />
              <Area type="monotone" dataKey="emails_sent" name="Sent" stroke="#4B3FD6" fill="url(#gSent)" strokeWidth={1.6} />
              <Area type="monotone" dataKey="positive_replies" name="Positive" stroke="#0E7C4A" fill="url(#gPos)" strokeWidth={1.6} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
        <div className="card">
          <h2>Funnel — 30 days</h2>
          <div className="stack" style={{ gap: 8 }}>
            {funnelStages.map(s => (
              <div key={s.k}>
                <div className="spread"><span className="mut">{s.k}</span><span className="num">{s.v.toLocaleString()}</span></div>
                <div style={{ height: 8, background: "#F0EFEA", borderRadius: 6, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${Math.max(1.5, (s.v / maxStage) * 100)}%`,
                    background: s.k === "Closed" ? "var(--keep)" : "var(--iris)", borderRadius: 6, opacity: s.k === "Sent" ? 0.35 : 0.85 }} />
                </div>
              </div>
            ))}
            <div className="mut" style={{ marginTop: 4 }}>MRR won: <b>{money(f.mrr_won)}</b> · deal value {money(f.deal_value)}</div>
          </div>
        </div>
      </div>

      <div className="split" style={{ marginBottom: 18 }}>
        <div className="card">
          <h2>Campaigns</h2>
          {!campaigns.length ? <Empty>No campaigns synced yet.</Empty> : (
            <table className="t"><thead><tr><th>Campaign</th><th>Status</th><th>Sent</th><th>Replies</th><th>Positive</th></tr></thead>
              <tbody>{campaigns.map(c => (
                <tr key={c.id}><td>{c.name}</td><td><Badge kind="gray">{c.status ?? "—"}</Badge></td>
                  <td className="num">{Number(c.sent).toLocaleString()}</td>
                  <td className="num">{c.replies}</td><td className="num">{c.positive}</td></tr>
              ))}</tbody></table>
          )}
        </div>
        <div className="card">
          <h2>Recent meetings</h2>
          {!meetings.length ? <Empty>No meetings on record.</Empty> : (
            <table className="t"><thead><tr><th>Booked</th><th>Lead</th><th>Outcome</th></tr></thead>
              <tbody>{meetings.slice(0, 8).map((m, i) => (
                <tr key={i}><td className="num">{new Date(m.booked_at).toLocaleDateString()}</td>
                  <td>{m.lead_name ?? "—"}</td>
                  <td><Badge kind={m.outcome === "showed" ? "keep" : m.outcome === "no_show" ? "cut" : "gray"}>{m.outcome}</Badge></td></tr>
              ))}</tbody></table>
          )}
        </div>
      </div>

      <div className="card">
        <h2>Deals attributed to {agency.name}</h2>
        {!deals.length ? <Empty>No deals attributed yet.</Empty> : (
          <table className="t"><thead><tr><th>Deal</th><th>Status</th><th>MRR</th><th>Total value</th><th>Won</th></tr></thead>
            <tbody>{deals.map((d, i) => (
              <tr key={i}><td>{d.deal_name}</td>
                <td><Badge kind={d.status === "won" ? "keep" : d.status === "lost" ? "cut" : "gray"}>{d.status}</Badge></td>
                <td className="num">{money(d.recurring_value_mrr)}</td>
                <td className="num">{money(d.value)}</td>
                <td className="num">{d.won_at ? new Date(d.won_at).toLocaleDateString() : "—"}</td></tr>
            ))}</tbody></table>
        )}
      </div>

      {modal === "thresholds" && (
        <Modal onClose={() => setModal(null)}>
          <h2>Thresholds &amp; SLA</h2>
          <p className="mut">These drive the verdict and the monitoring agents for this agency only.</p>
          <ThresholdForm agency={agency} onSaved={() => { setModal(null); load(); }} />
        </Modal>
      )}
      {modal === "archive" && (
        <Modal onClose={() => setModal(null)}>
          <h2>Archive {agency.name}?</h2>
          <p className="mut" style={{ margin: "10px 0" }}>
            Syncs stop, the stored key is revoked from our vault, and a lifetime summary is frozen.
            All history stays and remains visible under "archived". This is the standard way to cut an agency.
          </p>
          <div className="row" style={{ justifyContent: "flex-end", marginTop: 16 }}>
            <button className="btn" onClick={() => setModal(null)}>Cancel</button>
            <button className="btn danger" disabled={busy} onClick={() => act(`/agencies/${id}/archive`)}>Archive agency</button>
          </div>
        </Modal>
      )}
      {modal === "purge" && purgeInfo && (
        <Modal onClose={() => setModal(null)}>
          <h2>Purge {agency.name} — irreversible</h2>
          <p className="mut" style={{ margin: "10px 0" }}>This permanently deletes everything below. Export first if in doubt.</p>
          <div className="card" style={{ padding: 12, marginBottom: 12 }}>
            {Object.entries(purgeInfo.counts as Record<string, number>).map(([t, c]) => (
              <div key={t} className="spread"><span className="mut mono">{t}</span><span className="num">{c}</span></div>
            ))}
          </div>
          <a className="btn" style={{ width: "100%", justifyContent: "center", marginBottom: 12 }}
            href={`/api/agencies/${id}/export.csv`}>Download full export first</a>
          <label className="f">Type the agency name to confirm: <b>{agency.name}</b></label>
          <input value={confirmName} onChange={e => setConfirmName(e.target.value)} placeholder={agency.name} />
          <div className="row" style={{ justifyContent: "flex-end", marginTop: 16 }}>
            <button className="btn" onClick={() => setModal(null)}>Cancel</button>
            <button className="btn danger" disabled={busy || confirmName !== agency.name}
              onClick={() => act(`/agencies/${id}/purge`, { confirm_name: confirmName })}>Purge everything</button>
          </div>
        </Modal>
      )}
    </>
  );
}

function ThresholdForm({ agency, onSaved }: { agency: any; onSaved: () => void }) {
  const [f, setF] = useState({
    sla_daily_sends: agency.sla_daily_sends, threshold_bounce_rate: agency.threshold_bounce_rate,
    threshold_spam_rate: agency.threshold_spam_rate, sla_no_positive_days: agency.sla_no_positive_days,
    roi_keep_threshold: agency.roi_keep_threshold, roi_cut_threshold: agency.roi_cut_threshold
  });
  const set = (k: string, v: string) => setF(p => ({ ...p, [k]: v }));
  return (
    <>
      <label className="f">Committed sends / day (SLA)</label>
      <input type="number" value={f.sla_daily_sends} onChange={e => set("sla_daily_sends", e.target.value)} />
      <label className="f">Bounce-rate alert threshold (e.g. 0.03 = 3%)</label>
      <input type="number" step="0.005" value={f.threshold_bounce_rate} onChange={e => set("threshold_bounce_rate", e.target.value)} />
      <label className="f">Spam-rate alert threshold</label>
      <input type="number" step="0.0005" value={f.threshold_spam_rate} onChange={e => set("threshold_spam_rate", e.target.value)} />
      <label className="f">Days without a positive reply before alert</label>
      <input type="number" value={f.sla_no_positive_days} onChange={e => set("sla_no_positive_days", e.target.value)} />
      <label className="f">ROI "keep" threshold (×)</label>
      <input type="number" step="0.1" value={f.roi_keep_threshold} onChange={e => set("roi_keep_threshold", e.target.value)} />
      <label className="f">ROI "cut" threshold (×)</label>
      <input type="number" step="0.1" value={f.roi_cut_threshold} onChange={e => set("roi_cut_threshold", e.target.value)} />
      <div className="row" style={{ justifyContent: "flex-end", marginTop: 16 }}>
        <button className="btn primary" onClick={() => patch(`/agencies/${agency.id}`, f).then(onSaved)}>Save thresholds</button>
      </div>
    </>
  );
}
