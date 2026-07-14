import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionStore } from './authSession.js';

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
