# Flax Outbound Agency Command Center

Read-only oversight for a portfolio of 5–10 external cold-email agencies, each on their own
infrastructure, managed purely on ROI. One screen answers, in under 30 seconds:
**is agency X ROI-positive, healthy, and worth keeping — or should we cut them?**

## Architecture

```
┌─ Agencies' platforms ─────────────┐        ┌──────────── Railway ────────────┐
│ Smartlead · Instantly · EmailBison│──read──▶  worker (pg-boss)               │
└───────────────────────────────────┘  only  │   • sync every 30 min           │
┌─ Close CRM (down-funnel truth) ───┐──API──▶│   • 30–90 day backfill on add   │
└───────────────────────────────────┘        │   • monitoring agents (cron)    │
┌─ Manual spend entry ──────────────┐──UI───▶│                                 │
└───────────────────────────────────┘        │  api (Express)                  │
                                             │   • serves React SPA            │
                                             │   • /api surface + webhooks     │
                                             │  Postgres (data + job queue +   │
                                             │   encrypted credential vault)   │
                                             └───────────┬─────────────────────┘
                                                         │ digests / escalations
                                                    Slack ◀── n8n (notification layer only)
```

- **TypeScript / Node 20+ / Express** — API and static hosting for the React app
- **Postgres** — unified schema, pg-boss job queue, and the encrypted vault, all in one DB
- **pg-boss** — mission-critical ingestion with retries + exponential backoff (core syncs do NOT live in n8n)
- **React + Vite + Recharts** — premium light editorial dashboard (Archivo, IRIS accent)
- **n8n** — Slack digest + escalation only; importable JSONs in `n8n/`

## The ROI model

```
ROI(window) = attributed new MRR won in window ÷ agency cost allocated to window
```

- **MRR won** comes from Close: won opportunities with `value_period = monthly`, attributed via
  the `outbound_agency` custom field (field name configurable: `CLOSE_AGENCY_FIELD`).
- **Cost** is entered per month per agency (retainer + per-meeting + per-close fees). For a 7- or
  30-day window, monthly spend is prorated daily.
- **Lifetime ROI** = cumulative MRR won ÷ cumulative spend.
- **Verdicts** (editable per agency): keep ≥ 2.0×, cut < 1.0×, watch in between — over trailing 30d.

MRR is deliberately the numerator (not one-time deal value) because agencies are paid monthly and
retainer clients pay monthly; total deal value is shown alongside for context.

## Attribution contract (operational, non-negotiable)

1. Every agency gets a unique `agency_code` at onboarding (e.g. `leadbird`).
2. The agency tags that code on their campaigns/leads in their sending platform.
3. Flax's sales team sets `outbound_agency = <code>` on the Close lead/opportunity.
4. Any Close win **without** a code lands in the visible **Unattributed** bucket on the Alerts
   page — never dropped — where it can be manually assigned.

## Monitoring agents (worker cron)

| Agent | Schedule | Fires when |
|---|---|---|
| Sync health | every 15 min | connector error, or no successful sync in 2h |
| Deliverability watchdog | hourly | 7d bounce > threshold (default 3%), spam > 0.1%, or sending collapses to <10% of the agency's own baseline |
| SLA / performance | daily 08:00 UTC | volume < 80% of committed sends, positive-reply drought, reply rate < 40% of own baseline |
| Lead collision | hourly | two active agencies contacting the same brand/domain |
| Daily digest | daily 07:00 UTC | always — portfolio ROI, per-agency one-liners, movers, red flags |

All alerts dedupe by fingerprint, land in the in-app Alert Center, and push to Slack
(per-agency channel if set, else the default channel/webhook).

## Security model

- **No plaintext secrets anywhere.** Agency API keys are AES-256-GCM encrypted in the
  `vault_secrets` table; the master key exists only in the `MASTER_KEY` env var. Decryption
  happens in server memory at sync time. Keys never reach the frontend or logs (URL redaction
  on every log line).
- **All third-party calls are server-side** — required anyway since Smartlead auths via query param.
- **Per-agency keys**: rotating or revoking one agency never touches another. Rotation tests the
  new key live, then revokes the old ciphertext (zeroed, unrecoverable).
- **Webhooks** are per-connection URLs with a random token (only its SHA-256 stored), payloads
  whitelisted by event type.
- **Archive** (the default "cut") revokes the stored key automatically and reminds you to revoke
  agency-side. **Purge** requires typing the agency name and cascades a hard delete; the UI offers
  a full CSV export first.
- Auth v1 is a single Flax login (`ADMIN_PASSWORD`) with an HMAC-signed cookie; role scaffolding
  (audit actor field) is in place for later per-user logins.

## Platform requirements (tell agencies up front)

| Platform | Requirement for API access |
|---|---|
| Smartlead | Their workspace on **Pro plan or above**; API key is workspace-wide |
| Instantly | **Hypergrowth plan or above**; V2 scoped key (request **read-only** scopes) |
| Email Bison | API included on all plans; needs key **and** their instance URL |

Hard rule from the ops playbook: **new agencies must run Smartlead or Instantly** (Email Bison is
supported for the existing partner already on it).

## Demo mode

`npm run seed:demo` loads 5 agencies with ~90 days of realistic history (a clear keeper, a clear
cut, a watch, a ramping trial, an unattributed win, and one seeded cross-agency collision) so every
view is explorable before a single live key is connected. Demo connections are marked
`sync_status='demo'` and skipped by the worker, so demo and live agencies can coexist —
archive/purge the demo agencies whenever you're done with them.

## Repo layout

```
server/   Express API + pg-boss worker + adapters + agents (TypeScript, ESM)
web/      React SPA (Vite)
n8n/      Importable workflow JSONs (digest, alert relay)
docs/     DEPLOYMENT.md (Railway runbook), QA.md (launch checklist)
```

## Exports

Per-agency CSV export (lifetime summary + daily metrics + meetings + deals + spend) from the
Agency page, ROI page, and the purge flow. For PDF, use the ROI page's **Print / PDF** button —
the report view is print-friendly. (A server-rendered PDF was traded out for zero extra
dependencies; the CSV carries the data of record.)
