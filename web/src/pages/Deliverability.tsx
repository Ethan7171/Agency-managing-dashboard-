// Deliverability & Infrastructure Health — oversight that each vendor keeps
// sending quality high. Read-only; the fix is the agency's job.
import { useEffect, useState } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { get, pct, Rollup } from "../api";
import { Badge, Empty } from "../components/ui";

export default function Deliverability() {
  const [rows, setRows] = useState<Rollup[]>([]);
  const [sel, setSel] = useState<string>("");
  const [snaps, setSnaps] = useState<any[]>([]);

  useEffect(() => { get<Rollup[]>("/rollup?window=7").then(r => {
    const active = r.filter(x => x.status !== "archived");
    setRows(active);
    if (active[0]) setSel(active[0].agency_id);
  }); }, []);
  useEffect(() => {
    if (sel) get<any[]>(`/agencies/${sel}/deliverability`).then(s => setSnaps([...s].reverse()));
  }, [sel]);

  const selected = rows.find(r => r.agency_id === sel);
  const health = snaps.length ? snaps[snaps.length - 1] : null;
  const domains: any[] = health?.domain_health?.domains ?? [];

  return (
    <>
      <div className="pagehead">
        <div>
          <div className="eyebrow">Deliverability</div>
          <h1>Is anyone burning <em>our name?</em></h1>
          <p className="sub">7-day bounce and spam rates per agency, with per-domain health where the platform exposes it.</p>
        </div>
      </div>
      <div className="card" style={{ marginBottom: 16 }}>
        <table className="t">
          <thead><tr><th>Agency</th><th>Bounce (7d)</th><th>Spam (7d)</th><th>Sent (7d)</th><th>Status</th></tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.agency_id} className="click" onClick={() => setSel(r.agency_id)}
                style={sel === r.agency_id ? { background: "var(--iris-wash)" } : undefined}>
                <td><b>{r.name}</b></td>
                <td className="num" style={{ color: r.bounce_rate > 0.03 ? "var(--cut)" : undefined }}>{pct(r.bounce_rate)}</td>
                <td className="num" style={{ color: r.spam_rate > 0.001 ? "var(--cut)" : undefined }}>{pct(r.spam_rate, 2)}</td>
                <td className="num">{r.emails_sent.toLocaleString()}</td>
                <td>{r.bounce_rate > 0.05 ? <Badge kind="cut">critical</Badge>
                   : r.bounce_rate > 0.03 ? <Badge kind="watch">degraded</Badge>
                   : <Badge kind="keep">healthy</Badge>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="split">
        <div className="card">
          <h2>Bounce rate trend {selected ? `— ${selected.name}` : ""}</h2>
          {!snaps.length ? <Empty>No snapshots yet for this agency.</Empty> : (
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={snaps} margin={{ top: 6, right: 8, left: -12, bottom: 0 }}>
                <defs>
                  <linearGradient id="gB" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#C0392B" stopOpacity={0.28} />
                    <stop offset="100%" stopColor="#C0392B" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="#EFEDE8" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 10, fontFamily: "Spline Sans Mono" }}
                  tickFormatter={(d: string) => String(d).slice(5, 10)} minTickGap={40} />
                <YAxis tick={{ fontSize: 10, fontFamily: "Spline Sans Mono" }}
                  tickFormatter={(v: number) => `${(v * 100).toFixed(1)}%`} />
                <Tooltip formatter={(v: number) => `${(Number(v) * 100).toFixed(2)}%`}
                  contentStyle={{ fontSize: 12, borderRadius: 10, border: "1px solid #E8E5DF" }} />
                <Area type="monotone" dataKey="bounce_rate" name="Bounce" stroke="#C0392B" fill="url(#gB)" strokeWidth={1.6} />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
        <div className="card">
          <h2>Domain health</h2>
          {!domains.length ? <Empty>Platform doesn't expose per-domain health, or none synced yet.</Empty> : (
            <table className="t"><thead><tr><th>Domain</th><th>Health</th></tr></thead>
              <tbody>{domains.map((d: any, i: number) => (
                <tr key={i}><td className="mono" style={{ fontSize: 12 }}>{d.domain}</td>
                  <td><Badge kind={d.health === "good" ? "keep" : "cut"}>{d.health}</Badge></td></tr>
              ))}</tbody></table>
          )}
          {health?.inbox_placement != null && (
            <div className="mut" style={{ marginTop: 10 }}>Estimated inbox placement: <b>{pct(Number(health.inbox_placement))}</b></div>
          )}
        </div>
      </div>
    </>
  );
}
