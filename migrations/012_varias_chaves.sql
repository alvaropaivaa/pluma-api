-- Várias chaves de parceiro por conta: uma por sistema que usa a API.
-- Antes existia uma só (accounts.api_key_hash) e gerar outra derrubava todo mundo
-- na hora: em 25/09/2026 isso quebrou a criação de conexões por horas, porque o
-- sistema que usava a chave antiga só descobriu levando 401.
create table if not exists account_keys (
  id           uuid primary key default gen_random_uuid(),
  account_id   uuid not null references accounts(id) on delete cascade,
  name         text not null,
  key_hash     text not null unique,
  hint         text not null default '',   -- últimos caracteres, para reconhecer a chave na lista
  created_at   timestamptz not null default now(),
  created_by   uuid references panel_users(id) on delete set null,
  created_ip   text,
  last_used_at timestamptz,                -- responde "posso revogar essa sem quebrar nada?"
  revoked_at   timestamptz,
  revoked_by   uuid references panel_users(id) on delete set null,
  revoked_ip   text
);

create index if not exists ix_account_keys_ativas on account_keys (key_hash) where revoked_at is null;
create index if not exists ix_account_keys_conta on account_keys (account_id);

-- A chave que já existe vira a primeira linha: nenhum .env precisa mudar no deploy.
insert into account_keys (account_id, name, key_hash)
select a.id, 'Chave inicial', a.api_key_hash
  from accounts a
 where a.api_key_hash is not null and a.api_key_hash <> ''
   and not exists (select 1 from account_keys k where k.key_hash = a.api_key_hash);
