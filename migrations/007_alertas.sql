-- E-mails que recebem os alertas da conta (vazio = e-mails dos usuários do painel)
alter table accounts add column alert_emails text[] not null default '{}';

-- Fila de e-mails de alerta: nada se perde se o provedor de e-mail estiver fora
create table alert_outbox (
  id              bigserial primary key,
  account_id      uuid references accounts(id) on delete cascade,
  instance_id     uuid references instances(id) on delete cascade,
  kind            text not null,           -- disconnected | unstable | reconnected | ops
  recipients      text[] not null,
  subject         text not null,
  html            text not null,
  attempts        int not null default 0,
  next_attempt_at timestamptz not null default now(),
  sent_at         timestamptz,
  failed_at       timestamptz,
  last_error      text,
  created_at      timestamptz not null default now()
);
create index alert_outbox_pending_idx on alert_outbox (next_attempt_at) where sent_at is null and failed_at is null;

-- Incidente aberto por instância: um e-mail quando cai, outro quando volta (sem repetir)
create table instance_incidents (
  instance_id uuid primary key references instances(id) on delete cascade,
  kind        text not null,               -- disconnected | unstable
  opened_at   timestamptz not null default now()
);

-- Alertas internos (operação): evita mandar o mesmo aviso toda hora
create table ops_alert_state (
  key          text primary key,
  last_sent_at timestamptz not null default now()
);

-- Desde quando a instância está no status atual (o "tentando reconectar há X min" precisa disso)
alter table instances add column status_changed_at timestamptz not null default now();
