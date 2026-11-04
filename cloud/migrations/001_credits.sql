-- Impulse Cloud app tables. Better Auth owns "user", "session", "account" and
-- "verification" (created first by scripts/migrate.js). Amounts are
-- millicredits: 1 credit = 1000, so per-request charges never round to zero.

create table if not exists credit_account (
  user_id text primary key references "user"(id) on delete cascade,
  plan text not null default 'free',
  -- The plan's monthly allowance: refilled at period_end, can run below zero
  -- by at most one request's cost.
  plan_credits bigint not null default 0,
  -- Bonus, granted and bought credits: never expire, spent after plan credits.
  bonus_credits bigint not null default 0,
  period_start timestamptz not null default now(),
  period_end timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists credit_ledger (
  id bigserial primary key,
  user_id text not null references "user"(id) on delete cascade,
  kind text not null check (kind in (
    'signup_bonus', 'monthly_grant', 'usage', 'admin_grant', 'admin_debit',
    'purchase', 'refund', 'plan_change'
  )),
  delta bigint not null,
  plan_after bigint not null,
  bonus_after bigint not null,
  usage_id bigint,
  note text,
  actor_id text,
  created_at timestamptz not null default now()
);
create index if not exists credit_ledger_user_time on credit_ledger (user_id, created_at desc);

create table if not exists usage_event (
  id bigserial primary key,
  user_id text not null references "user"(id) on delete cascade,
  model text not null,
  served_model text,
  status text not null default 'pending'
    check (status in ('pending', 'ok', 'error', 'aborted', 'refused')),
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cache_read_tokens integer not null default 0,
  cache_write_tokens integer not null default 0,
  -- What the upstream call cost us, in micro-USD (list price).
  cost_micros bigint not null default 0,
  credits_charged bigint not null default 0,
  http_status integer,
  duration_ms integer,
  request_id text,
  client text,
  created_at timestamptz not null default now()
);
create index if not exists usage_event_user_time on usage_event (user_id, created_at desc);
create index if not exists usage_event_time on usage_event (created_at);

create table if not exists app_setting (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by text
);

-- One-time codes that hand a browser sign-in to the desktop app (PKCE).
create table if not exists desktop_code (
  code_hash text primary key,
  user_id text not null references "user"(id) on delete cascade,
  challenge text not null,
  expires_at timestamptz not null,
  used_at timestamptz
);
create index if not exists desktop_code_expiry on desktop_code (expires_at);

create table if not exists rate_bucket (
  user_id text not null,
  bucket timestamptz not null,
  count integer not null default 0,
  primary key (user_id, bucket)
);

create table if not exists upgrade_request (
  id bigserial primary key,
  user_id text not null references "user"(id) on delete cascade,
  plan text not null,
  note text,
  status text not null default 'open' check (status in ('open', 'approved', 'declined')),
  created_at timestamptz not null default now(),
  handled_by text,
  handled_at timestamptz
);
create unique index if not exists upgrade_request_one_open
  on upgrade_request (user_id) where status = 'open';

create table if not exists admin_audit (
  id bigserial primary key,
  actor_id text not null,
  action text not null,
  target_user_id text,
  detail jsonb,
  created_at timestamptz not null default now()
);
create index if not exists admin_audit_time on admin_audit (created_at desc);
