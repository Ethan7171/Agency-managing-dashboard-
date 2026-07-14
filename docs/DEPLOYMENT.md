# Deployment — Railway

Two services + one Postgres, all in one Railway project. Total setup ≈ 15 minutes.

## 1. Provision

1. Create a Railway project → **Add Postgres**.
2. **Service A — `api`**: deploy this repo.
   - Build: `npm install && npm run build`
   - Start: `npm run start:api`
3. **Service B — `worker`**: same repo, second service.
   - Build: `npm install && npm run build`
   - Start: `npm run start:worker`
4. Give the `api` service a public domain (Settings → Networking → Generate Domain).

Both services run migrations on boot (idempotent), so deploy order doesn't matter.

## 2. Environment variables (set on BOTH services)

| Var | Required | Notes |
|---|---|---|
| `DATABASE_URL` | ✅ | Reference Railway Postgres: `${{Postgres.DATABASE_URL}}` |
| `MASTER_KEY` | ✅ | 64 hex chars. Generate once: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. **Losing it means re-entering every agency key.** Store a copy in the team password manager. |
| `ADMIN_PASSWORD` | ✅ | The single Flax login |
| `APP_BASE_URL` | ✅ (api) | The public Railway URL — used to mint webhook URLs |
| `CLOSE_API_KEY` | for attribution | Close → Settings → API Keys |
| `CLOSE_AGENCY_FIELD` | default `outbound_agency` | Name of the Close custom field carrying the agency code |
| `SLACK_BOT_TOKEN` or `SLACK_WEBHOOK_URL` | for alerts/digest | Bot token enables per-agency channels; webhook is single-channel |
| `SLACK_DEFAULT_CHANNEL` | with bot token | e.g. `C0123ABCD` |
| `ANTHROPIC_API_KEY` | optional | Enables the reply classifier (cost-capped) |
| `CLASSIFIER_DAILY_CAP` | default `500` | Max classified messages/day |
| `DEMO_MODE` | default `false` | `true` skips live syncs entirely |
| `BACKFILL_DAYS` | default `60` | Clamped 30–90 |
| `SYNC_CRON` | default `*/30 * * * *` | Platform sync cadence |

## 3. First boot

```
# optional but recommended for the first look:
railway run npm run seed:demo
```

Open the public URL → sign in with `ADMIN_PASSWORD`. You'll see the demo portfolio.

## 4. Onboarding a real agency (5 minutes)

1. **Settings → + Add agency** — name + unique `agency_code` (+ Slack channel, SLA sends/day).
2. Ask the agency for a **read-only API key**:
   - *Smartlead*: Settings → API key (their workspace must be Pro+). Ask them to include the
     agency code in campaign names or tags.
   - *Instantly*: create a V2 key with read scopes only (Hypergrowth+).
   - *Email Bison*: API key + their instance URL.
3. Paste key → **Test connection** → wait for the green check → **Save & backfill** (pulls
   `BACKFILL_DAYS` of history immediately).
4. Copy the one-time **webhook URL** and have the agency add it for reply/bounce events
   (optional; syncs still run every 30 min without it).
5. Enter the month's spend on the **ROI & Spend** page.
6. In Close, make sure the `outbound_agency` custom field exists and sales sets it to the
   agency code on sourced leads/opportunities.

## 5. Slack + n8n

Core alerts and the daily digest post directly from the worker — n8n is optional redundancy /
routing. To use it: import `n8n/daily-digest.json` and `n8n/critical-alert-relay.json`, then set
n8n env vars `FLAX_OCC_BASE_URL`, `FLAX_OCC_PASSWORD`, `SLACK_WEBHOOK_URL`.

## 6. Cutting an agency

- **Archive** (default): Agency page → Archive. Syncs stop, our stored key is revoked, lifetime
  summary frozen, history stays visible under Settings → Archived. Then revoke the key on the
  agency's side too (the UI reminds you).
- **Purge** (rare): Agency page → Purge — export offered first, requires typing the agency name,
  then a cascading hard delete.

## 7. Operations notes

- **Key rotation**: Settings → Rotate key. Tested live before the old one is revoked.
- **Platform swap**: Settings → Swap platform. History is preserved; metrics continue under the
  same agency.
- **Data freshness**: every view shows last-sync; the sync-health agent alarms after 2h of staleness.
- **Backups**: enable Railway Postgres backups (Settings → Backups). The vault lives in this DB —
  backups + `MASTER_KEY` together restore everything.
