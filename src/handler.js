import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ==== Configurações ====

const LOCAIS_VALIDOS = [
  'Quadra BT',
  'Quadra Poliesportiva',
  'Salão de Festas',
  'Piscina',
  'Campo de Futebol',
  'Churrasqueira',
  'Auditório',
];

const MAX_RESERVAS_ATIVAS = 5;

// ==== Utils de data/hora no fuso America/Cuiaba ====

function getCuiabaParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Cuiaba',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map(p => [p.type, p.value]));
  return {
    year: parseInt(parts.year, 10),
    month: parseInt(parts.month, 10),
    day: parseInt(parts.day, 10),
    hour: parseInt(parts.hour, 10),
    minute: parseInt(parts.minute, 10),
  };
}

function todayCuiabaYMD() {
  const { year, month, day } = getCuiabaParts(new Date());
  return { year, month, day };
}

function isHojeCuiaba(d, m, a) {
  const t = todayCuiabaYMD();
  return d === t.day && m === t.month && a === t.year;
}

function isCuiabaAt(hour, minute) {
  const { hour: h, minute: min } = getCuiabaParts(new Date());
  return h === hour && min === minute;
}

function parseHora(horaStr) {
  if (!horaStr) return null;
  let s = horaStr.toLowerCase().replace(/\s+/g, '').replace(/às|as/g, '-').replace(/h/g, ':');
  const [startStr, endStr] = s.split('-');
  if (!startStr || !endStr) return null;

  const toMin = (str) => {
    const [HH, MM] = str.split(':');
    const h = parseInt(HH, 10);
    const m = MM ? parseInt(MM, 10) : 0;
    if (isNaN(h) || isNaN(m) || h < 0 || h > 24 || m < 0 || m >= 60) return null;
    return Math.min(h * 60 + m, 24 * 60);
  };

  const start = toMin(startStr);
  const end = toMin(endStr);
  if (start === null || end === null || start >= end) return null;
  return { start, end };
}

function getInicioEmMinutos(r) {
  const p = parseHora(r.hora || '');
  return p ? p.start : 24 * 60;
}

function parseDMAY(rDia) {
  const { year: anoPadrao } = todayCuiabaYMD();
  const [dStr, mStr, yStr] = (rDia || '').split('/').map(s => (s || '').trim());
  const d = parseInt(dStr, 10);
  const m = parseInt(mStr, 10);
  const a = parseInt(yStr, 10) || anoPadrao;
  if (isNaN(d) || isNaN(m) || isNaN(a) || d <= 0 || m <= 0 || m > 12) return null;

  // Valida o dia para o mês específico
  const diasNoMes = new Date(a, m, 0).getDate();
  if (d > diasNoMes) return null;

  return { d, m, a };
}

function ymdKey(d, m, a) {
  return a * 10000 + m * 100 + d;
}

function isPastDate(d, m, a) {
  const hoje = todayCuiabaYMD();
  return ymdKey(d, m, a) < ymdKey(hoje.day, hoje.month, hoje.year);
}

// ==== Persistência com mutex para evitar race condition ====

const dataDir = path.join(__dirname, '../data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const dbPath = path.join(dataDir, 'reservas.json');

let _writeLock = Promise.resolve();

function loadDB() {
  if (!fs.existsSync(dbPath)) return [];
  try {
    return JSON.parse(fs.readFileSync(dbPath, 'utf-8'));
  } catch {
    return [];
  }
}

function saveDB(data) {
  // Escreve em arquivo temporário e renomeia atomicamente para evitar corrupção
  const tmp = dbPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, dbPath);
}

function withLock(fn) {
  _writeLock = _writeLock.then(fn).catch(fn);
  return _writeLock;
}

// ==== Gerador de código único ====

function gerarCodigo(reservas) {
  if (reservas.length === 0) return '001';
  const maxCodigo = Math.max(...reservas.map(r => parseInt(r.codigo, 10) || 0));
  return (maxCodigo + 1).toString().padStart(3, '0');
}

// ==== Normalização de número ====

function normalizarNumero(numero) {
  if (!numero) return numero;
  return numero.replace('@s.whatsapp.net', '@c.us');
}

// ==== Verificação de conflito ====

function temConflito(nova, existentes) {
  const n = parseHora(nova.hora);
  if (!n) return false;
  return existentes.some(r => {
    const st = (r.status || '').toLowerCase();
    if (st !== 'reservado' && st !== 'avisado') return false;
    if ((r.dia || '') !== (nova.dia || '')) return false;
    if ((r.local || '').toLowerCase() !== (nova.local || '').toLowerCase()) return false;
    const e = parseHora(r.hora || '');
    if (!e) return false;
    return n.start < e.end && e.start < n.end;
  });
}

// ==== Estados de confirmação pendente ====
// chave: número do usuário → dados da reserva aguardando confirmação
const pendentes = new Map();

// ==== Ajuda ====

const MSG_AJUDA = `📋 *COMANDOS DO SISTEMA DE RESERVAS — CMC*

🟢 *Fazer uma reserva:*
\`\`\`
Reservar
Dia: 28/06
Hora: 18:00-20:00
Local: Quadra BT
Nome: João Silva
Qnt: 6
\`\`\`

🏟️ *Locais disponíveis:*
${LOCAIS_VALIDOS.map((l, i) => `  ${i + 1}. ${l}`).join('\n')}

🟥 *Cancelar reserva:*
\`\`\`
Cancelar 001
\`\`\`
_(somente o responsável pela reserva pode cancelar)_

📄 *Ver suas reservas:*
\`\`\`
Minhas Reservas
\`\`\`

📄 *Ver todas as próximas reservas:*
\`\`\`
Listar Reservas
\`\`\`

🌐 Acompanhe também em: https://reservascmc.squareweb.app/`;

// ==== Handler principal ====

async function handleMessage(client, message) {
  // Ignorar mensagens de grupos, status, etc.
  if (message.from === 'status@broadcast') return;

  const remetente = normalizarNumero(message.author || message.from);
  const raw = message.body ? message.body.trim() : '';
  const content = raw.toLowerCase();

  // === Confirmação pendente ===
  if (pendentes.has(remetente)) {
    const reservaPendente = pendentes.get(remetente);
    if (content === 'confirmar' || content === 'sim' || content === 's') {
      pendentes.delete(remetente);
      await withLock(async () => {
        const reservas = loadDB();
        // Re-verifica conflito antes de salvar
        if (temConflito(reservaPendente, reservas)) {
          await client.sendMessage(message.from,
            '⚠️ Outra reserva foi criada neste mesmo horário/local enquanto você confirmava. Tente novamente com outro horário.');
          return;
        }
        // Re-verifica limite
        const ativasDoUsuario = reservas.filter(r =>
          normalizarNumero(r.numero) === remetente &&
          ['reservado', 'avisado'].includes((r.status || '').toLowerCase())
        );
        if (ativasDoUsuario.length >= MAX_RESERVAS_ATIVAS) {
          await client.sendMessage(message.from,
            `⚠️ Você atingiu o limite de ${MAX_RESERVAS_ATIVAS} reservas ativas. Cancele uma antes de criar nova.`);
          return;
        }
        reservaPendente.codigo = gerarCodigo(reservas);
        reservas.push(reservaPendente);
        saveDB(reservas);
        await client.sendMessage(message.from,
          `✅ *Reserva confirmada!*\n\n` +
          `👤 *Nome:* ${reservaPendente.nome}\n` +
          `📍 *Local:* ${reservaPendente.local}\n` +
          `🗓️ *Dia:* ${reservaPendente.dia}\n` +
          `⏰ *Hora:* ${reservaPendente.hora}\n` +
          `👥 *Pessoas:* ${reservaPendente.qnt}\n` +
          `🔒 *Código:* ${reservaPendente.codigo}\n\n` +
          `ℹ️ Para consultar: envie *Minhas Reservas*\n` +
          `🌐 https://reservascmc.squareweb.app/`
        );
      });
      return;
    } else if (content === 'cancelar' || content === 'não' || content === 'nao' || content === 'n') {
      pendentes.delete(remetente);
      await client.sendMessage(message.from, '❌ Reserva cancelada. Nenhum dado foi salvo.');
      return;
    }
    // Se enviou outro comando, cancela a pendência e processa normalmente
    pendentes.delete(remetente);
  }

  // === RESERVAR ===
  if (content.startsWith('reservar')) {
    const linhas = raw.split('\n');

    const extrair = (prefixo) =>
      linhas.find(l => l.toLowerCase().startsWith(prefixo))
        ?.split(':').slice(1).join(':').trim() || '';

    const dia   = extrair('dia:');
    const hora  = extrair('hora:');
    const local = extrair('local:');
    const nome  = extrair('nome:');
    const qnt   = extrair('qnt:');

    // Feedback detalhado de campos faltantes
    const faltando = [];
    if (!dia)   faltando.push('Dia');
    if (!hora)  faltando.push('Hora');
    if (!local) faltando.push('Local');
    if (!nome)  faltando.push('Nome');
    if (!qnt)   faltando.push('Qnt');

    if (faltando.length > 0) {
      await client.sendMessage(message.from,
        `⚠️ *Campos obrigatórios faltando:* ${faltando.join(', ')}\n\n` +
        `Por favor, envie no formato:\n\n` +
        `Reservar\nDia: 28/06\nHora: 18:00-20:00\nLocal: Quadra BT\nNome: João\nQnt: 6`
      );
      return;
    }

    // Valida horário
    const janela = parseHora(hora);
    if (!janela) {
      await client.sendMessage(message.from,
        '⚠️ *Horário inválido!*\n\nInforme um intervalo no formato: *18:00-21:00* ou *18h às 21h*\nO horário final deve ser maior que o inicial.'
      );
      return;
    }

    // Valida data
    const dmy = parseDMAY(dia);
    if (!dmy) {
      await client.sendMessage(message.from,
        '⚠️ *Data inválida!*\n\nInforme no formato: *28/06* ou *28/06/2025*'
      );
      return;
    }

    // Valida data passada
    if (isPastDate(dmy.d, dmy.m, dmy.a)) {
      await client.sendMessage(message.from,
        '⚠️ Não é possível reservar para uma data que já passou.'
      );
      return;
    }

    // Valida local
    const localNormalizado = LOCAIS_VALIDOS.find(
      l => l.toLowerCase() === local.toLowerCase()
    );
    if (!localNormalizado) {
      await client.sendMessage(message.from,
        `⚠️ *Local inválido:* "${local}"\n\n` +
        `Locais disponíveis:\n${LOCAIS_VALIDOS.map((l, i) => `  ${i + 1}. ${l}`).join('\n')}`
      );
      return;
    }

    const novaReserva = {
      codigo: '???', // será definido ao confirmar
      dia,
      hora,
      local: localNormalizado,
      nome,
      qnt,
      numero: remetente,
      status: 'Reservado',
    };

    // Verifica conflito e limite ANTES de pedir confirmação
    const reservas = loadDB();

    if (temConflito(novaReserva, reservas)) {
      await client.sendMessage(message.from,
        '⚠️ Já existe uma reserva no mesmo dia e horário para este local!'
      );
      return;
    }

    const ativasDoUsuario = reservas.filter(r =>
      normalizarNumero(r.numero) === remetente &&
      ['reservado', 'avisado'].includes((r.status || '').toLowerCase())
    );
    if (ativasDoUsuario.length >= MAX_RESERVAS_ATIVAS) {
      await client.sendMessage(message.from,
        `⚠️ Você já possui ${MAX_RESERVAS_ATIVAS} reservas ativas. Cancele uma antes de criar nova.\n\nEnvie *Minhas Reservas* para ver suas reservas.`
      );
      return;
    }

    // Guarda pendência e pede confirmação
    pendentes.set(remetente, novaReserva);
    await client.sendMessage(message.from,
      `📋 *Confirme sua reserva:*\n\n` +
      `👤 *Nome:* ${nome}\n` +
      `📍 *Local:* ${localNormalizado}\n` +
      `🗓️ *Dia:* ${dia}\n` +
      `⏰ *Hora:* ${hora}\n` +
      `👥 *Pessoas:* ${qnt}\n\n` +
      `Responda *CONFIRMAR* para salvar ou *CANCELAR* para desistir.`
    );
    return;
  }

  // === CANCELAR ===
  if (content.startsWith('cancelar')) {
    const codigo = content.slice('cancelar'.length).trim();

    if (!codigo) {
      await client.sendMessage(message.from,
        '⚠️ Informe o código da reserva. Ex: *Cancelar 001*\n\nEnvie *Minhas Reservas* para ver seus códigos.'
      );
      return;
    }

    await withLock(async () => {
      const reservas = loadDB();
      const index = reservas.findIndex(
        r => r.codigo === codigo && ['reservado', 'avisado'].includes((r.status || '').toLowerCase())
      );

      if (index === -1) {
        await client.sendMessage(message.from,
          `⚠️ Código *${codigo}* não encontrado ou já cancelado.\n🌐 https://reservascmc.squareweb.app/`
        );
        return;
      }

      // Verifica se o cancelamento é do dono
      const reserva = reservas[index];
      if (normalizarNumero(reserva.numero) !== remetente) {
        await client.sendMessage(message.from,
          '🚫 Você não tem permissão para cancelar esta reserva.\nApenas o responsável pela reserva pode cancelá-la.'
        );
        return;
      }

      reservas[index].status = 'Cancelado';
      saveDB(reservas);
      await client.sendMessage(message.from,
        `❌ *Reserva ${codigo} cancelada com sucesso.*\n\n` +
        `ℹ️ Para ver suas reservas: *Minhas Reservas*\n` +
        `🌐 https://reservascmc.squareweb.app/`
      );
    });
    return;
  }

  // === MINHAS RESERVAS ===
  if (content === 'minhas reservas') {
    const hoje = todayCuiabaYMD();
    const reservas = loadDB()
      .filter(r => normalizarNumero(r.numero) === remetente)
      .filter(r => {
        const st = (r.status || '').toLowerCase();
        if (st === 'cancelado') return false;
        const dmy = parseDMAY(r.dia);
        if (!dmy) return true;
        return ymdKey(dmy.d, dmy.m, dmy.a) >= ymdKey(hoje.day, hoje.month, hoje.year);
      })
      .sort((a, b) => {
        const A = parseDMAY(a.dia), B = parseDMAY(b.dia);
        const kA = A ? ymdKey(A.d, A.m, A.a) : Number.MAX_SAFE_INTEGER;
        const kB = B ? ymdKey(B.d, B.m, B.a) : Number.MAX_SAFE_INTEGER;
        if (kA !== kB) return kA - kB;
        return getInicioEmMinutos(a) - getInicioEmMinutos(b);
      });

    if (reservas.length === 0) {
      await client.sendMessage(message.from,
        '📅 Você não possui reservas futuras ativas.\n\nEnvie *Ajuda* para ver como fazer uma reserva.'
      );
      return;
    }

    const linhas = reservas.map(r =>
      `🔒 *${r.codigo}* | ${r.dia} ${r.hora}\n   📍 ${r.local} | 👥 ${r.qnt} pessoas`
    ).join('\n\n');

    await client.sendMessage(message.from,
      `📅 *Suas próximas reservas:*\n\n${linhas}\n\n🌐 https://reservascmc.squareweb.app/`
    );
    return;
  }

  // === LISTAR RESERVAS ===
  if (content.startsWith('listar reservas')) {
    const hoje = todayCuiabaYMD();
    const reservas = loadDB()
      .filter(r => {
        const st = (r.status || '').toLowerCase();
        return st === 'reservado' || st === 'avisado';
      })
      .filter(r => {
        const dmy = parseDMAY(r.dia);
        if (!dmy) return true;
        return ymdKey(dmy.d, dmy.m, dmy.a) >= ymdKey(hoje.day, hoje.month, hoje.year);
      })
      .sort((a, b) => {
        const A = parseDMAY(a.dia), B = parseDMAY(b.dia);
        const kA = A ? ymdKey(A.d, A.m, A.a) : Number.MAX_SAFE_INTEGER;
        const kB = B ? ymdKey(B.d, B.m, B.a) : Number.MAX_SAFE_INTEGER;
        if (kA !== kB) return kA - kB;
        return getInicioEmMinutos(a) - getInicioEmMinutos(b);
      });

    if (reservas.length === 0) {
      await client.sendMessage(message.from, '📅 Não há reservas futuras no momento.');
      return;
    }

    const linhas = reservas.map(r =>
      `✔ *${r.codigo}* | ${r.dia} ${r.hora} | ${r.local} | ${r.nome} | ${r.qnt} pessoas`
    ).join('\n');

    await client.sendMessage(message.from,
      `📅 *Próximas reservas:*\n\n${linhas}\n\n🌐 https://reservascmc.squareweb.app/`
    );
    return;
  }

  // === AJUDA (e variantes de entrada) ===
  if (
    content === 'ajuda' ||
    content === 'oi' ||
    content === 'olá' ||
    content === 'ola' ||
    content === 'menu' ||
    content === 'start' ||
    content === 'começar' ||
    content === 'comecar' ||
    content === 'help'
  ) {
    await client.sendMessage(message.from, MSG_AJUDA);
    return;
  }

  // === Detecção de intenção para reservar ===
  if (
    content.includes('quero reservar') ||
    content.includes('fazer reserva') ||
    content.includes('como reservo') ||
    content.includes('como faço') ||
    content.includes('como faço para reservar')
  ) {
    await client.sendMessage(message.from,
      `Para reservar, envie uma mensagem neste formato:\n\n` +
      `Reservar\nDia: 28/06\nHora: 18:00-20:00\nLocal: Quadra BT\nNome: João\nQnt: 6\n\n` +
      `Envie *Ajuda* para ver todos os comandos.`
    );
    return;
  }
}

// ==== Avisos automáticos ====

let avisosInterval = null;

function iniciarAvisos(client) {
  if (avisosInterval) clearInterval(avisosInterval);

  avisosInterval = setInterval(async () => {
    if (!isCuiabaAt(8, 0)) return;

    await withLock(async () => {
      const reservas = loadDB();
      let alterou = false;

      for (const reserva of reservas) {
        if ((reserva.status || '').toLowerCase() !== 'reservado') continue;
        const dmy = parseDMAY(reserva.dia);
        if (!dmy) continue;
        if (!isHojeCuiaba(dmy.d, dmy.m, dmy.a)) continue;

        const aviso =
          `📢 *Olá ${reserva.nome}! Lembrete da sua reserva hoje:*\n\n` +
          `📍 *Local:* ${reserva.local}\n` +
          `🗓️ *Dia:* ${reserva.dia}\n` +
          `⏰ *Hora:* ${reserva.hora}\n` +
          `👥 *Pessoas:* ${reserva.qnt}\n\n` +
          `Te esperamos! 🏟️`;

        try {
          await client.sendMessage(normalizarNumero(reserva.numero), aviso);
          reserva.status = 'Avisado';
          alterou = true;
        } catch {
          // mantém como "Reservado" para reprocessar no próximo dia se falhar
        }
      }

      if (alterou) saveDB(reservas);
    });
  }, 60 * 1000);
}

export { handleMessage, iniciarAvisos };
