-- LinkBot database. Paste into Supabase -> SQL Editor -> Run. Safe to run more than once.
-- RLS is on with no policies: only the server (secret key) can read or write.

-- People who can use the bot (besides the owner IDs in ALLOWED_TELEGRAM_IDS).
create table if not exists users (
  telegram_id bigint primary key,
  first_name text,
  approved boolean not null default false,
  prefs jsonb not null default '{}'::jsonb, -- last chosen options, pre-selected next time
  profile jsonb, -- name, headline, photo for carousels (set in /settings)
  created_at timestamptz not null default now()
);

-- Where each user is in the conversation and what they picked so far.
create table if not exists sessions (
  telegram_id bigint primary key,
  step text not null default 'idle',
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Telegram can resend an update; we process each update_id only once.
create table if not exists processed_updates (
  update_id bigint primary key,
  created_at timestamptz not null default now()
);

-- Free chat history, so the bot remembers the conversation.
create table if not exists chat_messages (
  id bigint generated always as identity primary key,
  telegram_id bigint not null,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  created_at timestamptz not null default now()
);
create index if not exists chat_messages_user_idx on chat_messages (telegram_id, id desc);

-- Every post, from raw story to final text. status: draft | done.
create table if not exists posts (
  id uuid primary key default gen_random_uuid(),
  telegram_id bigint not null,
  status text not null default 'draft',
  voice_file_id text,
  transcript text,
  options jsonb not null default '{}'::jsonb,
  variants jsonb,
  meta jsonb not null default '{}'::jsonb, -- hooks, image prompt, slides, score
  final_text text,
  cost_usd numeric(10, 5) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Added later (for databases created before these columns existed).
alter table posts add column if not exists meta jsonb not null default '{}'::jsonb;
alter table users add column if not exists profile jsonb;
create index if not exists posts_user_idx on posts (telegram_id, created_at desc);

alter table users enable row level security;
alter table sessions enable row level security;
alter table processed_updates enable row level security;
alter table chat_messages enable row level security;
alter table posts enable row level security;
