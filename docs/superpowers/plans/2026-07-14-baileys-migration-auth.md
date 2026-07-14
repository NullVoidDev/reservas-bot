# Migração para Baileys + Página Oculta de Reautenticação — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Trocar `whatsapp-web.js`/Puppeteer por Baileys (sem navegador) para reduzir drasticamente o uso de memória, e adicionar uma página web oculta com credenciais dinâmicas rotativas (URL + senha impressas no log) que permite reautenticar o bot remotamente via QR Code.

**Architecture:** Módulos pequenos e testáveis em `src/` (status do bot, gerador/rotacionador de credenciais, rate limiter, sessão de cookie, adaptador de mensagem Baileys→formato interno) compostos num middleware Express (`authPage.js`) e num wrapper do cliente Baileys (`whatsapp.js`). `index.js` só conecta as peças; `src/handler.js` (lógica de negócio) não muda.

**Tech Stack:** Node.js 20+, Express 5, `@whiskeysockets/baileys` ^6.17.16, `qrcode` ^1.5.4, `pino` ^10.3.1 (produção); `node:test` + `node:assert/strict` (builtin) + `supertest` ^7.2.2 (dev, só para testar o middleware HTTP).

## Global Constraints

- Node.js >= 20 (já configurado no `squarecloud.config`/`squarecloud.app`).
- Nenhuma dependência de produção nova além de `@whiskeysockets/baileys`, `qrcode`, `pino` — o objetivo do projeto é reduzir footprint, não trocar um peso por outro.
- Sem `cookie-parser`: cookie de sessão é lido/escrito manualmente (payload trivial, uma dependência a menos).
- Testes usam `node --test` (runner nativo do Node, zero dependência de produção) + `supertest` como `devDependency`.
- Arquivos de teste ficam colados ao módulo que testam: `src/<nome>.js` + `src/<nome>.test.js`.
- `src/handler.js` (lógica de negócio: reservar/cancelar/listar/avisos) não é alterado nesta migração — só o transporte (como a mensagem chega/sai do WhatsApp) muda.
- Toda comunicação com o usuário final em código/UI é em português (pt-BR), consistente com o restante do projeto.

---

### Task 1: `src/botStatus.js` — estado compartilhado do bot

**Files:**
- Create: `src/botStatus.js`
- Test: `src/botStatus.test.js`
- Modify: `package.json` (adiciona `"test": "node --test src"` em `scripts`)

**Interfaces:**
- Consumes: nada (módulo raiz, sem dependências).
- Produces: `setConnected(value: boolean)`, `isConnected(): boolean`, `setQr(dataUrl: string): void`, `getQr(): string | null` — usados por `src/whatsapp.js` (Task 7) e `src/authPage.js` (Task 6).

- [ ] **Step 1: Escrever os testes**

Criar `src/botStatus.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const botStatus = require('./botStatus');

test('começa desconectado e sem QR', () => {
  assert.equal(botStatus.isConnected(), false);
  assert.equal(botStatus.getQr(), null);
});

test('guarda e devolve o QR atual', () => {
  botStatus.setQr('data:image/png;base64,ABC');
  assert.equal(botStatus.getQr(), 'data:image/png;base64,ABC');
});

test('marcar como conectado limpa o QR guardado', () => {
  botStatus.setQr('data:image/png;base64,ABC');
  botStatus.setConnected(true);
  assert.equal(botStatus.isConnected(), true);
  assert.equal(botStatus.getQr(), null);
});

test('marcar como desconectado mantém o status refletido', () => {
  botStatus.setConnected(false);
  assert.equal(botStatus.isConnected(), false);
});
```

- [ ] **Step 2: Adicionar o script de teste ao `package.json`**

Em `package.json`, dentro de `"scripts"`, adicionar:

```json
"test": "node --test src"
```

- [ ] **Step 3: Rodar os testes e confirmar que falham (módulo não existe ainda)**

Run: `npm test`
Expected: falha com `Cannot find module './botStatus'`

- [ ] **Step 4: Implementar `src/botStatus.js`**

```js
let connected = false;
let lastQrDataUrl = null;

function setConnected(value) {
  connected = value;
  if (value) lastQrDataUrl = null;
}

function isConnected() {
  return connected;
}

function setQr(dataUrl) {
  lastQrDataUrl = dataUrl;
}

function getQr() {
  return lastQrDataUrl;
}

module.exports = { setConnected, isConnected, setQr, getQr };
```

- [ ] **Step 5: Rodar os testes e confirmar que passam**

Run: `npm test`
Expected: todos os testes de `botStatus.test.js` em PASS

- [ ] **Step 6: Commit**

```bash
git add src/botStatus.js src/botStatus.test.js package.json
git commit -m "feat: adiciona módulo de status compartilhado do bot"
```

---

### Task 2: `src/messageAdapter.js` — normaliza mensagens do Baileys

**Files:**
- Create: `src/messageAdapter.js`
- Test: `src/messageAdapter.test.js`

**Interfaces:**
- Consumes: nada.
- Produces: `adaptBaileysMessage(msg: BaileysRawMessage): { body: string, author: string, from: string } | null` — usado por `src/whatsapp.js` (Task 7) para alimentar `handleMessage(clientAdapter, message)` de `src/handler.js`, que já espera exatamente esse formato `{ body, author, from }`.

- [ ] **Step 1: Escrever os testes**

Criar `src/messageAdapter.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { adaptBaileysMessage } = require('./messageAdapter');

test('adapta mensagem de texto simples de um contato individual', () => {
  const msg = {
    key: { remoteJid: '5511999999999@s.whatsapp.net', fromMe: false },
    message: { conversation: 'Reservar' },
  };
  const result = adaptBaileysMessage(msg);
  assert.deepEqual(result, {
    body: 'Reservar',
    author: '5511999999999@s.whatsapp.net',
    from: '5511999999999@s.whatsapp.net',
  });
});

test('adapta mensagem de texto estendido (com formatação/link)', () => {
  const msg = {
    key: { remoteJid: '5511999999999@s.whatsapp.net', fromMe: false },
    message: { extendedTextMessage: { text: 'Cancelar 001' } },
  };
  const result = adaptBaileysMessage(msg);
  assert.equal(result.body, 'Cancelar 001');
});

test('usa o participant como author quando a mensagem vem de um grupo', () => {
  const msg = {
    key: {
      remoteJid: '120363000000000000@g.us',
      participant: '5511988888888@s.whatsapp.net',
      fromMe: false,
    },
    message: { conversation: 'Ajuda' },
  };
  const result = adaptBaileysMessage(msg);
  assert.equal(result.from, '120363000000000000@g.us');
  assert.equal(result.author, '5511988888888@s.whatsapp.net');
});

test('ignora mensagens enviadas pelo próprio bot', () => {
  const msg = {
    key: { remoteJid: '5511999999999@s.whatsapp.net', fromMe: true },
    message: { conversation: 'oi' },
  };
  assert.equal(adaptBaileysMessage(msg), null);
});

test('ignora mensagens sem texto (ex: figurinha, imagem sem legenda)', () => {
  const msg = {
    key: { remoteJid: '5511999999999@s.whatsapp.net', fromMe: false },
    message: { stickerMessage: {} },
  };
  assert.equal(adaptBaileysMessage(msg), null);
});

test('ignora update sem campo message (ex: reação, exclusão)', () => {
  const msg = { key: { remoteJid: '5511999999999@s.whatsapp.net', fromMe: false } };
  assert.equal(adaptBaileysMessage(msg), null);
});

test('ignora update sem key', () => {
  assert.equal(adaptBaileysMessage({ message: { conversation: 'oi' } }), null);
  assert.equal(adaptBaileysMessage(null), null);
});
```

- [ ] **Step 2: Rodar os testes e confirmar que falham**

Run: `npm test`
Expected: falha com `Cannot find module './messageAdapter'`

- [ ] **Step 3: Implementar `src/messageAdapter.js`**

```js
function adaptBaileysMessage(msg) {
  if (!msg || !msg.key || msg.key.fromMe) return null;

  const content = msg.message;
  if (!content) return null;

  const body = content.conversation || content.extendedTextMessage?.text || '';
  if (!body) return null;

  const from = msg.key.remoteJid;
  if (!from) return null;

  const author = msg.key.participant || msg.key.remoteJid;

  return { body, author, from };
}

module.exports = { adaptBaileysMessage };
```

- [ ] **Step 4: Rodar os testes e confirmar que passam**

Run: `npm test`
Expected: todos os testes de `messageAdapter.test.js` em PASS

- [ ] **Step 5: Commit**

```bash
git add src/messageAdapter.js src/messageAdapter.test.js
git commit -m "feat: adiciona adaptador de mensagens do Baileys"
```

---

### Task 3: `src/rateLimiter.js` — proteção contra força bruta na senha

**Files:**
- Create: `src/rateLimiter.js`
- Test: `src/rateLimiter.test.js`

**Interfaces:**
- Consumes: nada.
- Produces: `createRateLimiter({ now?, maxFailures?, windowMs?, blockMs? }): { isBlocked(ip: string): boolean, recordFailure(ip: string): void, recordSuccess(ip: string): void }` — usado por `src/authPage.js` (Task 6).

- [ ] **Step 1: Escrever os testes**

Criar `src/rateLimiter.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRateLimiter } = require('./rateLimiter');

test('não bloqueia um IP sem tentativas', () => {
  const limiter = createRateLimiter();
  assert.equal(limiter.isBlocked('1.2.3.4'), false);
});

test('não bloqueia antes de atingir o limite de falhas', () => {
  const limiter = createRateLimiter({ now: () => 1000 });
  for (let i = 0; i < 4; i++) limiter.recordFailure('1.2.3.4');
  assert.equal(limiter.isBlocked('1.2.3.4'), false);
});

test('bloqueia o IP após atingir o limite de falhas (5)', () => {
  const limiter = createRateLimiter({ now: () => 1000 });
  for (let i = 0; i < 5; i++) limiter.recordFailure('1.2.3.4');
  assert.equal(limiter.isBlocked('1.2.3.4'), true);
});

test('desbloqueia automaticamente depois que o tempo de bloqueio passa', () => {
  let currentTime = 1000;
  const limiter = createRateLimiter({ now: () => currentTime, blockMs: 60000 });
  for (let i = 0; i < 5; i++) limiter.recordFailure('1.2.3.4');
  assert.equal(limiter.isBlocked('1.2.3.4'), true);

  currentTime += 60001;
  assert.equal(limiter.isBlocked('1.2.3.4'), false);
});

test('recordSuccess reseta o contador de falhas do IP', () => {
  const limiter = createRateLimiter({ now: () => 1000 });
  for (let i = 0; i < 4; i++) limiter.recordFailure('1.2.3.4');
  limiter.recordSuccess('1.2.3.4');
  limiter.recordFailure('1.2.3.4');
  assert.equal(limiter.isBlocked('1.2.3.4'), false);
});

test('a janela de falhas expira: falhas antigas não contam pro limite', () => {
  let currentTime = 1000;
  const limiter = createRateLimiter({ now: () => currentTime, windowMs: 60000 });
  for (let i = 0; i < 4; i++) limiter.recordFailure('1.2.3.4');

  currentTime += 60001;
  limiter.recordFailure('1.2.3.4');
  assert.equal(limiter.isBlocked('1.2.3.4'), false);
});

test('IPs diferentes são rastreados de forma independente', () => {
  const limiter = createRateLimiter({ now: () => 1000 });
  for (let i = 0; i < 5; i++) limiter.recordFailure('1.2.3.4');
  assert.equal(limiter.isBlocked('1.2.3.4'), true);
  assert.equal(limiter.isBlocked('5.6.7.8'), false);
});
```

- [ ] **Step 2: Rodar os testes e confirmar que falham**

Run: `npm test`
Expected: falha com `Cannot find module './rateLimiter'`

- [ ] **Step 3: Implementar `src/rateLimiter.js`**

```js
function createRateLimiter({
  now = Date.now,
  maxFailures = 5,
  windowMs = 10 * 60 * 1000,
  blockMs = 10 * 60 * 1000,
} = {}) {
  const attempts = new Map();

  function isBlocked(ip) {
    const entry = attempts.get(ip);
    if (!entry || !entry.blockedUntil) return false;
    if (now() >= entry.blockedUntil) {
      attempts.delete(ip);
      return false;
    }
    return true;
  }

  function recordFailure(ip) {
    const t = now();
    let entry = attempts.get(ip);

    if (!entry || t - entry.firstFailureAt > windowMs) {
      entry = { failures: 0, firstFailureAt: t, blockedUntil: null };
    }

    entry.failures += 1;
    if (entry.failures >= maxFailures) {
      entry.blockedUntil = t + blockMs;
    }

    attempts.set(ip, entry);
  }

  function recordSuccess(ip) {
    attempts.delete(ip);
  }

  return { isBlocked, recordFailure, recordSuccess };
}

module.exports = { createRateLimiter };
```

- [ ] **Step 4: Rodar os testes e confirmar que passam**

Run: `npm test`
Expected: todos os testes de `rateLimiter.test.js` em PASS

- [ ] **Step 5: Commit**

```bash
git add src/rateLimiter.js src/rateLimiter.test.js
git commit -m "feat: adiciona rate limiter para tentativas de senha"
```

---

### Task 4: `src/authSession.js` — sessão de cookie da página oculta

**Files:**
- Create: `src/authSession.js`
- Test: `src/authSession.test.js`

**Interfaces:**
- Consumes: `crypto` (builtin).
- Produces: `createSessionStore({ now?, ttlMs? }): { create(): string, isValid(id: string | undefined): boolean, invalidateAll(): void }` — usado por `src/authPage.js` (Task 6).

- [ ] **Step 1: Escrever os testes**

Criar `src/authSession.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSessionStore } = require('./authSession');

test('sessão recém-criada é válida', () => {
  const store = createSessionStore({ now: () => 1000 });
  const id = store.create();
  assert.equal(store.isValid(id), true);
});

test('id desconhecido não é válido', () => {
  const store = createSessionStore({ now: () => 1000 });
  assert.equal(store.isValid('nao-existe'), false);
});

test('id vazio/undefined não é válido', () => {
  const store = createSessionStore({ now: () => 1000 });
  assert.equal(store.isValid(undefined), false);
  assert.equal(store.isValid(''), false);
});

test('sessão expira depois do ttl (30 min por padrão)', () => {
  let currentTime = 1000;
  const store = createSessionStore({ now: () => currentTime, ttlMs: 60000 });
  const id = store.create();

  currentTime += 60001;
  assert.equal(store.isValid(id), false);
});

test('invalidateAll derruba todas as sessões ativas', () => {
  const store = createSessionStore({ now: () => 1000 });
  const id = store.create();
  store.invalidateAll();
  assert.equal(store.isValid(id), false);
});

test('duas sessões criadas têm ids diferentes', () => {
  const store = createSessionStore({ now: () => 1000 });
  const a = store.create();
  const b = store.create();
  assert.notEqual(a, b);
});
```

- [ ] **Step 2: Rodar os testes e confirmar que falham**

Run: `npm test`
Expected: falha com `Cannot find module './authSession'`

- [ ] **Step 3: Implementar `src/authSession.js`**

```js
const crypto = require('crypto');

function createSessionStore({ now = Date.now, ttlMs = 30 * 60 * 1000 } = {}) {
  const sessions = new Map();

  function create() {
    const id = crypto.randomBytes(24).toString('hex');
    sessions.set(id, now() + ttlMs);
    return id;
  }

  function isValid(id) {
    if (!id) return false;
    const expiresAt = sessions.get(id);
    if (!expiresAt) return false;
    if (now() >= expiresAt) {
      sessions.delete(id);
      return false;
    }
    return true;
  }

  function invalidateAll() {
    sessions.clear();
  }

  return { create, isValid, invalidateAll };
}

module.exports = { createSessionStore };
```

- [ ] **Step 4: Rodar os testes e confirmar que passam**

Run: `npm test`
Expected: todos os testes de `authSession.test.js` em PASS

- [ ] **Step 5: Commit**

```bash
git add src/authSession.js src/authSession.test.js
git commit -m "feat: adiciona sessão de cookie para a página oculta"
```

---

### Task 5: `src/authCredentials.js` — geração e rotação de URL/senha

**Files:**
- Create: `src/authCredentials.js`
- Test: `src/authCredentials.test.js`

**Interfaces:**
- Consumes: `crypto` (builtin).
- Produces:
  - `generateCredentials(): { path: string, password: string }` (path no formato `/auth-<32 hex>`, senha no formato `XXXX-XXXX-XXXX`)
  - `createAuthCredentialsManager({ onRotate?, rotationMs?, setIntervalFn?, clearIntervalFn? }): { startRotating(): void, stopRotating(): void, onDisconnected(): void, onConnected(): void, getPath(): string | null, getPassword(): string | null }`
  - Usado por `index.js` (Task 8, cria a instância e passa `onRotate` para imprimir no console) e por `src/whatsapp.js` (Task 7, chama `onDisconnected()`/`onConnected()`) e `src/authPage.js` (Task 6, chama `getPath()`/`getPassword()`).

- [ ] **Step 1: Escrever os testes**

Criar `src/authCredentials.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { generateCredentials, createAuthCredentialsManager } = require('./authCredentials');

test('generateCredentials produz um path no formato /auth-<32 hex>', () => {
  const { path } = generateCredentials();
  assert.match(path, /^\/auth-[0-9a-f]{32}$/);
});

test('generateCredentials produz uma senha no formato XXXX-XXXX-XXXX', () => {
  const { password } = generateCredentials();
  assert.match(password, /^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/);
});

test('duas chamadas seguidas geram path e senha diferentes', () => {
  const a = generateCredentials();
  const b = generateCredentials();
  assert.notEqual(a.path, b.path);
  assert.notEqual(a.password, b.password);
});

test('antes de startRotating, path e senha são null', () => {
  const manager = createAuthCredentialsManager({
    setIntervalFn: () => 'fake-timer',
    clearIntervalFn: () => {},
  });
  assert.equal(manager.getPath(), null);
  assert.equal(manager.getPassword(), null);
});

test('startRotating gera credenciais imediatamente e chama onRotate', () => {
  const rotations = [];
  const manager = createAuthCredentialsManager({
    onRotate: (creds) => rotations.push(creds),
    setIntervalFn: () => 'fake-timer',
    clearIntervalFn: () => {},
  });

  manager.startRotating();

  assert.equal(rotations.length, 1);
  assert.equal(manager.getPath(), rotations[0].path);
  assert.equal(manager.getPassword(), rotations[0].password);
});

test('chamar startRotating duas vezes seguidas não gera um novo par nem reagenda o timer', () => {
  let intervalCalls = 0;
  const manager = createAuthCredentialsManager({
    setIntervalFn: () => { intervalCalls += 1; return 'fake-timer'; },
    clearIntervalFn: () => {},
  });

  manager.startRotating();
  const firstPath = manager.getPath();
  manager.startRotating();

  assert.equal(manager.getPath(), firstPath);
  assert.equal(intervalCalls, 1);
});

test('onDisconnected é idempotente, igual startRotating', () => {
  const rotations = [];
  const manager = createAuthCredentialsManager({
    onRotate: (c) => rotations.push(c),
    setIntervalFn: () => 'fake-timer',
    clearIntervalFn: () => {},
  });

  manager.onDisconnected();
  manager.onDisconnected();

  assert.equal(rotations.length, 1);
});

test('o timer de rotação gera um novo par quando disparado', () => {
  let scheduledFn = null;
  const manager = createAuthCredentialsManager({
    setIntervalFn: (fn) => { scheduledFn = fn; return 'fake-timer'; },
    clearIntervalFn: () => {},
  });

  manager.startRotating();
  const firstPath = manager.getPath();

  scheduledFn(); // simula o disparo do intervalo de 30 min

  assert.notEqual(manager.getPath(), firstPath);
});

test('onConnected para a rotação e limpa as credenciais atuais', () => {
  let cleared = false;
  const manager = createAuthCredentialsManager({
    setIntervalFn: () => 'fake-timer',
    clearIntervalFn: () => { cleared = true; },
  });

  manager.startRotating();
  manager.onConnected();

  assert.equal(cleared, true);
  assert.equal(manager.getPath(), null);
  assert.equal(manager.getPassword(), null);
});

test('depois de conectar e desconectar de novo, um novo ciclo começa com credenciais novas', () => {
  const manager = createAuthCredentialsManager({
    setIntervalFn: () => 'fake-timer',
    clearIntervalFn: () => {},
  });

  manager.startRotating();
  const firstPath = manager.getPath();

  manager.onConnected();
  manager.onDisconnected();

  assert.notEqual(manager.getPath(), firstPath);
});
```

- [ ] **Step 2: Rodar os testes e confirmar que falham**

Run: `npm test`
Expected: falha com `Cannot find module './authCredentials'`

- [ ] **Step 3: Implementar `src/authCredentials.js`**

```js
const crypto = require('crypto');

const PASSWORD_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
const ROTATION_MS = 30 * 60 * 1000;

function randomPasswordSegment(length) {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += PASSWORD_ALPHABET[crypto.randomInt(PASSWORD_ALPHABET.length)];
  }
  return out;
}

function generateCredentials() {
  const path = `/auth-${crypto.randomBytes(16).toString('hex')}`;
  const password = [
    randomPasswordSegment(4),
    randomPasswordSegment(4),
    randomPasswordSegment(4),
  ].join('-');
  return { path, password };
}

function createAuthCredentialsManager({
  onRotate,
  rotationMs = ROTATION_MS,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  let current = null;
  let timer = null;
  let active = false;

  function rotate() {
    current = generateCredentials();
    if (onRotate) onRotate(current);
  }

  function startRotating() {
    if (active) return;
    active = true;
    rotate();
    timer = setIntervalFn(rotate, rotationMs);
  }

  function stopRotating() {
    active = false;
    if (timer) {
      clearIntervalFn(timer);
      timer = null;
    }
    current = null;
  }

  function onDisconnected() {
    startRotating();
  }

  function onConnected() {
    stopRotating();
  }

  function getPath() {
    return current ? current.path : null;
  }

  function getPassword() {
    return current ? current.password : null;
  }

  return { startRotating, stopRotating, onDisconnected, onConnected, getPath, getPassword };
}

module.exports = { generateCredentials, createAuthCredentialsManager };
```

- [ ] **Step 4: Rodar os testes e confirmar que passam**

Run: `npm test`
Expected: todos os testes de `authCredentials.test.js` em PASS

- [ ] **Step 5: Commit**

```bash
git add src/authCredentials.js src/authCredentials.test.js
git commit -m "feat: adiciona gerador/rotacionador de credenciais da página oculta"
```

---

### Task 6: `src/authPage.js` — middleware Express da página oculta

**Files:**
- Create: `src/authPage.js`
- Test: `src/authPage.test.js`
- Modify: `package.json` (adiciona `express` — já existe — e `supertest` como `devDependency`)

**Interfaces:**
- Consumes:
  - `botStatus` (Task 1): `isConnected()`, `getQr()`
  - `createRateLimiter` (Task 3)
  - `createSessionStore` (Task 4)
  - `credentialsManager` (Task 5, injetado por quem monta o middleware): `getPath()`, `getPassword()`
- Produces: `createAuthPageMiddleware({ credentialsManager, rateLimiter?, sessionStore?, status? }): (req, res, next) => void` — usado por `index.js` (Task 8) via `app.use(...)`.

- [ ] **Step 1: Instalar a dependência de teste**

Run: `npm install --save-dev supertest@7.2.2`
Expected: `supertest` aparece em `devDependencies` no `package.json`

- [ ] **Step 2: Escrever os testes**

Criar `src/authPage.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const { createAuthPageMiddleware } = require('./authPage');
const { createAuthCredentialsManager } = require('./authCredentials');
const { createRateLimiter } = require('./rateLimiter');
const { createSessionStore } = require('./authSession');
const botStatus = require('./botStatus');

function buildApp() {
  const credentialsManager = createAuthCredentialsManager({
    setIntervalFn: () => 'fake-timer',
    clearIntervalFn: () => {},
  });
  credentialsManager.startRotating();

  const rateLimiter = createRateLimiter({ now: () => 1000 });
  const sessionStore = createSessionStore({ now: () => 1000 });

  const app = express();
  app.use(express.json());
  app.use(createAuthPageMiddleware({ credentialsManager, rateLimiter, sessionStore, status: botStatus }));
  app.use((req, res) => res.status(404).send('not found'));

  return { app, credentialsManager };
}

test('caminho desconhecido cai no 404 normal (não revela nada)', async () => {
  const { app } = buildApp();
  const res = await request(app).get('/qualquer-coisa-aleatoria');
  assert.equal(res.status, 404);
});

test('GET no caminho secreto devolve a página de login', async () => {
  const { app, credentialsManager } = buildApp();
  const res = await request(app).get(credentialsManager.getPath());
  assert.equal(res.status, 200);
  assert.match(res.text, /Autenticação do Bot/);
  assert.equal(res.headers['x-robots-tag'], 'noindex');
});

test('POST /login com senha errada retorna 401', async () => {
  const { app, credentialsManager } = buildApp();
  const res = await request(app)
    .post(`${credentialsManager.getPath()}/login`)
    .send({ senha: 'errada' });
  assert.equal(res.status, 401);
});

test('POST /login com senha certa retorna 200 e seta cookie de sessão', async () => {
  const { app, credentialsManager } = buildApp();
  const res = await request(app)
    .post(`${credentialsManager.getPath()}/login`)
    .send({ senha: credentialsManager.getPassword() });
  assert.equal(res.status, 200);
  assert.match(res.headers['set-cookie'][0], /auth_session=/);
});

test('GET /status sem cookie retorna 401', async () => {
  const { app, credentialsManager } = buildApp();
  const res = await request(app).get(`${credentialsManager.getPath()}/status`);
  assert.equal(res.status, 401);
});

test('GET /status com cookie válido retorna o status do bot', async () => {
  const { app, credentialsManager } = buildApp();
  const agent = request.agent(app);

  await agent.post(`${credentialsManager.getPath()}/login`).send({ senha: credentialsManager.getPassword() });
  const res = await agent.get(`${credentialsManager.getPath()}/status`);

  assert.equal(res.status, 200);
  assert.equal(typeof res.body.connected, 'boolean');
});

test('bloqueia depois de 5 tentativas de senha erradas seguidas', async () => {
  const { app, credentialsManager } = buildApp();
  for (let i = 0; i < 5; i++) {
    await request(app).post(`${credentialsManager.getPath()}/login`).send({ senha: 'errada' });
  }
  const res = await request(app).post(`${credentialsManager.getPath()}/login`).send({ senha: 'errada' });
  assert.equal(res.status, 429);
});

test('quando não há credenciais ativas (bot conectado), a rota não existe', async () => {
  const credentialsManager = createAuthCredentialsManager({
    setIntervalFn: () => 'fake-timer',
    clearIntervalFn: () => {},
  });
  credentialsManager.startRotating();
  const knownPath = credentialsManager.getPath();
  credentialsManager.onConnected(); // limpa as credenciais, como quando o bot autentica

  const app = express();
  app.use(express.json());
  app.use(createAuthPageMiddleware({ credentialsManager }));
  app.use((req, res) => res.status(404).send('not found'));

  const res = await request(app).get(knownPath);
  assert.equal(res.status, 404);
});
```

- [ ] **Step 3: Rodar os testes e confirmar que falham**

Run: `npm test`
Expected: falha com `Cannot find module './authPage'`

- [ ] **Step 4: Implementar `src/authPage.js`**

```js
const crypto = require('crypto');
const botStatusModule = require('./botStatus');
const { createRateLimiter } = require('./rateLimiter');
const { createSessionStore } = require('./authSession');

const COOKIE_NAME = 'auth_session';

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    out[key] = decodeURIComponent(value);
  });
  return out;
}

function renderPageHtml() {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Autenticação do Bot</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0c1010;color:#e9eceb;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Arial}
  .card{width:min(360px,90vw);background:#121716;border:1px solid #1f2725;border-radius:16px;padding:24px;text-align:center}
  input{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:10px;border:1px solid #1f2725;background:#0f1413;color:#e9eceb;font-size:16px;margin-top:12px}
  button{width:100%;margin-top:12px;padding:10px 12px;border-radius:10px;border:1px solid #2b6c57;background:linear-gradient(180deg,#1e614b,#184c3b);color:#e9f5f1;font-weight:800;cursor:pointer}
  .msg{margin-top:10px;color:#e08a8a;font-size:14px;min-height:18px}
  img{max-width:100%;border-radius:8px;margin-top:12px}
  .ok{color:#6ddeba;font-weight:800;font-size:18px}
</style>
</head>
<body>
  <div class="card" id="card">
    <h2>Autenticação do Bot</h2>
    <div id="login">
      <input type="password" id="senha" placeholder="Senha" autocomplete="off" />
      <button id="btnEntrar">Entrar</button>
      <div class="msg" id="loginMsg"></div>
    </div>
    <div id="conteudo" style="display:none"></div>
  </div>
<script>
async function entrar(){
  const senha = document.getElementById('senha').value;
  const msg = document.getElementById('loginMsg');
  msg.textContent = '';
  const res = await fetch(window.location.pathname + '/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ senha })
  });
  if (res.status === 429) { msg.textContent = 'Muitas tentativas. Aguarde alguns minutos.'; return; }
  if (!res.ok) { msg.textContent = 'Senha incorreta.'; return; }
  document.getElementById('login').style.display = 'none';
  document.getElementById('conteudo').style.display = 'block';
  atualizarStatus();
  setInterval(atualizarStatus, 3000);
}
async function atualizarStatus(){
  const conteudo = document.getElementById('conteudo');
  const res = await fetch(window.location.pathname + '/status');
  if (res.status === 401) {
    document.getElementById('login').style.display = 'block';
    conteudo.style.display = 'none';
    return;
  }
  const data = await res.json();
  if (data.connected) {
    conteudo.innerHTML = '<div class="ok">✅ Bot autenticado e funcionando.</div>';
  } else if (data.qr) {
    conteudo.innerHTML = '<div>Escaneie o QR Code abaixo para autenticar o bot no WhatsApp:</div><img src="' + data.qr + '" alt="QR Code" />';
  } else {
    conteudo.innerHTML = '<div>Gerando QR Code, aguarde...</div>';
  }
}
document.getElementById('btnEntrar').addEventListener('click', entrar);
document.getElementById('senha').addEventListener('keydown', (e) => { if (e.key === 'Enter') entrar(); });
</script>
</body>
</html>`;
}

function createAuthPageMiddleware({
  credentialsManager,
  rateLimiter = createRateLimiter(),
  sessionStore = createSessionStore(),
  status = botStatusModule,
} = {}) {
  return function authPageMiddleware(req, res, next) {
    const base = credentialsManager.getPath();
    if (!base) return next();

    const cookies = parseCookies(req.headers.cookie);
    const sessionId = cookies[COOKIE_NAME];

    if (req.method === 'GET' && req.path === base) {
      res.setHeader('X-Robots-Tag', 'noindex');
      res.type('html').send(renderPageHtml());
      return;
    }

    if (req.method === 'POST' && req.path === `${base}/login`) {
      const ip = req.ip;
      if (rateLimiter.isBlocked(ip)) {
        res.status(429).json({ error: 'too_many_attempts' });
        return;
      }

      const senha = req.body && req.body.senha;
      const senhaAtual = credentialsManager.getPassword();
      const senhaValida =
        typeof senha === 'string' &&
        typeof senhaAtual === 'string' &&
        senha.length === senhaAtual.length &&
        crypto.timingSafeEqual(Buffer.from(senha), Buffer.from(senhaAtual));

      if (!senhaValida) {
        rateLimiter.recordFailure(ip);
        res.status(401).json({ error: 'invalid_password' });
        return;
      }

      rateLimiter.recordSuccess(ip);
      const sid = sessionStore.create();
      res.setHeader(
        'Set-Cookie',
        `${COOKIE_NAME}=${sid}; HttpOnly; SameSite=Strict; Path=${base}; Max-Age=1800`
      );
      res.status(200).json({ ok: true });
      return;
    }

    if (req.method === 'GET' && req.path === `${base}/status`) {
      if (!sessionStore.isValid(sessionId)) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }

      res.json({ connected: status.isConnected(), qr: status.getQr() });
      return;
    }

    next();
  };
}

module.exports = { createAuthPageMiddleware, parseCookies, renderPageHtml };
```

- [ ] **Step 5: Rodar os testes e confirmar que passam**

Run: `npm test`
Expected: todos os testes de `authPage.test.js` em PASS

- [ ] **Step 6: Commit**

```bash
git add src/authPage.js src/authPage.test.js package.json package-lock.json
git commit -m "feat: adiciona middleware da página oculta de autenticação"
```

---

### Task 7: `src/whatsapp.js` — cliente Baileys + troca de dependências

**Files:**
- Create: `src/whatsapp.js`
- Modify: `package.json` (remove `whatsapp-web.js`, `puppeteer`, `qrcode-terminal`; adiciona `@whiskeysockets/baileys`, `qrcode`, `pino`)

**Interfaces:**
- Consumes:
  - `handleMessage`, `iniciarAvisos` de `src/handler.js` (já existentes, formato `{ body, author, from }`)
  - `adaptBaileysMessage` (Task 2)
  - `botStatus` (Task 1)
  - `credentialsManager` (Task 5), injetado como parâmetro
- Produces: `startClient({ credentialsManager }): Promise<void>` — usado por `index.js` (Task 8).

Este módulo depende de uma conexão real com o WhatsApp e por isso **não tem teste automatizado** (mockar o socket do Baileys não traria confiança real — a verificação é manual, no Passo 4 e no checklist da Task 10).

- [ ] **Step 1: Trocar as dependências no `package.json`**

Editar `package.json`, campo `"dependencies"`, para ficar:

```json
{
  "name": "reservabot-final",
  "version": "1.0.0",
  "main": "index.js",
  "scripts": {
    "start": "node index.js",
    "test": "node --test src"
  },
  "dependencies": {
    "@whiskeysockets/baileys": "^6.17.16",
    "express": "^5.2.1",
    "pino": "^10.3.1",
    "qrcode": "^1.5.4"
  },
  "devDependencies": {
    "supertest": "^7.2.2"
  }
}
```

Run: `npm install`
Expected: instala `@whiskeysockets/baileys`, `pino`, `qrcode`; remove `whatsapp-web.js`, `puppeteer`, `qrcode-terminal` de `node_modules`

- [ ] **Step 2: Implementar `src/whatsapp.js`**

```js
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const qrcode = require('qrcode');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
} = require('@whiskeysockets/baileys');

const { handleMessage, iniciarAvisos } = require('./handler');
const { adaptBaileysMessage } = require('./messageAdapter');
const botStatus = require('./botStatus');

const AUTH_DIR = path.join(__dirname, '../auth_session');
const logger = pino({ level: 'silent' });

let reconnectScheduled = false;

function createClientAdapter(sock) {
  return {
    sendMessage: async (to, text) => {
      try {
        await sock.sendMessage(to, { text });
      } catch (e) {
        console.error('[BOT] Erro ao enviar mensagem:', e);
      }
    },
  };
}

async function startClient({ credentialsManager }) {
  reconnectScheduled = false;

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  const sock = makeWASocket({
    auth: state,
    logger,
    printQRInTerminal: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        const dataUrl = await qrcode.toDataURL(qr);
        botStatus.setQr(dataUrl);
        credentialsManager.onDisconnected();
      } catch (e) {
        console.error('[BOT] Erro ao gerar QR Code:', e);
      }
    }

    if (connection === 'open') {
      console.log('[STATUS] BOT WHATSAPP ONLINE E PRONTO');
      botStatus.setConnected(true);
      credentialsManager.onConnected();
      iniciarAvisos(createClientAdapter(sock));
    }

    if (connection === 'close') {
      botStatus.setConnected(false);

      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      if (loggedOut) {
        console.log('[STATUS] Sessão do WhatsApp encerrada. É necessário autenticar novamente.');
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      } else {
        console.log('[STATUS] WhatsApp desconectado. Reconectando em 5 segundos...');
      }

      if (!reconnectScheduled) {
        reconnectScheduled = true;
        setTimeout(() => startClient({ credentialsManager }), 5000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const raw of messages) {
      const message = adaptBaileysMessage(raw);
      if (!message) continue;

      try {
        await handleMessage(createClientAdapter(sock), message);
      } catch (e) {
        console.error('[ERRO handleMessage]', e);
      }
    }
  });

  return sock;
}

module.exports = { startClient };
```

- [ ] **Step 3: Confirmar sintaxe válida**

Run: `node --check src/whatsapp.js`
Expected: sem erros (saída vazia)

- [ ] **Step 4: Verificação manual (não dá pra automatizar sem um WhatsApp real)**

Depois que a Task 8 conectar tudo em `index.js`, rodar `node index.js` localmente e confirmar manualmente:
1. O terminal imprime `[AUTH] URL: ...` e `[AUTH] Senha: ...`.
2. Acessar a URL localmente, entrar com a senha, ver o QR Code renderizado na página.
3. Escanear com um WhatsApp real (ou de teste) e confirmar que a página troca para "✅ Bot autenticado e funcionando." sem precisar recarregar.
4. Enviar `Ajuda` pelo número escaneado e confirmar que o bot responde (prova que `handleMessage` está recebendo mensagens corretamente adaptadas).

- [ ] **Step 5: Commit**

```bash
git add src/whatsapp.js package.json package-lock.json
git commit -m "feat: migra o cliente WhatsApp de whatsapp-web.js para Baileys"
```

---

### Task 8: `index.js` — conectar tudo

**Files:**
- Modify: `index.js` (reescrita completa)

**Interfaces:**
- Consumes: `startClient` (Task 7), `createAuthPageMiddleware` (Task 6), `createAuthCredentialsManager` (Task 5), `botStatus` (Task 1).
- Produces: processo HTTP + bot rodando — consumido só por operação manual/deploy (Task 10).

- [ ] **Step 1: Reescrever `index.js`**

```js
const express = require('express');
const path = require('path');
const fs = require('fs');

const { startClient } = require('./src/whatsapp');
const { createAuthPageMiddleware } = require('./src/authPage');
const { createAuthCredentialsManager } = require('./src/authCredentials');
const botStatus = require('./src/botStatus');

process.on('uncaughtException', (err) => {
  console.log('Erro não tratado:', err);
});

process.on('unhandledRejection', (err) => {
  console.log('Promise rejeitada:', err);
});

const app = express();
app.use(express.json());

/* ========== WEB ========== */
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'reservas.html'));
});

app.get('/health', (_req, res) => res.status(200).send('ok'));

app.get('/api/reservas', (_req, res) => {
  fs.readFile(path.join(__dirname, 'data/reservas.json'), 'utf8', (err, data) => {
    if (err) {
      console.error('Erro ao ler reservas.json:', err);
      return res.status(500).json({ error: 'Erro ao carregar reservas' });
    }
    try {
      const reservas = JSON.parse(data);
      const publico = reservas.map(({ numero, ...r }) => r);
      res.json(publico);
    } catch (e) {
      console.error('Erro no JSON:', e);
      res.status(500).json({ error: 'JSON inválido' });
    }
  });
});

/* ========== PÁGINA OCULTA DE AUTENTICAÇÃO ========== */
const PORT = Number(process.env.PORT || 3000);

const credentialsManager = createAuthCredentialsManager({
  onRotate: ({ path: authPath, password }) => {
    const host = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
    console.log('[AUTH] Bot desconectado. Acesse para reautenticar:');
    console.log(`[AUTH] URL: ${host}${authPath}`);
    console.log(`[AUTH] Senha: ${password}`);
    console.log('[AUTH] Válida por 30 minutos.');
  },
});

app.use(createAuthPageMiddleware({ credentialsManager }));

/* ========== BOOT ========== */
console.log('[BOOT] PORT:', PORT);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[SITE] Servidor rodando em http://0.0.0.0:${PORT}`);
  startClient({ credentialsManager });
});

/* ========== KEEP ALIVE (ANTI-IDLE PARA SQUARE CLOUD) ========== */
setInterval(() => {
  if (botStatus.isConnected()) {
    console.log('[KEEP-ALIVE] Bot ativo e conectado.');
  } else {
    console.log(`[KEEP-ALIVE] ${new Date().toISOString()} - Serviço http rodando (bot desconectado ou iniciando)`);
  }
}, 45000);
```

- [ ] **Step 2: Confirmar sintaxe válida**

Run: `node --check index.js`
Expected: sem erros (saída vazia)

- [ ] **Step 3: Rodar a suíte de testes completa**

Run: `npm test`
Expected: todos os testes (Tasks 1-6) em PASS — `index.js` não tem teste próprio (é só fiação), mas não deve quebrar nada dos módulos que importa

- [ ] **Step 4: Commit**

```bash
git add index.js
git commit -m "refactor: conecta Baileys e página oculta de autenticação em index.js"
```

---

### Task 9: Limpeza de configuração (memória e duplicidade)

**Files:**
- Modify: `squarecloud.config`
- Delete: `squarecloud.app`

**Interfaces:**
- Consumes: nada.
- Produces: nada consumido por código — configuração de deploy.

- [ ] **Step 1: Atualizar `squarecloud.config`**

```
DISPLAY_NAME=ReservasCMC
DESCRIPTION=START
MEMORY=512
VERSION=recommended
AUTORESTART=true
MAIN=index.js
SUBDOMAIN=reservascmc
```

- [ ] **Step 2: Remover o arquivo duplicado**

Run: `rm squarecloud.app`
Expected: arquivo removido

- [ ] **Step 3: Commit**

```bash
git add -A squarecloud.config squarecloud.app
git commit -m "chore: reduz memória alocada na SquareCloud e remove config duplicada"
```

---

### Task 10: Checklist de verificação manual e deploy

**Files:** nenhum arquivo de código — só execução e observação.

- [ ] **Step 1: Instalar dependências do zero e rodar a suíte inteira**

```bash
rm -rf node_modules
npm install
npm test
```

Expected: todos os testes das Tasks 1-6 em PASS, sem warnings de dependência quebrada.

- [ ] **Step 2: Subida local a seco (dry run)**

```bash
node index.js
```

Expected na saída do terminal, em ordem:
1. `[BOOT] PORT: 3000`
2. `[SITE] Servidor rodando em http://0.0.0.0:3000`
3. `[AUTH] URL: http://localhost:3000/auth-<hex>`
4. `[AUTH] Senha: XXXX-XXXX-XXXX`

- [ ] **Step 3: Testar a página oculta manualmente**

1. Abrir a URL impressa no navegador.
2. Tentar uma senha errada → deve mostrar "Senha incorreta." na tela.
3. Tentar a senha errada mais 4 vezes seguidas (5 no total) → a 5ª ou a próxima tentativa deve mostrar "Muitas tentativas. Aguarde alguns minutos."
4. Esperar a suíte reiniciar o processo (`node index.js` de novo) e entrar com a senha certa → deve trocar para a tela de QR Code.
5. Escanear com um número real do WhatsApp.
6. Confirmar que a página muda sozinha para "✅ Bot autenticado e funcionando." sem precisar recarregar.

- [ ] **Step 4: Testar o fluxo de reserva ponta a ponta**

Pelo número escaneado, enviar:
```
Reservar
Dia: 28/06
Hora: 18:00-20:00
Local: Quadra BT
Nome: Teste
Qnt: 2
```
Expected: bot responde confirmando a reserva com um código. Depois, enviar `Listar Reservas` e confirmar que a reserva aparece.

- [ ] **Step 5: Confirmar o uso de memória**

Com o bot conectado e rodando por alguns minutos, observar o processo:

```bash
ps aux | grep "node index.js" | grep -v grep
```

Expected: RSS bem abaixo dos ~300-450MB que o `whatsapp-web.js`/Puppeteer consumia (dado de referência do watchdog removido na Task 7) — confirma que o `MEMORY=512` da Task 9 tem folga.

- [ ] **Step 6: Deploy na SquareCloud**

1. Fazer push do repositório (branch atualizada) para o GitHub, conforme o fluxo que o projeto já usa para deploy.
2. Subir/reiniciar o app na SquareCloud.
3. Acompanhar o log do painel da SquareCloud para pegar a URL/senha impressas (Step 2 deste checklist, só que em produção).
4. Repetir os Steps 3 e 4 deste checklist, mas acessando pela URL pública do app (`https://reservascmc.squareweb.app<path-secreto>`).

Este checklist não vira commit — é a validação final de que a migração funciona de ponta a ponta antes de considerar o trabalho concluído.
