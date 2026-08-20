'use strict';

// MasterHosting — Dashboard branché sur l'Express de index.js.
// IMPORTANT : index.js reste le point d'entrée du bot. Il crée l'application
// Express et appelle app.listen(). Ici, on intercepte temporairement listen()
// afin de récupérer EXACTEMENT la même instance Express, puis on ajoute les
// routes du dashboard avant de laisser un seul serveur écouter le port.

require('dotenv').config({
  path: require('node:path').resolve(process.cwd(), '.env'),
});

const express = require('express');
const path = require('node:path');
const crypto = require('node:crypto');
const axios = require('axios');
const Database = require('better-sqlite3');

const originalListen = express.application.listen;
let botApp = null;
let botServer = null;

// index.js appelle app.listen(). On récupère l'instance sans ouvrir un second
// socket. Le vrai listen() sera exécuté une seule fois à la fin de ce fichier.
express.application.listen = function interceptedListen(...args) {
  botApp = this;
  return {
    close(callback) {
      if (typeof callback === 'function') callback();
    },
    listening: false,
  };
};

try {
  require('../index.js');
} finally {
  express.application.listen = originalListen;
}

if (!botApp) {
  throw new Error('Impossible de récupérer l\'application Express créée par index.js.');
}

const app = botApp;
const PORT = Number(process.env.PORT || process.env.DASHBOARD_PORT || 25565);
const HOST = process.env.HOST || process.env.DASHBOARD_HOST || '0.0.0.0';
const TOKEN = process.env.DASHBOARD_TOKEN || '';
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || '';
const GUILD_ID = process.env.GUILD_ID || '';
const PTERO_URL = (process.env.PTERO_URL || '').replace(/\/+$/, '');
const PTERO_KEY = process.env.PTERO_API_KEY || '';

if (!TOKEN || TOKEN.length < 32) {
  throw new Error('DASHBOARD_TOKEN doit contenir au moins 32 caractères.');
}
if (!DISCORD_TOKEN || !GUILD_ID) {
  throw new Error('DISCORD_TOKEN et GUILD_ID sont requis.');
}

const db = new Database(path.resolve(process.cwd(), 'masterhosting.sqlite'), {
  fileMustExist: false,
});

const discord = axios.create({
  baseURL: 'https://discord.com/api/v10',
  headers: {
    Authorization: `Bot ${DISCORD_TOKEN}`,
    'User-Agent': 'MasterHosting-Dashboard/5.0',
  },
  timeout: 15000,
});

const ptero = PTERO_URL && PTERO_KEY
  ? axios.create({
      baseURL: `${PTERO_URL}/api/application`,
      headers: {
        Authorization: `Bearer ${PTERO_KEY}`,
        Accept: 'application/vnd.pterodactyl.v1+json',
      },
      timeout: 15000,
    })
  : null;

// index.js possède déjà express.json(). On ne le remplace pas ; cette limite
// supplémentaire protège néanmoins les routes du dashboard si elles sont
// montées avant d'autres middlewares dans une future version.
app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false);

app.use('/dashboard', express.static(path.join(process.cwd(), 'dashboard'), {
  index: 'index.html',
  extensions: ['html'],
}));

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function auth(req, res, next) {
  const header = req.get('authorization') || '';
  const value = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!safeEqual(value, TOKEN)) {
    return res.status(401).json({ error: 'Non autorisé' });
  }
  next();
}

function actor(req) {
  return req.get('x-dashboard-user') || 'dashboard-admin';
}

function audit(action, user, details) {
  try {
    db.prepare(
      'INSERT INTO logs(action,user,details) VALUES(?,?,?)',
    ).run(action, user, details || null);
  } catch (error) {
    console.error('[Dashboard audit]', error.message);
  }
}

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(process.cwd(), 'dashboard', 'index.html'));
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'masterhosting',
    botProcess: true,
    dashboard: true,
    sharedServer: true,
  });
});

const buckets = new Map();
app.use('/api/dashboard', (req, res, next) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const bucket = buckets.get(ip);

  if (!bucket || now - bucket.start >= 60000) {
    buckets.set(ip, { start: now, count: 1 });
    return next();
  }

  bucket.count += 1;
  if (bucket.count > 60) {
    return res.status(429).json({ error: 'Trop de requêtes' });
  }

  next();
});

app.use('/api/dashboard', auth);

app.get('/api/dashboard/overview', async (req, res) => {
  const result = {
    guilds: 0,
    members: 0,
    tickets: 0,
    warns: 0,
    commands: 0,
    ptero: Boolean(ptero),
    bot: { online: false },
  };

  try {
    const response = await discord.get(`/guilds/${GUILD_ID}?with_counts=true`);
    const guild = response.data;
    result.guilds = 1;
    result.members = Number(guild.approximate_member_count || 0);
    result.bot = { online: true, name: guild.name, id: guild.id };
  } catch {}

  try {
    result.tickets = db.prepare('SELECT COUNT(*) c FROM tickets').get().c;
  } catch {}

  try {
    result.warns = db.prepare('SELECT COUNT(*) c FROM warns').get().c;
  } catch {}

  try {
    result.commands = db
      .prepare("SELECT COUNT(*) c FROM logs WHERE action LIKE 'CMD%'")
      .get().c;
  } catch {}

  res.json(result);
});

app.get('/api/dashboard/members', async (req, res) => {
  try {
    const response = await discord.get(`/guilds/${GUILD_ID}/members?limit=1000`);
    res.json({
      members: response.data.map((member) => ({
        id: member.user.id,
        tag: member.user.discriminator && member.user.discriminator !== '0'
          ? `${member.user.username}#${member.user.discriminator}`
          : member.user.username,
        roles: member.roles?.length || 0,
      })),
    });
  } catch {
    res.status(502).json({ error: 'Impossible de récupérer les membres Discord' });
  }
});

app.get('/api/dashboard/tickets', (req, res) => {
  res.json({
    tickets: db.prepare(
      'SELECT channel_id,owner_id,assigned_to,opened_at FROM tickets ORDER BY opened_at DESC LIMIT 200',
    ).all(),
  });
});

app.get('/api/dashboard/giveaways', (req, res) => {
  res.json({
    giveaways: db.prepare(
      'SELECT message_id,prize,winner_count,ends_at,ended FROM giveaways ORDER BY ends_at DESC LIMIT 200',
    ).all(),
  });
});

app.get('/api/dashboard/logs', (req, res) => {
  res.json({
    logs: db.prepare(
      'SELECT action,user,details,created_at FROM logs ORDER BY id DESC LIMIT 250',
    ).all(),
  });
});

app.get('/api/dashboard/moderation', (req, res) => {
  res.json({
    warns: db.prepare('SELECT COUNT(*) c FROM warns').get().c,
    bans: db.prepare("SELECT COUNT(*) c FROM logs WHERE action='BAN'").get().c,
    kicks: db.prepare("SELECT COUNT(*) c FROM logs WHERE action='KICK'").get().c,
  });
});

app.get('/api/dashboard/ptero', async (req, res) => {
  if (!ptero) return res.json({ connected: false });

  try {
    const [servers, nodes] = await Promise.all([
      ptero.get('/servers?per_page=1'),
      ptero.get('/nodes?per_page=1'),
    ]);

    res.json({
      connected: true,
      servers: servers.data.meta?.pagination?.total || 0,
      nodes: nodes.data.meta?.pagination?.total || 0,
    });
  } catch {
    res.json({ connected: false });
  }
});

async function discordAction(req, res, type) {
  const id = String(req.params.id || '');
  if (!/^\d{15,25}$/.test(id)) {
    return res.status(400).json({ error: 'ID Discord invalide' });
  }

  const reason = String(
    req.body?.reason || 'Action effectuée depuis MasterHosting',
  ).slice(0, 512);

  const headers = {
    'X-Audit-Log-Reason': encodeURIComponent(reason),
  };

  try {
    if (type === 'ban') {
      await discord.put(
        `/guilds/${GUILD_ID}/bans/${id}`,
        { delete_message_seconds: 0 },
        { headers },
      );
    }

    if (type === 'kick') {
      await discord.delete(`/guilds/${GUILD_ID}/members/${id}`, { headers });
    }

    if (type === 'timeout') {
      const minutes = Math.min(
        Math.max(Number(req.body.minutes) || 5, 1),
        40320,
      );

      await discord.patch(
        `/guilds/${GUILD_ID}/members/${id}`,
        {
          communication_disabled_until: new Date(
            Date.now() + minutes * 60000,
          ).toISOString(),
        },
        { headers },
      );
    }

    audit(type.toUpperCase(), actor(req), `target:${id} reason:${reason}`);
    res.json({ ok: true });
  } catch (error) {
    res.status(error.response?.status === 404 ? 404 : 502).json({
      error: 'Discord a refusé l’action ou le membre est introuvable.',
    });
  }
}

app.post('/api/dashboard/members/:id/ban', (req, res) => {
  discordAction(req, res, 'ban');
});

app.post('/api/dashboard/members/:id/kick', (req, res) => {
  discordAction(req, res, 'kick');
});

app.post('/api/dashboard/members/:id/timeout', (req, res) => {
  discordAction(req, res, 'timeout');
});

// C'est le SEUL listen du couple bot + dashboard.
// index.js est chargé avant et son app.listen() a été intercepté ci-dessus.
botServer = app.listen(PORT, HOST, () => {
  console.log('[MasterHosting] Bot + Dashboard démarrés dans le même processus.');
  console.log(`[MasterHosting] Dashboard : http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}/dashboard`);
  console.log(`[MasterHosting] API       : http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}/api/dashboard`);
});

process.on('SIGTERM', () => botServer.close(() => process.exit(0)));
process.on('SIGINT', () => botServer.close(() => process.exit(0)));
