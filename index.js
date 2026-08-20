'use strict';

// MasterHosting — serveur unique Bot Discord + Dashboard.
// index.js est désormais l'unique point d'entrée HTTP.
// Le code historique du bot est conservé dans ./bot.js afin de ne rien perdre.

require('dotenv').config({
  path: require('node:path').resolve(process.cwd(), '.env'),
});

const express = require('express');
const path = require('node:path');
const crypto = require('node:crypto');
const axios = require('axios');
const Database = require('better-sqlite3');

// Le bot historique contient encore son propre app.listen().
// On intercepte cet appel pendant son chargement : aucun socket n'est ouvert.
const originalListen = express.application.listen;
let botApp = null;

express.application.listen = function interceptedListen() {
  botApp = this;
  return {
    close(callback) {
      if (typeof callback === 'function') callback();
    },
    listening: false,
  };
};

try {
  require('./bot.js');
} finally {
  express.application.listen = originalListen;
}

if (!botApp) {
  throw new Error("Impossible de récupérer l'application Express du bot.");
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
  console.warn('[Dashboard] DASHBOARD_TOKEN absent ou trop court. Les API restent protégées.');
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

app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(),microphone=(),geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:");
  next();
});

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
  if (!TOKEN || !safeEqual(value, TOKEN)) {
    return res.status(401).json({ error: 'Non autorisé' });
  }
  next();
}

function actor(req) {
  return req.get('x-dashboard-user') || 'dashboard-admin';
}

function audit(action, user, details) {
  try {
    db.prepare('INSERT INTO logs(action,user,details) VALUES(?,?,?)')
      .run(action, user, details || null);
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
    port: PORT,
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

  try { result.tickets = db.prepare('SELECT COUNT(*) c FROM tickets').get().c; } catch {}
  try { result.warns = db.prepare('SELECT COUNT(*) c FROM warns').get().c; } catch {}
  try { result.commands = db.prepare("SELECT COUNT(*) c FROM logs WHERE action LIKE 'CMD%'").get().c; } catch {}

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
        username: member.user.username,
        avatar: member.user.avatar,
        bot: Boolean(member.user.bot),
      })),
    });
  } catch {
    res.status(502).json({ error: 'Impossible de récupérer les membres Discord' });
  }
});

app.get('/api/dashboard/tickets', (req, res) => {
  res.json({
    tickets: db.prepare('SELECT channel_id,owner_id,assigned_to,opened_at FROM tickets ORDER BY opened_at DESC LIMIT 200').all(),
  });
});

app.get('/api/dashboard/giveaways', (req, res) => {
  res.json({
    giveaways: db.prepare('SELECT message_id,prize,winner_count,ends_at,ended FROM giveaways ORDER BY ends_at DESC LIMIT 200').all(),
  });
});

app.get('/api/dashboard/logs', (req, res) => {
  res.json({
    logs: db.prepare('SELECT action,user,details,created_at FROM logs ORDER BY id DESC LIMIT 250').all(),
  });
});

app.get('/api/dashboard/moderation', (req, res) => {
  res.json({
    warns: db.prepare('SELECT COUNT(*) c FROM warns').get().c,
    bans: db.prepare("SELECT COUNT(*) c FROM logs WHERE action='BAN'").get().c,
    kicks: db.prepare("SELECT COUNT(*) c FROM logs WHERE action='KICK'").get().c,
    mutes: db.prepare("SELECT COUNT(*) c FROM logs WHERE action='MUTE'").get().c,
  });
});

app.get('/api/dashboard/ptero', async (req, res) => {
  if (!ptero) return res.json({ connected: false, servers: 0, nodes: 0 });

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
    res.json({ connected: false, servers: 0, nodes: 0 });
  }
});

async function discordAction(req, res, type) {
  const id = String(req.params.id || '');
  if (!/^\d{15,25}$/.test(id)) {
    return res.status(400).json({ error: 'ID Discord invalide' });
  }

  const reason = String(req.body?.reason || 'Action effectuée depuis MasterHosting').slice(0, 512);
  const headers = { 'X-Audit-Log-Reason': encodeURIComponent(reason) };

  try {
    if (type === 'ban') {
      await discord.put(`/guilds/${GUILD_ID}/bans/${id}`, { delete_message_seconds: 0 }, { headers });
    } else if (type === 'kick') {
      await discord.delete(`/guilds/${GUILD_ID}/members/${id}`, { headers });
    } else if (type === 'timeout') {
      const minutes = Math.min(Math.max(Number(req.body?.minutes) || 5, 1), 40320);
      await discord.patch(`/guilds/${GUILD_ID}/members/${id}`, {
        communication_disabled_until: new Date(Date.now() + minutes * 60000).toISOString(),
      }, { headers });
    }

    audit(type.toUpperCase(), actor(req), `target:${id} reason:${reason}`);
    res.json({ ok: true });
  } catch (error) {
    res.status(error.response?.status === 404 ? 404 : 502).json({
      error: 'Discord a refusé l’action ou le membre est introuvable.',
    });
  }
}

app.post('/api/dashboard/members/:id/ban', (req, res) => discordAction(req, res, 'ban'));
app.post('/api/dashboard/members/:id/kick', (req, res) => discordAction(req, res, 'kick'));
app.post('/api/dashboard/members/:id/timeout', (req, res) => discordAction(req, res, 'timeout'));

const httpServer = app.listen(PORT, HOST, () => {
  const address = HOST === '0.0.0.0' ? '0.0.0.0' : HOST;
  console.log(`[MasterHosting] Bot + Dashboard sur ${address}:${PORT}`);
  console.log(`[MasterHosting] Dashboard : /dashboard`);
  console.log(`[MasterHosting] API        : /api/dashboard`);
});

process.on('SIGTERM', () => httpServer.close(() => process.exit(0)));
process.on('SIGINT', () => httpServer.close(() => process.exit(0)));
