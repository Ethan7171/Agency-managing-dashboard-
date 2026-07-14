import { useEffect, useState } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import { get, post } from "./api";
import Overview from "./pages/Overview";
import Agency from "./pages/Agency";
import Inbox from "./pages/Inbox";
import Leads from "./pages/Leads";
import Deliverability from "./pages/Deliverability";
import Roi from "./pages/Roi";
import Alerts from "./pages/Alerts";
import Settings from "./pages/Settings";

function Login({ onOk }: { onOk: () => void }) {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true); setErr("");
    try { await post("/auth/login", { password: pw }); onOk(); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="wordmark" style={{ color: "var(--ink)", padding: 0 }}>FLAX<span> LABS</span></div>
        <div className="eyebrow" style={{ marginTop: 4 }}>Outbound Command Center</div>
        <label className="f">Team password</label>
        <input type="password" value={pw} autoFocus onChange={e => setPw(e.target.value)}
          onKeyDown={e => e.key === "Enter" && submit()} placeholder="••••••••" />
        {err && <div className="mut" style={{ color: "var(--cut)", marginTop: 8 }}>{err}</div>}
        <button className="btn primary" style={{ width: "100%", marginTop: 16, justifyContent: "center" }}
          disabled={busy || !pw} onClick={submit}>Sign in</button>
      </div>
    </div>
  );
}

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [alertCount, setAlertCount] = useState(0);

  useEffect(() => {
    get("/rollup?window=7").then(() => setAuthed(true)).catch(() => setAuthed(false));
    const onUnauth = () => setAuthed(false);
    window.addEventListener("flax:unauthorized", onUnauth);
    return () => window.removeEventListener("flax:unauthorized", onUnauth);
  }, []);

  useEffect(() => {
    if (!authed) return;
    const load = () => get<unknown[]>("/alerts").then(a => setAlertCount(a.length)).catch(() => {});
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, [authed]);

  if (authed === null) return null;
  if (!authed) return <Login onOk={() => setAuthed(true)} />;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="wordmark">FLAX<span> LABS</span></div>
        <div className="tagline">Outbound Command Center</div>
        <nav className="nav">
          <NavLink to="/" end>Portfolio</NavLink>
          <NavLink to="/inbox">Inbox</NavLink>
          <NavLink to="/leads">Lead Journey</NavLink>
          <NavLink to="/deliverability">Deliverability</NavLink>
          <NavLink to="/roi">ROI &amp; Spend</NavLink>
          <NavLink to="/alerts">Alerts {alertCount > 0 && <span className="count">{alertCount}</span>}</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
        <div className="foot">READ-ONLY OVERSIGHT<br />v1 · pg-boss · Railway</div>
      </aside>
      <main className="main">
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/agency/:id" element={<Agency />} />
          <Route path="/inbox" element={<Inbox />} />
          <Route path="/leads" element={<Leads />} />
          <Route path="/deliverability" element={<Deliverability />} />
          <Route path="/roi" element={<Roi />} />
          <Route path="/alerts" element={<Alerts />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>
    </div>
  );
}
