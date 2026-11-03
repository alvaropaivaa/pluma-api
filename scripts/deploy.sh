#!/usr/bin/env bash
# Deploy sem queda: troca um container da API de cada vez.
# O que sai passa os números para o outro (cada número pisca 1 a 3 s, sem ler QR de novo).
# Uso, no servidor, dentro da pasta do projeto:  scripts/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."

log() { printf '\n==> %s\n' "$*"; }

wait_healthy() {
  local svc=$1
  for _ in $(seq 1 60); do
    local id state
    id=$(docker compose ps -q "$svc")
    state=$(docker inspect -f '{{.State.Health.Status}}' "$id" 2>/dev/null || echo starting)
    if [ "$state" = healthy ]; then
      # Dá um ciclo para os workers dele se registrarem e poderem receber números
      sleep 6
      return 0
    fi
    sleep 2
  done
  echo "ERRO: $svc não ficou saudável em 2 minutos. O outro container segue atendendo." >&2
  docker compose logs --tail 80 "$svc" >&2
  exit 1
}

# Quantos números cada container segura agora (troca primeiro o mais vazio: cada número muda uma vez só)
held_by() {
  docker compose exec -T db psql -U roxa -d api_roxa -Atc \
    "select count(*) from instance_leases where worker_id like '$1-worker-%' and expires_at > now()" 2>/dev/null || echo 0
}

log "Construindo a imagem nova"
docker compose build app_a

a=$(held_by a)
b=$(held_by b)
if [ "$a" -le "$b" ]; then order="app_a app_b"; else order="app_b app_a"; fi
log "Números: a=$a b=$b. Ordem: $order"

for svc in $order; do
  log "Trocando $svc (o outro segura os números)"
  docker compose up -d --no-deps "$svc"
  wait_healthy "$svc"
done

log "Pronto. Saúde:"
docker compose ps
