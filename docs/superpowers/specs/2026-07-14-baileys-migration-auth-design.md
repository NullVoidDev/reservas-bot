# Migração para Baileys + Página Oculta de Reautenticação

Data: 2026-07-14
Status: Aprovado (aguardando plano de implementação)

## Contexto

O bot de reservas roda hoje sobre `whatsapp-web.js` + `puppeteer`, que exige um
Chromium headless em segundo plano. Isso é a causa raiz do alto consumo de
memória em produção (SquareCloud, plano com 1999MB de RAM configurados) e
motivou um workaround no código atual que mata e reinicia o cliente sempre
que o uso de RAM ultrapassa 450MB (`index.js`, watchdog de memória).

Além disso, quando a sessão do WhatsApp expira (ex: o número foi deslogado
manualmente, trocou de aparelho, etc.), reautenticar o bot exige acesso ao
terminal/console do servidor para escanear o QR Code impresso em texto — não
há hoje um jeito de delegar essa reautenticação a outra pessoa (ex: o
cliente/dono do número) sem dar acesso ao painel da SquareCloud.

Este documento cobre duas mudanças relacionadas:

1. Migração da biblioteca de WhatsApp de `whatsapp-web.js` para `Baileys`,
   eliminando o Chromium e reduzindo drasticamente o uso de memória.
2. Uma página web oculta, com credenciais dinâmicas, que expõe o QR Code de
   autenticação (ou uma mensagem de status, se já autenticado) para que
   qualquer pessoa com o link e a senha do momento possa reautenticar o bot
   remotamente, sem acesso ao servidor.

## Fora de escopo

- Migrar o armazenamento de reservas de JSON para banco de dados (tratado
  separadamente — ver item de race condition já identificado em auditoria
  anterior).
- Autenticação/autorização do site público de reservas (`reservas.html`) —
  esse segue público, só sem o campo `numero` (já implementado).
- Qualquer mudança na lógica de negócio de `handleMessage` /
  `iniciarAvisos` além do necessário para adaptar o formato de mensagem.

## Arquitetura

### 1. Troca de biblioteca: whatsapp-web.js → Baileys

- Remove dependências: `whatsapp-web.js`, `puppeteer`, `qrcode-terminal`.
- Adiciona dependências: `@whiskeysockets/baileys`, `qrcode` (geração de
  imagem PNG/data-URL do QR para a página web), `pino` (logger leve exigido
  pelo Baileys).
- A sessão autenticada passa a ser persistida via `useMultiFileAuthState`
  numa pasta local `auth_session/` (adicionada ao `.gitignore` — equivalente
  a uma credencial, nunca deve ser versionada).
- O watchdog de memória (`index.js`, "RAM > 450MB mata o client") é removido
  — existia só para compensar o Chromium; Baileys não precisa dele.
- A reconexão automática passa a usar o evento `connection.update` nativo do
  Baileys (`connection === 'close'` com checagem do motivo via
  `DisconnectReason`) em vez do listener manual `client.on('disconnected')`.

### 2. Camada de adaptação de mensagens

O formato de mensagem do Baileys é estruturalmente diferente do
`whatsapp-web.js`. Para não reescrever `src/handler.js` (que contém toda a
lógica de negócio: reservar, cancelar, listar, avisos), a integração cria um
adaptador fino em `index.js`/`src/whatsapp.js`:

- Entrada: um listener `sock.ev.on('messages.upsert', ...)` recebe o evento
  bruto do Baileys, extrai o texto (`msg.message.conversation` ou
  `msg.message.extendedTextMessage.text`), o remetente
  (`msg.key.participant || msg.key.remoteJid`) e o JID de origem
  (`msg.key.remoteJid`), e monta um objeto `{ body, author, from }`
  equivalente ao que `handleMessage` já espera hoje — **nenhuma mudança de
  assinatura em `handleMessage`**.
- Saída: `clientAdapter.sendMessage(to, text)` (já existe hoje como
  abstração) passa a chamar `sock.sendMessage(jid, { text })` internamente
  em vez de `client.sendMessage(jid, text)`.

### 3. Estado do bot (módulo compartilhado)

Um módulo pequeno (`src/botStatus.js`) mantém em memória:
- `connected: boolean`
- `lastQrDataUrl: string | null` (QR atual, como data-URL PNG, gerado via
  `qrcode.toDataURL`)

Esse módulo é importado tanto pelo cliente Baileys (que o atualiza a cada
evento `connection.update`) quanto pela rota da página oculta (que só lê).

### 4. Página oculta de reautenticação

**Credenciais dinâmicas (path + senha):**

- Ao iniciar, e sempre que o bot ficar **desautenticado** (primeira
  inicialização sem sessão salva, ou perda de sessão), o servidor gera em
  memória:
  - um caminho secreto aleatório (`/auth-<hex de 16 bytes>`)
  - uma senha aleatória legível (ex: formato `Xk92-QpLw-7Bcd`, gerada a
    partir de bytes aleatórios codificados em base32/hex e agrupados)
- Esse par é impresso no log do processo (visível no painel da SquareCloud):
  ```
  [AUTH] Bot desconectado. Acesse para reautenticar:
  [AUTH] URL: https://<host>/auth-7f3a9c2e1b8d4f6a
  [AUTH] Senha: Xk92-QpLw-7Bcd
  [AUTH] Válida até: 14:32 (expira em 30 min)
  ```
- **Enquanto o bot estiver conectado, nada é gerado nem impresso** — a
  rotina de geração fica inativa.
- Enquanto o bot permanecer desautenticado, o par (path + senha) é
  regenerado e reimpresso a cada **30 minutos**; a combinação anterior deixa
  de ser aceita imediatamente após a rotação.
- Assim que a autenticação é concluída com sucesso (evento `connection.update`
  com `connection === 'open'`), a rotação para. Se o bot desconectar de novo
  no futuro, o ciclo reinicia do zero (novo path, nova senha, nova rotação).
- O path anterior, ao expirar por rotação, passa a responder 404 (não
  "esconde" o fato de ter existido de forma diferenciável de qualquer outra
  rota inexistente).

**Rota e fluxo de acesso:**

- `GET /<path-secreto>` → serve uma página HTML autocontida (sem link a
  partir de nenhum outro lugar do site, sem entrada em sitemap) com header
  `X-Robots-Tag: noindex`.
- A página abre pedindo a senha (campo de senha na própria página, conforme
  decidido). Ao submeter:
  - `POST /<path-secreto>/login` valida a senha (comparação
    *timing-safe*, via `crypto.timingSafeEqual`) contra a senha atual em
    memória.
  - Acerto → define um cookie de sessão (`httpOnly`, `sameSite=strict`,
    `secure` em produção) válido por 30 minutos, escopado a esse path.
  - Errado → contabiliza tentativa por IP; após 5 tentativas erradas em 10
    minutos, bloqueia novas tentativas desse IP por 10 minutos
    (rate-limiting simples em memória, sem dependência externa).
- Com cookie válido, o front-end faz polling em
  `GET /<path-secreto>/status` a cada ~3s:
  - Se `connected: true` → mostra apenas "✅ Bot autenticado e
    funcionando." (sem QR).
  - Se `connected: false` → mostra o QR atual (`lastQrDataUrl`) com o texto
    "Escaneie o QR Code abaixo para autenticar o bot no WhatsApp", atualiza
    a imagem sozinho se o QR mudar (o Baileys reemite `qr` periodicamente
    até ser escaneado), e troca para a mensagem de sucesso automaticamente
    assim que `connected` virar `true` — sem precisar recarregar a página.
- Se o path acessado não bate com o path secreto atual (por ter rotacionado
  ou nunca ter existido), a rota simplesmente não existe → 404 padrão do
  Express, indistinguível de qualquer URL aleatória.

### 5. Configuração / memória

- `package.json`: remove `whatsapp-web.js`, `puppeteer`, `qrcode-terminal`;
  adiciona `@whiskeysockets/baileys`, `qrcode`, `pino`.
- `squarecloud.config` / `squarecloud.app`: reduz `MEMORY` de `1999` para
  `512` (valor inicial sugerido, com folga; ajustável após observar consumo
  real em produção). Resolve também a duplicidade entre os dois arquivos de
  config, mantendo apenas um.
- `.gitignore` (novo arquivo, projeto ainda não tem controle de versão):
  ignora `node_modules/`, `auth_session/`, `.env`.

## Tratamento de erros

- Falha ao gerar QR (`qrcode.toDataURL` lança erro) → loga o erro, mantém
  `lastQrDataUrl` anterior (ou `null`), página mostra "Gerando QR Code,
  tente novamente em instantes."
- Falha na leitura/escrita da sessão (`auth_session/` corrompida ou sem
  permissão de disco) → loga erro explícito no boot e falha rápido (melhor
  um crash claro no log do que um bot "zumbi" que nunca conecta).
- Excesso de tentativas de senha → resposta HTTP 429 com mensagem genérica
  (não revela quantas tentativas restam, para não facilitar brute force).
- Cookie de sessão expirado durante uso ativo (usuário demorou mais de 30min
  na página) → próxima chamada a `/status` retorna 401; front-end detecta e
  volta a mostrar a tela de senha.

## Testes / verificação

Como este ambiente não tem acesso a um número de WhatsApp real para
escanear o QR, a verificação end-to-end completa (escanear e confirmar
`connected: true`) precisa ser feita manualmente após o deploy. O plano de
implementação deve cobrir, localmente:

- Sintaxe/typecheck de todos os arquivos alterados.
- Teste manual da rota oculta: senha errada é rejeitada, senha certa libera
  cookie, rate-limit bloqueia após 5 tentativas, página exibe QR mock/status
  corretamente.
- Confirmação de que `handleMessage`/`iniciarAvisos` continuam funcionando
  com mensagens simuladas no novo formato adaptado (testes unitários leves
  para o adaptador de mensagem, já que não há suíte de testes hoje).
- Checklist de deploy manual: subir na SquareCloud, observar log para a
  URL/senha gerada, acessar, escanear com um WhatsApp real, confirmar que
  `handleMessage` recebe e responde corretamente a `reservar` / `cancelar` /
  `listar reservas` após a migração.
