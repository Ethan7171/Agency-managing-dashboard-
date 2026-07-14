// ROI & Spend — manual monthly spend entry per agency, cost-per-X, CSV export,
// and a print-friendly report (browser print → PDF).
import { useEffect, useState } from "react";
import { get, put, money, roiFmt, Rollup } from "../api";
import { Badge, Empty, Modal } from "../components/ui";

export default function Roi() {
  const [rows, setRows] = useState<Rollup[] | null>(null);
  const [win, setWin] = useState<"30" | "all">("30");
  const [editing, setEditing] = useState<Rollup | null>(null);

  const load = () => get<Rollup[]>(`/rollup?window=${win}`).then(r => setRows(r.filter(x => x.status !== "archived")));
  useEffect(() => { setRows(null); load(); }, [win]);

  const totalSpend = (rows ?? []).reduce((s, r) => s + Number(r.spend), 0);
  const totalMrr = (rows ?? []).reduce((s, r) => s + Number(r.mrr_won), 0);

  return (
    <>
      <div className="pagehead">
        <div>
          <div className="eyebrow">ROI &amp; Spend</div>
          <h1>What we pay, <em>what we get.</em></h1>
          <p className="sub">ROI = attributed MRR won ÷ agency cost. Spend is entered monthly per agency (retainer + performance fees).</p>
        </div>
        <div className="row">
          <div className="seg">
            <button className={win === "30" ? "on" : ""} onClick={() => setWin("30")}>30d</button>
            <button className={win === "all" ? "on" : ""} onClick={() => setWin("all")}>All-time</button>
          </div>
          <button className="btn" onClick={() => window.print()}>Print / PDF</button>
        </div>
      </div>
      {!rows ? <Empty>Loading…</Empty> : (
        <div className="card">
          <table className="t">
            <thead><tr>
              <th>Agency</th><th>Spend</th><th>MRR won</th><th>ROI</th>
              <th>$/positive</th><th>$/meeting</th><th>$/close</th><th></th>
            </tr></thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.agency_id}>
                  <td><b>{r.name}</b> <Badge kind={r.verdict === "no_data" ? "gray" : r.verdict}>{r.verdict}</Badge></td>
                  <td className="num">{money(r.spend)}</td>
                  <td className="num">{money(r.mrr_won)}</td>
                  <td className="num" style={{ fontWeight: 700,
                    color: r.verdict === "keep" ? "var(--keep)" : r.verdict === "cut" ? "var(--cut)" : undefined }}>{roiFmt(r.roi)}</td>
                  <td className="num">{money(r.cost_per_positive_reply)}</td>
                  <td className="num">{money(r.cost_per_meeting)}</td>
                  <td className="num">{money(r.cost_per_close)}</td>
                  <td className="row" style={{ justifyContent: "flex-end" }}>
                    <button className="btn" onClick={() => setEditing(r)}>Spend…</button>
                    <a className="btn" href={`/api/agencies/${r.agency_id}/export.csv`}>CSV</a>
                  </td>
                </tr>
              ))}
              <tr>
                <td><b>Portfolio</b></td>
                <td className="num"><b>{money(totalSpend)}</b></td>
                <td className="num"><b>{money(totalMrr)}</b></td>
                <td className="num"><b>{totalSpend ? roiFmt(totalMrr / totalSpend) : "—"}</b></td>
                <td colSpan={4} />
              </tr>
            </tbody>
          </table>
        </div>
      )}
      {editing && <SpendModal agency={editing} onClose={() => { setEditing(null); load(); }} />}
    </>
  );
}

function SpendModal({ agency, onClose }: { agency: Rollup; onClose: () => void }) {
  const [history, setHistory] = useState<any[]>([]);
  const now = new Date();
  const [period, setPeriod] = useState(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`);
  const [retainer, setRetainer] = useState("");
  const [meetingFees, setMeetingFees] = useState("0");
  const [closeFees, setCloseFees] = useState("0");
  const [notes, setNotes] = useState("");

  const load = () => get<any[]>(`/agencies/${agency.agency_id}/spend`).then(setHistory);
  useEffect(() => { load(); }, []);

  const save = async () => {
    await put(`/agencies/${agency.agency_id}/spend`, {
      period: `${period}-01`, retainer: Number(retainer || 0),
      per_meeting_fee: Number(meetingFees || 0), per_close_fee: Number(closeFees || 0), notes
    });
    setRetainer(""); setMeetingFees("0"); setCloseFees("0"); setNotes("");
    load();
  };

  return (
    <Modal onClose={onClose}>
      <h2>Spend — {agency.name}</h2>
      <p className="mut">One row per month. Total = retainer + per-meeting + per-close fees.</p>
      <label className="f">Month</label>
      <input type="month" value={period} onChange={e => setPeriod(e.target.value)} />
      <label className="f">Retainer ($)</label>
      <input type="number" value={retainer} onChange={e => setRetainer(e.target.value)} placeholder="5000" />
      <div className="grid c2">
        <div><label className="f">Per-meeting fees ($)</label>
          <input type="number" value={meetingFees} onChange={e => setMeetingFees(e.target.value)} /></div>
        <div><label className="f">Per-close fees ($)</label>
          <input type="number" value={closeFees} onChange={e => setCloseFees(e.target.value)} /></div>
      </div>
      <label className="f">Notes</label>
      <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="optional" />
      <div className="row" style={{ justifyContent: "flex-end", marginTop: 14 }}>
        <button className="btn" onClick={onClose}>Done</button>
        <button className="btn primary" onClick={save} disabled={!retainer && !meetingFees && !closeFees}>Save month</button>
      </div>
      {history.length > 0 && (
        <>
          <h2 style={{ marginTop: 20 }}>History</h2>
          <table className="t"><thead><tr><th>Month</th><th>Retainer</th><th>Fees</th><th>Total</th></tr></thead>
            <tbody>{history.map((s, i) => (
              <tr key={i}><td className="num">{String(s.period).slice(0, 7)}</td>
                <td className="num">{money(s.retainer)}</td>
                <td className="num">{money(Number(s.per_meeting_fee) + Number(s.per_close_fee))}</td>
                <td className="num"><b>{money(s.total_spend)}</b></td></tr>
            ))}</tbody></table>
        </>
      )}
    </Modal>
  );
}
