// Inbox / Thread Viewer — read actual replies without logging into five platforms.
import { useEffect, useState } from "react";
import { get, ago } from "../api";
import { Badge, Empty } from "../components/ui";

export default function Inbox() {
  const [agencies, setAgencies] = useState<any[]>([]);
  const [agency, setAgency] = useState("");
  const [filter, setFilter] = useState("");
  const [threads, setThreads] = useState<any[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => { get<any[]>("/agencies").then(setAgencies); }, []);
  useEffect(() => {
    setThreads(null);
    const p = new URLSearchParams();
    if (agency) p.set("agency_id", agency);
    if (filter) p.set("filter", filter);
    get<any[]>(`/threads?${p}`).then(setThreads);
  }, [agency, filter]);

  const sentimentBadge = (t: any) => {
    const s = t.interest_status ?? t.ai_sentiment;
    if (!s) return null;
    const pos = ["positive", "interested", "meeting_booked", "booked", "meeting_completed"].includes(s);
    const neg = ["negative", "not_interested", "lost"].includes(s);
    return <Badge kind={pos ? "keep" : neg ? "cut" : "gray"}>{s}{!t.interest_status && t.ai_sentiment ? " · ai" : ""}</Badge>;
  };

  return (
    <>
      <div className="pagehead">
        <div>
          <div className="eyebrow">Inbox</div>
          <h1>Reply threads, <em>one pane.</em></h1>
          <p className="sub">Read-only view of real conversations across every agency's sending platform.</p>
        </div>
        <div className="row">
          <select value={agency} onChange={e => setAgency(e.target.value)} style={{ width: 180 }}>
            <option value="">All agencies</option>
            {agencies.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <div className="seg">
            <button className={filter === "" ? "on" : ""} onClick={() => setFilter("")}>All</button>
            <button className={filter === "positive" ? "on" : ""} onClick={() => setFilter("positive")}>Positive</button>
            <button className={filter === "booked" ? "on" : ""} onClick={() => setFilter("booked")}>Booked</button>
          </div>
        </div>
      </div>
      {!threads ? <Empty>Loading threads…</Empty> :
       !threads.length ? <Empty>No threads match. Threads appear after the first sync pulls replies.</Empty> : (
        <div className="stack">
          {threads.map(t => (
            <div key={t.id} className="thread" onClick={() => setOpen(open === t.id ? null : t.id)}>
              <div className="spread">
                <div className="row">
                  <b>{t.lead_company ?? t.lead_email ?? "Unknown lead"}</b>
                  {sentimentBadge(t)}
                  <Badge kind="iris">{t.agency_name}</Badge>
                </div>
                <span className="freshness">{ago(t.last_message_at)}</span>
              </div>
              <div className="mut" style={{ marginTop: 4 }}>{t.subject}</div>
              {open !== t.id && <div style={{ marginTop: 6, fontSize: 13 }}>{t.snippet}…</div>}
              {open === t.id && (t.messages ?? []).map((m: any, i: number) => (
                <div key={i} className={`msg ${m.direction}`}>
                  <div className="mut mono" style={{ fontSize: 10.5, marginBottom: 4 }}>
                    {m.direction === "inbound" ? "↩ " : "→ "}{m.from} {m.at ? `· ${new Date(m.at).toLocaleString()}` : ""}
                  </div>
                  {m.body}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
