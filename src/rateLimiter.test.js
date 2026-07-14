import test from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter } from './rateLimiter.js';

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
