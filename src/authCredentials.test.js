import test from 'node:test';
import assert from 'node:assert/strict';
import { generateCredentials, createAuthCredentialsManager } from './authCredentials.js';

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
