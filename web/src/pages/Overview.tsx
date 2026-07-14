// Portfolio Overview — the 30-second answer. Signature verdict rail on the
// left edge of every row: giant ROI multiple + KEEP / WATCH / CUT.
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { get, money, pct, roiFmt, ago, Rollup } from "../api";
import { Sparkline, Badge, Metric, Empty } from "../components/ui";

type Win = "7" | "30" | "all";

export default function Overview() {
  const [win, setWin] = useState<Win>("30");
  const [rows, setRows] = useState<Rollup[] | null>(null);
  const nav = useNavigate();

  useEffect(() => { setRows(null); get<Rollup[]>(`/rollup?window=${win}`).then(setRows); }, [win]);

  const active = (rows ?? []).filter(r => r.status !== "archived");
  const spend = active.reduce((s, r) => s + Number(r.spend), 0);
  const mrr = active.reduce((s, r) => s + Number(r.mrr_won), 0);
  const meetings = active.reduce((s, r) => s + r.meetings_booked, 0);
  const closes = active.reduce((s, r) => s + r.closes, 0);
  const portfolioRoi = spend > 0 ? mrr / spend : null;
  const staleAny = active.some(r => r.sync_status !== "demo" && r.last_synced_at &&
    Date.now() - new Date(r.last_synced_at).getTime() > 2 * 3600e3);

  return (
    <>
      <div className="pagehead">
        <div>
          <div className="eyebrow">Portfolio Overview</div>
          <h1>Keep, watch, <em>or cut.</em></h1>
          <p className="sub">Every agency ranked by return: attributed MRR won against what we pay them.</p>
        </div>
        <div className="row">
          {staleAny && <span className="freshness stale">● some data stale &gt;2h</span>}
          <div className="seg">
            {(["7", "30", "all"] as Win[]).map(w => (
              <button key={w} className={win === w ? "on" : ""} onClick={() => setWin(w)}>
                {w === "all" ? "All-time" : `${w}d`}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="grid c4" style={{ marginBottom: 22 }}>
        <Metric k="Portfolio ROI" v={roiFmt(portfolioRoi)} d={`${money(mrr)} MRR / ${money(spend)} spend`} />
        <Metric k="Active agencies" v={active.length} d={`${active.filter(r => r.verdict === "keep").length} keep · ${active.filter(r => r.verdict === "watch").length} watch · ${active.filter(r => r.verdict === "cut").length} cut`} />
        <Metric k="Meetings booked" v={meetings} d={`window: ${win === "all" ? "all-time" : win + " days"}`} />
        <Metric k="Deals closed" v={closes} d={money(active.reduce((s, r) => s + Number(r.deal_value), 0)) + " total value"} />
      </div>

      {!rows ? <Empty>Loading leaderboard…</Empty> :
       !active.length ? <Empty>No agencies yet. Add your first one in Settings.</Empty> : (
        <div className="board">
          {active.map(r => (
            <div key={r.agency_id} className="board-row" onClick={() => nav(`/agency/${r.agency_id}`)}
              role="button" tabIndex={0} onKeyDown={e => e.key === "Enter" && nav(`/agency/${r.agency_id}`)}>
              <div className={`rail ${r.verdict}`}>
                <div className="roi">{r.roi30 == null ? "—" : `${Number(r.roi30).toFixed(1)}×`}</div>
                <div className="verdict">{r.verdict === "no_data" ? "no data" : `${r.verdict} · 30d`}</div>
              </div>
              <div className="board-cell board-name">
                <div className="v">{r.name}</div>
                <div className="meta">
                  <span className="code-pill">{r.agency_code}</span>
                  <span>{r.platform ?? "no connector"}</span>
                  <span className={`dot ${r.sync_status ?? "paused"}`} title={`sync: ${r.sync_status}`} />
                  <span className="freshness">{r.sync_status === "demo" ? "demo" : ago(r.last_synced_at)}</span>
                </div>
              </div>
              <div className="board-cell hide-sm">
                <div className="k">Sent</div>
                <div className="v">{r.emails_sent.toLocaleString()}</div>
                <Sparkline data={r.send_trend} color="var(--faint)" />
              </div>
              <div className="board-cell hide-sm">
                <div className="k">Positive</div>
                <div className="v">{r.positive_replies}</div>
                <div className="s">{pct(r.positive_reply_rate, 2)} of delivered</div>
              </div>
              <div className="board-cell hide-md">
                <div className="k">Booked / Showed</div>
                <div className="v">{r.meetings_booked} / {r.showed}</div>
                <div className="s">{pct(r.show_rate, 0)} show rate</div>
              </div>
              <div className="board-cell hide-md">
                <div className="k">Closed</div>
                <div className="v">{r.closes}</div>
                <div className="s">{money(r.mrr_won)} MRR</div>
              </div>
              <div className="board-cell hide-sm">
                <div className="k">Bounce</div>
                <div className="v" style={{ color: r.bounce_rate > 0.03 ? "var(--cut)" : undefined }}>{pct(r.bounce_rate)}</div>
                <div className="s">{r.spam_complaints} spam flags</div>
              </div>
              <div className="board-cell">
                <div className="k">Spend</div>
                <div className="v">{money(r.spend)}</div>
                <div className="s">{r.cost_per_meeting ? `${money(r.cost_per_meeting)}/meeting` : "—"}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
