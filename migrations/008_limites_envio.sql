-- Limite de envio por instância. null = usa o padrão do servidor; send_per_day = 0 = sem limite diário
alter table instances
  add column send_per_minute int check (send_per_minute between 1 and 600),
  add column send_per_day int check (send_per_day >= 0);
