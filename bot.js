'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
//  MASTER HOSTING — Discord Bot  ·  index.js  v4.0.0
//  discord.js v14  ·  Node.js 18+  ·  better-sqlite3  ·  axios
//
//  Architecture :
//    §1  Config & validation
//    §2  Base de données SQLite (WAL)
//    §3  Client Pterodactyl (Application API v1)
//    §4  Client Discord
//    §5  Utilitaires
//    §6  Commandes Slash
//    §7  Règlement (18 articles)
//    §8  Embeds factory
//    §9  Composants (Boutons · Menus · Modals)
//    §10 Transcript HTML
//    §11 Helpers tickets
//    §12 Anti-spam
//    §13 Giveaways
//    §14 Logs modération
//    §15 Handler — Slash commands
//    §16 Handler — Boutons
//    §17 Handler — Menus
//    §18 Handler — Modals
//    §19 Routeur interactions
//    §20 Événements guild
//    §21 Init salons & démarrage
//    §22 Gestion erreurs globales
// ═══════════════════════════════════════════════════════════════════════════════

require('dotenv').config();

const {
  Client, GatewayIntentBits, Partials,
  EmbedBuilder, ActionRowBuilder,
  ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  ChannelType, PermissionFlagsBits,
  REST, Routes, SlashCommandBuilder,
  ActivityType,
} = require('discord.js');

const axios    = require('axios');
const Database = require('better-sqlite3');
const express = require("express");

const app = express();

app.use(express.json());
// ──────────────────────────────────────────────────────────────────────────────
//  §1  CONFIG & VALIDATION
// ──────────────────────────────────────────────────────────────────────────────

const REQUIRED = ['DISCORD_TOKEN', 'CLIENT_ID', 'GUILD_ID'];
for (const k of REQUIRED) {
  if (!process.env[k]) {
    console.error(`[FATAL] Variable d'environnement manquante : ${k}`);
    process.exit(1);
  }
}

const cfg = Object.freeze({
  // Core
  token:     process.env.DISCORD_TOKEN,
  clientId:  process.env.CLIENT_ID,
  guildId:   process.env.GUILD_ID,
  prefix:    process.env.PREFIX || '!',

  // Pterodactyl
  pteroUrl:    (process.env.PTERO_URL || '').replace(/\/+$/, ''),
  pteroKey:    process.env.PTERO_API_KEY || '',
  pteroClient: process.env.PTERO_CLIENT_KEY || '',   // clé client (optionnel)

  // Rôles
  staffRoleId:  process.env.STAFF_ROLE_ID  || null,
  verifyRoleId: process.env.VERIFY_ROLE_ID || null,

  // Salons
  verifyChannelId:      process.env.VERIFY_CHANNEL_ID       || null,
  ticketPanelChannelId: process.env.TICKET_PANEL_CHANNEL_ID || null,
  ticketCategoryId:     process.env.TICKET_CATEGORY_ID      || null,
  modLogChannelId:      process.env.MOD_LOG_CHANNEL_ID      || null,
  welcomeChannelId:     process.env.WELCOME_CHANNEL_ID      || null,
  leaveChannelId:       process.env.LEAVE_CHANNEL_ID        || null,
  suggestionChannelId:  process.env.SUGGESTION_CHANNEL_ID   || null,
  announcementChannelId:process.env.ANNOUNCEMENT_CHANNEL_ID || null,

  // Anti-spam
  spamThreshold: parseInt(process.env.SPAM_THRESHOLD    || '5'),
  spamWindow:    parseInt(process.env.SPAM_WINDOW       || '4000'),
  spamMuteMins:  parseInt(process.env.SPAM_MUTE_MINUTES || '5'),

  // Modération
  maxWarns: parseInt(process.env.MAX_WARNS || '5'),

  // Branding
  siteUrl: process.env.SITE_URL || 'https://masterhosting.fr',

  // Couleurs
  colors: {
    primary: 0x5865F2,
    success: 0x00B894,
    danger:  0xE74C3C,
    warning: 0xF59E0B,
    orange:  0xF97316,
    purple:  0x8B5CF6,
    gold:    0xFFD166,
    dark:    0x2F3136,
  },
});

const VERSION = '4.0.0';

const PLANS = [
  { name: '🌱 Starter',    price: '2,99 €/mois',  spec: '1 vCPU · 1 Go RAM · 5 Go SSD' },
  { name: '🚀 Pro',        price: '6,99 €/mois',  spec: '2 vCPU · 4 Go RAM · 20 Go SSD' },
  { name: '💼 Business',   price: '12,99 €/mois', spec: '4 vCPU · 8 Go RAM · 50 Go NVMe' },
  { name: '🏢 Enterprise', price: '29,99 €/mois', spec: '8 vCPU · 32 Go RAM · 200 Go NVMe' },
];

// ──────────────────────────────────────────────────────────────────────────────
//  §2  BASE DE DONNÉES SQLite
// ──────────────────────────────────────────────────────────────────────────────

const db = new Database('masterhosting.sqlite');
const logsColumns = db.prepare("PRAGMA table_info(logs)").all();

if (!logsColumns.some(col => col.name === "details")) {
    db.prepare(`
        ALTER TABLE logs ADD COLUMN details TEXT
    `).run();

    console.log("✅ Migration : colonne logs.details ajoutée");
}
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    discord_id TEXT PRIMARY KEY,
    ptero_id   INTEGER UNIQUE NOT NULL,
    username   TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS warns (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    discord_id TEXT NOT NULL,
    guild_id   TEXT NOT NULL,
    reason     TEXT NOT NULL,
    mod_tag    TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS logs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    action     TEXT NOT NULL,
    user       TEXT NOT NULL,
    details    TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS giveaways (
    message_id   TEXT PRIMARY KEY,
    channel_id   TEXT NOT NULL,
    guild_id     TEXT NOT NULL,
    prize        TEXT NOT NULL,
    winner_count INTEGER NOT NULL DEFAULT 1,
    ends_at      INTEGER NOT NULL,
    ended        INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS giveaway_entries (
    message_id TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    PRIMARY KEY (message_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS tickets (
    channel_id  TEXT PRIMARY KEY,
    owner_id    TEXT NOT NULL,
    assigned_to TEXT,
    opened_at   DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Vérification de la table logs (à mettre AVANT const stmt)
console.log(
  db.prepare("PRAGMA table_info(logs)").all()
);

// Prepared statements
const stmt = {
  // Accounts
  getAccount:    db.prepare('SELECT * FROM accounts WHERE discord_id = ?'),
  upsertAccount: db.prepare('INSERT INTO accounts (discord_id, ptero_id, username) VALUES (?, ?, ?) ON CONFLICT(discord_id) DO UPDATE SET ptero_id=excluded.ptero_id, username=excluded.username'),

  // Warns
  addWarn:    db.prepare('INSERT INTO warns (discord_id, guild_id, reason, mod_tag) VALUES (?, ?, ?, ?)'),
  getWarns:   db.prepare('SELECT * FROM warns WHERE discord_id = ? ORDER BY created_at DESC'),
  clearWarns: db.prepare('DELETE FROM warns WHERE discord_id = ?'),

  // Logs
  addLog: db.prepare('INSERT INTO logs (action, user, details) VALUES (?, ?, ?)'),

  // Giveaways
  createGiveaway: db.prepare('INSERT INTO giveaways (message_id, channel_id, guild_id, prize, winner_count, ends_at) VALUES (?, ?, ?, ?, ?, ?)'),
  getGiveaway:    db.prepare('SELECT * FROM giveaways WHERE message_id = ?'),
  endGiveaway:    db.prepare('UPDATE giveaways SET ended = 1 WHERE message_id = ?'),
  getExpired:     db.prepare('SELECT * FROM giveaways WHERE ended = 0 AND ends_at <= ?'),
  addEntry:       db.prepare('INSERT INTO giveaway_entries (message_id, user_id) VALUES (?, ?)'),
  hasEntry:       db.prepare('SELECT 1 FROM giveaway_entries WHERE message_id = ? AND user_id = ?'),
  getEntries:     db.prepare('SELECT user_id FROM giveaway_entries WHERE message_id = ?'),
  countEntries:   db.prepare('SELECT COUNT(*) as c FROM giveaway_entries WHERE message_id = ?'),

  // Tickets
  createTicket: db.prepare('INSERT OR IGNORE INTO tickets (channel_id, owner_id) VALUES (?, ?)'),
  getTicket: db.prepare('SELECT * FROM tickets WHERE channel_id = ?'),
  assignTicket: db.prepare('UPDATE tickets SET assigned_to = ? WHERE channel_id = ?'),
  deleteTicket: db.prepare('DELETE FROM tickets WHERE channel_id = ?'),
  findTicket: db.prepare('SELECT * FROM tickets WHERE owner_id = ?'),
};

const log = (action, user, details = null) =>
  stmt.addLog.run(action, user, details);

// ──────────────────────────────────────────────────────────────────────────────
//  §3  CLIENT PTERODACTYL (Application API v1)
//
//  Référence officielle : https://dashfox.gitbook.io/pterodactyl-api
//  Endpoints couverts :
//    GET/POST/PATCH/DELETE /users
//    GET/POST/PATCH/DELETE /servers
//    GET/POST              /nodes
//    GET                   /locations
//    GET                   /nests & /nests/:id/eggs
//    GET                   /nodes/:id/allocations
//    GET                   /databases (hosts)
// ──────────────────────────────────────────────────────────────────────────────

let ptero = null;

if (cfg.pteroUrl && cfg.pteroKey) {
  ptero = axios.create({
    baseURL: `${cfg.pteroUrl}/api/application`,
    headers: {
      Authorization: `Bearer ${cfg.pteroKey}`,
      Accept:        'application/vnd.pterodactyl.v1+json',
      'Content-Type': 'application/json',
    },
    timeout: 20_000,
  });

  ptero.interceptors.response.use(
    (r) => r,
    (err) => {
      const data = err.response?.data;
      console.error('[Pterodactyl]', JSON.stringify(data || err.message, null, 2));
      return Promise.reject(err);
    },
  );
}

const hasPtero = () => !!ptero;

const pteroErr = (err) => {
  const detail = err.response?.data?.errors?.[0]?.detail;
  return detail ? `❌ **Pterodactyl :** ${detail}` : '❌ Erreur API Pterodactyl. Vérifiez les logs.';
};

// ─── Helpers API ─────────────────────────────────────────────────────────────

const api = {
  // Users
  users: {
    list:    (page = 1)    => ptero.get(`/users?per_page=50&page=${page}`),
    get:     (id)          => ptero.get(`/users/${id}?include=servers`),
    getExt:  (externalId)  => ptero.get(`/users/external/${externalId}`),
    create:  (body)        => ptero.post('/users', body),
    update:  (id, body)    => ptero.patch(`/users/${id}`, body),
    delete:  (id)          => ptero.delete(`/users/${id}`),
  },
  // Servers
servers: {
    list: (page = 1) =>
        ptero.get(`/servers?per_page=50&page=${page}&include=user,node,allocations`),

    get: (id) =>
        ptero.get(`/servers/${id}?include=user,node,allocations,variables`),

    create: (body) =>
        ptero.post(`/servers`, body),

    suspend: (id) =>
        ptero.post(`/servers/${id}/suspend`),

    unsuspend: (id) =>
        ptero.post(`/servers/${id}/unsuspend`),

    reinstall: (id) =>
        ptero.post(`/servers/${id}/reinstall`),

    delete: (id, force = false) =>
        ptero.delete(`/servers/${id}${force ? '/force' : ''}`),

    rename: (id, name) =>
        ptero.patch(`/servers/${id}/details`, {
            name
        }),

    updateBuild: (id, body) =>
        ptero.patch(`/servers/${id}/build`, body),

    updateStartup: (id, body) =>
        ptero.patch(`/servers/${id}/startup`, body),

    updateDetails: (id, body) =>
        ptero.patch(`/servers/${id}/details`, body)
},
  // Nodes
  nodes: {
    list:        ()     => ptero.get('/nodes?per_page=50&include=allocations,location,servers'),
    get:         (id)   => ptero.get(`/nodes/${id}?include=allocations,location,servers`),
    config:      (id)   => ptero.get(`/nodes/${id}/configuration`),
    allocations: (id, page = 1) => ptero.get(`/nodes/${id}/allocations?per_page=50&page=${page}`),
  },
  // Locations
  locations: {
    list: () => ptero.get('/locations?per_page=50&include=nodes'),
    get:  (id) => ptero.get(`/locations/${id}?include=nodes`),
  },
  // Nests & Eggs
  nests: {
    list:     ()          => ptero.get('/nests?per_page=50'),
    get:      (id)        => ptero.get(`/nests/${id}?include=eggs,servers`),
    listEggs: (nestId)    => ptero.get(`/nests/${nestId}/eggs?include=nest,config,script,variables`),
    getEgg:   (nestId, eggId) => ptero.get(`/nests/${nestId}/eggs/${eggId}?include=nest,config,script,variables`),
  },
  // Database hosts
  databases: {
    list: () => ptero.get('/database-hosts?per_page=50&include=databases'),
    get:  (id) => ptero.get(`/databases/${id}?include=databases`),
  },
};

function genPassword(len = 16) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()-_=+';
  return Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function mbToHuman(mb) {
  if (mb === 0) return '∞ (illimité)';
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} Go`;
  return `${mb} Mo`;
}

// ──────────────────────────────────────────────────────────────────────────────
//  §4  CLIENT DISCORD
// ──────────────────────────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction],
  allowedMentions: { parse: ['users', 'roles'] },
});

const spamMap      = new Map(); // userId → number[]
const cooldownMap  = new Map(); // userId → timestamp

const botStats = {
  ticketsOpened: 0, ticketsClosed: 0,
  commandsRun:   0, warnsIssued: 0,
  bansIssued:    0, kicksIssued: 0,
  startedAt:     Date.now(),
};

// ──────────────────────────────────────────────────────────────────────────────
//  §5  UTILITAIRES
// ──────────────────────────────────────────────────────────────────────────────

const sleep     = (ms) => new Promise((r) => setTimeout(r, ms));
const relT      = (ms) => `<t:${Math.floor(ms / 1000)}:R>`;
const absT      = (ms) => `<t:${Math.floor(ms / 1000)}:f>`;
const dateT     = (ms) => `<t:${Math.floor(ms / 1000)}:D>`;
const esc       = (s) => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
const slug      = (v) => String(v || 'user').replace(/[^a-z0-9-]/gi,'-').replace(/-+/g,'-').replace(/^-|-$/g,'').slice(0,30)||'user';
const clamp     = (n, min, max) => Math.min(max, Math.max(min, n));

const fmtDuration = (ms) => {
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d)  return `${d}j ${h%24}h ${m%60}min`;
  if (h)  return `${h}h ${m%60}min`;
  if (m)  return `${m}min ${s%60}s`;
  return `${s}s`;
};

const getCh  = (guild, id) => id ? guild.channels.fetch(id).catch(() => null) : null;
const getMbr = (guild, id) => guild.members.fetch(id).catch(() => null);

const reply = (i, payload) =>
  i.deferred || i.replied ? i.editReply(payload) : i.reply({ ...payload, ephemeral: true });

const isStaff = (member) => {
  if (!member) return false;
  if (member.permissions?.has(PermissionFlagsBits.Administrator)) return true;
  return cfg.staffRoleId ? member.roles?.cache?.has(cfg.staffRoleId) : false;
};

const requireStaff = async (i) => {
  if (isStaff(i.member)) return true;
  await reply(i, { content: '🚫 Cette commande est réservée au staff.' });
  return false;
};

const requirePtero = async (i) => {
  if (hasPtero()) return true;
  await reply(i, { content: '❌ Pterodactyl non configuré (`PTERO_URL` / `PTERO_API_KEY` manquants).' });
  return false;
};

// ──────────────────────────────────────────────────────────────────────────────
//  §6  COMMANDES SLASH
// ──────────────────────────────────────────────────────────────────────────────

const P = PermissionFlagsBits.Administrator;

const commands = [
  // — Général —
  new SlashCommandBuilder().setName('ping').setDescription('Latence WebSocket du bot'),
  new SlashCommandBuilder().setName('help').setDescription('Afficher toutes les commandes disponibles'),
  new SlashCommandBuilder().setName('stats').setDescription('Statistiques en temps réel du bot'),
  new SlashCommandBuilder().setName('site').setDescription('Lien officiel du site MasterHosting'),
  new SlashCommandBuilder().setName('offres').setDescription('Consulter les offres d\'hébergement'),
  new SlashCommandBuilder().setName('ticket').setDescription('Ouvrir un ticket de support'),
  new SlashCommandBuilder().setName('suggest').setDescription('Soumettre une suggestion')
    .addStringOption((o) => o.setName('texte').setDescription('Votre suggestion').setRequired(true).setMaxLength(1000)),
  new SlashCommandBuilder().setName('userinfo').setDescription('Informations détaillées d\'un membre')
    .addUserOption((o) => o.setName('membre').setDescription('Membre cible (vous par défaut)')),
  new SlashCommandBuilder().setName('serverinfo').setDescription('Informations sur le serveur Discord'),

  // — Modération —
  new SlashCommandBuilder().setName('ban').setDescription('Bannir définitivement un membre').setDefaultMemberPermissions(P)
    .addUserOption((o) => o.setName('membre').setDescription('Cible').setRequired(true))
    .addStringOption((o) => o.setName('raison').setDescription('Raison du ban').setMaxLength(512))
    .addIntegerOption((o) => o.setName('purge_jours').setDescription('Effacer les messages des N derniers jours (0-7)').setMinValue(0).setMaxValue(7)),
  new SlashCommandBuilder().setName('kick').setDescription('Expulser un membre').setDefaultMemberPermissions(P)
    .addUserOption((o) => o.setName('membre').setDescription('Cible').setRequired(true))
    .addStringOption((o) => o.setName('raison').setDescription('Raison').setMaxLength(512)),
  new SlashCommandBuilder().setName('mute').setDescription('Timeout un membre (Discord natif)').setDefaultMemberPermissions(P)
    .addUserOption((o) => o.setName('membre').setDescription('Cible').setRequired(true))
    .addIntegerOption((o) => o.setName('minutes').setDescription('Durée en minutes').setRequired(true).setMinValue(1).setMaxValue(40320))
    .addStringOption((o) => o.setName('raison').setDescription('Raison').setMaxLength(512)),
  new SlashCommandBuilder().setName('unmute').setDescription('Lever le timeout d\'un membre').setDefaultMemberPermissions(P)
    .addUserOption((o) => o.setName('membre').setDescription('Cible').setRequired(true)),
  new SlashCommandBuilder().setName('warn').setDescription('Avertir un membre').setDefaultMemberPermissions(P)
    .addUserOption((o) => o.setName('membre').setDescription('Cible').setRequired(true))
    .addStringOption((o) => o.setName('raison').setDescription('Raison').setRequired(true).setMaxLength(512)),
  new SlashCommandBuilder().setName('warns').setDescription('Voir les avertissements d\'un membre').setDefaultMemberPermissions(P)
    .addUserOption((o) => o.setName('membre').setDescription('Cible').setRequired(true)),
  new SlashCommandBuilder().setName('clearwarns').setDescription('Effacer tous les avertissements d\'un membre').setDefaultMemberPermissions(P)
    .addUserOption((o) => o.setName('membre').setDescription('Cible').setRequired(true)),
  new SlashCommandBuilder().setName('purge').setDescription('Supprimer N messages dans ce salon').setDefaultMemberPermissions(P)
    .addIntegerOption((o) => o.setName('nombre').setDescription('Nombre de messages (1–100)').setRequired(true).setMinValue(1).setMaxValue(100)),
  new SlashCommandBuilder().setName('slow').setDescription('Mode lent sur ce salon').setDefaultMemberPermissions(P)
    .addIntegerOption((o) => o.setName('secondes').setDescription('Délai en secondes (0 = désactiver)').setRequired(true).setMinValue(0).setMaxValue(21600)),
  new SlashCommandBuilder().setName('lock').setDescription('Verrouiller un salon').setDefaultMemberPermissions(P)
    .addChannelOption((o) => o.setName('salon').setDescription('Salon cible (actuel par défaut)')),
  new SlashCommandBuilder().setName('unlock').setDescription('Déverrouiller un salon').setDefaultMemberPermissions(P)
    .addChannelOption((o) => o.setName('salon').setDescription('Salon cible (actuel par défaut)')),

  // — Administration —
  new SlashCommandBuilder().setName('config').setDescription('Afficher la configuration du bot').setDefaultMemberPermissions(P),
  new SlashCommandBuilder().setName('verify').setDescription('Réinitialiser le panel de vérification').setDefaultMemberPermissions(P),
  new SlashCommandBuilder().setName('giveaway').setDescription('Lancer un giveaway').setDefaultMemberPermissions(P)
    .addStringOption((o) => o.setName('prix').setDescription('Prix à gagner').setRequired(true).setMaxLength(100))
    .addIntegerOption((o) => o.setName('minutes').setDescription('Durée en minutes').setRequired(true).setMinValue(1))
    .addIntegerOption((o) => o.setName('gagnants').setDescription('Nombre de gagnants (défaut : 1)').setMinValue(1).setMaxValue(20))
    .addStringOption((o) => o.setName('description').setDescription('Description optionnelle').setMaxLength(300)),
  new SlashCommandBuilder().setName('endgiveaway').setDescription('Forcer la fin d\'un giveaway').setDefaultMemberPermissions(P)
    .addStringOption((o) => o.setName('message_id').setDescription('ID du message du giveaway').setRequired(true)),
  new SlashCommandBuilder().setName('rerollgiveaway').setDescription('Re-tirer un gagnant pour un giveaway terminé').setDefaultMemberPermissions(P)
    .addStringOption((o) => o.setName('message_id').setDescription('ID du message du giveaway').setRequired(true)),
  new SlashCommandBuilder().setName('announce').setDescription('Publier une annonce officielle').setDefaultMemberPermissions(P),

  // — Compte Pterodactyl (tous membres) —
  new SlashCommandBuilder().setName('compte').setDescription('Afficher votre compte Pterodactyl lié'),

  // — Utilisateurs Pterodactyl (Staff) —
  new SlashCommandBuilder().setName('utilisateur').setDescription('Gestion des utilisateurs Pterodactyl').setDefaultMemberPermissions(P)
    .addSubcommand((s) => s.setName('creer').setDescription('Créer un utilisateur')
      .addStringOption((o) => o.setName('username').setDescription('Nom d\'utilisateur (unique)').setRequired(true))
      .addStringOption((o) => o.setName('email').setDescription('Adresse email').setRequired(true))
      .addStringOption((o) => o.setName('prenom').setDescription('Prénom'))
      .addStringOption((o) => o.setName('nom').setDescription('Nom de famille')))
    .addSubcommand((s) => s.setName('liste').setDescription('Lister les utilisateurs'))
    .addSubcommand((s) => s.setName('info').setDescription('Détails d\'un utilisateur')
      .addIntegerOption((o) => o.setName('id').setDescription('ID Pterodactyl').setRequired(true)))
    .addSubcommand((s) => s.setName('modifier').setDescription('Modifier email/nom d\'un utilisateur')
      .addIntegerOption((o) => o.setName('id').setDescription('ID Pterodactyl').setRequired(true))
      .addStringOption((o) => o.setName('email').setDescription('Nouvel email'))
      .addStringOption((o) => o.setName('username').setDescription('Nouveau username'))
      .addStringOption((o) => o.setName('password').setDescription('Nouveau mot de passe (laisser vide = auto)')))
    .addSubcommand((s) => s.setName('admin').setDescription('Modifier le rôle administrateur')
      .addIntegerOption((o) => o.setName('id').setDescription('ID Pterodactyl').setRequired(true))
      .addBooleanOption((o) => o.setName('activer').setDescription('Rendre admin ?').setRequired(true)))
    .addSubcommand((s) => s.setName('supprimer').setDescription('⚠️ Supprimer définitivement un utilisateur')
      .addIntegerOption((o) => o.setName('id').setDescription('ID Pterodactyl').setRequired(true)))
    .addSubcommand((s) => s.setName('lier').setDescription('Associer Discord ↔ Pterodactyl')
      .addUserOption((o) => o.setName('discord').setDescription('Membre Discord').setRequired(true))
      .addIntegerOption((o) => o.setName('ptero').setDescription('ID Pterodactyl').setRequired(true)))
    .addSubcommand((s) => s.setName('delier').setDescription('Supprimer l\'association Discord ↔ Pterodactyl')
      .addUserOption((o) => o.setName('discord').setDescription('Membre Discord').setRequired(true))),

  // — Serveurs Pterodactyl (Staff) —
  new SlashCommandBuilder().setName('serveur').setDescription('Gestion des serveurs Pterodactyl').setDefaultMemberPermissions(P)
    .addSubcommand((s) => s.setName('liste').setDescription('Lister les serveurs'))
    .addSubcommand((s) => s.setName('info').setDescription('Détails d\'un serveur')
      .addIntegerOption((o) => o.setName('id').setDescription('ID du serveur').setRequired(true)))
    .addSubcommand((s) => s.setName('suspendre').setDescription('Suspendre un serveur')
      .addIntegerOption((o) => o.setName('id').setDescription('ID du serveur').setRequired(true)))
    .addSubcommand((s) => s.setName('retablir').setDescription('Rétablir (unsuspend) un serveur')
      .addIntegerOption((o) => o.setName('id').setDescription('ID du serveur').setRequired(true)))
    .addSubcommand((s) => s.setName('reinstaller').setDescription('⚠️ Réinstaller un serveur')
      .addIntegerOption((o) => o.setName('id').setDescription('ID du serveur').setRequired(true)))
    .addSubcommand((s) => s.setName('renommer').setDescription('Renommer un serveur')
      .addIntegerOption((o) => o.setName('id').setDescription('ID du serveur').setRequired(true))
      .addStringOption((o) => o.setName('nom').setDescription('Nouveau nom').setRequired(true).setMaxLength(191)))
    .addSubcommand((s) => s.setName('ram').setDescription('Modifier la RAM allouée')
      .addIntegerOption((o) => o.setName('id').setDescription('ID du serveur').setRequired(true))
      .addIntegerOption((o) => o.setName('mb').setDescription('RAM en MB (0 = illimité)').setRequired(true).setMinValue(0)))
    .addSubcommand((s) => s.setName('cpu').setDescription('Modifier les % CPU alloués')
      .addIntegerOption((o) => o.setName('id').setDescription('ID du serveur').setRequired(true))
      .addIntegerOption((o) => o.setName('pourcent').setDescription('CPU en % (0 = illimité)').setRequired(true).setMinValue(0)))
    .addSubcommand((s) => s.setName('disque').setDescription('Modifier l\'espace disque alloué')
      .addIntegerOption((o) => o.setName('id').setDescription('ID du serveur').setRequired(true))
      .addIntegerOption((o) => o.setName('mb').setDescription('Disque en MB (0 = illimité)').setRequired(true).setMinValue(0)))
    .addSubcommand((s) => s.setName('supprimer').setDescription('⚠️ Supprimer définitivement un serveur')
      .addIntegerOption((o) => o.setName('id').setDescription('ID du serveur').setRequired(true))
      .addBooleanOption((o) => o.setName('force').setDescription('Forcer la suppression même si le serveur tourne'))),

  // — Nodes Pterodactyl (Staff) —
  new SlashCommandBuilder().setName('node').setDescription('Gestion des nodes Pterodactyl').setDefaultMemberPermissions(P)
    .addSubcommand((s) => s.setName('liste').setDescription('Lister tous les nodes'))
    .addSubcommand((s) => s.setName('info').setDescription('Détails complets d\'un node')
      .addIntegerOption((o) => o.setName('id').setDescription('ID du node').setRequired(true)))
    .addSubcommand((s) => s.setName('allocations').setDescription('Voir les allocations IP d\'un node')
      .addIntegerOption((o) => o.setName('id').setDescription('ID du node').setRequired(true))),

  // — Locations Pterodactyl (Staff) —
  new SlashCommandBuilder().setName('location').setDescription('Gestion des locations Pterodactyl').setDefaultMemberPermissions(P)
    .addSubcommand((s) => s.setName('liste').setDescription('Lister toutes les locations'))
    .addSubcommand((s) => s.setName('info').setDescription('Détails d\'une location')
      .addIntegerOption((o) => o.setName('id').setDescription('ID de la location').setRequired(true))),

  // — Nests & Eggs Pterodactyl (Staff) —
  new SlashCommandBuilder().setName('nest').setDescription('Gestion des Nests & Eggs Pterodactyl').setDefaultMemberPermissions(P)
    .addSubcommand((s) => s.setName('liste').setDescription('Lister tous les nests'))
    .addSubcommand((s) => s.setName('eggs').setDescription('Lister les eggs d\'un nest')
      .addIntegerOption((o) => o.setName('id').setDescription('ID du nest').setRequired(true))),

  // — Database Hosts Pterodactyl (Staff) —
  new SlashCommandBuilder().setName('dbhosts').setDescription('Lister les hôtes de bases de données Pterodactyl').setDefaultMemberPermissions(P),

].map((c) => c.toJSON());

// ──────────────────────────────────────────────────────────────────────────────
//  §7  RÈGLEMENT (18 articles)
// ──────────────────────────────────────────────────────────────────────────────

const RULES = [
  ['Respect',             'Le respect est obligatoire envers tous — membres, clients, partenaires et équipe.',          '⛔ Interdit',       'Insultes, menaces, harcèlement, provocations, discriminations et attaques personnelles.'],
  ['Comportement',        'Adoptez un comportement mature et responsable en toutes circonstances.',                     '✅ À respecter',    'Les conflits doivent être réglés calmement ou escaladés au staff.'],
  ['Spam',                'Il est interdit de spammer, flooder ou saturer les salons.',                                 '⛔ Interdit',       'Messages en rafale, emojis en masse, mentions inutiles, spam de commandes.'],
  ['Publicité',           'Toute publicité non autorisée est formellement interdite.',                                  '⛔ Interdit',       'Liens Discord externes, promotion d\'hébergeurs concurrents, démarchage en MP.'],
  ['Contenu',             'Les contenus dangereux, choquants ou illégaux sont bannis.',                                 '⛔ Interdit',       'NSFW, gore, malware, virus, contenus illégaux ou pédopornographiques.'],
  ['Comptes',             'Chaque utilisateur est responsable de l\'utilisation de son compte Discord.',                '⚠️ Important',      'Le partage de compte est déconseillé. Toute fraude engage votre responsabilité.'],
  ['Tickets',             'Ouvrez vos tickets avec clarté et politesse.',                                               '✅ À faire',        'Décrivez précisément votre problème. Un ticket par sujet maximum.'],
  ['Hébergement',         'Nos services ne peuvent être utilisés à des fins illégales ou malveillantes.',               '⛔ Interdit',       'Attaques réseau (DDoS), spam, hébergement de contenu illégal, escroqueries.'],
  ['Sécurité',            'Votre sécurité en ligne est primordiale.',                                                   '✅ À faire',        'Activez la 2FA, ne partagez jamais votre mot de passe, signalez toute anomalie.'],
  ['Staff',               'Les décisions du staff sont définitives et doivent être respectées.',                        '✅ À faire',        'En cas de désaccord, ouvrez un ticket. Restez respectueux en toutes circonstances.'],
  ['Pseudo & profil',     'Pseudo, avatar et statut doivent rester appropriés et neutres.',                             '⛔ Interdit',       'Insultes, NSFW, usurpation d\'identité, publicité dans le pseudo.'],
  ['Salons',              'Chaque salon est dédié à un usage précis.',                                                  '⚠️ Attention',      'Les messages hors-sujet seront supprimés sans préavis.'],
  ['Confidentialité',     'Les échanges dans les tickets sont strictement confidentiels.',                              '⛔ Interdit',       'Publier une conversation privée avec le staff sans accord explicite des deux parties.'],
  ['Signalement',         'Signalez tout bug, comportement suspect ou faille de sécurité.',                             '✅ À faire',        'Ouvrez immédiatement un ticket pour prévenir le staff.'],
  ['Sanctions',           'Les sanctions vont du rappel à l\'ordre au bannissement définitif.',                         '⚠️ Possible',       'Avertissement, mute, restriction d\'accès, suspension temporaire ou permanente.'],
  ['CGU & Légalité',      'En utilisant nos services, vous acceptez nos CGU et les lois en vigueur.',                   '⚠️ Important',      'Ce règlement, nos CGU et la législation applicable constituent un ensemble contractuel.'],
  ['Modifications',       'Ce règlement peut être modifié à tout moment.',                                              '📋 À savoir',       'Consultez régulièrement les annonces officielles pour rester informé des évolutions.'],
  ['Esprit communautaire','MasterHosting repose sur l\'entraide, le partage et la bienveillance.',                      '🤝 À encourager',   'Respect mutuel, aide aux nouveaux membres, bonne humeur et partage de connaissances.'],
];

const buildRulesEmbeds = () =>
  RULES.map(([title, desc, field, val], i) =>
    new EmbedBuilder()
      .setColor(i === 0 ? cfg.colors.gold : cfg.colors.warning)
      .setTitle(`${i === 0 ? '📜' : '📖'} Article ${i + 1} — ${title}`)
      .setDescription(desc)
      .addFields({ name: field, value: val })
      .setFooter({ text: 'Master Hosting · Règlement officiel' }),
  );

const sendRules = async (channel) => {
  const embeds = buildRulesEmbeds();
  for (let i = 0; i < embeds.length; i += 10)
    await channel.send({ embeds: embeds.slice(i, i + 10) });
};

// ──────────────────────────────────────────────────────────────────────────────
//  §8  EMBEDS FACTORY
// ──────────────────────────────────────────────────────────────────────────────

const E = {

  panel: () =>
    new EmbedBuilder()
      .setColor(cfg.colors.primary)
      .setTitle('🎫 Support — Master Hosting')
      .setDescription('> Ouvrez un ticket pour toute question relative à votre hébergement.\n> Notre équipe vous répond dans les plus brefs délais.')
      .addFields(
        { name: '⚡ Temps de réponse',  value: 'Moins de 30 minutes en moyenne.', inline: true },
        { name: '🛠️ Domaines couverts', value: 'Panel · DNS · SSL · Facturation · Technique', inline: true },
        { name: '📋 Avant d\'ouvrir',   value: 'Préparez : ID de service · captures d\'écran · description précise.', inline: false },
      )
      .setFooter({ text: `Master Hosting · Support · v${VERSION}` })
      .setTimestamp(),

  ticketIntro: (member, reason) =>
    new EmbedBuilder()
      .setColor(cfg.colors.success)
      .setTitle('🎫 Ticket créé avec succès')
      .setDescription(`Bonjour ${member} ! Un membre de l'équipe va vous répondre rapidement.\n\n**Décrivez votre problème en détail** pour une résolution optimale.`)
      .addFields(
        { name: '📌 Sujet',       value: reason || 'Non précisé', inline: true },
        { name: '👤 Utilisateur', value: `${member}`,             inline: true },
        { name: '🕐 Ouvert',      value: relT(Date.now()),         inline: true },
      )
      .setFooter({ text: 'Master Hosting · Support' })
      .setTimestamp(),

  ticketTaken: (staff, already = false) =>
    new EmbedBuilder()
      .setColor(already ? cfg.colors.warning : cfg.colors.success)
      .setTitle(already ? '⚠️ Ticket déjà attribué' : '✅ Ticket pris en charge')
      .setDescription(already ? 'Ce ticket est déjà en cours de traitement par un membre du staff.' : `Ticket attribué à ${staff}.`)
      .addFields(
        { name: '👤 Staff',   value: `${staff}`, inline: true },
        { name: '🕐 À',       value: relT(Date.now()), inline: true },
      )
      .setTimestamp(),

  ticketClosed: (closedBy, reason, transcriptUrl) => {
    const e = new EmbedBuilder()
      .setColor(cfg.colors.orange)
      .setTitle('🔒 Ticket fermé')
      .setDescription(`Votre ticket a été fermé par **${closedBy?.user?.tag ?? 'le staff'}**.`)
      .addFields(
        { name: '📝 Raison',   value: reason || 'Aucune' },
        { name: '🕐 Fermé le', value: absT(Date.now()) },
      )
      .setFooter({ text: 'Master Hosting · Pour toute nouvelle demande, ouvrez un nouveau ticket.' })
      .setTimestamp();
    if (transcriptUrl) e.addFields({ name: '📋 Transcript', value: `[Consulter la conversation](${transcriptUrl})` });
    return e;
  },

  closeRequest: (member, reason) =>
    new EmbedBuilder()
      .setColor(cfg.colors.warning)
      .setTitle('📩 Demande de fermeture')
      .setDescription(`**${member.user.tag}** demande la fermeture de ce ticket.`)
      .addFields({ name: '📝 Motif', value: reason || 'Aucun' })
      .setTimestamp(),

  verify: () =>
    new EmbedBuilder()
      .setColor(cfg.colors.success)
      .setTitle('✅ Vérification des membres')
      .setDescription('Lisez attentivement le règlement ci-dessus.\nCliquez ensuite sur **"Vérifier mon compte"** pour obtenir votre accès.')
      .addFields(
        { name: '🔐 Sécurité',      value: 'Cette vérification confirme que vous êtes un vrai membre du serveur.' },
        { name: '📌 Rôle attribué', value: cfg.verifyRoleId ? `<@&${cfg.verifyRoleId}>` : '`VERIFY_ROLE_ID` non configuré', inline: true },
        { name: '⚡ Instantané',    value: 'Le rôle est attribué immédiatement après validation.', inline: true },
      )
      .setFooter({ text: 'Master Hosting · Vérification' })
      .setTimestamp(),

  welcome: (member) =>
    new EmbedBuilder()
      .setColor(cfg.colors.success)
      .setTitle('👋 Bienvenue !')
      .setDescription(`Bienvenue ${member} sur **Master Hosting** !\n\nLisez le règlement et vérifiez votre compte pour accéder à toutes les fonctionnalités.`)
      .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
      .addFields(
        { name: '👥 Membre n°',   value: `**${member.guild.memberCount}**`, inline: true },
        { name: '🌐 Notre site', value: `[masterhosting.fr](${cfg.siteUrl})`, inline: true },
      )
      .setTimestamp(),

  leave: (member) =>
    new EmbedBuilder()
      .setColor(cfg.colors.danger)
      .setTitle('👋 Départ')
      .setDescription(`**${member.user.tag}** a quitté le serveur.`)
      .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
      .addFields({ name: '👥 Membres restants', value: String(member.guild.memberCount) })
      .setTimestamp(),

  config: (guild) =>
    new EmbedBuilder()
      .setColor(cfg.colors.primary)
      .setTitle('⚙️ Configuration — Master Hosting Bot')
      .setThumbnail(guild.iconURL())
      .addFields(
        { name: '🎫 Panel tickets',    value: cfg.ticketPanelChannelId  ? `<#${cfg.ticketPanelChannelId}>` : '`Non défini`', inline: true },
        { name: '📂 Catégorie',        value: cfg.ticketCategoryId      ? `<#${cfg.ticketCategoryId}>`     : '`Non défini`', inline: true },
        { name: '🔐 Vérification',     value: cfg.verifyChannelId       ? `<#${cfg.verifyChannelId}>`      : '`Non défini`', inline: true },
        { name: '📝 Logs modération',  value: cfg.modLogChannelId       ? `<#${cfg.modLogChannelId}>`      : '`Non défini`', inline: true },
        { name: '👋 Bienvenue',        value: cfg.welcomeChannelId      ? `<#${cfg.welcomeChannelId}>`     : '`Non défini`', inline: true },
        { name: '👋 Départ',           value: cfg.leaveChannelId        ? `<#${cfg.leaveChannelId}>`       : '`Non défini`', inline: true },
        { name: '💡 Suggestions',      value: cfg.suggestionChannelId   ? `<#${cfg.suggestionChannelId}>`  : '`Non défini`', inline: true },
        { name: '📢 Annonces',         value: cfg.announcementChannelId ? `<#${cfg.announcementChannelId}>`: '`Non défini`', inline: true },
        { name: '🛡️ Rôle staff',       value: cfg.staffRoleId  ? `<@&${cfg.staffRoleId}>`  : '`Non défini`', inline: true },
        { name: '✅ Rôle vérification', value: cfg.verifyRoleId ? `<@&${cfg.verifyRoleId}>` : '`Non défini`', inline: true },
        { name: '🦅 Pterodactyl',      value: hasPtero() ? `✅ \`${cfg.pteroUrl}\`` : '❌ Non configuré', inline: false },
        { name: '🔇 Anti-spam',        value: `${cfg.spamThreshold} messages / ${cfg.spamWindow}ms → timeout ${cfg.spamMuteMins}min`, inline: true },
        { name: '⚠️ Warns avant ban',  value: `${cfg.maxWarns}`, inline: true },
      )
      .setFooter({ text: `Master Hosting · Bot v${VERSION}` })
      .setTimestamp(),

  botStats: (guild) =>
    new EmbedBuilder()
      .setColor(cfg.colors.purple)
      .setTitle('📊 Statistiques du bot')
      .setThumbnail(client.user.displayAvatarURL())
      .addFields(
        { name: '🤖 Version',          value: VERSION,                                       inline: true },
        { name: '📡 WebSocket ping',   value: `${client.ws.ping}ms`,                         inline: true },
        { name: '⏱️ Uptime',           value: fmtDuration(Date.now() - botStats.startedAt),  inline: true },
        { name: '🎫 Tickets ouverts',  value: String(botStats.ticketsOpened),                inline: true },
        { name: '🔒 Tickets fermés',   value: String(botStats.ticketsClosed),                inline: true },
        { name: '💬 Commandes',        value: String(botStats.commandsRun),                  inline: true },
        { name: '⚠️ Warns émis',       value: String(botStats.warnsIssued),                  inline: true },
        { name: '🔨 Bans',             value: String(botStats.bansIssued),                   inline: true },
        { name: '👢 Kicks',            value: String(botStats.kicksIssued),                  inline: true },
        { name: '👥 Membres',          value: String(guild.memberCount),                     inline: true },
        { name: '💬 Salons',           value: String(guild.channels.cache.size),             inline: true },
        { name: '🎭 Rôles',            value: String(guild.roles.cache.size),                inline: true },
      )
      .setFooter({ text: 'Master Hosting' })
      .setTimestamp(),

  offers: () =>
    new EmbedBuilder()
      .setColor(cfg.colors.primary)
      .setTitle('💼 Nos offres d\'hébergement')
      .setDescription(`Retrouvez toutes nos offres sur **[${cfg.siteUrl}](${cfg.siteUrl})**\n\n*Paiement sécurisé · Support 7j/7 · Activation instantanée*`)
      .addFields(PLANS.map((p) => ({ name: p.name, value: `**${p.price}**\n${p.spec}`, inline: true })))
      .setFooter({ text: 'Master Hosting · Prix TTC' })
      .setTimestamp(),

  giveaway: (prize, winners, endsAt, desc) =>
    new EmbedBuilder()
      .setColor(cfg.colors.gold)
      .setTitle(`🎁 Giveaway — ${prize}`)
      .setDescription(desc || 'Participez en cliquant sur le bouton ci-dessous !')
      .addFields(
        { name: '🏆 Gagnants',    value: `**${winners}**`,  inline: true },
        { name: '⏰ Se termine',  value: relT(endsAt),       inline: true },
        { name: '📅 Date exacte', value: absT(endsAt),       inline: true },
      )
      .setFooter({ text: 'Master Hosting · Giveaway — Bonne chance !' })
      .setTimestamp(),

  suggestion: (member, text) =>
    new EmbedBuilder()
      .setColor(cfg.colors.purple)
      .setTitle('💡 Nouvelle suggestion')
      .setDescription(text)
      .setAuthor({ name: member.user.tag, iconURL: member.user.displayAvatarURL() })
      .addFields({ name: '📊 Votes', value: '✅ 0  ·  ❌ 0' })
      .setFooter({ text: `ID : ${member.id}` })
      .setTimestamp(),

  warnDm: (guild, reason, count) =>
    new EmbedBuilder()
      .setColor(cfg.colors.warning)
      .setTitle('⚠️ Avertissement reçu')
      .setDescription(`Vous avez reçu un avertissement sur **${guild.name}**.`)
      .addFields(
        { name: '📝 Raison',      value: reason },
        { name: '🔢 Avertissements', value: `${count} / ${cfg.maxWarns}` },
        ...(count >= cfg.maxWarns - 1 ? [{ name: '🚨 Dernier avertissement', value: 'Un avertissement supplémentaire entraînera un bannissement automatique !' }] : []),
      )
      .setTimestamp(),

  modLog: (action, target, mod, reason, extra = {}) => {
    const color = { BAN: cfg.colors.danger, KICK: cfg.colors.orange, MUTE: cfg.colors.warning, WARN: 0xFFA726, UNMUTE: cfg.colors.success }[action] ?? cfg.colors.primary;
    const icon  = { BAN: '🔨', KICK: '👢', MUTE: '🔇', WARN: '⚠️', UNMUTE: '🔊' }[action] ?? '🛡️';
    const e = new EmbedBuilder()
      .setColor(color)
      .setTitle(`${icon} ${action} — ${target.user.tag}`)
      .setThumbnail(target.user.displayAvatarURL())
      .addFields(
        { name: '👤 Membre',       value: `${target} (\`${target.id}\`)`, inline: true },
        { name: '🛡️ Modérateur',  value: `${mod}`,                        inline: true },
        { name: '📝 Raison',       value: reason || 'Aucune',              inline: false },
      )
      .setFooter({ text: `ID : ${target.id}` })
      .setTimestamp();
    if (extra.duration) e.addFields({ name: '⏱️ Durée', value: extra.duration, inline: true });
    if (extra.warns)    e.addFields({ name: '⚠️ Total warns', value: String(extra.warns), inline: true });
    return e;
  },

  spamAlert: (member) =>
    new EmbedBuilder()
      .setColor(cfg.colors.danger)
      .setTitle('🚫 Anti-spam')
      .setDescription(`${member} a été automatiquement mis en timeout pour spam.`)
      .addFields({ name: '⏱️ Durée', value: `${cfg.spamMuteMins} minute(s)` })
      .setTimestamp(),

  userinfo: (member) =>
    new EmbedBuilder()
      .setColor(cfg.colors.primary)
      .setTitle(`👤 ${member.user.tag}`)
      .setThumbnail(member.user.displayAvatarURL({ dynamic: true, size: 256 }))
      .addFields(
        { name: '🆔 ID',              value: member.id,                                                                              inline: true },
        { name: '📛 Surnom',          value: member.nickname ?? '_aucun_',                                                           inline: true },
        { name: '🤖 Bot',             value: member.user.bot ? 'Oui' : 'Non',                                                        inline: true },
        { name: '📅 Compte créé',     value: absT(member.user.createdTimestamp),                                                     inline: true },
        { name: '📅 A rejoint',       value: absT(member.joinedTimestamp),                                                           inline: true },
        { name: '⚠️ Avertissements', value: String(stmt.getWarns.all(member.id).length),                                             inline: true },
        { name: `🎭 Rôles (${member.roles.cache.size - 1})`,
          value: member.roles.cache.filter((r) => r.id !== member.guild.id).map((r) => `${r}`).slice(0, 15).join(' ') || 'Aucun' },
      )
      .setTimestamp(),

  serverinfo: (guild) =>
    new EmbedBuilder()
      .setColor(cfg.colors.primary)
      .setTitle(`🏠 ${guild.name}`)
      .setThumbnail(guild.iconURL({ dynamic: true, size: 256 }))
      .addFields(
        { name: '🆔 ID',            value: guild.id,                                    inline: true },
        { name: '👑 Propriétaire',  value: `<@${guild.ownerId}>`,                       inline: true },
        { name: '📅 Créé le',       value: absT(guild.createdTimestamp),                inline: true },
        { name: '👥 Membres',       value: String(guild.memberCount),                   inline: true },
        { name: '💬 Salons',        value: String(guild.channels.cache.size),           inline: true },
        { name: '🎭 Rôles',         value: String(guild.roles.cache.size),              inline: true },
        { name: '😀 Emojis',        value: String(guild.emojis.cache.size),             inline: true },
        { name: '🔒 Vérification',  value: guild.verificationLevel.toString(),          inline: true },
        { name: '🚀 Boosts',        value: String(guild.premiumSubscriptionCount ?? 0), inline: true },
      )
      .setTimestamp(),

  pteroAccount: (user, account, pteroUser) =>
    new EmbedBuilder()
      .setColor(cfg.colors.success)
      .setTitle('🦅 Mon compte Pterodactyl')
      .addFields(
        { name: '👤 Discord',         value: `<@${user.id}>`,                                                          inline: true },
        { name: '🔑 Username',        value: account.username,                                                          inline: true },
        { name: '🆔 ID Pterodactyl', value: String(account.ptero_id),                                                  inline: true },
        { name: '📧 Email',           value: pteroUser?.email ?? '_inconnu_',                                           inline: true },
        { name: '🎭 Rôle',           value: pteroUser?.root_admin ? '👑 Administrateur' : '👤 Client',                  inline: true },
        { name: '📅 Lié le',         value: dateT(new Date(account.created_at).getTime()),                              inline: true },
      )
      .setTimestamp(),

  help: (staff) => {
    const e = new EmbedBuilder()
      .setColor(cfg.colors.primary)
      .setTitle('📖 Aide — Master Hosting Bot')
      .addFields({
        name: '🌐 Général',
        value: '`/ping` `/help` `/stats` `/site` `/offres`\n`/ticket` `/suggest` `/userinfo` `/serverinfo`\n`/compte`',
      });
    if (staff) {
      e.addFields(
        { name: '🛡️ Modération',       value: '`/ban` `/kick` `/mute` `/unmute`\n`/warn` `/warns` `/clearwarns`\n`/purge` `/slow` `/lock` `/unlock`' },
        { name: '⚙️ Administration',   value: '`/config` `/verify` `/announce`\n`/giveaway` `/endgiveaway` `/rerollgiveaway`' },
        { name: '🦅 Pterodactyl — Utilisateurs', value: '`/utilisateur creer|liste|info|modifier|admin|supprimer|lier|delier`' },
        { name: '🦅 Pterodactyl — Serveurs',     value: '`/serveur liste|info|suspendre|retablir|reinstaller|renommer|ram|cpu|disque|supprimer`' },
        { name: '🦅 Pterodactyl — Infrastructure', value: '`/node liste|info|allocations`\n`/location liste|info`\n`/nest liste|eggs`\n`/dbhosts`' },
      );
    }
    return e.setFooter({ text: `Master Hosting · Bot v${VERSION}` }).setTimestamp();
  },
};

// ──────────────────────────────────────────────────────────────────────────────
//  §9  COMPOSANTS
// ──────────────────────────────────────────────────────────────────────────────

const C = {
  panelRow: () =>
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('btn:open-ticket').setLabel('Ouvrir un ticket').setEmoji('🎫').setStyle(ButtonStyle.Primary),
    ),

  verifyRow: () =>
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('btn:verify').setLabel('Vérifier mon compte').setEmoji('✅').setStyle(ButtonStyle.Success),
    ),

  ticketRows: () => [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('btn:take-ticket').setLabel('Prendre en charge').setEmoji('🤝').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('btn:add-member').setLabel('Ajouter membre').setEmoji('➕').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('btn:transcript').setLabel('Transcript').setEmoji('📋').setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('btn:close-ticket').setLabel('Fermer le ticket').setEmoji('🔒').setStyle(ButtonStyle.Danger),
    ),
  ],

  closeDecisionRow: () =>
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('btn:accept-close').setLabel('Confirmer la fermeture').setEmoji('✅').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('btn:refuse-close').setLabel('Refuser').setEmoji('❌').setStyle(ButtonStyle.Danger),
    ),

  giveawayRow: () =>
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('btn:join-giveaway').setLabel('Participer').setEmoji('🎉').setStyle(ButtonStyle.Primary),
    ),

  linkRow: (label, url) =>
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel(label).setStyle(ButtonStyle.Link).setURL(url),
    ),

  addMemberMenu: (guild, channel, staffId) => {
    const opts = [];
    for (const [id, m] of guild.members.cache) {
      if (m.id === staffId || m.user.bot) continue;
      if (channel.permissionOverwrites.cache.some((o) => o.id === id && o.allow.has(PermissionFlagsBits.ViewChannel))) continue;
      opts.push(new StringSelectMenuOptionBuilder().setLabel(m.user.tag.slice(0, 100)).setValue(m.id));
      if (opts.length >= 25) break;
    }
    if (!opts.length) return null;
    return new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('sel:add-member')
        .setPlaceholder('Choisir un membre à ajouter…')
        .addOptions(opts),
    );
  },

  modal: (id, title, inputId, label, placeholder, long = true) =>
    new ModalBuilder().setCustomId(id).setTitle(title)
      .addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId(inputId)
          .setLabel(label)
          .setStyle(long ? TextInputStyle.Paragraph : TextInputStyle.Short)
          .setPlaceholder(placeholder)
          .setRequired(false)
          .setMaxLength(long ? 1000 : 150),
      )),

  modals: {
    openTicket:   () => C.modal('modal:open-ticket',   'Ouvrir un ticket',        'reason',          'Sujet / Raison (facultatif)',        'Décrivez votre problème…'),
    closeTicket:  () => C.modal('modal:close-ticket',  'Fermer le ticket',        'close-reason',    'Raison de fermeture (facultatif)',   'Problème résolu, sans réponse…'),
    closeRequest: () => C.modal('modal:close-request', 'Demander la fermeture',   'request-reason',  'Pourquoi fermer ce ticket ?',        'Mon problème est résolu.'),
    announce:     () => C.modal('modal:announce',      'Annonce officielle',      'announce-text',   'Contenu de l\'annonce',              'Annonce importante…'),
  },
};

// ──────────────────────────────────────────────────────────────────────────────
//  §10  TRANSCRIPT HTML
// ──────────────────────────────────────────────────────────────────────────────

const buildTranscript = async (channel) => {
  const msgs = (await channel.messages.fetch({ limit: 100 }))
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp);

  const renderAtt = async (att) => {
    const isImg = /\.(png|jpe?g|gif|webp|svg)$/i.test(att.url);
    if (!isImg) return `<div class="att file"><a href="${att.url}" target="_blank">📎 ${esc(att.name)}</a></div>`;
    try {
      const r    = await fetch(att.url);
      const buf  = Buffer.from(await r.arrayBuffer());
      const mime = r.headers.get('content-type') || 'image/png';
      return `<div class="att img"><img src="data:${mime};base64,${buf.toString('base64')}" alt="${esc(att.name)}"></div>`;
    } catch {
      return `<div class="att file"><a href="${att.url}" target="_blank">📎 ${esc(att.name)}</a></div>`;
    }
  };

  const rows = await Promise.all(msgs.map(async (m) => {
    const text  = m.content?.trim() ? esc(m.content) : '<em class="nc">aucun texte</em>';
    const ts    = new Date(m.createdTimestamp).toLocaleString('fr-FR');
    const tag   = esc(m.author.tag);
    const init  = tag.slice(0, 2).toUpperCase();
    const atts  = (await Promise.all(m.attachments.map(renderAtt))).join('');
    const embs  = m.embeds.length ? `<span class="emb">📎 ${m.embeds.length} embed(s)</span>` : '';
    return `
<div class="msg${m.author.bot ? ' bot' : ''}">
  <div class="av">${init}</div>
  <div class="bbl">
    <div class="meta">
      <span class="auth">${tag}</span>
      ${m.author.bot ? '<span class="badge">BOT</span>' : ''}
      <span class="ts">${ts}</span>
    </div>
    <div class="txt">${text}</div>
    ${atts}${embs}
  </div>
</div>`;
  }));

  return `<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8">
<title>Transcript · #${esc(channel.name)}</title>
<style>
:root{--bg:#0d1017;--sf:#13161e;--ca:#1a1d26;--bo:rgba(255,255,255,.08);--tx:#f3f4f6;--mt:#8a93a2;--ac:#5865f2;--gr:#00b894}
*{box-sizing:border-box;margin:0;padding:0}
body{font:15px/1.6 Inter,system-ui,sans-serif;background:var(--bg);color:var(--tx);padding:24px 16px}
.wrap{max-width:860px;margin:auto}
header{background:linear-gradient(135deg,#1a2540,#1e2d52);border:1px solid var(--bo);border-radius:14px;padding:18px 22px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:18px}
.brand{display:flex;align-items:center;gap:12px}
.logo{width:46px;height:46px;border-radius:10px;background:linear-gradient(135deg,var(--ac),#7a8fff);display:grid;place-items:center;font-weight:900;color:#fff;font-size:.85rem}
h1{font-size:1.15rem;font-weight:800}h1 small{display:block;font-size:.78rem;color:#9baac4;font-weight:400;margin-top:2px}
.meta-hd{text-align:right;font-size:.76rem;color:var(--mt)}
.bdg{display:inline-block;padding:3px 9px;border-radius:999px;background:rgba(88,101,242,.15);border:1px solid rgba(88,101,242,.3);color:#7a8fff;font-weight:700;font-size:.7rem;margin-bottom:6px}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:10px;margin-bottom:18px}
.card{background:var(--ca);border:1px solid var(--bo);border-radius:10px;padding:12px}
.cl{font-size:.68rem;color:var(--mt);text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px}
.cv{font-size:1rem;font-weight:700}
.msgs{background:var(--sf);border:1px solid var(--bo);border-radius:14px;overflow:hidden}
.msg{display:grid;grid-template-columns:42px 1fr;gap:12px;padding:12px 16px;border-bottom:1px solid rgba(255,255,255,.04)}
.msg:last-child{border-bottom:0}.msg:hover{background:rgba(255,255,255,.02)}.msg.bot .av{background:linear-gradient(135deg,var(--ac),#7289da)}
.av{width:42px;height:42px;border-radius:50%;background:linear-gradient(135deg,#7c5cff,#4890ff);display:grid;place-items:center;font-weight:800;font-size:.8rem;align-self:flex-start;margin-top:2px;flex-shrink:0}
.meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:5px}
.auth{font-weight:700;color:#a9c2ff;font-size:.86rem}.badge{background:var(--ac);color:#fff;font-size:.6rem;font-weight:800;padding:2px 5px;border-radius:4px}.ts{font-size:.72rem;color:var(--mt)}
.txt{white-space:pre-wrap;word-break:break-word;font-size:.88rem;line-height:1.7}.nc{color:var(--mt);font-style:italic}
.att{margin-top:8px}.att.img img{max-width:min(100%,340px);max-height:240px;border-radius:8px;border:1px solid var(--bo);display:block;object-fit:contain}
.att.file{padding:7px 12px;background:rgba(255,255,255,.04);border:1px solid var(--bo);border-radius:8px;font-size:.83rem}
.att a{color:#7a8fff}.emb{font-size:.74rem;color:var(--mt);margin-top:4px}
</style></head>
<body><div class="wrap">
<header>
  <div class="brand">
    <div class="logo">MH</div>
    <h1>Master Hosting<small>Transcript — #${esc(channel.name)}</small></h1>
  </div>
  <div class="meta-hd"><div class="bdg">TRANSCRIPT</div><div>Généré le ${new Date().toLocaleString('fr-FR')}</div></div>
</header>
<div class="cards">
  <div class="card"><div class="cl">Messages</div><div class="cv">${msgs.size}</div></div>
  <div class="card"><div class="cl">Salon</div><div class="cv">#${esc(channel.name)}</div></div>
  <div class="card"><div class="cl">Date</div><div class="cv">${new Date().toLocaleDateString('fr-FR')}</div></div>
</div>
<div class="msgs">${rows.join('') || '<div style="padding:30px;text-align:center;color:var(--mt)">Aucun message.</div>'}</div>
</div></body></html>`;
};

// ──────────────────────────────────────────────────────────────────────────────
//  §11  HELPERS TICKETS
// ──────────────────────────────────────────────────────────────────────────────

const createTicketChannel = async (guild, member, reason) => {
  const perms = [
    { id: guild.roles.everyone,   deny:  [PermissionFlagsBits.ViewChannel] },
    { id: member.id,              allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] },
  ];
  if (cfg.staffRoleId) perms.push({
    id: cfg.staffRoleId,
    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.ManageMessages],
  });

  const channel = await guild.channels.create({
    name:   `ticket-${slug(member.user.username)}`,
    type:   ChannelType.GuildText,
    parent: cfg.ticketCategoryId ?? undefined,
    permissionOverwrites: perms,
  });

  stmt.createTicket.run(channel.id, member.id);

  const ping = cfg.staffRoleId ? `<@${member.id}> <@&${cfg.staffRoleId}>` : `<@${member.id}>`;
  await channel.send({ content: ping, embeds: [E.ticketIntro(member, reason)], components: C.ticketRows() });

  botStats.ticketsOpened++;
  return channel;
};

const ensureTicket = async (guild, member, reason) => {
  const last = cooldownMap.get(member.id);
  if (last && Date.now() - last < 30_000)
    return { error: `Veuillez attendre ${Math.ceil((30_000 - (Date.now() - last)) / 1000)}s avant d'ouvrir un nouveau ticket.` };

  const row = stmt.findTicket.get(member.id);
  if (row) {
    const existing = guild.channels.cache.get(row.channel_id) ?? await guild.channels.fetch(row.channel_id).catch(() => null);
    if (existing) return { created: false, channel: existing };
    // Orphan — cleanup
    stmt.deleteTicket.run(row.channel_id);
  }

  cooldownMap.set(member.id, Date.now());
  const channel = await createTicketChannel(guild, member, reason);
  return { created: true, channel };
};

const sendTranscript = async (guild, channel) => {
  if (!cfg.modLogChannelId) return null;
  const logCh = await getCh(guild, cfg.modLogChannelId);
  if (!logCh?.isTextBased()) return null;
  const html = await buildTranscript(channel);
  const file = { attachment: Buffer.from(html, 'utf8'), name: `transcript-${channel.name}-${Date.now()}.html` };
  const msg  = await logCh.send({ content: `📋 Transcript — ${channel.name}`, files: [file] });
  return `https://discord.com/channels/${guild.id}/${logCh.id}/${msg.id}`;
};

const closeTicket = async ({ guild, channel, closedBy, reason }) => {
  const row = stmt.getTicket.get(channel.id);
  const url = await sendTranscript(guild, channel);

  if (row?.owner_id) {
    const owner = await getMbr(guild, row.owner_id);
    if (owner) {
      const comps = url ? [C.linkRow('Voir le transcript', url)] : [];
      await owner.user.send({ embeds: [E.ticketClosed(closedBy, reason, url)], components: comps }).catch(() => null);
    }
  }

  stmt.deleteTicket.run(channel.id);
  log('TICKET_CLOSE', closedBy?.user?.tag ?? 'system', `channel:${channel.name} reason:${reason}`);
  botStats.ticketsClosed++;
  await channel.delete().catch(() => null);
};

// ──────────────────────────────────────────────────────────────────────────────
//  §12  ANTI-SPAM
// ──────────────────────────────────────────────────────────────────────────────

const handleAntiSpam = async (message) => {
  if (message.author.bot || !message.guild || isStaff(message.member)) return;
  const now        = Date.now();
  const uid        = message.author.id;
  const timestamps = (spamMap.get(uid) ?? []).filter((t) => now - t < cfg.spamWindow);
  timestamps.push(now);
  spamMap.set(uid, timestamps);
  if (timestamps.length < cfg.spamThreshold) return;
  spamMap.delete(uid);

  try {
    await message.member.timeout(cfg.spamMuteMins * 60_000, 'Anti-spam automatique');
    log('ANTI_SPAM', message.author.tag, `duration:${cfg.spamMuteMins}min`);
    const logCh = await getCh(message.guild, cfg.modLogChannelId);
    await logCh?.send({ embeds: [E.spamAlert(message.member)] }).catch(() => null);
  } catch { /* permission insuffisante */ }
};

// ──────────────────────────────────────────────────────────────────────────────
//  §13  GIVEAWAYS
// ──────────────────────────────────────────────────────────────────────────────

const drawGiveaway = async (guild, messageId, reroll = false) => {
  const ga = stmt.getGiveaway.get(messageId);
  if (!ga || (ga.ended && !reroll)) return;

  if (!reroll) stmt.endGiveaway.run(messageId);

  const channel = await getCh(guild, ga.channel_id);
  if (!channel) return;

  let msg;
  try { msg = await channel.messages.fetch(messageId); } catch { return; }

  const entries = stmt.getEntries.all(messageId);
  if (!entries.length) {
    await msg.reply('🎁 Aucun participant — personne ne gagne ce giveaway.');
    return;
  }

  const shuffled = [...entries].sort(() => Math.random() - 0.5);
  const winners  = shuffled.slice(0, Math.min(ga.winner_count, shuffled.length)).map((e) => `<@${e.user_id}>`).join(', ');

  const embed = new EmbedBuilder()
    .setColor(cfg.colors.gold)
    .setTitle(reroll ? '🔄 Re-tirage !' : '🎉 Giveaway terminé !')
    .setDescription(`**Prix :** ${ga.prize}\n**Gagnant(s) :** ${winners}`)
    .addFields({ name: '👥 Participants', value: String(entries.length), inline: true })
    .setTimestamp();

  await msg.reply({ content: `🎊 Félicitations ${winners} !`, embeds: [embed] });
};

const checkGiveaways = async () => {
  const expired = stmt.getExpired.all(Date.now());
  for (const ga of expired) {
    const guild = client.guilds.cache.get(ga.guild_id);
    if (guild) await drawGiveaway(guild, ga.message_id).catch(console.error);
  }
};

// ──────────────────────────────────────────────────────────────────────────────
//  §14  LOGS MODÉRATION
// ──────────────────────────────────────────────────────────────────────────────

const logMod = async (guild, target, data) => {
  const ch = await getCh(guild, cfg.modLogChannelId);
  if (!ch?.isTextBased()) return;
  await ch.send({ embeds: [E.modLog(data.action, target, data.mod, data.reason, data)] }).catch(() => null);
};

// ──────────────────────────────────────────────────────────────────────────────
//  §15  HANDLER — SLASH COMMANDS
// ──────────────────────────────────────────────────────────────────────────────

const handleSlash = async (interaction) => {
  const { commandName: cmd, options, user, guild, member, channel } = interaction;
  botStats.commandsRun++;

  // ────────────────────────── GÉNÉRAL ──────────────────────────────────────

  if (cmd === 'ping') {
    const ws = client.ws.ping;
    return interaction.reply({ content: `🏓 **Pong !** — WebSocket : \`${ws}ms\``, ephemeral: true });
  }

  if (cmd === 'help') return interaction.reply({ embeds: [E.help(isStaff(member))], ephemeral: true });

  if (cmd === 'stats') return interaction.reply({ embeds: [E.botStats(guild)], ephemeral: true });

  if (cmd === 'site') return interaction.reply({
    content: `🌐 **[Master Hosting](${cfg.siteUrl})**`,
    components: [C.linkRow('Visiter le site', cfg.siteUrl)],
    ephemeral: true,
  });

  if (cmd === 'offres') return interaction.reply({ embeds: [E.offers()], ephemeral: true });

  if (cmd === 'ticket') return interaction.showModal(C.modals.openTicket());

  if (cmd === 'suggest') {
    const text = options.getString('texte');
    const ch   = await getCh(guild, cfg.suggestionChannelId);
    if (!ch) return reply(interaction, { content: '❌ Salon de suggestions non configuré (`SUGGESTION_CHANNEL_ID`).' });
    const msg = await ch.send({ embeds: [E.suggestion(member, text)] });
    await msg.react('✅').catch(() => null);
    await msg.react('❌').catch(() => null);
    return reply(interaction, { content: '✅ Suggestion envoyée avec succès !' });
  }

  if (cmd === 'userinfo') {
    await interaction.deferReply({ ephemeral: true });
    const target = await getMbr(guild, options.getUser('membre')?.id ?? user.id);
    if (!target) return interaction.editReply('❌ Membre introuvable.');
    return interaction.editReply({ embeds: [E.userinfo(target)] });
  }

  if (cmd === 'serverinfo') return interaction.reply({ embeds: [E.serverinfo(guild)] });

  // ────────────────────────── MODÉRATION ───────────────────────────────────

  if (cmd === 'ban') {
    if (!await requireStaff(interaction)) return;
    await interaction.deferReply({ ephemeral: true });
    const target = options.getUser('membre');
    const reason = options.getString('raison') || 'Non précisée';
    const days   = options.getInteger('purge_jours') ?? 0;
    const tm = await getMbr(guild, target.id);
    if (!tm) return interaction.editReply('❌ Membre introuvable.');
    try {
      await tm.ban({ reason, deleteMessageSeconds: days * 86400 });
      botStats.bansIssued++;
      await logMod(guild, tm, { action: 'BAN', mod: member, reason });
      log('BAN', user.tag, `target:${target.tag}`);
      return interaction.editReply(`✅ **${target.tag}** a été banni.`);
    } catch { return interaction.editReply('❌ Impossible de bannir ce membre (permissions insuffisantes).'); }
  }

  if (cmd === 'kick') {
    if (!await requireStaff(interaction)) return;
    await interaction.deferReply({ ephemeral: true });
    const target = options.getUser('membre');
    const reason = options.getString('raison') || 'Non précisée';
    const tm = await getMbr(guild, target.id);
    if (!tm) return interaction.editReply('❌ Membre introuvable.');
    try {
      await tm.kick(reason);
      botStats.kicksIssued++;
      await logMod(guild, tm, { action: 'KICK', mod: member, reason });
      log('KICK', user.tag, `target:${target.tag}`);
      return interaction.editReply(`✅ **${target.tag}** a été expulsé.`);
    } catch { return interaction.editReply('❌ Impossible d\'expulser ce membre.'); }
  }

  if (cmd === 'mute') {
    if (!await requireStaff(interaction)) return;
    await interaction.deferReply({ ephemeral: true });
    const target  = options.getUser('membre');
    const minutes = options.getInteger('minutes');
    const reason  = options.getString('raison') || 'Non précisée';
    const tm = await getMbr(guild, target.id);
    if (!tm) return interaction.editReply('❌ Membre introuvable.');
    try {
      await tm.timeout(minutes * 60_000, reason);
      await logMod(guild, tm, { action: 'MUTE', mod: member, reason, duration: `${minutes} min` });
      log('MUTE', user.tag, `target:${target.tag} minutes:${minutes}`);
      return interaction.editReply(`✅ **${target.tag}** en timeout pour **${minutes} minute(s)**.`);
    } catch { return interaction.editReply('❌ Impossible de muter ce membre.'); }
  }

  if (cmd === 'unmute') {
    if (!await requireStaff(interaction)) return;
    await interaction.deferReply({ ephemeral: true });
    const target = options.getUser('membre');
    const tm = await getMbr(guild, target.id);
    if (!tm) return interaction.editReply('❌ Membre introuvable.');
    try {
      await tm.timeout(null);
      await logMod(guild, tm, { action: 'UNMUTE', mod: member, reason: 'Timeout retiré manuellement' });
      return interaction.editReply(`✅ Timeout de **${target.tag}** retiré.`);
    } catch { return interaction.editReply('❌ Impossible de retirer le timeout.'); }
  }

  if (cmd === 'warn') {
    if (!await requireStaff(interaction)) return;
    await interaction.deferReply({ ephemeral: true });
    const target = options.getUser('membre');
    const reason = options.getString('raison');
    const tm = await getMbr(guild, target.id);
    if (!tm) return interaction.editReply('❌ Membre introuvable.');

    stmt.addWarn.run(target.id, guild.id, reason, user.tag);
    const count = stmt.getWarns.all(target.id).length;
    botStats.warnsIssued++;

    await target.send({ embeds: [E.warnDm(guild, reason, count)] }).catch(() => null);
    await logMod(guild, tm, { action: 'WARN', mod: member, reason, warns: count });
    log('WARN', user.tag, `target:${target.tag} count:${count}`);

    if (count >= cfg.maxWarns) {
      await tm.ban({ reason: `${cfg.maxWarns} avertissements atteints.` }).catch(() => null);
      botStats.bansIssued++;
      return interaction.editReply(`⛔ **${target.tag}** a atteint ${cfg.maxWarns} warns → **banni automatiquement**.`);
    }

    return interaction.editReply(`⚠️ Avertissement envoyé à **${target.tag}**. (${count}/${cfg.maxWarns})`);
  }

  if (cmd === 'warns') {
    if (!await requireStaff(interaction)) return;
    await interaction.deferReply({ ephemeral: true });
    const target = options.getUser('membre');
    const list   = stmt.getWarns.all(target.id);
    if (!list.length) return interaction.editReply(`✅ **${target.tag}** n'a aucun avertissement.`);
    const embed = new EmbedBuilder()
      .setColor(cfg.colors.warning)
      .setTitle(`⚠️ Avertissements — ${target.tag}`)
      .setDescription(list.map((w, i) =>
        `**${i + 1}.** ${w.reason}\n*Par ${w.mod_tag} · <t:${Math.floor(new Date(w.created_at).getTime() / 1000)}:D>*`
      ).join('\n\n').slice(0, 4000))
      .setFooter({ text: `${list.length} / ${cfg.maxWarns}` })
      .setTimestamp();
    return interaction.editReply({ embeds: [embed] });
  }

  if (cmd === 'clearwarns') {
    if (!await requireStaff(interaction)) return;
    const target = options.getUser('membre');
    stmt.clearWarns.run(target.id);
    log('CLEARWARNS', user.tag, `target:${target.tag}`);
    return reply(interaction, { content: `✅ Avertissements de **${target.tag}** effacés.` });
  }

  if (cmd === 'purge') {
    if (!await requireStaff(interaction)) return;
    await interaction.deferReply({ ephemeral: true });
    const n = options.getInteger('nombre');
    const deleted = await channel.bulkDelete(n, true).catch(() => null);
    return interaction.editReply(`✅ ${deleted?.size ?? 0} message(s) supprimé(s).`);
  }

  if (cmd === 'slow') {
    if (!await requireStaff(interaction)) return;
    const s = options.getInteger('secondes');
    await channel.setRateLimitPerUser(s);
    return reply(interaction, { content: s === 0 ? '✅ Mode lent désactivé.' : `⏱️ Mode lent : **${s}s** par message.` });
  }

  if (cmd === 'lock') {
    if (!await requireStaff(interaction)) return;
    const ch = options.getChannel('salon') || channel;
    await ch.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false });
    return reply(interaction, { content: `🔒 ${ch} verrouillé.` });
  }

  if (cmd === 'unlock') {
    if (!await requireStaff(interaction)) return;
    const ch = options.getChannel('salon') || channel;
    await ch.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: null });
    return reply(interaction, { content: `🔓 ${ch} déverrouillé.` });
  }

  // ────────────────────────── ADMINISTRATION ────────────────────────────────

  if (cmd === 'config') {
    if (!await requireStaff(interaction)) return;
    return interaction.reply({ embeds: [E.config(guild)], ephemeral: true });
  }

  if (cmd === 'verify') {
    if (!await requireStaff(interaction)) return;
    await interaction.deferReply({ ephemeral: true });
    await initVerifyChannel(guild);
    return interaction.editReply('✅ Panel de vérification réinitialisé.');
  }

  if (cmd === 'giveaway') {
    if (!await requireStaff(interaction)) return;
    const prize   = options.getString('prix');
    const minutes = options.getInteger('minutes');
    const winners = options.getInteger('gagnants') ?? 1;
    const desc    = options.getString('description');
    const endsAt  = Date.now() + minutes * 60_000;

    const msg = await channel.send({ embeds: [E.giveaway(prize, winners, endsAt, desc)], components: [C.giveawayRow()] });
    stmt.createGiveaway.run(msg.id, channel.id, guild.id, prize, winners, endsAt);
    log('GIVEAWAY_CREATE', user.tag, `prize:${prize} mins:${minutes} winners:${winners}`);
    return reply(interaction, { content: '🎁 Giveaway lancé !' });
  }

  if (cmd === 'endgiveaway') {
    if (!await requireStaff(interaction)) return;
    await interaction.deferReply({ ephemeral: true });
    await drawGiveaway(guild, options.getString('message_id'));
    return interaction.editReply('✅ Giveaway terminé.');
  }

  if (cmd === 'rerollgiveaway') {
    if (!await requireStaff(interaction)) return;
    await interaction.deferReply({ ephemeral: true });
    await drawGiveaway(guild, options.getString('message_id'), true);
    return interaction.editReply('🔄 Re-tirage effectué.');
  }

  if (cmd === 'announce') {
    if (!await requireStaff(interaction)) return;
    return interaction.showModal(C.modals.announce());
  }

  // ────────────────────────── COMPTE PTERODACTYL ───────────────────────────

  if (cmd === 'compte') {
    await interaction.deferReply({ ephemeral: true });
    const account = stmt.getAccount.get(user.id);
    if (!account) return interaction.editReply('❌ Aucun compte Pterodactyl associé à votre compte Discord.');
    let pteroUser = null;
    if (hasPtero()) {
      try { pteroUser = (await api.users.get(account.ptero_id)).data.attributes; } catch { /* ignore */ }
    }
    return interaction.editReply({ embeds: [E.pteroAccount(user, account, pteroUser)] });
  }

  // ────────────────────────── PTERODACTYL — UTILISATEURS ───────────────────

  if (cmd === 'utilisateur') {
    if (!await requireStaff(interaction)) return;
    if (!await requirePtero(interaction)) return;
    await interaction.deferReply({ ephemeral: true });
    const sub = options.getSubcommand();

    if (sub === 'creer') {
      const username  = options.getString('username');
      const email     = options.getString('email');
      const firstName = options.getString('prenom') || username;
      const lastName  = options.getString('nom')    || 'User';
      const password  = genPassword(16);
      try {
        const res = (await api.users.create({ username, email, first_name: firstName, last_name: lastName, password })).data.attributes;
        log('PTERO_USER_CREATE', user.tag, `id:${res.id} username:${username}`);
        const embed = new EmbedBuilder()
          .setColor(cfg.colors.success)
          .setTitle('✅ Utilisateur créé')
          .addFields(
            { name: '🆔 ID',          value: String(res.id), inline: true },
            { name: '👤 Username',    value: res.username,   inline: true },
            { name: '📧 Email',       value: res.email,      inline: true },
            { name: '🔑 Mot de passe', value: `\`${password}\`` },
          )
          .setFooter({ text: 'Transmettez le mot de passe de manière sécurisée — il ne sera plus affiché.' })
          .setTimestamp();
        return interaction.editReply({ embeds: [embed] });
      } catch (e) { return interaction.editReply(pteroErr(e)); }
    }

    if (sub === 'liste') {
      try {
        const res  = (await api.users.list()).data;
        const list = res.data.map((u) =>
          `\`#${u.attributes.id}\` **${u.attributes.username}** — ${u.attributes.email}${u.attributes.root_admin ? ' 👑' : ''}`
        ).join('\n');
        const embed = new EmbedBuilder()
          .setColor(cfg.colors.primary)
          .setTitle(`👥 Utilisateurs Pterodactyl (${res.meta.pagination.total})`)
          .setDescription(list.slice(0, 4090) || 'Aucun utilisateur.')
          .setTimestamp();
        return interaction.editReply({ embeds: [embed] });
      } catch (e) { return interaction.editReply(pteroErr(e)); }
    }

    if (sub === 'info') {
      try {
        const attr = (await api.users.get(options.getInteger('id'))).data.attributes;
        const servers = attr.relationships?.servers?.data ?? [];
        const embed = new EmbedBuilder()
          .setColor(cfg.colors.primary)
          .setTitle(`👤 ${attr.username}`)
          .addFields(
            { name: '🆔 ID',           value: String(attr.id),                        inline: true },
            { name: '📧 Email',        value: attr.email,                              inline: true },
            { name: '🎭 Rôle',         value: attr.root_admin ? '👑 Admin' : '👤 Client', inline: true },
            { name: '📛 Nom complet',  value: `${attr.first_name} ${attr.last_name}`, inline: true },
            { name: '📅 Créé le',      value: dateT(new Date(attr.created_at).getTime()), inline: true },
            { name: `🖥️ Serveurs (${servers.length})`, value: servers.map((s) => s.attributes.name).join(', ') || 'Aucun', inline: false },
          )
          .setTimestamp();
        return interaction.editReply({ embeds: [embed] });
      } catch (e) { return interaction.editReply(pteroErr(e)); }
    }

    if (sub === 'modifier') {
      const id  = options.getInteger('id');
      const newEmail    = options.getString('email');
      const newUsername = options.getString('username');
      const newPassword = options.getString('password') || genPassword(16);
      try {
        const cur = (await api.users.get(id)).data.attributes;
        const body = {
          username:   newUsername || cur.username,
          email:      newEmail    || cur.email,
          first_name: cur.first_name,
          last_name:  cur.last_name,
          password:   newPassword,
        };
        await api.users.update(id, body);
        log('PTERO_USER_EDIT', user.tag, `id:${id}`);
        const changes = [];
        if (newEmail)    changes.push(`Email → \`${newEmail}\``);
        if (newUsername) changes.push(`Username → \`${newUsername}\``);
        if (!options.getString('password')) changes.push(`Mot de passe réinitialisé → \`${newPassword}\``);
        return interaction.editReply(`✅ Utilisateur **#${id}** mis à jour :\n${changes.join('\n')}`);
      } catch (e) { return interaction.editReply(pteroErr(e)); }
    }

    if (sub === 'admin') {
      const id      = options.getInteger('id');
      const isAdmin = options.getBoolean('activer');
      try {
        const cur = (await api.users.get(id)).data.attributes;
        await api.users.update(id, {
          username: cur.username, email: cur.email,
          first_name: cur.first_name, last_name: cur.last_name,
          root_admin: isAdmin,
        });
        log('PTERO_USER_ROLE', user.tag, `id:${id} admin:${isAdmin}`);
        return interaction.editReply(`✅ **${cur.username}** (#${id}) est maintenant **${isAdmin ? 'Administrateur 👑' : 'Client'}**.`);
      } catch (e) { return interaction.editReply(pteroErr(e)); }
    }

    if (sub === 'supprimer') {
      const id = options.getInteger('id');
      try {
        await api.users.delete(id);
        log('PTERO_USER_DELETE', user.tag, `id:${id}`);
        return interaction.editReply(`✅ Utilisateur **#${id}** supprimé.`);
      } catch (e) { return interaction.editReply(pteroErr(e)); }
    }

    if (sub === 'lier') {
      const targetUser = options.getUser('discord');
      const pteroId    = options.getInteger('ptero');
      try {
        const attr = (await api.users.get(pteroId)).data.attributes;
        stmt.upsertAccount.run(targetUser.id, pteroId, attr.username);
        log('PTERO_LINK', user.tag, `discord:${targetUser.tag} ptero:${pteroId}`);
        const embed = new EmbedBuilder()
          .setColor(cfg.colors.success)
          .setTitle('🔗 Compte associé')
          .addFields(
            { name: 'Discord',      value: `<@${targetUser.id}>`, inline: true },
            { name: 'Pterodactyl', value: `${attr.username} (#${pteroId})`, inline: true },
          )
          .setTimestamp();
        return interaction.editReply({ embeds: [embed] });
      } catch (e) { return interaction.editReply(pteroErr(e)); }
    }

    if (sub === 'delier') {
      const targetUser = options.getUser('discord');
      db.prepare('DELETE FROM accounts WHERE discord_id = ?').run(targetUser.id);
      log('PTERO_UNLINK', user.tag, `discord:${targetUser.tag}`);
      return interaction.editReply(`✅ Association de **${targetUser.tag}** supprimée.`);
    }
  }

  // ────────────────────────── PTERODACTYL — SERVEURS ───────────────────────

  if (cmd === 'serveur') {
    if (!await requireStaff(interaction)) return;
    if (!await requirePtero(interaction)) return;
    await interaction.deferReply({ ephemeral: true });
    const sub = options.getSubcommand();

    if (sub === 'liste') {
      try {
        const res  = (await api.servers.list()).data;
        const list = res.data.map((s) =>
          `\`#${s.attributes.id}\` **${s.attributes.name}** (\`${s.attributes.identifier}\`) ${s.attributes.suspended ? '🔴' : '🟢'}`
        ).join('\n');
        const embed = new EmbedBuilder()
          .setColor(cfg.colors.primary)
          .setTitle(`🖥️ Serveurs (${res.meta.pagination.total})`)
          .setDescription(list.slice(0, 4090) || 'Aucun serveur.')
          .setTimestamp();
        return interaction.editReply({ embeds: [embed] });
      } catch (e) { return interaction.editReply(pteroErr(e)); }
    }

    if (sub === 'info') {
      const id = options.getInteger('id');
      try {
        const attr  = (await api.servers.get(id)).data.attributes;
        const owner = attr.relationships?.user?.attributes;
        const node  = attr.relationships?.node?.attributes;
        const alloc = attr.relationships?.allocations?.data?.[0]?.attributes;
        const lim   = attr.limits;
        const feat  = attr.feature_limits;
        const embed = new EmbedBuilder()
          .setColor(cfg.colors.primary)
          .setTitle(`🖥️ ${attr.name}`)
          .addFields(
            { name: '🆔 ID',            value: String(attr.id),                           inline: true },
            { name: '🔑 Identifiant',   value: `\`${attr.identifier}\``,                  inline: true },
            { name: '🚦 Statut',        value: attr.suspended ? '🔴 Suspendu' : '🟢 Actif', inline: true },
            { name: '👤 Propriétaire',  value: owner ? `${owner.username} (#${attr.user})` : String(attr.user), inline: true },
            { name: '🌐 Node',          value: node ? `${node.name} (#${attr.node})`       : String(attr.node), inline: true },
            { name: '🌍 Adresse',       value: alloc ? `${alloc.ip}:${alloc.port}`         : '—', inline: true },
            { name: '💾 RAM',           value: mbToHuman(lim.memory), inline: true },
            { name: '💿 Disque',        value: mbToHuman(lim.disk),   inline: true },
            { name: '⚡ CPU',           value: lim.cpu === 0 ? '∞ %' : `${lim.cpu}%`, inline: true },
            { name: '🗄️ Bases de données', value: String(feat.databases),  inline: true },
            { name: '💾 Backups',       value: String(feat.backups),    inline: true },
            { name: '🔌 Allocations',   value: String(feat.allocations), inline: true },
          )
          .setTimestamp();
        return interaction.editReply({ embeds: [embed] });
      } catch (e) { return interaction.editReply(pteroErr(e)); }
    }

    if (sub === 'suspendre') {
      const id = options.getInteger('id');
      try {
        await api.servers.suspend(id);
        log('PTERO_SERVER_SUSPEND', user.tag, `id:${id}`);
        return interaction.editReply(`🔴 Serveur **#${id}** suspendu.`);
      } catch (e) { return interaction.editReply(pteroErr(e)); }
    }

    if (sub === 'retablir') {
      const id = options.getInteger('id');
      try {
        await api.servers.unsuspend(id);
        log('PTERO_SERVER_UNSUSPEND', user.tag, `id:${id}`);
        return interaction.editReply(`🟢 Serveur **#${id}** rétabli.`);
      } catch (e) { return interaction.editReply(pteroErr(e)); }
    }

    if (sub === 'reinstaller') {
      const id = options.getInteger('id');
      try {
        await api.servers.reinstall(id);
        log('PTERO_SERVER_REINSTALL', user.tag, `id:${id}`);
        return interaction.editReply(`⚠️ Serveur **#${id}** en cours de réinstallation — les données seront perdues.`);
      } catch (e) { return interaction.editReply(pteroErr(e)); }
    }

    if (sub === 'renommer') {
      const id   = options.getInteger('id');
      const name = options.getString('nom');
      try {
        await api.servers.rename(id, name);
        log('PTERO_SERVER_RENAME', user.tag, `id:${id} name:${name}`);
        return interaction.editReply(`✅ Serveur **#${id}** renommé en **${name}**.`);
      } catch (e) { return interaction.editReply(pteroErr(e)); }
    }

    if (sub === 'ram' || sub === 'cpu' || sub === 'disque') {
      const id = options.getInteger('id');
      const map = { ram: 'memory', cpu: 'cpu', disque: 'disk' };
      const key = map[sub];
      const val = sub === 'cpu' ? options.getInteger('pourcent') : options.getInteger('mb');
      try {
        // Fetch current build to merge
        const cur = (await api.servers.get(id)).data.attributes;
        const lim = { ...cur.limits, [key]: val };
        const feat = cur.feature_limits;
        await api.servers.updateBuild(id, {
          allocation: cur.relationships?.allocations?.data?.[0]?.attributes
            ? cur.relationships.allocations.data.find((a) => a.attributes.is_default)?.id ?? 1
            : 1,
          memory: lim.memory, swap: lim.swap, disk: lim.disk, cpu: lim.cpu, io: lim.io,
          threads: lim.threads, feature_limits: feat,
        });
        const label = { ram: `${mbToHuman(val)} RAM`, cpu: `${val === 0 ? '∞' : val}% CPU`, disque: `${mbToHuman(val)} disque` }[sub];
        log(`PTERO_SERVER_${sub.toUpperCase()}`, user.tag, `id:${id} value:${val}`);
        return interaction.editReply(`✅ Serveur **#${id}** — ${label} appliqué.`);
      } catch (e) { return interaction.editReply(pteroErr(e)); }
    }

    if (sub === 'supprimer') {
      const id    = options.getInteger('id');
      const force = options.getBoolean('force') ?? false;
      try {
        await api.servers.delete(id, force);
        log('PTERO_SERVER_DELETE', user.tag, `id:${id} force:${force}`);
        return interaction.editReply(`✅ Serveur **#${id}** supprimé définitivement.`);
      } catch (e) { return interaction.editReply(pteroErr(e)); }
    }
  }

  // ────────────────────────── PTERODACTYL — NODES ───────────────────────────

  if (cmd === 'node') {
    if (!await requireStaff(interaction)) return;
    if (!await requirePtero(interaction)) return;
    await interaction.deferReply({ ephemeral: true });
    const sub = options.getSubcommand();

    if (sub === 'liste') {
      try {
        const nodes = (await api.nodes.list()).data.data;
        const embed = new EmbedBuilder()
          .setColor(cfg.colors.primary)
          .setTitle(`🌐 Nodes (${nodes.length})`)
          .setDescription(nodes.map((n) =>
            `\`#${n.attributes.id}\` **${n.attributes.name}** — ${n.attributes.fqdn} | RAM: ${mbToHuman(n.attributes.memory)} | Disque: ${mbToHuman(n.attributes.disk)}`
          ).join('\n').slice(0, 4090) || 'Aucun node.')
          .setTimestamp();
        return interaction.editReply({ embeds: [embed] });
      } catch (e) { return interaction.editReply(pteroErr(e)); }
    }

    if (sub === 'info') {
      const id = options.getInteger('id');
      try {
        const a    = (await api.nodes.get(id)).data.attributes;
        const loc  = a.relationships?.location?.attributes;
        const srvs = a.relationships?.servers?.data ?? [];
        const embed = new EmbedBuilder()
          .setColor(cfg.colors.primary)
          .setTitle(`🌐 Node : ${a.name}`)
          .addFields(
            { name: '🆔 ID',             value: String(a.id),             inline: true },
            { name: '🌍 FQDN',           value: a.fqdn,                   inline: true },
            { name: '🔌 Port daemon',    value: String(a.daemon_port),     inline: true },
            { name: '🔒 TLS',            value: a.ssl ? 'Oui' : 'Non',    inline: true },
            { name: '📍 Location',       value: loc ? `${loc.short} — ${loc.long}` : String(a.location_id), inline: true },
            { name: '💾 RAM',            value: `${mbToHuman(a.memory)} (seuil: ${a.memory_overallocate}%)`, inline: true },
            { name: '💿 Disque',         value: `${mbToHuman(a.disk)} (seuil: ${a.disk_overallocate}%)`,    inline: true },
            { name: '🖥️ Serveurs actifs', value: String(srvs.length),     inline: true },
          )
          .setTimestamp();
        return interaction.editReply({ embeds: [embed] });
      } catch (e) { return interaction.editReply(pteroErr(e)); }
    }

    if (sub === 'allocations') {
      const id = options.getInteger('id');
      try {
        const res   = (await api.nodes.allocations(id)).data;
        const alloc = res.data;
        const embed = new EmbedBuilder()
          .setColor(cfg.colors.primary)
          .setTitle(`🔌 Allocations — Node #${id} (${res.meta.pagination.total})`)
          .setDescription(alloc.map((a) => {
            const attr = a.attributes;
            const status = attr.assigned ? '🔴 Utilisée' : '🟢 Libre';
            return `\`#${attr.id}\` **${attr.ip}:${attr.port}** ${attr.alias ? `(${attr.alias})` : ''} — ${status}`;
          }).join('\n').slice(0, 4090) || 'Aucune allocation.')
          .setTimestamp();
        return interaction.editReply({ embeds: [embed] });
      } catch (e) { return interaction.editReply(pteroErr(e)); }
    }
  }

  // ────────────────────────── PTERODACTYL — LOCATIONS ──────────────────────

  if (cmd === 'location') {
    if (!await requireStaff(interaction)) return;
    if (!await requirePtero(interaction)) return;
    await interaction.deferReply({ ephemeral: true });
    const sub = options.getSubcommand();

    if (sub === 'liste') {
      try {
        const locs = (await api.locations.list()).data.data;
        const embed = new EmbedBuilder()
          .setColor(cfg.colors.primary)
          .setTitle(`📍 Locations (${locs.length})`)
          .setDescription(locs.map((l) => {
            const a = l.attributes;
            const nodes = a.relationships?.nodes?.data?.length ?? '?';
            return `\`#${a.id}\` **${a.short}** — ${a.long} · ${nodes} node(s)`;
          }).join('\n').slice(0, 4090) || 'Aucune location.')
          .setTimestamp();
        return interaction.editReply({ embeds: [embed] });
      } catch (e) { return interaction.editReply(pteroErr(e)); }
    }

    if (sub === 'info') {
      const id = options.getInteger('id');
      try {
        const a     = (await api.locations.get(id)).data.attributes;
        const nodes = a.relationships?.nodes?.data ?? [];
        const embed = new EmbedBuilder()
          .setColor(cfg.colors.primary)
          .setTitle(`📍 ${a.short} — ${a.long}`)
          .addFields(
            { name: '🆔 ID',       value: String(a.id), inline: true },
            { name: '📛 Code',     value: a.short,       inline: true },
            { name: '📋 Description', value: a.long,    inline: true },
            { name: `🌐 Nodes (${nodes.length})`, value: nodes.map((n) => n.attributes.name).join(', ') || 'Aucun' },
          )
          .setTimestamp();
        return interaction.editReply({ embeds: [embed] });
      } catch (e) { return interaction.editReply(pteroErr(e)); }
    }
  }

  // ────────────────────────── PTERODACTYL — NESTS & EGGS ───────────────────

  if (cmd === 'nest') {
    if (!await requireStaff(interaction)) return;
    if (!await requirePtero(interaction)) return;
    await interaction.deferReply({ ephemeral: true });
    const sub = options.getSubcommand();

    if (sub === 'liste') {
      try {
        const nests = (await api.nests.list()).data.data;
        const embed = new EmbedBuilder()
          .setColor(cfg.colors.primary)
          .setTitle(`📦 Nests (${nests.length})`)
          .setDescription(nests.map((n) =>
            `\`#${n.attributes.id}\` **${n.attributes.name}** — ${n.attributes.description || '_Aucune description_'}`
          ).join('\n').slice(0, 4090))
          .setTimestamp();
        return interaction.editReply({ embeds: [embed] });
      } catch (e) { return interaction.editReply(pteroErr(e)); }
    }

    if (sub === 'eggs') {
      const nestId = options.getInteger('id');
      try {
        const eggs  = (await api.nests.listEggs(nestId)).data.data;
        const embed = new EmbedBuilder()
          .setColor(cfg.colors.primary)
          .setTitle(`🥚 Eggs — Nest #${nestId} (${eggs.length})`)
          .setDescription(eggs.map((e) => {
            const a = e.attributes;
            return `\`#${a.id}\` **${a.name}** — Docker: \`${a.docker_image.split(':')[0].split('/').pop()}\``;
          }).join('\n').slice(0, 4090) || 'Aucun egg.')
          .setTimestamp();
        return interaction.editReply({ embeds: [embed] });
      } catch (e) { return interaction.editReply(pteroErr(e)); }
    }
  }

  // ────────────────────────── PTERODACTYL — DB HOSTS ───────────────────────

  if (cmd === 'dbhosts') {
    if (!await requireStaff(interaction)) return;
    if (!await requirePtero(interaction)) return;
    await interaction.deferReply({ ephemeral: true });
    try {
      const hosts = (await api.databases.list()).data.data;
      const embed = new EmbedBuilder()
        .setColor(cfg.colors.primary)
        .setTitle(`🗄️ Hôtes de bases de données (${hosts.length})`)
        .setDescription(hosts.map((h) => {
          const a = h.attributes;
          return `\`#${a.id}\` **${a.name}** — \`${a.host}:${a.port}\``;
        }).join('\n').slice(0, 4090) || 'Aucun hôte configuré.')
        .setTimestamp();
      return interaction.editReply({ embeds: [embed] });
    } catch (e) { return interaction.editReply(pteroErr(e)); }
  }
};

// ──────────────────────────────────────────────────────────────────────────────
//  §16  HANDLER — BOUTONS
// ──────────────────────────────────────────────────────────────────────────────

const handleButton = async (interaction) => {
  const { customId, member, guild, channel, user } = interaction;

  if (customId === 'btn:verify') {
    if (!cfg.verifyRoleId) return interaction.reply({ content: '❌ `VERIFY_ROLE_ID` non configuré.', ephemeral: true });
    if (member.roles.cache.has(cfg.verifyRoleId))
      return interaction.reply({ content: '✅ Vous êtes déjà vérifié !', ephemeral: true });
    await member.roles.add(cfg.verifyRoleId).catch(() => null);
    return interaction.reply({ content: '✅ Vérification réussie ! Bienvenue sur **Master Hosting**.', ephemeral: true });
  }

  if (customId === 'btn:open-ticket')
    return interaction.showModal(C.modals.openTicket());

  if (customId === 'btn:take-ticket') {
    if (!isStaff(member)) return interaction.reply({ content: '🚫 Réservé au staff.', ephemeral: true });
    const row = stmt.getTicket.get(channel.id);
    if (row?.assigned_to) return interaction.reply({ embeds: [E.ticketTaken(member, true)], ephemeral: true });
    stmt.assignTicket.run(member.id, channel.id);
    return interaction.reply({ embeds: [E.ticketTaken(member)] });
  }

  if (customId === 'btn:add-member') {
    if (!isStaff(member)) return interaction.reply({ content: '🚫 Réservé au staff.', ephemeral: true });
    const menu = C.addMemberMenu(guild, channel, member.id);
    if (!menu) return interaction.reply({ content: 'Aucun membre disponible à ajouter.', ephemeral: true });
    return interaction.reply({ content: 'Choisissez un membre à ajouter :', components: [menu], ephemeral: true });
  }

  if (customId === 'btn:transcript') {
    if (!isStaff(member)) return interaction.reply({ content: '🚫 Réservé au staff.', ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    const url = await sendTranscript(guild, channel);
    return interaction.editReply(url ? `✅ Transcript envoyé. [Lien](${url})` : '✅ Transcript envoyé (aucun lien disponible).');
  }

  if (customId === 'btn:close-ticket')
    return interaction.showModal(isStaff(member) ? C.modals.closeTicket() : C.modals.closeRequest());

  if (customId === 'btn:accept-close') {
    if (!isStaff(member)) return interaction.reply({ content: '🚫 Réservé au staff.', ephemeral: true });
    await interaction.deferUpdate();
    await closeTicket({ guild, channel, closedBy: member, reason: 'Fermeture confirmée par le staff' });
  }

  if (customId === 'btn:refuse-close') {
    if (!isStaff(member)) return interaction.reply({ content: '🚫 Réservé au staff.', ephemeral: true });
    return interaction.update({ content: '❌ Demande de fermeture refusée.', embeds: [], components: [] });
  }

  if (customId === 'btn:join-giveaway') {
    const ga = stmt.getGiveaway.get(interaction.message.id);
    if (!ga)          return interaction.reply({ content: '❌ Giveaway introuvable.', ephemeral: true });
    if (ga.ended)     return interaction.reply({ content: '❌ Ce giveaway est terminé.', ephemeral: true });
    if (Date.now() > ga.ends_at) return interaction.reply({ content: '❌ Ce giveaway est expiré.', ephemeral: true });
    if (stmt.hasEntry.get(ga.message_id, user.id))
      return interaction.reply({ content: '🎉 Vous participez déjà à ce giveaway !', ephemeral: true });
    stmt.addEntry.run(ga.message_id, user.id);
    const count = stmt.countEntries.get(ga.message_id).c;
    return interaction.reply({ content: `🎉 Participation enregistrée ! (${count} participant(s))`, ephemeral: true });
  }
};

// ──────────────────────────────────────────────────────────────────────────────
//  §17  HANDLER — MENUS
// ──────────────────────────────────────────────────────────────────────────────

const handleSelectMenu = async (interaction) => {
  if (interaction.customId === 'sel:add-member') {
    const targetId = interaction.values[0];
    await interaction.channel.permissionOverwrites.edit(targetId, {
      ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true,
    }).catch(() => null);
    await interaction.update({ content: `✅ <@${targetId}> a été ajouté au ticket.`, components: [] });
  }
};

// ──────────────────────────────────────────────────────────────────────────────
//  §18  HANDLER — MODALS
// ──────────────────────────────────────────────────────────────────────────────

const handleModal = async (interaction) => {
  const { customId, fields, guild, member, channel, user } = interaction;

  if (customId === 'modal:open-ticket') {
    const reason = fields.getTextInputValue('reason');
    await interaction.deferReply({ ephemeral: true });
    const res = await ensureTicket(guild, member, reason);
    if (res.error) return interaction.editReply(`❌ ${res.error}`);
    return interaction.editReply(res.created
      ? `✅ Votre ticket a été créé : ${res.channel}.`
      : `✅ Vous avez déjà un ticket ouvert : ${res.channel}.`
    );
  }

  if (customId === 'modal:close-ticket') {
    const reason = fields.getTextInputValue('close-reason');
    await interaction.deferUpdate().catch(() => null);
    await closeTicket({ guild, channel, closedBy: member, reason });
  }

  if (customId === 'modal:close-request') {
    const reason = fields.getTextInputValue('request-reason');
    await interaction.reply({
      embeds:     [E.closeRequest(member, reason)],
      components: [C.closeDecisionRow()],
    });
  }

  if (customId === 'modal:announce') {
    const text  = fields.getTextInputValue('announce-text');
    const annCh = await getCh(guild, cfg.announcementChannelId);
    if (!annCh) return reply(interaction, { content: '❌ `ANNOUNCEMENT_CHANNEL_ID` non configuré.' });
    const embed = new EmbedBuilder()
      .setColor(cfg.colors.primary)
      .setTitle('📢 Annonce officielle')
      .setDescription(text)
      .setAuthor({ name: member.user.tag, iconURL: member.user.displayAvatarURL() })
      .setFooter({ text: 'Master Hosting' })
      .setTimestamp();
    await annCh.send({ embeds: [embed] });
    return reply(interaction, { content: '✅ Annonce publiée.' });
  }
};

// ──────────────────────────────────────────────────────────────────────────────
//  §19  ROUTEUR INTERACTIONS
// ──────────────────────────────────────────────────────────────────────────────

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) return await handleSlash(interaction);
    if (interaction.isButton())           return await handleButton(interaction);
    if (interaction.isStringSelectMenu()) return await handleSelectMenu(interaction);
    if (interaction.isModalSubmit())      return await handleModal(interaction);
  } catch (err) {
    console.error(`[Interaction] Erreur [${interaction.customId ?? interaction.commandName}]:`, err);
    const msg = '❌ Une erreur est survenue. Réessayez ou contactez le staff.';
    try {
      if (interaction.deferred || interaction.replied) await interaction.editReply({ content: msg }).catch(() => null);
      else await interaction.reply({ content: msg, ephemeral: true }).catch(() => null);
    } catch { /* ignore */ }
  }
});

// ──────────────────────────────────────────────────────────────────────────────
//  §20  ÉVÉNEMENTS GUILD
// ──────────────────────────────────────────────────────────────────────────────

client.on('guildMemberAdd', async (member) => {
  const ch = await getCh(member.guild, cfg.welcomeChannelId);
  if (ch?.isTextBased()) await ch.send({ embeds: [E.welcome(member)] }).catch(() => null);
});

client.on('guildMemberRemove', async (member) => {
  const ch = await getCh(member.guild, cfg.leaveChannelId);
  if (ch?.isTextBased()) await ch.send({ embeds: [E.leave(member)] }).catch(() => null);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;
  await handleAntiSpam(message);
});

// ──────────────────────────────────────────────────────────────────────────────
//  §21  INIT SALONS & DÉMARRAGE
// ──────────────────────────────────────────────────────────────────────────────

const bulkClear = async (channel, limit = 100) => {
  try {
    const msgs = await channel.messages.fetch({ limit });
    if (msgs.size) await channel.bulkDelete(msgs, true).catch(() => null);
  } catch { /* messages > 14j */ }
};

const initPanelChannel = async (guild) => {
  if (!cfg.ticketPanelChannelId) return;
  const ch = await getCh(guild, cfg.ticketPanelChannelId);
  if (!ch?.isTextBased()) return;
  await bulkClear(ch);
  await ch.send({ embeds: [E.panel()], components: [C.panelRow()] });
  console.log('[Init] Panel tickets ✅');
};

const initVerifyChannel = async (guild) => {
  if (!cfg.verifyChannelId) return;
  const ch = await getCh(guild, cfg.verifyChannelId);
  if (!ch?.isTextBased()) return;
  await bulkClear(ch);
  await sendRules(ch);
  await ch.send({ embeds: [E.verify()], components: [C.verifyRow()] });
  console.log('[Init] Salon vérification ✅');
};

const registerCommands = async () => {
  const rest = new REST({ version: '10' }).setToken(cfg.token);
  console.log('[Slash] Synchronisation des commandes…');
  await rest.put(Routes.applicationGuildCommands(cfg.clientId, cfg.guildId), { body: commands });
  console.log(`[Slash] ${commands.length} commandes enregistrées ✅`);
};

const testPteroConnection = async () => {
  if (!hasPtero()) {
    console.warn('[Ptero] Non configuré — commandes Pterodactyl désactivées.');
    return;
  }
  try {
    const res = (await api.users.list()).data;
    console.log(`[Ptero] Connexion OK — ${res.meta.pagination.total} utilisateur(s) ✅`);
  } catch {
    console.error('[Ptero] ❌ Impossible de joindre l\'API. Vérifiez PTERO_URL et PTERO_API_KEY.');
  }
};

client.once('clientReady', async (ready) => {
  console.log('\n═══════════════════════════════════════');
  console.log(`  Master Hosting Bot  v${VERSION}`);
  console.log(`  Connecté : ${ready.user.tag}`);
  console.log(`  Serveur  : ${cfg.guildId}`);
  console.log('═══════════════════════════════════════\n');

  ready.user.setActivity('masterhosting.fr', { type: ActivityType.Watching });

  await registerCommands();
  await testPteroConnection();

  const guild = ready.guilds.cache.get(cfg.guildId);
  if (guild) {
    await initPanelChannel(guild);
    await initVerifyChannel(guild);
  }

  setInterval(() => checkGiveaways().catch(console.error), 30_000);

  console.log('\n✅ Bot opérationnel.\n');
});

app.get("/api/account/:discord", async (req,res)=>{

    const id = req.params.discord;


    const account =
    db.prepare(
        "SELECT * FROM accounts WHERE discord_id=?"
    )
    .get(id);


    if(!account)
        return res.status(404).json({
            error:"Compte non lié"
        });


    res.json(account);

});


app.listen(25565,()=>{

console.log("API account online");

});
// ──────────────────────────────────────────────────────────────────────────────
//  §22  GESTION ERREURS GLOBALES
// ──────────────────────────────────────────────────────────────────────────────

process.on('unhandledRejection', (r) => console.error('[UnhandledRejection]', r));
process.on('uncaughtException',  (e) => console.error('[UncaughtException]',  e));

client.login(cfg.token);