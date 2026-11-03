-- Importar o histórico que o WhatsApp entrega quando o número conecta.
-- Desligado por padrão: quem liga é o dono da instância, um número por vez.
alter table instances
  add column import_history boolean not null default false,
  add column history_imported_at timestamptz;
