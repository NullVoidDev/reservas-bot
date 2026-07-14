import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { createAuthPageMiddleware } from './authPage.js';
import { createAuthCredentialsManager } from './authCredentials.js';
import { createRateLimiter } from './rateLimiter.js';
import { createSessionStore } from './authSession.js';
import * as botStatus from './botStatus.js';

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
  credentialsManager.onConnected();

  const app = express();
  app.use(express.json());
  app.use(createAuthPageMiddleware({ credentialsManager }));
  app.use((req, res) => res.status(404).send('not found'));

  const res = await request(app).get(knownPath);
  assert.equal(res.status, 404);
});
