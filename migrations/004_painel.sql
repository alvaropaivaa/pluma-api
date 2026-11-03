-- Usuários do painel (cada um pertence a uma conta)
create table panel_users (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null references accounts(id) on delete cascade,
  email         text not null unique,
  name          text,
  password_hash text not null,
  created_at    timestamptz not null default now(),
  last_login_at timestamptz
);

-- Sessões do painel (cookie httpOnly com um token aleatório; no banco fica só o hash)
create table panel_sessions (
  token_hash  text primary key,
  user_id     uuid not null references panel_users(id) on delete cascade,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);
create index panel_sessions_user_idx on panel_sessions (user_id);
