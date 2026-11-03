-- Worker saindo (deploy ou reciclagem): não recebe números novos e não conta na divisão justa
alter table workers add column draining boolean not null default false;
