-- Token por instância (Bearer das rotas compatíveis com a W-API)
alter table instances add column token text;
update instances set token = replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
alter table instances alter column token set not null;
alter table instances alter column token set default replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
create unique index instances_token_idx on instances (token);

-- Comportamento da instância
alter table instances add column auto_read boolean not null default false;
alter table instances add column ignore_groups boolean not null default false;
alter table instances add column reject_calls boolean not null default false;
alter table instances add column call_message text;

-- Webhooks no formato W-API, uma URL por evento: received, delivery, connected, disconnected, status, presence
alter table instances add column wapi_webhooks jsonb not null default '{}';

-- Proxy por instância: {protocol: http|https|socks5, host, port, user, pass}
alter table instances add column proxy jsonb;

-- Agenda: contatos que o WhatsApp sincroniza + quem mandou mensagem
create table contacts (
  instance_id   uuid not null references instances(id) on delete cascade,
  jid           text not null,
  lid           text,
  phone         text,
  name          text,
  notify        text,
  verified_name text,
  updated_at    timestamptz not null default now(),
  primary key (instance_id, jid)
);
create index contacts_phone_idx on contacts (instance_id, phone);

-- Webhooks: destino por evento (formato W-API) e resultado de cada entrega (logs)
alter table webhook_outbox add column target_url text;
alter table webhook_outbox add column response_status int;
alter table webhook_outbox add column duration_ms int;

-- Atraso pedido pelo cliente (delayMessage), para mostrar na fila
alter table send_jobs add column delay_seconds int not null default 0;
