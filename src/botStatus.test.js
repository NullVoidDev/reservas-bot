import test from 'node:test';
import assert from 'node:assert/strict';
import * as botStatus from './botStatus.js';

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
