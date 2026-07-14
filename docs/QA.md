# QA — launch smoke test record

Executed against a live local stack (Postgres 16 + compiled `dist/` builds of both services,
seeded with `npm run seed:demo`). All 40 checks passed.

## What was verified

**Auth** — unauthenticated 401 · wrong password 401 · login sets HMAC cookie · logout invalidates.

**Portfolio rollup** — leaderboard across 7d / 30d / all-time; verdicts always computed on the
trailing 30 days regardless of the display window (a quiet week can't flip a keeper to "cut");
prorated spend math; 14-day sparkline trends; sort by ROI.

**Agency deep-dive** — detail + connection state · 30d funnel (sent→delivered→replied→positive→
booked→showed→closed) · MoM deltas · campaign table · 90 days of daily metrics ·
deliverability snapshots · deals · meetings.

**Inbox & leads** — thread list, positive/booked filters, per-agency filter · lead search ·
journey timeline (contact → replies → meetings → deals) · the seeded cross-agency collision
resolves to exactly two agencies on one domain.

**ROI & spend** — monthly spend PUT upsert (retainer + fees → total) · spend history ·
cost-per-positive / per-meeting / per-close in rollup.

**Alerts** — seeded bounce/collision/collapse alerts listed · acknowledge removes from open ·
unattributed-deals bucket shows the seeded Close win · manual attribution moves it to an agency
and back.

**Digest** — `/api/digest/daily.txt` renders the Slack-ready text with portfolio ROI and
per-agency verdict lines.

**Connections** — test-before-store returns a clean failure (no crash, key never persisted) when
the platform call fails · webhook endpoint rejects a bad token with 401 · agency_code regex
rejected · duplicate code → 409.

**Lifecycle** — archive freezes a lifetime summary, revokes the vault key, keeps history ·
purge preview returns row counts · purge with wrong name 400 · purge with exact name cascades ·
export CSV contains all five sections and survives the purge flow (offered first).

**Audit** — archive / purge / attribute / export / spend actions all recorded.

## Bugs found during QA (all fixed in this build)

1. pg-boss v10 `createQueue` signature (options object requires `name`).
2. `tsc` doesn't copy `.sql` migrations — build now copies them into `dist/`.
3. Postgres rejected the original spend-proration CTE (window function inside an aggregate) —
   rewritten as overlap-day proration.
4. Async route errors escaped Express 4 and crashed the process — every handler is now wrapped
   so failures return 500s and the service stays up.
5. Verdict was computed from the display window — now pinned to trailing 30d.
6. Seed had the collision brand in the generic lead pool (5-agency collision instead of the
   intended 2) — excluded.

## Known limitations to note on first live connect

- Smartlead / Instantly / Email Bison adapter endpoints follow their public docs but were not
  exercised against live keys from this sandbox (egress blocked). Mappings are isolated in
  `server/src/adapters/*` — if a field name drifted, it's a one-file fix per platform.
  Email Bison is the least-documented of the three and most likely to need a tune pass.
- The AI reply classifier needs `ANTHROPIC_API_KEY`; without it, threads still sync and
  platform-provided interest labels are used.
- PDF export is the ROI page's print view + per-agency CSV (data of record).
