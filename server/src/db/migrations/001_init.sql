-- Flax Outbound Agency Command Center — unified schema
-- Principle: every platform's shape is normalized into these tables at ingest.
-- Deletion design: agencies.status='archived' is the reversible soft-delete;
-- a purge relies on ON DELETE CASCADE from agencies so one DELETE removes every dependent row.

create extension if not exists pgcrypto;

-- Encrypted credential store. Only ciphertext lives in the DB; the AES-256-GCM
-- master key exists solely in the MASTER_KEY env var. Rows are never updated in
-- place: rotation inserts a new row and revokes the old one.
create table vault_secrets (
  id          uuid primary key default gen_random_uuid(),
  label       text not null,
  ciphertext  bytea not null,
  iv          bytea not null,
  auth_tag    bytea not null,
  created_at  timestamptz not null default now(),
  revoked_at  timestamptz
);

create table agencies (
  id                    uuid primary key default gen_random_uuid(),
  name                  text not null,
  agency_code           text not null unique,
  status                text not null default 'trial'
                        check (status in ('active','trial','paused','archived')),
  start_date            date default current_date,
  primary_contact       text,
  slack_channel_id      text,
  notes                 text,
  -- SLA / alert thresholds (editable per agency)
  sla_daily_sends       integer not null default 0,
  threshold_bounce_rate numeric not null default 0.03,   -- 3%
  threshold_spam_rate   numeric not null default 0.001,  -- 0.1%
  sla_no_positive_days  integer not null default 7,
  roi_keep_threshold    numeric not null default 2.0,
  roi_cut_threshold     numeric not null default 1.0,
  archived_at           timestamptz,
  -- frozen lifetime summary written at archive time (spend, meetings, closes, mrr, roi)
  lifetime_summary      jsonb,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create table connections (
  id              uuid primary key default gen_random_uuid(),
  agency_id       uuid not null references agencies(id) on delete cascade,
  platform        text not null check (platform in ('smartlead','instantly','emailbison')),
  secret_id       uuid references vault_secrets(id) on delete set null,
  instance_url    text,               -- required for Email Bison per-account instances
  scope           text not null default 'read_only',
  webhook_token_hash text,            -- sha256 of the per-connection inbound webhook token
  active          boolean not null default true,
  last_synced_at  timestamptz,
  sync_status     text not null default 'pending'
                  check (sync_status in ('pending','ok','error','paused','demo')),
  last_error      text,
  created_at      timestamptz not null default now()
);
create index on connections (agency_id);

create table campaigns (
  id                   uuid primary key default gen_random_uuid(),
  agency_id            uuid not null references agencies(id) on delete cascade,
  connection_id        uuid not null references connections(id) on delete cascade,
  platform_campaign_id text not null,
  name                 text not null,
  status               text,
  created_at           timestamptz not null default now(),
  unique (connection_id, platform_campaign_id)
);
create index on campaigns (agency_id);

-- Time-series backbone: one row per campaign per day.
create table daily_metrics (
  id               bigserial primary key,
  agency_id        uuid not null references agencies(id) on delete cascade,
  campaign_id      uuid not null references campaigns(id) on delete cascade,
  date             date not null,
  emails_sent      integer not null default 0,
  delivered        integer not null default 0,
  bounced          integer not null default 0,
  opens            integer not null default 0,
  replies          integer not null default 0,
  positive_replies integer not null default 0,
  unsubscribes     integer not null default 0,
  spam_complaints  integer not null default 0,
  unique (campaign_id, date)
);
create index on daily_metrics (agency_id, date);

create table leads (
  id                 uuid primary key default gen_random_uuid(),
  agency_id          uuid not null references agencies(id) on delete cascade,
  platform_lead_id   text,
  email              text,
  company            text,           -- brand name; drives the collision detector
  company_domain     text,           -- normalized domain for collision matching
  status             text,
  interest_status    text,
  first_contacted_at timestamptz,
  last_activity_at   timestamptz,
  close_lead_id      text,
  unique (agency_id, platform_lead_id)
);
create index on leads (agency_id);
create index on leads (lower(company));
create index on leads (company_domain);

create table meetings (
  id            uuid primary key default gen_random_uuid(),
  agency_id     uuid not null references agencies(id) on delete cascade,
  lead_id       uuid references leads(id) on delete set null,
  close_activity_id text unique,
  booked_at     timestamptz not null,
  scheduled_for timestamptz,
  outcome       text not null default 'booked'
                check (outcome in ('booked','showed','no_show','rescheduled','cancelled')),
  source        text not null default 'close',
  lead_name     text
);
create index on meetings (agency_id, booked_at);

-- agency_id is nullable ON PURPOSE: a Close win with no outbound_agency value
-- lands here with agency_id null = the "unattributed" bucket. Never dropped.
create table deals (
  id                   uuid primary key default gen_random_uuid(),
  agency_id            uuid references agencies(id) on delete cascade,
  close_opportunity_id text unique,
  deal_name            text not null,
  value                numeric not null default 0,
  recurring_value_mrr  numeric not null default 0,
  status               text not null default 'open' check (status in ('open','won','lost')),
  won_at               timestamptz,
  created_at           timestamptz not null default now()
);
create index on deals (agency_id, status);

create table spend (
  id              uuid primary key default gen_random_uuid(),
  agency_id       uuid not null references agencies(id) on delete cascade,
  period          date not null,  -- first of month
  retainer        numeric not null default 0,
  per_meeting_fee numeric not null default 0,
  per_close_fee   numeric not null default 0,
  total_spend     numeric not null default 0,
  notes           text,
  unique (agency_id, period)
);

create table deliverability_snapshots (
  id                 bigserial primary key,
  agency_id          uuid not null references agencies(id) on delete cascade,
  date               date not null,
  bounce_rate        numeric not null default 0,
  spam_rate          numeric not null default 0,
  inbox_placement    numeric,          -- 0..1 when the platform exposes it
  domain_health      jsonb,            -- per-domain/account health from the platform
  blacklist_hits     integer not null default 0,
  unique (agency_id, date)
);

create table alerts (
  id              uuid primary key default gen_random_uuid(),
  agency_id       uuid references agencies(id) on delete cascade,  -- null = portfolio-level
  type            text not null,
  severity        text not null default 'warning' check (severity in ('info','warning','critical')),
  message         text not null,
  created_at      timestamptz not null default now(),
  acknowledged_at timestamptz,
  muted           boolean not null default false,
  -- dedupe key so agents don't re-fire the same alert every run
  fingerprint     text,
  unique (fingerprint)
);
create index on alerts (agency_id, created_at desc);

-- Reply threads pulled from each platform's master inbox (also the demo store).
create table threads_cache (
  id                 uuid primary key default gen_random_uuid(),
  agency_id          uuid not null references agencies(id) on delete cascade,
  platform_thread_id text not null,
  lead_email         text,
  lead_company       text,
  subject            text,
  snippet            text,
  interest_status    text,           -- positive / neutral / negative / booked
  ai_sentiment       text,           -- from the classifier when platform doesn't label
  messages           jsonb not null default '[]',
  deep_link          text,
  last_message_at    timestamptz,
  unique (agency_id, platform_thread_id)
);
create index on threads_cache (agency_id, last_message_at desc);

-- Classifier cache: never re-classify the same message. Also the cost meter.
create table reply_classifications (
  id            bigserial primary key,
  message_hash  text not null unique,
  sentiment     text not null,
  model         text not null,
  classified_at timestamptz not null default now()
);

create table sync_log (
  id            bigserial primary key,
  agency_id     uuid references agencies(id) on delete cascade,
  connection_id uuid references connections(id) on delete cascade,
  job           text not null,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  status        text not null default 'running' check (status in ('running','ok','error')),
  rows_written  integer not null default 0,
  error         text
);
create index on sync_log (agency_id, started_at desc);

create table audit_log (
  id         bigserial primary key,
  actor      text not null default 'flax_admin',
  action     text not null,
  entity     text not null,
  entity_id  text,
  detail     jsonb,
  created_at timestamptz not null default now()
);

-- Simple key/value for counters and app state (e.g. classifier daily spend).
create table app_meta (
  key   text primary key,
  value jsonb not null
);
