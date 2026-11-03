# Segurança

Repositório privado da API Roxa. Achou uma falha? Não abra issue: fale direto com o time técnico.

## Como os dados são protegidos

- **No banco, cifrado (AES-256-GCM):** sessões do WhatsApp, tokens de instância, segredos de webhook, senha de proxy, conteúdo de mensagens, fila de envio e webhooks. A chave (`DATA_KEY`) fica só no `.env` do servidor, nunca no Git.
- **Nunca guardado em texto:** chaves de conta e sessões do painel (só o hash SHA-256); senhas do painel (scrypt).
- **Rede:** só 80/443 abertos; banco e workers sem acesso externo; HTTPS com HSTS; URLs de mídia/webhook para rede interna são recusadas (SSRF).
- **Acesso:** token por instância, chave de parceiro por conta, limite de requisições, freio de tentativa de senha, cookie `HttpOnly`/`Secure`/`SameSite=Strict`, proteção CSRF no painel.
- **Código:** varredura de segredos no commit (`.githooks/pre-commit`) e no CI (histórico inteiro), auditoria de dependências e Dependabot.

## Regras

- Nunca commitar `.env`, chaves, tokens ou dados de clientes. O hook e o CI barram, mas a responsabilidade é de quem commita.
- Perder a `DATA_KEY` = perder as sessões salvas (todos os números precisam ler o QR de novo). Guarde uma cópia num cofre de senhas.
- Vazou algum token? Gere outro no painel (o antigo para na hora).
