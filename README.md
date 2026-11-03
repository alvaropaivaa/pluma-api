# API Roxa

API não oficial de WhatsApp, multi-instância, sobre [Baileys](https://github.com/WhiskeySockets/Baileys) 7.

> Não oficial: viola os termos do WhatsApp e números podem ser banidos. Para números críticos, use a API oficial da Meta.

## Rodar local

```bash
cp .env.example .env        # preencha ADMIN_KEY (openssl rand -hex 32)
createdb whatsapp_api
npm install
npm run migrate
npm run dev
```

## Painel e documentação

- **Painel:** `/painel/`, com login por e-mail e senha. Lá ficam o dashboard (envios, recebidas, falhas, webhooks e quedas, calculados do banco), as instâncias, a conexão por QR ou código, o **ID e token** com botão de copiar, os webhooks, as configurações, o envio de teste, a fila, os logs e as chaves de parceiro (uma por sistema, com último uso e revogação individual).
- **Documentação:** `/docs/`, pública, com todos os endpoints e os guias de integração (sistema que pede ID e token, CRM que cria instância sozinho, n8n, migrar da W-API).
- **Marca:** API Roxa com a pena roxa (padrão). Para white-label: `BRAND_NAME`, `BRAND_COLOR` e `BRAND_LOGO` no `.env`.

Criar um usuário do painel (e a conta, se não existir):

```bash
npm run create-user -- --email voce@empresa.com --password 'senha-com-10+' --account "Nome da conta"
```

## Fluxo

```bash
# 1. criar conta + usuário do painel (pelo terminal; mostra a apiKey uma vez)
npm run create-user -- --email voce@empresa.com --password 'senha-com-10+' --account "Minha empresa"

# 2. criar instância -> guarda o webhookSecret, ele só aparece aqui
curl -XPOST localhost:8080/instances -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"name":"comercial","webhookUrl":"https://meu-crm/webhook"}'

# 3. conectar (QR) ou com código de pareamento (manda "phone")
curl -XPOST localhost:8080/instances/$ID/connect -H "x-api-key: $KEY"
curl localhost:8080/instances/$ID/qr -H "x-api-key: $KEY"      # qr, qrImage (data URL), pairingCode

# 4. enviar
curl -XPOST localhost:8080/instances/$ID/messages -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"to":"5511999999999","text":"oi"}'
```

Todas as rotas abaixo começam com `/instances/:id` (exceto as de conta e instância) e usam o header `x-api-key`.

**Conta e instância**

| Rota | O que faz |
|---|---|
| `POST /accounts` | cria conta (header `x-admin-key`; só com `ADMIN_API_ENABLED=true`) |
| `POST /instances` · `GET /instances` · `GET /instances/:id` · `DELETE /instances/:id` | criar, listar, detalhe, apagar |
| `POST …/connect` | liga; body opcional `{"phone"}` para código de pareamento |
| `GET …/qr` | QR atual (texto + imagem) |
| `POST …/restart` · `…/disconnect` · `…/logout` | reiniciar, desligar sem deslogar, deslogar |
| `PUT …/webhook` | `{"webhookUrl", "webhookEvents"}` |

**Mensagens**

| Rota | O que faz |
|---|---|
| `POST …/messages` | texto, imagem, vídeo, áudio, documento, figurinha, localização, contato, enquete, evento, encaminhar, reagir, editar, apagar, fixar (ver abaixo) |
| `POST …/status` | publica nos status (stories): texto, imagem, vídeo, áudio |
| `GET …/messages/jobs/:jobId` | situação de um envio |
| `GET …/messages/:messageId/media` | baixa de novo a mídia de uma mensagem (link novo) |

**Conversas**

| Rota | O que faz |
|---|---|
| `GET …/chats` · `GET …/chats/:chatId/messages` | conversas e mensagens guardadas (janela de retenção) |
| `POST …/chats/read` | `{"chatId", "messageIds?"}` marca como lida |
| `POST …/chats/:chatId/{archive,unarchive,pin,unpin,mute,unmute,unread,clear,delete}` | ações na conversa (`mute` aceita `{"seconds"}`) |
| `POST …/presence` | `{"to", "state"}`: `composing` (digitando), `recording` (gravando), `paused`, `available`, `unavailable` |

**Contatos**

| Rota | O que faz |
|---|---|
| `GET …/check/:phone` | tem WhatsApp? devolve o JID real |
| `GET …/contacts/:contact/{photo,about,business}` | foto, recado, perfil comercial |
| `POST …/contacts/:contact/{block,unblock}` · `GET …/blocklist` | bloquear, desbloquear, lista |
| `POST …/contacts/:contact/subscribe-presence` | passa a receber "online/digitando" desse contato |

**Perfil do número e privacidade**

| Rota | O que faz |
|---|---|
| `GET …/profile` | nome, JID, foto |
| `PUT …/profile/name` · `PUT …/profile/about` | nome, recado |
| `PUT …/profile/picture` · `DELETE …/profile/picture` | foto (url ou base64) |
| `GET …/privacy` · `PUT …/privacy` | visto por último, online, foto, recado, confirmação de leitura, quem adiciona em grupos, ligações, mensagens |

**Grupos**

| Rota | O que faz |
|---|---|
| `GET …/groups` · `POST …/groups` · `GET …/groups/:groupId` | listar, criar (`{"subject","participants"}`), detalhes |
| `PUT …/groups/:groupId/{subject,description,picture}` · `DELETE …/groups/:groupId/picture` | editar nome, descrição, foto |
| `PUT …/groups/:groupId/settings` | `announcement`, `locked`, `ephemeral`, `joinApproval`, `membersCanAdd` |
| `POST …/groups/:groupId/participants` | `{"action": add/remove/promote/demote, "participants"}` |
| `GET …/groups/:groupId/invite` · `POST …/groups/:groupId/invite/revoke` | link de convite, revogar |
| `GET …/groups/invite/:code` · `POST …/groups/join` | ver convite, entrar por link |
| `GET/POST …/groups/:groupId/requests` | pedidos para entrar (aprovar/recusar) |
| `POST …/groups/:groupId/leave` | sair |

**Ligações**: `POST …/calls/reject` `{"callId","from"}` (os dois vêm no webhook `call`).

Erros: `409` instância não conectada, `422` número sem WhatsApp ou mídia inválida, `404` mensagem não encontrada, `4xx` com "WhatsApp recusou" quando o próprio WhatsApp nega (ex.: não é admin do grupo).

### Envio

Todo envio passa por uma fila no banco (sobrevive a restart), com intervalo mínimo entre mensagens e ritmo por número (padrão 60/min, sem limite diário; ajustável por instância em `PATCH /instances/:id/settings` com `sendPerMinute`/`sendPerDay`). Acima do limite a mensagem espera, nunca falha. O `POST` espera até `SEND_WAIT_MS` pelo resultado:
`200` enviado (`messageId`), `202` ainda na fila (acompanhe por `jobId` ou webhook `send.update`), `4xx/502` falhou.

```jsonc
{ "to": "5511999999999", "type": "text", "text": "oi" }
{ "to": "...", "type": "image", "url": "https://...", "caption": "..." }      // ou "base64"
{ "to": "...", "type": "video", "url": "https://...", "caption": "..." }
{ "to": "...", "type": "audio", "url": "https://...", "ptt": true }          // ptt = mensagem de voz (converte com ffmpeg)
{ "to": "...", "type": "document", "url": "https://...", "fileName": "proposta.pdf" }
{ "type": "reaction", "messageId": "ABC", "emoji": "👍" }                     // "" remove
{ "type": "edit", "messageId": "ABC", "text": "corrigido" }
{ "type": "delete", "messageId": "ABC" }
{ "to": "...", "type": "sticker", "url": "https://.../foto.png" }              // png/jpg/gif viram webp 512x512
{ "to": "...", "type": "location", "latitude": -3.73, "longitude": -38.52, "name": "Loja", "address": "..." }
{ "to": "...", "type": "contact", "contacts": [{ "name": "Fulano", "phone": "5585999999999" }] }
{ "to": "...", "type": "poll", "name": "Melhor dia?", "options": ["Seg", "Ter"], "selectableCount": 1 }
{ "to": "...", "type": "event", "name": "Reunião", "startDate": "2026-09-20T14:00:00-03:00" }
{ "to": "...", "type": "forward", "messageId": "ABC" }
{ "type": "pin", "messageId": "ABC", "pin": true, "duration": 604800 }
```

Extras: `mentions` (telefones/JIDs) e `mentionAll` em texto e mídia; `viewOnce` em imagem/vídeo/áudio; `gif` e `videoNote` (vídeo redondo) em vídeo.

Opcionais: `quotedId` (responder citando) e `idempotencyKey` (ou header `Idempotency-Key`): repetir com a mesma chave não envia de novo.
Se a API cair no meio de um envio, o job vira `failed` com `errorCode: "interrupted"` em vez de reenviar (evita mensagem duplicada).

## Webhooks

`POST` com JSON `{ event, instanceId, data, timestamp }` e headers:

- `x-webhook-event`: `qr`, `connection.update`, `messages.upsert`, `messages.update` (entregue/lido), `messages.delete`, `messages.edit`, `poll.update` (votos), `send.update`, `presence.update`, `call`, `groups.update`, `group-participants.update`
- `x-webhook-id`: id da entrega (use para ignorar duplicatas; a entrega é "pelo menos uma vez")
- `x-webhook-signature`: `sha256=` + HMAC-SHA256 do corpo com o `webhookSecret`

Falhou (erro de rede ou status diferente de 2xx)? Tenta de novo em 2s, 4s, 8s... até 10 vezes. A ordem entre eventos não é garantida.

`messages.upsert` traz `chatPhone`/`senderPhone` já resolvidos de LID para telefone quando possível, `quotedId`, `reaction` e, para mídia, `media: { url, mimetype, fileName, size, seconds, ptt }`. A mídia é baixada e guardada no storage (`MEDIA_STORAGE`); o link vale `MEDIA_URL_TTL_DAYS` dias. Mídia de histórico com mais de 24h não é baixada.

Requer `ffmpeg` instalado no servidor (conversão de áudio).

Segurança: URLs de mídia e de webhook que apontem para a rede interna (localhost, 10.x, 169.254.x...) são recusadas. `ALLOW_PRIVATE_URLS=true` só em desenvolvimento local.

Prévia de link automática desligada (a biblioteca do Baileys tem falha de segurança sem correção); use `type: "link"` com título/descrição/imagem.

## Compatível com a W-API

As mesmas rotas, parâmetros, respostas e webhooks da [W-API](https://docs.w-api.app). A especificação que serviu de base está em [docs/wapi-spec.json](docs/wapi-spec.json). Para trocar um sistema que usa a W-API, basta mudar a URL base (`https://api.w-api.app/v1` → `https://<nossa-api>/v1`) e os tokens.

- **Autenticação:** `?instanceId=<id>` + `Authorization: Bearer <token da instância>`. O token vem em `GET /instances/:id` e em `create-instance`.
- **Criar instância automaticamente:** `POST /v1/integrator/create-instance` (ou `/v1/client/create-instance`) com `Authorization: Bearer <apiKey da conta>`, aceitando os mesmos campos da W-API (`instanceName`, `webhook*Url`, `automaticReading`, `rejectCalls`, `callMessage`, proxy). Também existem `GET …/list-instances` e `DELETE …/delete-instance`.
- **Webhooks:** `webhookReceived`, `webhookDelivery` (com `fromApi`), `webhookStatus`, `webhookConnected`, `webhookDisconnected` e `webhookPresence`, cada um na URL configurada para ele. A mídia vem com `URL`, `mediaKey` e `directPath` como no whatsmeow.

| Grupo | Rotas |
|---|---|
| instance | `qr-code`, `pairing-code`, `restart`, `disconnect`, `logout`, `status-instance`, `device`, `fetch-instance`, `update-instance-name`, `update-auto-read-message`, `update-ignore-groups`, `update-call-reject-auto`, `update-call-reject-message`, `update-proxy`, `profile-name`, `profile-description`, `profile-picture` |
| message | `send-text`, `send-image`, `send-video`, `send-audio`, `send-document`, `send-sticker`, `send-gif`, `send-ptv`, `send-link`, `send-location`, `send-contact`, `send-contacts`, `send-poll`, `send-reaction`, `remove-reaction`, `edit-message`, `delete-message`, `read-message`, `download-media`, `send-buttons-action`, `send-button-list`, `send-otp`, `send-pix`, `send-carousel`, `send-list` |
| chats | `fetch-chats`, `chat`, `send-presence` |
| contacts | `phone-exists`, `check-numbers`, `fetch-contacts`, `profile-picture`, `block-contact` |
| group | `create-group`, `update-group-name`, `update-group-photo`, `update-description`, `add-participant`, `remove-participant`, `add-admin`, `remove-admin`, `leave-group`, `group-metadata`, `group-invitation-metadata`, `get-Participants`, `revoke-invite`, `update-group-settings`, `get-all-groups` |
| webhook | `update-webhook-{connected,disconnected,delivery,received,message-status,chat-presence}`, `fetch-webhook-logs`, `get-webhook-log` |
| quere (fila) | `quere`, `delete-quere`, `delete-message` |

Fora do escopo: rotas de pagamento da W-API (`/v1/payment/*`) e `extension-token` (extensão de navegador deles).

**Experimental:** botões, lista, carrossel, PIX e OTP são mensagens interativas montadas à mão, como a W-API faz. O WhatsApp muda isso com frequência e alguns aparelhos podem não exibir.

## Status da instância

`created` → `connecting` → `qr` → `connected`. Finais (não religam sozinhos): `logged_out` (desconectado pelo celular), `replaced` (aberto em outro lugar), `forbidden` (possível banimento), `disconnected` (desligado ou QR expirou). Quedas comuns religam sozinhas com espera crescente até 60s.

## Segurança e estabilidade

- Dados sensíveis cifrados no banco (`DATA_KEY`, obrigatória em produção). Detalhes em [SECURITY.md](SECURITY.md).
- Supervisor (`dist/cluster.js`): roteador + um worker por CPU; reinicia quem cai, derruba quem trava (sem responder 30 s) e recicla worker acima de `MAX_WORKER_MEMORY_MB`.
- Cada número tem um dono (lease no banco); se um worker some, outro assume em ~30 s.

## Deploy sem queda

Produção roda **dois containers iguais** (`app_a` e `app_b`) atrás do Caddy. No servidor:

```bash
scripts/deploy.sh
```

O script constrói a imagem e troca um container de cada vez (o mais vazio primeiro). O que sai passa os números para o outro em lotes de 10 e avisa pelo Postgres (`pg_notify`), então o outro assume na hora: cada número fica fora 1 a 3 s, **sem ler QR de novo**, e o que chegar nesse meio o WhatsApp entrega na reconexão. A API continua respondendo o tempo todo. Migrações precisam ser só aditivas (os dois containers convivem por alguns segundos com versões diferentes).

## Testes

```bash
createdb whatsapp_api_test
npm test          # unidade + integração (Postgres)
```

O CI (`.github/workflows/ci.yml`) roda tipos, testes, auditoria de dependências, varredura de segredos no histórico e build da imagem. Ative o hook local: `git config core.hooksPath .githooks` (precisa do `gitleaks`).

## Roadmap

- [x] Fase 1: instâncias, QR/pareamento, sessão no Postgres, reconexão, texto, webhooks com outbox
- [x] Fase 2: mídia (envio e recebimento), fila persistente com limites e idempotência, grupos, lido/digitando/reação/edição/exclusão
- [x] Compatível com a W-API (todas as rotas, webhooks e criação automática de instância)
- [x] Extras: leitura automática, ignorar grupos, recusar ligações, agenda, fila, logs de webhook, proxy por instância, botões/lista/carrossel/PIX (experimental)
- [ ] Fase 3: vários workers com lease no Redis, painel de saúde, proxy por instância
- [ ] Fase 4: adapter no CRM (flag + staging + canário)
