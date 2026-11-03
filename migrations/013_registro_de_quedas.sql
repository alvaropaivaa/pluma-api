-- Histórico de quedas com começo E fim, para responder "quanto tempo esse número
-- ficou fora hoje?" sem ter que garimpar log. A tabela instance_incidents não
-- serve: ela é apagada quando o número volta, então o histórico se perde.
create table if not exists channel_downtime (
  id          bigserial primary key,
  instance_id uuid not null references instances(id) on delete cascade,
  started_at  timestamptz not null default now(),
  ended_at    timestamptz,                       -- nulo = ainda fora
  seconds     int,                               -- preenchido quando volta
  code        int,                               -- código do WhatsApp (428, 515, 500…)
  reason      text
);

-- Uma queda aberta por instância: a volta fecha a que estiver aberta.
create unique index if not exists ix_downtime_aberta on channel_downtime (instance_id) where ended_at is null;
create index if not exists ix_downtime_instancia_dia on channel_downtime (instance_id, started_at desc);
