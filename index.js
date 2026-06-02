const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { handleMessage, iniciarAvisos } = require('./src/handler');

const express = require('express');
const path = require('path');
const fs = require('fs');

process.on('uncaughtException', (err) => {
  console.error('[ERRO] Exceção não tratada:', err);
});

process.on('unhandledRejection', (err) => {
  console.error('[ERRO] Promise rejeitada:', err);
});

const app = express();

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'reservas.html'));
});

app.get('/health', (_req, res) => res.status(200).send('ok'));

app.get('/api/reservas', (_req, res) => {
  fs.readFile(path.join(__dirname, 'public/reservas.json'), 'utf8', (err, data) => {
    if (err) {
      console.error('[API] Erro ao ler reservas.json:', err);
      return res.status(500).json({ error: 'Erro ao carregar reservas' });
    }
    try {
      res.json(JSON.parse(data));
    } catch (e) {
      console.error('[API] JSON inválido:', e);
      res.status(500).json({ error: 'JSON inválido' });
    }
  });
});

app.get('/api/status', (_req, res) => {
  res.json({ online: clientInitialized });
});

const PORT = Number(process.env.PORT || 3000);
console.log('[BOOT] PORT:', PORT);

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[SITE] Servidor rodando em http://0.0.0.0:${PORT}`);
  startClient();
});

/* ========== WHATSAPP ========== */

let clientInitialized = false;
let isReconnecting = false;
let client;
let retryCount = 0;
const MAX_RETRIES = 10;

// Args otimizados para ambiente container/cloud (sem --single-process)
const PUPPETEER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-software-rasterizer',
  '--disable-accelerated-2d-canvas',
  '--no-first-run',
  '--no-zygote',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-default-apps',
  '--disable-sync',
  '--disable-translate',
  '--hide-scrollbars',
  '--metrics-recording-only',
  '--mute-audio',
  '--safebrowsing-disable-auto-update',
];

async function startClient() {
  if (clientInitialized || isReconnecting) return;
  isReconnecting = true;

  console.log(`[STATUS] Iniciando cliente... (tentativa ${retryCount + 1}/${MAX_RETRIES})`);

  client = new Client({
    authStrategy: new LocalAuth({ clientId: 'bot-session' }),
    puppeteer: {
      headless: true,
      args: PUPPETEER_ARGS,
    },
    // Tempo extra para o contexto do Chromium estabilizar antes da injeção
    restartOnAuthFail: true,
  });

  const clientAdapter = {
    sendMessage: async (to, text) => {
      try {
        const jid = to.endsWith('@s.whatsapp.net')
          ? to.replace('@s.whatsapp.net', '@c.us')
          : to;
        await client.sendMessage(jid, text);
      } catch (e) {
        console.error('[BOT] Erro ao enviar mensagem:', e);
      }
    },
  };

  client.on('qr', (qr) => {
    retryCount = 0; // QR apareceu → Chromium funcionando, reseta contador
    console.log('[STATUS] Escaneie o QR Code abaixo:');
    qrcode.generate(qr, { small: true });
  });

  client.on('authenticated', () => {
    console.log('[STATUS] Autenticado com sucesso!');
    retryCount = 0;
  });

  client.on('auth_failure', (msg) => {
    console.error('[STATUS] Falha de autenticação:', msg);
  });

  client.on('change_state', (state) => {
    console.log('[STATUS] Estado de conexão:', state);
  });

  client.on('ready', () => {
    console.log('[STATUS] BOT WHATSAPP ONLINE E PRONTO');
    clientInitialized = true;
    isReconnecting = false;
    retryCount = 0;
    iniciarAvisos(clientAdapter);
  });

  client.on('disconnected', async (reason) => {
    console.log('[STATUS] WhatsApp desconectado. Motivo:', reason);
    clientInitialized = false;
    isReconnecting = true;

    try {
      await client.destroy();
    } catch (err) {
      console.error('[ERRO] Erro ao destruir cliente:', err);
    }

    const delay = 5000;
    console.log(`[STATUS] Reiniciando em ${delay / 1000}s...`);
    setTimeout(() => {
      isReconnecting = false;
      startClient();
    }, delay);
  });

  client.on('message', async (message) => {
    try {
      await handleMessage(clientAdapter, message);
    } catch (e) {
      console.error('[ERRO handleMessage]', e);
    }
  });

  try {
    console.log('[STATUS] Inicializando Client...');
    await client.initialize();
  } catch (err) {
    console.error('[ERRO] Falha ao inicializar o Client:', err.message);
    isReconnecting = false;

    // Retry com backoff exponencial (máx 5 min)
    if (retryCount < MAX_RETRIES) {
      retryCount++;
      const delay = Math.min(10000 * retryCount, 300000); // 10s, 20s, 30s ... 5min
      console.log(`[STATUS] Retry ${retryCount}/${MAX_RETRIES} em ${delay / 1000}s...`);

      try { await client.destroy(); } catch (_) {}

      setTimeout(() => {
        startClient();
      }, delay);
    } else {
      console.error('[ERRO] Número máximo de tentativas atingido. Verifique o ambiente.');
    }
  }
}

// Monitoramento de memória
setInterval(async () => {
  const memMB = Math.round(process.memoryUsage().rss / 1024 / 1024);

  if (process.env.DEBUG) {
    console.log(`[MEMÓRIA] RAM usada: ${memMB}MB`);
  }

  if (memMB > 450) {
    console.warn(`[ALERTA] RAM alta (${memMB}MB). Reiniciando cliente...`);
    clientInitialized = false;
    isReconnecting = true;

    if (client) {
      try {
        await client.destroy();
      } catch (e) {
        console.error('[ERRO] Falha ao destruir client:', e);
      }
    }

    setTimeout(() => {
      console.log('[STATUS] Reiniciando cliente após limpeza de memória...');
      isReconnecting = false;
      startClient();
    }, 5000);
  }
}, 60000);

// Keep-alive
setInterval(() => {
  if (clientInitialized && client && client.info) {
    console.log(`[KEEP-ALIVE] Bot ativo — ${client.info.pushname || '...'}`);
  } else {
    console.log(`[KEEP-ALIVE] ${new Date().toISOString()} — http ativo, bot desconectado`);
  }
}, 45000);
