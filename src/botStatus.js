let connected = false;
let lastQrDataUrl = null;

export function setConnected(value) {
  connected = value;
  if (value) lastQrDataUrl = null;
}

export function isConnected() {
  return connected;
}

export function setQr(dataUrl) {
  lastQrDataUrl = dataUrl;
}

export function getQr() {
  return lastQrDataUrl;
}
