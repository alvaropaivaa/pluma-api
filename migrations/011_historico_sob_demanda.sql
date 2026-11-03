-- Carimbo do WhatsApp na mensagem: é a âncora para pedir "mensagens mais antigas que esta".
-- Nas linhas antigas fica nulo e o pedido usa a data em que guardamos, que é equivalente.
alter table messages add column ts bigint;
