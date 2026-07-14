// Lead Journey — search any prospect, see the full path: contacted → replied →
// meeting → outcome → deal, and which agency owns it.
import { useEffect, useState } from "react";
import { get, money, ago } from "../api";
import { Badge, Empty } from "../components/ui";

export default function Leads() {
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState<any[] | null>(null);
  const [journey, setJourney] = useState<any>(null);

  useEffect(() => {
    const t = setTimeout(() => get<any[]>(`/leads?search=${encodeURIComponent(search)}`).then(setRows), 250);
    return () => clearTimeout(t);
  }, [search]);

  const openJourney = (id: string) => get<any>(`/leads/${id}/journey`).then(setJourney);

  const timeline: Array<{ at: string | null; label: string; badge?: string; kind?: string }> = [];
  if (journey) {
    const l = journey.lead;
    if (l.first_contacted_at) timeline.push({ at: l.first_contacted_at, label: `First contacted by ${l.agency_name}` });
    for (const t of journey.threads) timeline.push({
      at: t.last_message_at, label: `Replied — "${t.subject}"`,
      badge: t.interest_status ?? t.ai_sentiment ?? undefined,
      kind: ["positive", "interested"].includes(t.interest_status ?? t.ai_sentiment) ? "keep" : "gray"
    });
    for (const m of journey.meetings) timeline.push({
      at: m.booked_at, label: `Meeting ${m.outcome}`,
      badge: m.outcome, kind: m.outcome === "showed" ? "keep" : m.outcome === "no_show" ? "cut" : "gray"
    });
    for (const d of journey.deals) timeline.push({
      at: d.won_at, label: `Deal ${d.status}: ${d.deal_name} — ${money(d.recurring_value_mrr)} MRR`,
      badge: d.status, kind: d.status === "won" ? "keep" : "gray"
    });
    timeline.sort((a, b) => new Date(a.at ?? 0).getTime() - new Date(b.at ?? 0).getTime());
  }

  return (
    <>
      <div className="pagehead">
        <div>
          <div className="eyebrow">Lead Journey</div>
          <h1>Where is <em>this brand</em> in the funnel?</h1>
        </div>
        <input style={{ width: 320 }} placeholder="Search brand or email…" value={search}
          onChange={e => setSearch(e.target.value)} autoFocus />
      </div>
      <div className="split">
        <div className="card">
          {!rows ? <Empty>Loading…</Empty> : !rows.length ? <Empty>No leads match.</Empty> : (
            <table className="t">
              <thead><tr><th>Brand</th><th>Email</th><th>Agency</th><th>Interest</th><th>Last activity</th></tr></thead>
              <tbody>{rows.map(l => (
                <tr key={l.id} className="click" onClick={() => openJourney(l.id)}>
                  <td><b>{l.company ?? "—"}</b></td>
                  <td className="mono" style={{ fontSize: 12 }}>{l.email}</td>
                  <td><Badge kind="iris">{l.agency_name}</Badge></td>
                  <td>{l.interest_status ? <Badge kind={l.interest_status === "positive" ? "keep" : "gray"}>{l.interest_status}</Badge> : "—"}</td>
                  <td className="freshness">{ago(l.last_activity_at)}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </div>
        <div className="card">
          <h2>Journey</h2>
          {!journey ? <Empty>Select a lead to trace its path.</Empty> : (
            <>
              <div style={{ marginBottom: 10 }}>
                <b>{journey.lead.company}</b>
                <div className="mut mono" style={{ fontSize: 12 }}>{journey.lead.email}</div>
                <Badge kind="iris">{journey.lead.agency_name}</Badge>
              </div>
              {!timeline.length ? <Empty>Contacted — no downstream events yet.</Empty> : (
                <div className="stack" style={{ gap: 0 }}>
                  {timeline.map((e, i) => (
                    <div key={i} className="alert-row">
                      <span className="sev info" />
                      <div>
                        <div>{e.label} {e.badge && <Badge kind={e.kind ?? "gray"}>{e.badge}</Badge>}</div>
                        <div className="freshness">{e.at ? new Date(e.at).toLocaleString() : "—"}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
