-- The scalable knowledge loop, built on 002's fix_record:
--   * fix_outcome   — did a known fix actually work when applied (weights ranking)
--   * fix_playbook  — precomputed ranked fixes per signature, so reads never scan raw rows
--   * recipe_record — opt-in working, verified sketches (proof-carrying) for first answers
--   * knowledge_manifest — one served row, so every instance ships the same thing
--   * pgvector columns — semantic retrieval, used only when the database has pgvector;
--     without it the loop still runs on exact-signature matching.
-- Still never a whole sketch or prompt unless the user opts into recipe sharing.

-- Did a known fix work when it was applied? Real success beats recency for ranking.
create table if not exists fix_outcome (
  id bigserial primary key,
  user_id text not null references "user"(id) on delete cascade,
  signature_hash text not null,
  diff_hash text not null,
  worked boolean not null,
  board text,
  created_at timestamptz not null default now()
);
create index if not exists fix_outcome_sig on fix_outcome (signature_hash, diff_hash);
create index if not exists fix_outcome_user_time on fix_outcome (user_id, created_at desc);

-- Precomputed ranked fixes, refreshed from fix_record + fix_outcome. A read is
-- an index lookup on a small table instead of a scan-and-aggregate of every raw row.
create table if not exists fix_playbook (
  signature_hash text not null,
  board text not null default '',
  diff_hash text not null,
  diff text not null,
  kind text not null,
  core_version text,
  fixes int not null default 0,
  users int not null default 0,
  by_agent int not null default 0,
  worked int not null default 0,
  failed int not null default 0,
  score double precision not null default 0,
  last_at timestamptz not null default now(),
  primary key (signature_hash, board, diff_hash)
);
create index if not exists fix_playbook_rank on fix_playbook (signature_hash, score desc);

-- Opt-in working-sketch recipes. Only written when the owner turns recipe
-- sharing on; the sketch is the user's code, so this is off by default.
create table if not exists recipe_record (
  id bigserial primary key,
  user_id text not null references "user"(id) on delete cascade,
  board text,
  core text,
  core_version text,
  task text not null,
  task_hash text not null,
  sketch text not null,
  libraries text[] not null default '{}',
  proof text not null default 'compiled',
  created_at timestamptz not null default now()
);
create index if not exists recipe_task_time on recipe_record (task_hash, created_at desc);
create index if not exists recipe_board_time on recipe_record (board, created_at desc);

-- One served manifest row (id = 1), refreshed on a schedule.
create table if not exists knowledge_manifest (
  id int primary key,
  data jsonb not null,
  generated_at timestamptz not null default now(),
  constraint knowledge_manifest_one check (id = 1)
);

-- Semantic retrieval when the database has pgvector; skipped cleanly otherwise
-- (the local test Postgres may not have it; Neon does). 1536 dims matches
-- OpenAI's text-embedding-3-small in src/embed.js.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'vector') then
    create extension if not exists vector;
    execute 'alter table fix_record add column if not exists embedding vector(1536)';
    execute 'create index if not exists fix_record_embedding on fix_record using hnsw (embedding vector_cosine_ops)';
    execute 'alter table recipe_record add column if not exists embedding vector(1536)';
    execute 'create index if not exists recipe_embedding on recipe_record using hnsw (embedding vector_cosine_ops)';
  else
    raise notice 'pgvector not available; semantic retrieval disabled, exact matching still works';
  end if;
end $$;
