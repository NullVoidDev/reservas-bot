import crypto from 'crypto';

const PASSWORD_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
const ROTATION_MS = 30 * 60 * 1000;

function randomPasswordSegment(length) {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += PASSWORD_ALPHABET[crypto.randomInt(PASSWORD_ALPHABET.length)];
  }
  return out;
}

export function generateCredentials() {
  const path = `/auth-${crypto.randomBytes(16).toString('hex')}`;
  const password = [
    randomPasswordSegment(4),
    randomPasswordSegment(4),
    randomPasswordSegment(4),
  ].join('-');
  return { path, password };
}

export function createAuthCredentialsManager({
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
