-- Autor da mensagem em grupos (necessário para citar, reagir e marcar como lida)
alter table messages add column participant text;

-- Data da primeira conexão (base do aquecimento de números novos)
alter table instances add column first_connected_at timestamptz;
update instances set first_connected_at = connected_at where connected_at is not null;

-- Fila de envio persistente: sobrevive a restart da API
create table send_jobs (
  id              uuid primary key default gen_random_uuid(),
  instance_id     uuid not null references instances(id) on delete cascade,
  idempotency_key text,
  payload         jsonb not null,
  -- queued | sending | sent | failed
  status          text not null default 'queued',
  attempts        int not null default 0,
  not_before      timestamptz not null default now(),
  message_id      text,
  remote_jid      text,
  error_code      text,
  error           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  sent_at         timestamptz,
  unique (instance_id, idempotency_key)
);
create index send_jobs_queued_idx on send_jobs (instance_id, created_at) where status = 'queued';
create index send_jobs_sent_idx on send_jobs (instance_id, sent_at) where status = 'sent';
