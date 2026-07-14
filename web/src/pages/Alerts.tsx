// Alert Center — acknowledge, mute, and see the unattributed-deals bucket.
import { useEffect, useState } from "react";
import { get, post, money, ago } from "../api";
import { Badge, Empty } from "../components/ui";

export default function Alerts() {
  const [alerts, setAlerts] = useState<any[] | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [unattributed, setUnattributed] = useState<any[]>([]);
  const [agencies, setAgencies] = useState<any[]>([]);

  const load = () => {
    get<any[]>(`/alerts?all=${showAll}`).then(setAlerts);
    get<any[]>("/deals/unattributed").then(setUnattributed);
    get<any[]>("/agencies").then(setAgencies);
  };
  useEffect(load, [showAll]);

  return (
    <>
      <div className="pagehead">
        <div>
          <div className="eyebrow">Alert Center</div>
          <h1>What needs a <em>human.</em></h1>
        </div>
        <div className="seg">
          <button className={!showAll ? "on" : ""} onClick={() => setShowAll(false)}>Open</button>
          <button className={showAll ? "on" : ""} onClick={() => setShowAll(true)}>All</button>
        </div>
      </div>

      {unattributed.length > 0 && (
        <div className="card" style={{ marginBottom: 16, borderColor: "var(--watch)" }}>
          <h2>Unattributed wins — {unattributed.length}</h2>
          <p className="mut">Closed in Close with no <span className="mono">outbound_agency</span> value. Assign or leave in the bucket; they're never dropped.</p>
          <table className="t"><thead><tr><th>Deal</th><th>MRR</th><th>Won</th><th>Assign to</th></tr></thead>
            <tbody>{unattributed.map(d => (
              <tr key={d.id}>
                <td><b>{d.deal_name}</b></td>
                <td className="num">{money(d.recurring_value_mrr)}</td>
                <td className="num">{d.won_at ? new Date(d.won_at).toLocaleDateString() : "—"}</td>
                <td>
                  <select defaultValue="" onChange={e => e.target.value &&
                    post(`/deals/${d.id}/attribute`, { agency_id: e.target.value }).then(load)} style={{ width: 180 }}>
                    <option value="">— pick agency —</option>
                    {agencies.filter(a => a.status !== "archived").map(a =>
                      <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </td>
              </tr>
            ))}</tbody></table>
        </div>
      )}

      <div className="card">
        {!alerts ? <Empty>Loading…</Empty> : !alerts.length ? <Empty>All clear. Agents run on schedule and will post here + Slack.</Empty> : (
          alerts.map(a => (
            <div key={a.id} className="alert-row">
              <span className={`sev ${a.severity}`} />
              <div style={{ flex: 1 }}>
                <div className="row">
                  <b className="mono" style={{ fontSize: 11, letterSpacing: "0.06em" }}>{a.type}</b>
                  {a.agency_name && <Badge kind="iris">{a.agency_name}</Badge>}
                  {a.acknowledged_at && <Badge kind="gray">acked</Badge>}
                  {a.muted && <Badge kind="gray">muted</Badge>}
                </div>
                <div style={{ marginTop: 3 }}>{a.message}</div>
                <div className="freshness">{ago(a.created_at)}</div>
              </div>
              {!a.acknowledged_at && !a.muted && (
                <div className="row">
                  <button className="btn" onClick={() => post(`/alerts/${a.id}/ack`).then(load)}>Acknowledge</button>
                  <button className="btn" onClick={() => post(`/alerts/${a.id}/mute`).then(load)}>Mute</button>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </>
  );
}
