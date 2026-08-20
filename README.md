# MasterHosting

Bot Discord + API Dashboard pour Master Hosting.

## Architecture

- `index.js` : bot Discord existant, commandes, tickets, modération, giveaways et Pterodactyl.
- `dashboard/server.js` : API d'administration sécurisée, connectée à Discord, SQLite et Pterodactyl.
- `dashboard/index.html` / `style.css` / `app.js` : interface web responsive.
- SQLite : base runtime locale, **à ne jamais versionner**.

## Installation

```bash
npm install
cp .env.example .env
```

Renseigne au minimum `DISCORD_TOKEN`, `CLIENT_ID`, `GUILD_ID` et un `DASHBOARD_TOKEN` aléatoire d'au moins 32 caractères.

Générer le token dashboard :

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

## Démarrage

Bot :

```bash
npm start
```

Dashboard :

```bash
npm run dashboard
```

Par défaut, le dashboard écoute sur `127.0.0.1:25566`. Pour un domaine public, place-le derrière Nginx/Caddy avec HTTPS et conserve le backend lié à localhost.

URL locale : `http://127.0.0.1:25566/dashboard`

## Sécurité

- Token dashboard uniquement dans l'en-tête `Authorization: Bearer ...`.
- Comparaison du token en temps constant.
- Limitation de requêtes par IP.
- Limite JSON à 32 KiB.
- CSP, anti-clickjacking et anti-MIME sniffing.
- Clé Pterodactyl conservée côté serveur.
- Actions Discord validées côté backend et journalisées.
- SQLite et fichiers WAL/SHM ignorés par Git.

> Pour la production, utilise impérativement HTTPS et ne publie jamais `.env`, `DISCORD_TOKEN` ou `PTERO_API_KEY`.
