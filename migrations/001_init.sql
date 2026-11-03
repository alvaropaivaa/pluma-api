-- Contas (cada cliente/agência que usa a API)
create table accounts (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  api_key_hash  text not null unique,
  created_at    timestamptz not null default now()
);

-- Instâncias = um número de WhatsApp conectado
create table instances (
  id              uuid primary key default gen_random_uuid(),
  account_id      uuid not null references accounts(id) on delete cascade,
  name            text not null,
  -- created | connecting | qr | connected | disconnected | logged_out | replaced | forbidden
  status          text not null default 'created',
  phone           text,
  -- se a instância deve estar ligada; é o que o boot usa para religar depois de um restart
  desired_running boolean not null default false,
  webhook_url     text,
  webhook_secret  text not null,
  -- vazio = todos os eventos
  webhook_events  text[] not null default '{}',
  last_error      text,
  connected_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (account_id, name)
);

-- Sessão do Baileys: credenciais (1 linha por instância)
create table auth_creds (
  instance_id uuid primary key references instances(id) on delete cascade,
  creds       text not null,
  updated_at  timestamptz not null default now()
);

-- Sessão do Baileys: chaves Signal (pre-key, session, sender-key, app-state...)
create table auth_keys (
  instance_id uuid not null references instances(id) on delete cascade,
  type        text not null,
  id          text not null,
  value       text not null,
  primary key (instance_id, type, id)
);

-- Mensagens recentes: o Baileys pede via getMessage para reenviar quando a outra ponta não descriptografa
create table messages (
  instance_id uuid not null references instances(id) on delete cascade,
  remote_jid  text not null,
  id          text not null,
  from_me     boolean not null,
  message     text not null,
  created_at  timestamptz not null default now(),
  primary key (instance_id, remote_jid, id)
);
create index messages_created_at_idx on messages (created_at);

-- LID <-> telefone (WhatsApp passou a usar LID no lugar do número em muitos eventos)
create table lid_mappings (
  instance_id uuid not null references instances(id) on delete cascade,
  lid         text not null,
  pn          text not null,
  updated_at  timestamptz not null default now(),
  primary key (instance_id, lid)
);
create index lid_mappings_pn_idx on lid_mappings (instance_id, pn);

-- Webhooks a entregar (outbox): nada se perde se o destino estiver fora do ar
create table webhook_outbox (
  id              bigserial primary key,
  instance_id     uuid not null references instances(id) on delete cascade,
  event           text not null,
  payload         jsonb not null,
  attempts        int not null default 0,
  next_attempt_at timestamptz not null default now(),
  delivered_at    timestamptz,
  failed_at       timestamptz,
  last_error      text,
  created_at      timestamptz not null default now()
);
create index webhook_outbox_pending_idx on webhook_outbox (next_attempt_at)
  where delivered_at is null and failed_at is null;
