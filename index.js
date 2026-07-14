import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
} from '@whiskeysockets/baileys';
import qrcodeTerminal from 'qrcode-terminal';
import qrcode from 'qrcode';
import express from 'express';
import { readFile, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { handleMessage, iniciarAvisos } from './src/handler.js';
import { createAuthPageMiddleware } from './src/authPage.js';
import { createAuthCredentialsManager } from './src/authCredentials.js';
import * as botStatus from './src/botStatus.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

process.on('uncaughtException', (err) => console.error('[ERRO] Exceção:', err));
process.on('unhandledRejection', (err) => console.error('[ERRO] Promise:', err));

/* ========== EXPRESS ========== */

const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

app.get('/', (_req, res) => res.sendFile(join(__dirname, 'public', 'reservas.html')));
app.get('/health', (_req, res) => res.status(200).send('ok'));

app.get('/api/reservas', (_req, res) => {
  readFile(join(__dirname, 'data/reservas.json'), 'utf8', (err, data) => {
    if (err) return res.status(500).json({ error: 'Erro ao carregar reservas' });
    try {
      const reservas = JSON.parse(data);
      const publico = reservas.map(({ numero, ...r }) => r);
      res.json(publico);
    }
    catch { res.status(500).json({ error: 'JSON inválido' }); }
  });
});

app.get('/api/status', (_req, res) => res.json({ online: isConnected }));

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

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[SITE] Servidor rodando em http://0.0.0.0:${PORT}`);
  startBot();
});

/* ========== WHATSAPP (Baileys) ========== */

let isConnected = false;
let sock = null;
let retryCount = 0;
const MAX_RETRIES = 10;

// Pasta onde a sessão autenticada fica salva
const AUTH_DIR = join(__dirname, 'auth_info');
if (!existsSync(AUTH_DIR)) mkdirSync(AUTH_DIR, { recursive: true });

async function startBot() {
  try {
    const { version } = await fetchLatestBaileysVersion();
    console.log(`[BAILEYS] Versão do protocolo WA: ${version.join('.')}`);

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, console),
      },
      browser: Browsers.ubuntu('Chrome'),
      printQRInTerminal: false,  // gerenciamos o QR manualmente abaixo
      getMessage: async () => ({ conversation: '' }), // obrigatório no v7
    });

    // Salva credenciais sempre que atualizadas
    sock.ev.on('creds.update', saveCreds);

    // Adaptador: interface compatível com o handler.js
    const clientAdapter = {
      sendMessage: async (jid, text) => {
        try {
          const dest = jid.endsWith('@s.whatsapp.net') ? jid : jid;
          await sock.sendMessage(dest, { text });
        } catch (e) {
          console.error('[BOT] Erro ao enviar mensagem:', e.message);
        }
      },
    };

    // Conexão / QR / reconexão
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log('[STATUS] Escaneie o QR Code abaixo:');
        qrcodeTerminal.generate(qr, { small: true });
        retryCount = 0;

        try {
          const dataUrl = await qrcode.toDataURL(qr);
          botStatus.setQr(dataUrl);
        } catch (e) {
          console.error('[BOT] Erro ao gerar QR Code para a página oculta:', e.message);
        }
        credentialsManager.onDisconnected();
      }

      if (connection === 'open') {
        console.log('[STATUS] BOT WHATSAPP ONLINE E PRONTO ✓');
        isConnected = true;
        botStatus.setConnected(true);
        credentialsManager.onConnected();
        retryCount = 0;
        iniciarAvisos(clientAdapter);
      }

      if (connection === 'close') {
        isConnected = false;
        botStatus.setConnected(false);
        credentialsManager.onDisconnected();

        const code = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = code !== DisconnectReason.loggedOut;

        console.log(`[STATUS] Conexão encerrada. Código: ${code} | Reconectar: ${shouldReconnect}`);

        if (shouldReconnect) {
          if (retryCount < MAX_RETRIES) {
            retryCount++;
            const delay = Math.min(8000 * retryCount, 300000);
            console.log(`[STATUS] Retry ${retryCount}/${MAX_RETRIES} em ${delay / 1000}s...`);
            setTimeout(startBot, delay);
          } else {
            console.error('[ERRO] Número máximo de tentativas atingido.');
          }
        } else {
          console.log('[STATUS] Sessão encerrada (logout). Apague a pasta auth_info e reinicie para parear novamente.');
        }
      }
    });

    // Recebe mensagens
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        // Ignora mensagens do próprio bot e de status
        if (msg.key.fromMe) continue;
        if (msg.key.remoteJid === 'status@broadcast') continue;

        // Extrai texto da mensagem (suporta texto simples e resposta citada)
        const body =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          msg.message?.imageMessage?.caption ||
          msg.message?.videoMessage?.caption ||
          '';

        if (!body.trim()) continue;

        // Monta objeto compatível com o handler.js
        const msgAdapter = {
          body,
          from: msg.key.remoteJid,
          author: msg.key.participant || msg.key.remoteJid, // participant em grupos
        };

        try {
          await handleMessage(clientAdapter, msgAdapter);
        } catch (e) {
          console.error('[ERRO handleMessage]', e);
        }
      }
    });

  } catch (err) {
    console.error('[ERRO] Falha ao iniciar bot:', err.message);
    if (retryCount < MAX_RETRIES) {
      retryCount++;
      const delay = Math.min(8000 * retryCount, 300000);
      console.log(`[STATUS] Retry ${retryCount}/${MAX_RETRIES} em ${delay / 1000}s...`);
      setTimeout(startBot, delay);
    }
  }
}

// Monitoramento de memória
setInterval(async () => {
  const memMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
  if (process.env.DEBUG) console.log(`[MEMÓRIA] RAM: ${memMB}MB`);

  if (memMB > 450 && sock) {
    console.warn(`[ALERTA] RAM alta (${memMB}MB). Reconectando...`);
    isConnected = false;
    botStatus.setConnected(false);
    try { sock.end(undefined); } catch (_) {}
    setTimeout(startBot, 5000);
  }
}, 60000);

// Keep-alive
setInterval(() => {
  if (isConnected) {
    console.log(`[KEEP-ALIVE] Bot ativo — ${new Date().toLocaleTimeString('pt-BR')}`);
  } else {
    console.log(`[KEEP-ALIVE] ${new Date().toISOString()} — http ativo, bot desconectado`);
  }
}, 45000);
