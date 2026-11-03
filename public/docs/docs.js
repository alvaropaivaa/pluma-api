'use strict'

function h(tag, attrs, ...children) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
    else if (k === 'class') el.className = v
    else el.setAttribute(k, v === true ? '' : v)
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue
    el.append(c instanceof Node ? c : document.createTextNode(String(c)))
  }
  return el
}

let BRAND = 'API'
let BASE = location.origin

/** Parágrafo com **negrito** e `código` (texto fixo desta página, nunca dado externo) */
function p(text, tag = 'p') {
  const el = h(tag)
  for (const part of text.split(/(\*\*[^*]+\*\*|`[^`]+`)/)) {
    if (!part) continue
    if (part.startsWith('**')) el.append(h('b', {}, part.slice(2, -2)))
    else if (part.startsWith('`')) el.append(h('code', {}, part.slice(1, -1)))
    else el.append(part)
  }
  return el
}
const ul = (...items) => h('ul', {}, items.map((i) => p(i, 'li')))
const steps = (...items) => h('ol', { class: 'steps-doc' }, items.map((i) => p(i, 'li')))
const callout = (text, warn) => h('div', { class: 'callout' + (warn ? ' warn' : '') }, h('span', { class: 'ci' }, warn ? '⚠️' : '💡'), p(text))
const cards = (...items) => h('div', { class: 'cards' }, items.map(([emoji, title, text, href]) => h('a', { class: 'gcard', href }, h('span', { class: 'ge' }, emoji), h('b', {}, title), h('span', {}, text))))

function code(text) {
  const t = text.replaceAll('{BASE}', BASE).replaceAll('{BRAND}', BRAND)
  return h('div', { class: 'code-wrap' },
    h('pre', { class: 'code' }, t),
    h('button', {
      class: 'btn btn-sm',
      type: 'button',
      onclick: (e) => navigator.clipboard.writeText(t).then(() => { e.target.textContent = 'Copiado ✓'; setTimeout(() => (e.target.textContent = 'Copiar'), 1500) }),
    }, 'Copiar'),
  )
}

/** Endpoint recolhível: [método, caminho, descrição, parâmetros [[nome, obrigatório, descrição]], exemplo de corpo, exemplo de resposta] */
function ep(method, path, desc, params = [], body, response) {
  const box = h('div', { class: 'ep' },
    h('div', { class: 'ep-head', onclick: () => box.classList.toggle('open') },
      h('span', { class: 'm ' + method }, method), h('span', { class: 'path' }, path), h('span', { class: 'desc' }, desc), h('span', { class: 'chev' }, '›')),
    h('div', { class: 'ep-body' },
      params.length
        ? [h('div', { class: 'lbl' }, 'Parâmetros'), h('table', { class: 'params' }, h('tbody', {}, params.map(([n, req, d]) => h('tr', {}, h('td', {}, n, req ? h('span', { class: 'req' }, '*') : ''), h('td', {}, p(d, 'span'))))))]
        : null,
      body ? [h('div', { class: 'lbl' }, 'Exemplo de corpo'), code(typeof body === 'string' ? body : JSON.stringify(body, null, 2))] : null,
      response ? [h('div', { class: 'lbl' }, 'Resposta'), code(JSON.stringify(response, null, 2))] : null,
    ),
  )
  return box
}

const Q = [['instanceId', true, 'ID da instância (na query string)']]
const SEND_OK = { instanceId: '…', messageId: '3EB0C99881842E51879688', insertedId: '…' }
const common = [['phone', true, 'Número com DDI e DDD (5511999999999), ID de grupo (…@g.us) ou @lid'], ['messageId', false, 'Responder citando esta mensagem'], ['delayMessage', false, 'Espera N segundos antes de enviar (a resposta volta na hora)']]

// ================= conteúdo =================

const SECTIONS = [
  { group: 'Começando' },
  {
    id: 'intro',
    title: 'Visão geral',
    body: () => [
      p('A **{BRAND}** conecta números de WhatsApp ao seu sistema. Cada número é uma **instância**: você conecta lendo um QR code, envia mensagens por HTTP e recebe tudo que chega por **webhook**.'.replace('{BRAND}', BRAND)),
      p('Por onde começar:'),
      cards(
        ['⚡', 'Início rápido', 'Conecte um número e envie a primeira mensagem em 2 minutos.', '#inicio'],
        ['🔑', 'Autenticação', 'Token da instância e chave de parceiro: quando usar cada um.', '#auth'],
        ['🧩', 'Guias de integração', 'Chatbots, plataformas, n8n e migração de outra API.', '#guia-id-token'],
        ['📚', 'Referência', 'Todas as rotas com parâmetros e exemplos.', '#compat'],
      ),
      callout('A {BRAND} conecta como um "aparelho conectado", igual ao WhatsApp Web. Siga as **boas práticas** para evitar bloqueios. Para disparos em massa, prefira a API oficial da Meta.'.replace('{BRAND}', BRAND), true),
    ],
  },
  {
    id: 'inicio',
    title: 'Início rápido',
    body: () => [
      steps(
        'Entre no **painel** (`{BASE}/painel/`) com o e-mail e a senha que você recebeu.'.replace('{BASE}', BASE),
        'Clique em **Criar instância** e dê um nome (ex.: "Comercial"). O QR code abre na hora.',
        'Leia o QR com o celular: WhatsApp → Configurações → Aparelhos conectados → Conectar aparelho.',
        'Clique em **Gerenciar** → aba **ID e token** e copie o **Instance ID** e o **Token**.',
        'Envie a primeira mensagem:',
      ),
      code('curl -X POST "{BASE}/v1/message/send-text?instanceId=SEU_INSTANCE_ID" \\\n  -H "Authorization: Bearer SEU_TOKEN" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"phone": "5511999999999", "message": "Olá! 👋"}\''),
      p('Resposta:'),
      code(JSON.stringify(SEND_OK, null, 2)),
    ],
  },
  {
    id: 'auth',
    title: 'Autenticação',
    body: () => [
      p('Existem três credenciais, cada uma para um uso:'),
      h('table', { class: 'params' }, h('tbody', {},
        [['Token da instância', 'Rotas `/v1/...`. Vai no header `Authorization: Bearer <token>` junto com `?instanceId=<id>`. Pega no painel, aba **ID e token**.'],
         ['Chave de parceiro', 'Criar instâncias automaticamente (`/v1/integrator/create-instance`) e as rotas nativas (header `x-api-key`). Gera no painel, em **Chaves de API**. Aparece uma vez só. Use uma chave por sistema: revogar uma não afeta as outras.'],
         ['Login do painel', 'E-mail e senha, só para usar o painel.'],
        ].map(([a, b]) => h('tr', {}, h('td', {}, a), h('td', {}, p(b)))))),
      callout('Trate o token e a chave como senhas: não coloque em código de front-end nem em repositório público. Se uma chave vazar, crie outra no painel, troque no sistema que usava a antiga e só então revogue a antiga — as demais continuam funcionando.', true),
    ],
  },

  { group: 'Guias de integração' },
  {
    id: 'guia-id-token',
    title: 'Conectar em um sistema que pede ID e token',
    body: () => [
      p('Chatbots, plataformas de atendimento, ferramentas de IA e automações costumam pedir três dados para usar um número de WhatsApp:'),
      steps(
        'No painel, clique em **Criar instância** e conecte o número pelo QR code.',
        'Clique em **Gerenciar** → aba **ID e token** e copie a **URL base**, o **Instance ID** e o **Token**.',
        'Cole os três dados na tela de integração do sistema. Se ele tiver o campo "URL da API", use `{BASE}/v1`.'.replace('{BASE}', BASE),
        'Se o sistema te der uma URL de webhook, cole no painel, aba **Webhooks** (o botão "usar a mesma URL em todos" ajuda).',
        'Mande uma mensagem de teste para o número e confira a entrega na aba **Logs**.',
      ),
      callout('Os dados seguem um padrão de mercado usado por várias APIs de WhatsApp. Se o sistema tiver o endereço de outra API fixo no código, basta pedir para deixar a URL base configurável.'),
    ],
  },
  {
    id: 'guia-crm',
    title: 'Plataforma que cria instâncias sozinha',
    body: () => [
      p('Ideal para SaaS, CRMs e plataformas com vários clientes: quando o usuário clica em **Conectar WhatsApp**, o seu sistema cria a instância, guarda o ID e o token e já mostra o QR. Ninguém precisa entrar no painel, e não existe custo por instância criada.'),
      steps('**Criar a instância** (só se o usuário ainda não tiver uma), com a chave de parceiro. Ela fica pronta na hora:'),
      code('POST {BASE}/v1/integrator/create-instance\nAuthorization: Bearer SUA_CHAVE_DE_PARCEIRO\nContent-Type: application/json\n\n{\n  "instanceName": "Cliente - fulano@empresa.com",\n  "webhookReceivedUrl": "https://seu-sistema.com/webhook",\n  "webhookDeliveryUrl": "https://seu-sistema.com/webhook",\n  "webhookStatusUrl": "https://seu-sistema.com/webhook",\n  "webhookConnectedUrl": "https://seu-sistema.com/webhook",\n  "webhookDisconnectedUrl": "https://seu-sistema.com/webhook",\n  "rejectCalls": false\n}'),
      code(JSON.stringify({ error: false, message: 'Instância criada com sucesso.', instanceId: '46d91a14-…', token: 'bbc1ee31…', instanceName: 'Cliente - fulano@empresa.com', status: 'ACTIVE' }, null, 2)),
      steps('**Guardar** `instanceId` e `token` no seu banco, ligados ao usuário.'),
      steps('**Antes de mostrar QR, conferir o status** (pedir QR com a sessão ativa dá erro):'),
      code('GET {BASE}/v1/instance/status-instance?instanceId=ID\nAuthorization: Bearer TOKEN\n\n→ { "instanceId": "…", "connected": false }'),
      steps('**Pedir o QR** e mostrar a imagem (`qrcode` já vem como data URL de imagem). Peça de novo a cada ~20 s até conectar:'),
      code('GET {BASE}/v1/instance/qr-code?instanceId=ID&image=disable\nAuthorization: Bearer TOKEN\n\n→ { "error": false, "qrcode": "data:image/png;base64,…", "instanceId": "…" }'),
      steps('**Esperar o webhook** `webhookConnected`: a partir daí é só enviar e receber.'),
      callout('Desconectar: `GET /v1/instance/disconnect` (desloga o aparelho). Excluir de vez: `DELETE /v1/integrator/delete-instance?instanceId=ID` com a chave de parceiro.'),
    ],
  },
  {
    id: 'guia-n8n',
    title: 'n8n',
    body: () => [
      p('**Enviar mensagem:** nó **HTTP Request**.'),
      ul(
        'Method: `POST` · URL: `{BASE}/v1/message/send-text?instanceId=SEU_ID`'.replace('{BASE}', BASE),
        'Authentication: **Generic → Header Auth** com Name `Authorization` e Value `Bearer SEU_TOKEN` (salve como credencial)',
        'Body: JSON `{ "phone": "{{$json.telefone}}", "message": "{{$json.texto}}" }`',
      ),
      p('**Receber mensagem:** nó **Webhook** (método POST). Copie a "Production URL" dele e cole no painel, aba **Webhooks**, em "Ao receber mensagem". O texto chega em `msgContent.conversation` ou `msgContent.extendedTextMessage.text`, e o telefone em `sender.id`.'),
      callout('Filtre `fromMe = false` no n8n para não responder às próprias mensagens.'),
    ],
  },
  {
    id: 'guia-migrar',
    title: 'Migrando de outra API',
    body: () => [
      p('As rotas `/v1` seguem o formato da W-API, um dos padrões mais usados no Brasil. Se o seu sistema já fala esse formato, a troca é de configuração, não de código.'),
      steps(
        'Crie as instâncias aqui (painel ou `create-instance`) e conecte os números. **Atenção:** o mesmo número não pode ficar ativo em duas APIs; ao conectar aqui, remova o aparelho antigo no celular.',
        'No seu sistema, troque a URL base da API antiga por `{BASE}/v1`.'.replace('{BASE}', BASE),
        'Troque o token de parceiro e os tokens de instância pelos daqui.',
        'Configure os webhooks (as URLs do seu sistema continuam as mesmas).',
        'Teste num ambiente de homologação primeiro. Se der problema, voltar é desfazer a troca da URL.',
      ),
      p('Diferenças conhecidas:'),
      ul(
        'O `instanceId` aqui é um UUID (ex.: `46d91a14-2275-…`).',
        'Não há rotas de cobrança: criar instância não tem custo.',
        'O webhook `webhookPresence` só chega para contatos inscritos (veja a referência nativa).',
      ),
    ],
  },

  { group: 'Referência da API' },
  {
    id: 'compat',
    title: 'Instância',
    body: () => [
      p('Todas as rotas levam `?instanceId=ID` e o header `Authorization: Bearer TOKEN`. Parâmetros podem ir no corpo JSON ou na query string. Erro sempre volta como `{ "error": true, "message": "…" }`.'),
      ep('POST', '/v1/integrator/create-instance', 'Criar instância (chave de parceiro)', [['instanceName', true, 'Nome'], ['webhook…Url', false, 'Received, Delivery, Status, Connected, Disconnected, Presence'], ['automaticReading', false, 'Marcar como lida ao receber'], ['rejectCalls / callMessage', false, 'Recusar ligações e mensagem enviada a quem ligou'], ['useProxy, proxyHost…', false, 'Proxy da instância']]),
      ep('GET', '/v1/integrator/list-instances', 'Listar instâncias (chave de parceiro)'),
      ep('DELETE', '/v1/integrator/delete-instance', 'Excluir instância (chave de parceiro)', Q),
      ep('GET', '/v1/instance/qr-code', 'QR code para conectar', [...Q, ['image', false, '`disable` = JSON com data URL (padrão); `enable` = imagem PNG']], null, { error: false, qrcode: 'data:image/png;base64,…', instanceId: '…' }),
      ep('GET', '/v1/instance/pairing-code', 'Conectar por código (sem câmera)', [...Q, ['phoneNumber', true, 'Número que vai conectar']], null, { error: false, instanceId: '…', pairingCode: 'WAPIPBYM' }),
      ep('GET', '/v1/instance/status-instance', 'Está conectada?', Q, null, { instanceId: '…', connected: true }),
      ep('GET', '/v1/instance/device', 'Dados do aparelho', Q, null, { connectedPhone: '5511999999999', lid: '…@lid', name: 'Fulano', platform: 'smbi', profilePictureUrl: 'https://…', status: 'Disponível', isBusiness: true }),
      ep('GET', '/v1/instance/fetch-instance', 'Dados da instância e configurações', Q),
      ep('GET', '/v1/instance/restart', 'Reiniciar a conexão', Q),
      ep('GET', '/v1/instance/disconnect', 'Deslogar o aparelho (também em /logout)', Q),
      ep('PUT', '/v1/instance/update-instance-name', 'Renomear', [...Q, ['instanceName', true, 'Nome novo']]),
      ep('PUT', '/v1/instance/update-auto-read-message', 'Leitura automática', [...Q, ['value', false, 'true/false (sem valor, alterna)']]),
      ep('PUT', '/v1/instance/update-ignore-groups', 'Ignorar grupos nos webhooks', [...Q, ['value', false, 'true/false']]),
      ep('PUT', '/v1/instance/update-call-reject-auto', 'Recusar ligações', [...Q, ['value', false, 'true/false']]),
      ep('PUT', '/v1/instance/update-call-reject-message', 'Mensagem ao recusar ligação', [...Q, ['value', true, 'Texto']]),
      ep('PUT', '/v1/instance/update-proxy', 'Proxy', [...Q, ['useProxy', true, 'true/false'], ['proxyProtocol', false, 'http, https ou socks5'], ['proxyHost / proxyPort', false, 'Endereço'], ['proxyUser / proxyPass', false, 'Credenciais']]),
      ep('PUT', '/v1/instance/profile-name', 'Nome do perfil do WhatsApp', [...Q, ['name', true, 'Até 25 caracteres']]),
      ep('PUT', '/v1/instance/profile-description', 'Recado do perfil', [...Q, ['description', true, 'Até 139 caracteres']]),
      ep('PUT', '/v1/instance/profile-picture', 'Foto do perfil', [...Q, ['url', true, 'URL ou base64 da imagem']]),
    ],
  },
  {
    id: 'compat-msg',
    title: 'Mensagens',
    body: () => [
      p('Toda rota de envio responde `{ instanceId, messageId, insertedId }`. O `insertedId` identifica o envio na fila. Com `delayMessage`, a resposta volta na hora e a mensagem sai depois.'),
      ep('POST', '/v1/message/send-text', 'Texto', [...Q, ...common, ['message', true, 'Texto (aceita *negrito*, _itálico_, emojis)']], { phone: '5511999999999', message: 'Olá!' }, SEND_OK),
      ep('POST', '/v1/message/send-image', 'Imagem', [...Q, ...common, ['image', true, 'URL ou base64'], ['caption', false, 'Legenda']], { phone: '5511999999999', image: 'https://…/foto.jpg', caption: 'Olha só' }),
      ep('POST', '/v1/message/send-video', 'Vídeo', [...Q, ...common, ['video', true, 'URL ou base64 (mp4)'], ['caption', false, 'Legenda']]),
      ep('POST', '/v1/message/send-audio', 'Áudio (chega como mensagem de voz)', [...Q, ...common, ['audio', true, 'URL ou base64; qualquer formato, convertido automaticamente']]),
      ep('POST', '/v1/message/send-document', 'Documento', [...Q, ...common, ['document', true, 'URL ou base64'], ['extension', false, 'pdf, docx, xlsx…'], ['fileName', false, 'Nome do arquivo'], ['caption', false, 'Legenda']]),
      ep('POST', '/v1/message/send-sticker', 'Figurinha', [...Q, ...common, ['sticker', true, 'URL ou base64 (png/jpg/gif viram figurinha)']]),
      ep('POST', '/v1/message/send-gif', 'GIF', [...Q, ...common, ['gif', true, 'URL ou base64 (mp4)'], ['caption', false, 'Legenda']]),
      ep('POST', '/v1/message/send-ptv', 'Vídeo redondo', [...Q, ...common, ['ptv', true, 'URL ou base64 (mp4)']]),
      ep('POST', '/v1/message/send-link', 'Link com prévia', [...Q, ...common, ['message', true, 'Texto'], ['linkUrl', true, 'Link'], ['title', true, 'Título da prévia'], ['linkDescription', false, 'Descrição'], ['image', false, 'Imagem da prévia (URL ou base64)']]),
      ep('POST', '/v1/message/send-location', 'Localização', [...Q, ...common, ['latitude / longitude', true, 'Coordenadas'], ['name', false, 'Nome do local'], ['address', false, 'Endereço']]),
      ep('POST', '/v1/message/send-contact', 'Contato', [...Q, ...common, ['contactName', true, 'Nome'], ['contactPhone', true, 'Telefone'], ['contactBusinessDescription', false, 'Empresa']]),
      ep('POST', '/v1/message/send-contacts', 'Vários contatos', [...Q, ...common, ['contacts', true, 'Lista de { contactName, contactPhone, contactBusinessDescription }']]),
      ep('POST', '/v1/message/send-poll', 'Enquete', [...Q, ...common, ['message', true, 'Pergunta'], ['poll', true, 'Lista de opções (2 a 12)'], ['pollMaxOptions', false, 'Quantas opções cada pessoa pode marcar']], { phone: '5511999999999', message: 'Melhor dia?', poll: ['Segunda', 'Terça'] }),
      ep('POST', '/v1/message/send-reaction', 'Reagir', [...Q, ['phone', true, 'Conversa'], ['messageId', true, 'Mensagem'], ['reaction', true, 'Emoji']]),
      ep('POST', '/v1/message/remove-reaction', 'Tirar reação', [...Q, ['phone', true, 'Conversa'], ['messageId', true, 'Mensagem']]),
      ep('POST', '/v1/message/edit-message', 'Editar mensagem enviada', [...Q, ['phone', true, 'Conversa'], ['messageId', true, 'Mensagem'], ['text', true, 'Texto novo']]),
      ep('DELETE', '/v1/message/delete-message', 'Apagar para todos', [...Q, ['phone', true, 'Conversa'], ['messageId', true, 'Mensagem enviada por este número']]),
      ep('POST', '/v1/message/read-message', 'Marcar como lida', [...Q, ['phone', true, 'Conversa'], ['messageId', true, 'Mensagem']]),
      ep('POST', '/v1/message/download-media', 'Baixar mídia recebida', [...Q, ['mediaKey', true, 'Do webhook (msgContent.*Message.mediaKey)'], ['directPath', true, 'Do webhook'], ['type', true, 'image, video, audio, document, sticker'], ['mimetype', true, 'Do webhook']], null, { error: false, fileLink: 'https://…', expires: 1790000000000 }),
      h('h3', {}, 'Interativas (experimental)'),
      callout('Botões, lista, carrossel, PIX e OTP são montados como mensagens interativas do WhatsApp Business. O WhatsApp muda isso com frequência: **teste no seu celular antes de usar em produção**, porque alguns aparelhos podem não exibir.', true),
      ep('POST', '/v1/message/send-buttons-action', 'Botões de ação', [...Q, ...common, ['message', true, 'Texto'], ['buttonActions', true, 'Até 10: { type: CALL | URL | REPLY, buttonText, phone?, url? }']], { phone: '5511999999999', message: 'Como prefere falar?', buttonActions: [{ type: 'URL', buttonText: 'Site', url: 'https://…' }, { type: 'CALL', buttonText: 'Ligar', phone: '+5511999999999' }, { type: 'REPLY', buttonText: 'Falar com atendente' }] }),
      ep('POST', '/v1/message/send-button-list', 'Botões de resposta', [...Q, ...common, ['message', true, 'Texto'], ['buttonList.buttons', true, 'Lista de { id, label }']]),
      ep('POST', '/v1/message/send-list', 'Lista de opções', [...Q, ...common, ['title', false, 'Título'], ['description', true, 'Texto'], ['buttonText', true, 'Texto do botão que abre a lista'], ['footerText', false, 'Rodapé'], ['sections', true, 'Lista de { title, rows: [{ title, description, rowId }] }']]),
      ep('POST', '/v1/message/send-carousel', 'Carrossel', [...Q, ...common, ['message', true, 'Texto'], ['cards', true, 'Lista de { text, image, buttonActions }']]),
      ep('POST', '/v1/message/send-otp', 'Código com botão de copiar', [...Q, ...common, ['message', true, 'Texto'], ['buttonText', true, 'Texto do botão'], ['code', true, 'Código copiado']]),
      ep('POST', '/v1/message/send-pix', 'Botão de PIX', [...Q, ...common, ['merchantName', false, 'Nome do recebedor'], ['pixKey', true, 'Chave'], ['type', true, 'CPF, CNPJ, PHONE, EMAIL ou EVP'], ['amount', false, 'Valor em reais']]),
    ],
  },
  {
    id: 'compat-chats',
    title: 'Conversas e contatos',
    body: () => [
      ep('GET', '/v1/chats/fetch-chats', 'Conversas recentes', [...Q, ['perPage', false, 'Padrão 20'], ['page', false, 'Padrão 1']]),
      ep('GET', '/v1/chats/chat', 'Uma conversa', [...Q, ['phoneNumber', true, 'Número ou JID']]),
      ep('POST', '/v1/chats/send-presence', '"Digitando…" / "Gravando…"', [...Q, ['phone', true, 'Conversa'], ['presence', true, 'composing, recording, paused, available'], ['delay', false, 'Segundos até parar sozinho']]),
      ep('POST', '/v1/chats/fetch-older-messages', 'Buscar mensagens antigas', [...Q, ['phone', true, ''], ['count', false, 'Quantas buscar (padrão 50, máximo 200)']], 'As mensagens chegam pelo webhook em alguns segundos, marcadas com historical: true.'),
      ep('GET', '/v1/contacts/phone-exists', 'O número tem WhatsApp?', [...Q, ['phoneNumber', true, 'Número']], null, { exists: true, phoneNumber: '5511999999999', lid: '1417…@lid' }),
      ep('POST', '/v1/contacts/check-numbers', 'Vários números de uma vez', [...Q, ['phones', true, 'Lista de números (até 500)']]),
      ep('GET', '/v1/contacts/fetch-contacts', 'Agenda', [...Q, ['perPage', false, ''], ['page', false, '']]),
      ep('GET', '/v1/contacts/profile-picture', 'Foto de perfil', [...Q, ['phoneNumber', true, 'Número']], null, { link: 'https://pps.whatsapp.net/…' }),
      ep('POST', '/v1/contacts/block-contact', 'Bloquear / desbloquear', [...Q, ['phoneNumber', true, 'Número'], ['blockStatus', true, 'block ou unblock']]),
    ],
  },
  {
    id: 'compat-group',
    title: 'Grupos',
    body: () => [
      ep('GET', '/v1/group/get-all-groups', 'Grupos que o número participa', Q),
      ep('POST', '/v1/group/create-group', 'Criar grupo', [...Q, ['groupName', true, 'Nome'], ['participants', true, 'Números'], ['profilePictureUrl', false, 'Foto'], ['autoInvite', false, '']], null, { error: false, group: { id: '1203…@g.us', inviteLink: 'https://chat.whatsapp.com/…' } }),
      ep('GET', '/v1/group/group-metadata', 'Dados do grupo', [...Q, ['groupId', true, '…@g.us']]),
      ep('GET', '/v1/group/get-Participants', 'Participantes', [...Q, ['groupId', true, '']]),
      ep('POST', '/v1/group/add-participant', 'Adicionar', [...Q, ['groupId', true, ''], ['phones', true, 'Números'], ['autoInvite', false, 'Quem não puder ser adicionado recebe o link']]),
      ep('POST', '/v1/group/remove-participant', 'Remover', [...Q, ['groupId', true, ''], ['phones', true, '']]),
      ep('POST', '/v1/group/add-admin', 'Promover a admin', [...Q, ['groupId', true, ''], ['phones', true, '']]),
      ep('POST', '/v1/group/remove-admin', 'Tirar admin', [...Q, ['groupId', true, ''], ['phones', true, '']]),
      ep('POST', '/v1/group/update-group-name', 'Renomear', [...Q, ['groupId', true, ''], ['groupName', true, '']]),
      ep('POST', '/v1/group/update-description', 'Descrição', [...Q, ['groupId', true, ''], ['description', true, '']]),
      ep('POST', '/v1/group/update-group-photo', 'Foto', [...Q, ['groupId', true, ''], ['groupPhoto', true, 'URL ou base64']]),
      ep('POST', '/v1/group/update-group-settings', 'Permissões', [...Q, ['groupId', true, ''], ['adminOnlyMessage', false, 'Só admins mandam mensagem'], ['adminOnlySettings', false, 'Só admins editam o grupo']]),
      ep('POST', '/v1/group/revoke-invite', 'Gerar link de convite novo', [...Q, ['groupId', true, '']]),
      ep('GET', '/v1/group/group-invitation-metadata', 'Dados de um convite', [...Q, ['inviteUrl', true, 'Link ou código']]),
      ep('DELETE', '/v1/group/leave-group', 'Sair do grupo', [...Q, ['groupId', true, '']]),
    ],
  },
  {
    id: 'compat-webhook',
    title: 'Configurar webhooks e fila',
    body: () => [
      ep('PUT', '/v1/webhook/update-webhook-received', 'URL: mensagem recebida', [...Q, ['value', true, 'URL (vazio desliga)']]),
      ep('PUT', '/v1/webhook/update-webhook-delivery', 'URL: mensagem enviada', [...Q, ['value', true, '']]),
      ep('PUT', '/v1/webhook/update-webhook-message-status', 'URL: status (entregue/lida)', [...Q, ['value', true, '']]),
      ep('PUT', '/v1/webhook/update-webhook-connected', 'URL: conectou', [...Q, ['value', true, '']]),
      ep('PUT', '/v1/webhook/update-webhook-disconnected', 'URL: desconectou', [...Q, ['value', true, '']]),
      ep('PUT', '/v1/webhook/update-webhook-chat-presence', 'URL: presença', [...Q, ['value', true, '']]),
      ep('GET', '/v1/webhook/fetch-webhook-logs', 'Histórico de entregas', [...Q, ['perPage', false, ''], ['page', false, '']]),
      ep('GET', '/v1/webhook/get-webhook-log', 'Uma entrega (com o conteúdo)', [...Q, ['id', true, '']]),
      ep('GET', '/v1/quere/quere', 'Mensagens na fila', [...Q, ['perPage', false, ''], ['page', false, '']]),
      ep('DELETE', '/v1/quere/delete-quere', 'Esvaziar a fila', Q),
      ep('DELETE', '/v1/quere/delete-message', 'Tirar uma mensagem da fila', [...Q, ['insertedId', true, 'Devolvido no envio']]),
    ],
  },

  { group: 'Webhooks' },
  {
    id: 'webhooks',
    title: 'Eventos',
    body: () => [
      p('Cada evento vai para a URL configurada para ele, como `POST` com JSON. Responda **2xx** em até 10 s. Se falhar, tentamos de novo em 2 s, 4 s, 8 s… até 10 vezes. A entrega é "pelo menos uma vez": use o `messageId` para ignorar repetidos.'),
      h('h3', {}, 'webhookReceived: mensagem recebida'),
      code(JSON.stringify({ event: 'webhookReceived', instanceId: '…', connectedPhone: '5511888888888', connectedLid: '…@lid', isGroup: false, messageId: '3A8317DB58329E0FF357', fromMe: false, chat: { id: '5511999999999', profilePicture: 'https://…' }, sender: { id: '5511999999999', senderLid: '…@lid', profilePicture: null, pushName: 'Fulano', verifiedBizName: '' }, moment: 1769084192, msgContent: { conversation: 'Oi, tudo bem?' } }, null, 2)),
      p('O texto vem em `msgContent.conversation` ou `msgContent.extendedTextMessage.text`. Mídia vem em `msgContent.imageMessage` (ou video/audio/document/sticker) com `URL`, `mediaKey` e `directPath`: baixe com `download-media`.'),
      h('h3', {}, 'webhookDelivery: mensagem enviada'),
      p('Mesmo formato, com `fromMe: true` e `fromApi`: `true` quando saiu pela API, `false` quando alguém mandou pelo celular.'),
      h('h3', {}, 'webhookStatus: entregue / lida'),
      code(JSON.stringify({ event: 'webhookStatus', instanceId: '…', status: 'READ', messageId: '3EB0…', fromMe: true, moment: 1770155908288, chat: { id: '…@lid' }, isGroup: false }, null, 2)),
      p('`status`: `SERVER_ACK` (saiu), `DELIVERY` (entregue), `READ` (lida), `PLAYED` (áudio ouvido), `ERROR`.'),
      h('h3', {}, 'webhookConnected / webhookDisconnected'),
      code(JSON.stringify({ event: 'webhookConnected', instanceId: '…', connectedPhone: '5511888888888', connectedLid: '…@lid', connected: true, moment: 1770903411 }, null, 2)),
      code(JSON.stringify({ event: 'webhookDisconnected', instanceId: '…', disconnected: true, moment: 1770903434 }, null, 2)),
      p('`webhookDisconnected` só é enviado quando a sessão cai de vez (deslogado no celular, bloqueio, aberto em outro lugar). Quedas rápidas de rede religam sozinhas, sem aviso.'),
    ],
  },
  {
    id: 'webhooks-nativo',
    title: 'Webhook nativo (assinado)',
    body: () => [
      p('No formato nativo, todos os eventos vão para uma URL só, com `{ event, instanceId, data, timestamp }` e os headers `x-webhook-event`, `x-webhook-id` e `x-webhook-signature` (HMAC-SHA256 do corpo com o segredo da instância). Valide assim (Node):'),
      code("import { createHmac, timingSafeEqual } from 'node:crypto'\n\nfunction assinaturaValida(corpoCru, header, segredo) {\n  const esperado = 'sha256=' + createHmac('sha256', segredo).update(corpoCru).digest('hex')\n  return header?.length === esperado.length && timingSafeEqual(Buffer.from(header), Buffer.from(esperado))\n}"),
      p('Eventos: `messages.upsert`, `messages.update`, `messages.delete`, `messages.edit`, `poll.update`, `send.update`, `connection.update`, `qr`, `presence.update`, `call`, `groups.update`, `group-participants.update`.'),
    ],
  },

  { group: 'Mais' },
  {
    id: 'nativo',
    title: 'Referência nativa (resumo)',
    body: () => [
      p('Autenticação: header `x-api-key: SUA_CHAVE_DE_PARCEIRO`. Tudo abaixo começa com `/instances/:id`.'),
      h('table', { class: 'params' }, h('tbody', {}, [
        ['POST /instances', 'Criar instância'],
        ['POST …/connect · GET …/qr', 'Conectar (body `{ phone }` para código de pareamento)'],
        ['POST …/messages', 'Enviar: `type` = text, image, video, audio, document, sticker, location, contact, poll, event, link, buttons, list, carousel, pix, reaction, edit, delete, forward, pin. Aceita `quotedId`, `mentions`, `delaySeconds`, `idempotencyKey`'],
        ['POST …/status', 'Publicar nos status (stories)'],
        ['GET …/chats · …/chats/:chatId/messages', 'Conversas e mensagens guardadas'],
        ['POST …/chats/:chatId/{archive,pin,mute,unread,clear,delete}', 'Ações na conversa'],
        ['GET …/contacts · POST …/check', 'Agenda e verificação em lote'],
        ['GET/POST …/groups…', 'Grupos (criar, participantes, admins, convite, configurações)'],
        ['GET …/profile · PUT …/profile/*', 'Perfil do número'],
        ['GET/PUT …/privacy', 'Privacidade'],
        ['PATCH …/settings', 'Leitura automática, ignorar grupos, recusar ligações, proxy, ritmo de envio (sendPerMinute, sendPerDay)'],
        ['GET/DELETE …/queue', 'Fila de envio'],
        ['GET …/webhook-logs', 'Histórico de webhooks'],
      ].map(([a, b]) => h('tr', {}, h('td', {}, a), h('td', {}, p(b)))))),
    ],
  },
  {
    id: 'boas-praticas',
    title: 'Boas práticas e limites',
    body: () => [
      ul(
        'Padrão: cada número envia até **60 mensagens por minuto**, sem limite diário. Dá para ajustar por instância (painel ou `PATCH …/settings`). Acima do limite a mensagem **não falha**: espera na fila e sai assim que houver vaga.',
        '**Número novo:** comece devagar. Nos primeiros dias, mande principalmente para quem já conversa com você.',
        'Evite o mesmo texto para muita gente de uma vez. Varie a mensagem e use `delayMessage`.',
        'Mensagem para quem nunca falou com o número é o que mais gera denúncia e bloqueio.',
        'Use o **proxy** para separar números de clientes diferentes.',
        'Guardamos as mensagens por 7 dias (necessário para citar, reagir e reenviar). Os links de mídia valem **7 dias**: baixe e guarde o arquivo no seu sistema quando o webhook chegar. Depois disso o arquivo é apagado do nosso servidor.',
      ),
      h('h3', {}, 'Erros comuns'),
      h('table', { class: 'params' }, h('tbody', {}, [
        ['401', 'Token ou chave errados (ou token de outra instância)'],
        ['400 "Instância desconectada"', 'Conecte pelo painel antes de enviar'],
        ['422', 'Número sem WhatsApp, ou mídia que não deu para baixar'],
        ['502 "WhatsApp recusou"', 'O próprio WhatsApp negou (ex.: não é admin do grupo)'],
      ].map(([a, b]) => h('tr', {}, h('td', {}, a), h('td', {}, b))))),
    ],
  },
]

async function main() {
  try {
    const b = await (await fetch('/painel/api/brand')).json()
    BRAND = b.name
    BASE = (b.publicUrl || location.origin).replace(/\/$/, '')
    const root = document.documentElement.style
    root.setProperty('--brand', b.color)
    root.setProperty('--brand-ink', inkFor(b.color))
    document.title = `${BRAND} · Documentação`
    document.querySelectorAll('[data-brand]').forEach((el) => (el.textContent = BRAND))
    document.querySelectorAll('[data-initial]').forEach((el) => {
      if (b.logo) el.replaceWith(h('img', { class: 'brand-logo', src: b.logo, alt: '' }))
      else el.textContent = BRAND.trim()[0].toUpperCase()
    })
  } catch {}

  document.getElementById('hero').append(
    h('span', { class: 'eyebrow' }, '● API de WhatsApp para desenvolvedores'),
    h('h1', {}, 'Conecte o WhatsApp ao seu sistema ', h('em', {}, 'em minutos')),
    h('p', {}, `Com a ${BRAND} você conecta vários números, envia qualquer tipo de mensagem e recebe tudo por webhook. Sem custo por instância e com painel para gerenciar.`),
    h('div', { class: 'row' },
      h('a', { class: 'btn btn-primary btn-pill', href: '#inicio' }, 'Começar agora →'),
      h('a', { class: 'btn btn-pill', href: '#compat' }, 'Ver as rotas'),
    ),
    h('div', { class: 'features' },
      [['📱', 'Vários números', 'Uma instância por número, criadas pelo painel ou pela API.'],
       ['💬', 'Todo tipo de mensagem', 'Texto, mídia, áudio, figurinha, enquete, botões e mais.'],
       ['🔔', 'Webhooks confiáveis', 'Tentamos de novo se o seu sistema estiver fora do ar.'],
       ['🔄', 'Fácil de migrar', 'Segue o formato mais usado no Brasil: troque só a URL.']]
        .map(([e, t, d]) => h('div', { class: 'feature' }, h('div', { class: 'fi' }, e), h('b', {}, t), h('span', {}, d))),
    ),
  )

  const toc = document.getElementById('toc')
  const content = document.getElementById('content')
  const links = []
  for (const s of SECTIONS) {
    if (s.group) {
      toc.append(h('b', {}, s.group))
      continue
    }
    const title = s.title.replace('{BRAND}', BRAND)
    const a = h('a', { href: '#' + s.id }, title)
    links.push([s.id, a])
    toc.append(a)
    content.append(h('section', { id: s.id }, h('h2', {}, title), ...s.body()))
  }
  // Destaca no menu a seção que está na tela
  const spy = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue
      for (const [id, a] of links) a.classList.toggle('on', id === e.target.id)
    }
  }, { rootMargin: '-80px 0px -70% 0px' })
  content.querySelectorAll('section').forEach((sec) => spy.observe(sec))
  if (location.hash) document.querySelector(location.hash)?.scrollIntoView()
}
main()

/** Texto sobre a cor da marca: branco ou quase-preto, o que tiver mais contraste (WCAG) */
function inkFor(hex) {
  const lum = (c) => {
    const v = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4))
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]
  }
  const l = lum(hex)
  return (1.05 / (l + 0.05)) >= (l + 0.05) / (lum('#04120c') + 0.05) ? '#ffffff' : '#04120c'
}
