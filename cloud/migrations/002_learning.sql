-- Learning from fixes. One row per fix a user's app recorded and shared: the
-- error's signature (first error line with paths, line numbers and ports taken
-- out), the board and core, the libraries in play, a redacted diff of the
-- lines that changed, and who changed them. Aggregated per signature for the
-- app (known fixes) and the admin console (what people struggle with).
-- Never the whole sketch, never a prompt.

create table if not exists fix_record (
  id bigserial primary key,
  user_id text not null references "user"(id) on delete cascade,
  signature_hash text not null,
  signature text not null,
  kind text not null check (kind in ('compile', 'upload')),
  failure_code text,
  board text,
  core text,
  core_version text,
  libraries text[] not null default '{}',
  error_excerpt text not null,
  diff text not null default '',
  fixed_by text not null check (fixed_by in ('agent', 'user', 'unknown')),
  model text,
  app_version text,
  created_at timestamptz not null default now()
);
create index if not exists fix_record_signature_time on fix_record (signature_hash, created_at desc);
create index if not exists fix_record_user_time on fix_record (user_id, created_at desc);
create index if not exists fix_record_time on fix_record (created_at desc);
