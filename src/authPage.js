import crypto from 'crypto';
import * as botStatusModule from './botStatus.js';
import { createRateLimiter } from './rateLimiter.js';
import { createSessionStore } from './authSession.js';

const COOKIE_NAME = 'auth_session';

export function parseCookies(header) {
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

export function renderPageHtml() {
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

export function createAuthPageMiddleware({
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
