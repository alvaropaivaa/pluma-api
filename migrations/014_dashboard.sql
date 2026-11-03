-- Consultas da tela inicial do painel. webhook_outbox só tinha índice das entregas
-- pendentes: sem estes, abrir o painel varreria a tabela inteira a cada atualização.
create index if not exists ix_webhook_outbox_instancia_dia on webhook_outbox (instance_id, created_at);
create index if not exists ix_send_jobs_falhas on send_jobs (instance_id, updated_at) where status = 'failed';
