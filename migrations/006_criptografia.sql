-- Conteúdo de mensagens na fila de envio e nos webhooks passa a ser guardado cifrado (texto)
alter table send_jobs alter column payload type text using payload::text;
alter table webhook_outbox alter column payload type text using payload::text;
-- Tokens de instância passam a ser gerados (e cifrados) pela aplicação
alter table instances alter column token drop default;
