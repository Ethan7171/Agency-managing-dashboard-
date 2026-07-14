// Settings / Connections — the guided add-agency flow (green check before save),
// key rotation, platform swaps, pause/resume, archived list, sync + audit logs.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { get, post, ago } from "../api";
import { Badge, Empty, Modal } from "../components/ui";

export default function Settings() {
  const [agencies, setAgencies] = useState<any[]>([]);
  const [adding, setAdding] = useState(false);
  const [connecting, setConnecting] = useState<any>(null);
  const [rotating, setRotating] = useState<any>(null);
  const [syncLog, setSyncLog] = useState<any[]>([]);
  const [auditLog, setAuditLog] = useState<any[]>([]);
  const [tab, setTab] = useState<"agencies" | "logs">("agencies");

  const load = () => {
    get<any[]>("/agencies").then(setAgencies);
    get<any[]>("/sync-log").then(setSyncLog);
    get<any[]>("/audit").then(setAuditLog);
  };
  useEffect(load, []);

  const active = agencies.filter(a => a.status !== "archived");
  const archived = agencies.filter(a => a.status === "archived");

  return (
    <>
      <div className="pagehead">
        <div>
          <div className="eyebrow">Settings</div>
          <h1>Agencies &amp; <em>connections.</em></h1>
          <p className="sub">Keys are encrypted at rest in the vault and only ever decrypted server-side at sync time. New agencies must run Smartlead or Instantly (Email Bison also supported).</p>
        </div>
        <div className="row">
          <div className="seg">
            <button className={tab === "agencies" ? "on" : ""} onClick={() => setTab("agencies")}>Agencies</button>
            <button className={tab === "logs" ? "on" : ""} onClick={() => setTab("logs")}>Logs</button>
          </div>
          <button className="btn primary" onClick={() => setAdding(true)}>+ Add agency</button>
        </div>
      </div>

      {tab === "agencies" && (
        <div className="stack">
          <div className="card">
            <h2>Active</h2>
            {!active.length ? <Empty>No agencies yet.</Empty> : (
              <table className="t">
                <thead><tr><th>Agency</th><th>Code</th><th>Status</th><th>Connector</th><th>Last sync</th><th></th></tr></thead>
                <tbody>{active.map(a => <AgencyRow key={a.id} agency={a}
                  onConnect={() => setConnecting(a)} onRotate={setRotating} onChanged={load} />)}</tbody>
              </table>
            )}
          </div>
          {archived.length > 0 && (
            <div className="card">
              <h2>Archived</h2>
              <table className="t">
                <thead><tr><th>Agency</th><th>Archived</th><th>Lifetime ROI</th><th></th></tr></thead>
                <tbody>{archived.map(a => (
                  <tr key={a.id}>
                    <td><b>{a.name}</b> <span className="code-pill">{a.agency_code}</span></td>
                    <td className="num">{a.archived_at ? new Date(a.archived_at).toLocaleDateString() : "—"}</td>
                    <td className="num">{a.lifetime_summary?.roi != null ? `${Number(a.lifetime_summary.roi).toFixed(2)}×` : "—"}</td>
                    <td style={{ textAlign: "right" }}><Link className="btn" to={`/agency/${a.id}`}>View history</Link></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === "logs" && (
        <div className="split">
          <div className="card">
            <h2>Sync log</h2>
            {!syncLog.length ? <Empty>No syncs yet.</Empty> : (
              <table className="t"><thead><tr><th>When</th><th>Agency</th><th>Job</th><th>Status</th><th>Rows</th></tr></thead>
                <tbody>{syncLog.slice(0, 30).map(s => (
                  <tr key={s.id}><td className="freshness">{ago(s.started_at)}</td>
                    <td>{s.agency_name ?? "—"}</td><td className="mono" style={{ fontSize: 11 }}>{s.job}</td>
                    <td><Badge kind={s.status === "ok" ? "keep" : s.status === "error" ? "cut" : "gray"}>{s.status}</Badge></td>
                    <td className="num">{s.rows_written}</td></tr>
                ))}</tbody></table>
            )}
          </div>
          <div className="card">
            <h2>Audit log</h2>
            {!auditLog.length ? <Empty>No actions yet.</Empty> : (
              auditLog.slice(0, 30).map(a => (
                <div key={a.id} className="alert-row">
                  <span className="sev info" />
                  <div><b className="mono" style={{ fontSize: 11 }}>{a.action}</b> {a.entity}
                    <div className="freshness">{ago(a.created_at)} · {a.actor}</div></div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {adding && <AddAgencyWizard onClose={() => { setAdding(false); load(); }} />}
      {connecting && <ConnectModal agency={connecting} onClose={() => { setConnecting(null); load(); }} />}
      {rotating && <RotateModal connection={rotating} onClose={() => { setRotating(null); load(); }} />}
    </>
  );
}

function AgencyRow({ agency, onConnect, onRotate, onChanged }:
  { agency: any; onConnect: () => void; onRotate: (c: any) => void; onChanged: () => void }) {
  const [detail, setDetail] = useState<any>(null);
  useEffect(() => { get<any>(`/agencies/${agency.id}`).then(setDetail); }, [agency.id]);
  const conn = detail?.connections?.find((c: any) => c.active);
  return (
    <tr>
      <td><Link to={`/agency/${agency.id}`}><b>{agency.name}</b></Link></td>
      <td><span className="code-pill">{agency.agency_code}</span></td>
      <td><Badge kind={agency.status === "active" ? "keep" : "gray"}>{agency.status}</Badge></td>
      <td>{conn ? <span className="row"><span className={`dot ${conn.sync_status}`} />{conn.platform}
        {conn.last_error && <span className="mut" title={conn.last_error}>⚠</span>}</span> : <span className="mut">none</span>}</td>
      <td className="freshness">{conn?.sync_status === "demo" ? "demo" : ago(conn?.last_synced_at)}</td>
      <td style={{ textAlign: "right" }}>
        <span className="row" style={{ justifyContent: "flex-end" }}>
          {conn && <button className="btn" onClick={() =>
            post<any>(`/connections/${conn.id}/test`).then(r => alert(r.ok ? `✓ ${r.message}` : `✗ ${r.message}`))}>Test</button>}
          {conn && conn.sync_status !== "demo" && <button className="btn" onClick={() => onRotate(conn)}>Rotate key</button>}
          <button className="btn" onClick={onConnect}>{conn ? "Swap platform" : "Connect"}</button>
        </span>
      </td>
    </tr>
  );
}

function AddAgencyWizard({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(1);
  const [f, setF] = useState({ name: "", agency_code: "", primary_contact: "", slack_channel_id: "", sla_daily_sends: "" });
  const [agencyId, setAgencyId] = useState("");
  const [err, setErr] = useState("");
  const set = (k: string, v: string) => setF(p => ({ ...p, [k]: v }));

  const createAgency = async () => {
    setErr("");
    try {
      const a = await post<any>("/agencies", { ...f, sla_daily_sends: Number(f.sla_daily_sends || 0) });
      setAgencyId(a.id); setStep(2);
    } catch (e) { setErr((e as Error).message); }
  };

  return (
    <Modal onClose={onClose}>
      <h2>Add agency</h2>
      <div className="steps"><div className={`st ${step >= 1 ? "on" : ""}`} /><div className={`st ${step >= 2 ? "on" : ""}`} /></div>
      {step === 1 ? (
        <>
          <p className="mut">Step 1 — identity. The agency code is the attribution key: it must be tagged on their platform campaigns AND set as <span className="mono">outbound_agency</span> in Close. It can't be changed casually once live.</p>
          <label className="f">Agency name</label>
          <input value={f.name} onChange={e => set("name", e.target.value)} placeholder="Leadbird" autoFocus />
          <label className="f">Agency code (unique, lowercase)</label>
          <input value={f.agency_code} onChange={e => set("agency_code", e.target.value.toLowerCase())} placeholder="leadbird" />
          <label className="f">Primary contact</label>
          <input value={f.primary_contact} onChange={e => set("primary_contact", e.target.value)} placeholder="Nick A." />
          <label className="f">Slack channel ID (optional — for per-agency alerts)</label>
          <input value={f.slack_channel_id} onChange={e => set("slack_channel_id", e.target.value)} placeholder="C0123ABCD" />
          <label className="f">Committed sends/day (SLA, optional)</label>
          <input type="number" value={f.sla_daily_sends} onChange={e => set("sla_daily_sends", e.target.value)} placeholder="1000" />
          {err && <div className="mut" style={{ color: "var(--cut)", marginTop: 8 }}>{err}</div>}
          <div className="row" style={{ justifyContent: "flex-end", marginTop: 16 }}>
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn primary" disabled={!f.name || !f.agency_code} onClick={createAgency}>Next: connect platform</button>
          </div>
        </>
      ) : (
        <ConnectForm agencyId={agencyId} onDone={onClose} />
      )}
    </Modal>
  );
}

function ConnectModal({ agency, onClose }: { agency: any; onClose: () => void }) {
  return (
    <Modal onClose={onClose}>
      <h2>Connect platform — {agency.name}</h2>
      <p className="mut">Swapping platforms keeps all history; the old key is revoked from the vault automatically.</p>
      <ConnectForm agencyId={agency.id} onDone={onClose} />
    </Modal>
  );
}

function ConnectForm({ agencyId, onDone }: { agencyId: string; onDone: () => void }) {
  const [platform, setPlatform] = useState("smartlead");
  const [apiKey, setApiKey] = useState("");
  const [instanceUrl, setInstanceUrl] = useState("");
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);

  const runTest = async () => {
    setBusy(true); setTest(null);
    try { setTest(await post<any>("/connections/test", { platform, api_key: apiKey, instance_url: instanceUrl })); }
    catch (e) { setTest({ ok: false, message: (e as Error).message }); }
    finally { setBusy(false); }
  };
  const save = async () => {
    setBusy(true);
    try { setResult(await post<any>(`/agencies/${agencyId}/connections`, { platform, api_key: apiKey, instance_url: instanceUrl })); }
    catch (e) { alert((e as Error).message); }
    finally { setBusy(false); }
  };

  if (result) return (
    <>
      <div className="card" style={{ borderColor: "var(--keep)", background: "var(--keep-wash)", marginTop: 12 }}>
        ✓ Connected. Backfilling the last {result.backfill_days} days now.
      </div>
      <label className="f">Real-time webhook URL — shown once, give it to the agency (optional but recommended)</label>
      <div className="copybox">{result.webhook_url}</div>
      <div className="row" style={{ justifyContent: "flex-end", marginTop: 16 }}>
        <button className="btn primary" onClick={onDone}>Done</button>
      </div>
    </>
  );

  return (
    <>
      <p className="mut" style={{ marginTop: 8 }}>Step 2 — read-only key. Ask the agency for a scoped, read-only API key. It's tested live before anything is stored.</p>
      <label className="f">Platform</label>
      <select value={platform} onChange={e => { setPlatform(e.target.value); setTest(null); }}>
        <option value="smartlead">Smartlead (their workspace must be Pro plan+)</option>
        <option value="instantly">Instantly (V2 key, Hypergrowth plan+)</option>
        <option value="emailbison">Email Bison (key + instance URL)</option>
      </select>
      {platform === "emailbison" && (
        <>
          <label className="f">Instance URL</label>
          <input value={instanceUrl} onChange={e => setInstanceUrl(e.target.value)} placeholder="https://send.agency.com" />
        </>
      )}
      <label className="f">API key (read-only)</label>
      <input type="password" value={apiKey} onChange={e => { setApiKey(e.target.value); setTest(null); }} placeholder="paste key" />
      {test && (
        <div className="card" style={{ marginTop: 10, padding: 12,
          borderColor: test.ok ? "var(--keep)" : "var(--cut)",
          background: test.ok ? "var(--keep-wash)" : "var(--cut-wash)" }}>
          {test.ok ? "✓ " : "✗ "}{test.message}
        </div>
      )}
      <div className="row" style={{ justifyContent: "flex-end", marginTop: 16 }}>
        <button className="btn" disabled={busy || !apiKey} onClick={runTest}>Test connection</button>
        <button className="btn primary" disabled={busy || !test?.ok} onClick={save}>Save &amp; backfill</button>
      </div>
    </>
  );
}

function RotateModal({ connection, onClose }: { connection: any; onClose: () => void }) {
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  return (
    <Modal onClose={onClose}>
      <h2>Rotate key — {connection.platform}</h2>
      <p className="mut">The new key is tested live first; the old one is revoked from the vault the moment this succeeds.</p>
      <label className="f">New API key</label>
      <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} autoFocus />
      {err && <div className="mut" style={{ color: "var(--cut)", marginTop: 8 }}>{err}</div>}
      <div className="row" style={{ justifyContent: "flex-end", marginTop: 16 }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy || !apiKey} onClick={async () => {
          setBusy(true); setErr("");
          try { await post(`/connections/${connection.id}/rotate-key`, { api_key: apiKey }); onClose(); }
          catch (e) { setErr((e as Error).message); }
          finally { setBusy(false); }
        }}>Test &amp; rotate</button>
      </div>
    </Modal>
  );
}
