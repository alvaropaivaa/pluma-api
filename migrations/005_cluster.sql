-- Processos que seguram conexões (workers). Cada um renova o heartbeat a cada poucos segundos
create table workers (
  id           text primary key,
  host         text not null,
  port         int not null,
  started_at   timestamptz not null default now(),
  heartbeat_at timestamptz not null default now(),
  instances    int not null default 0,
  rss_mb       int,
  loop_lag_ms  int
);

-- Qual worker é dono de cada instância. Lease vencido = qualquer worker pode assumir
create table instance_leases (
  instance_id uuid primary key references instances(id) on delete cascade,
  worker_id   text not null,
  acquired_at timestamptz not null default now(),
  expires_at  timestamptz not null
);
create index instance_leases_worker_idx on instance_leases (worker_id);

-- Foto do próprio perfil (o roteador não tem as sessões em memória)
alter table instances add column picture_url text;
