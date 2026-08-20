'use strict';
require('dotenv').config();
const express=require('express');
const path=require('node:path');
const crypto=require('node:crypto');
const helmet=require('helmet');
const rateLimit=require('express-rate-limit');
const axios=require('axios');
const Database=require('better-sqlite3');

const app=express();
const PORT=Number(process.env.DASHBOARD_PORT||25566);
const HOST=process.env.DASHBOARD_HOST||'127.0.0.1';
const TOKEN=process.env.DASHBOARD_TOKEN||'';
const DISCORD_TOKEN=process.env.DISCORD_TOKEN||'';
const GUILD_ID=process.env.GUILD_ID||'';
const PTERO_URL=(process.env.PTERO_URL||'').replace(/\/+$/,'');
const PTERO_KEY=process.env.PTERO_API_KEY||'';

if(!TOKEN||TOKEN.length<32) throw new Error('DASHBOARD_TOKEN doit contenir au moins 32 caractères.');
if(!DISCORD_TOKEN||!GUILD_ID) throw new Error('DISCORD_TOKEN et GUILD_ID sont requis pour le dashboard.');

const db=new Database(path.resolve(process.cwd(),'masterhosting.sqlite'),{fileMustExist:false});
const discord=axios.create({baseURL:'https://discord.com/api/v10',headers:{Authorization:`Bot ${DISCORD_TOKEN}`,'User-Agent':'MasterHosting-Dashboard/5.0'}});
const ptero=PTERO_URL&&PTERO_KEY?axios.create({baseURL:`${PTERO_URL}/api/application`,headers:{Authorization:`Bearer ${PTERO_KEY}`,Accept:'application/vnd.pterodactyl.v1+json'}}):null;

app.disable('x-powered-by');
app.set('trust proxy',process.env.TRUST_PROXY==='true'?1:false);
app.use(helmet({contentSecurityPolicy:{directives:{defaultSrc:["'self'"],styleSrc:["'self'"],scriptSrc:["'self'"],imgSrc:["'self'","data:"]}}}));
app.use(express.json({limit:'32kb'}));
app.use('/api/dashboard',rateLimit({windowMs:60_000,max:60,standardHeaders:true,legacyHeaders:false}));
app.use('/dashboard',express.static(path.join(process.cwd(),'dashboard'),{index:'index.html',extensions:['html']}));

function safeEqual(a,b){const x=Buffer.from(String(a));const y=Buffer.from(String(b));return x.length===y.length&&crypto.timingSafeEqual(x,y)}
function auth(req,res,next){const h=req.get('authorization')||'';const value=h.startsWith('Bearer ')?h.slice(7):'';if(!safeEqual(value,TOKEN))return res.status(401).json({error:'Non autorisé'});next()}
function guildMemberCount(g){return Number(g.approximate_member_count||0)}
function log(action,user,details){try{db.prepare('INSERT INTO logs(action,user,details) VALUES(?,?,?)').run(action,user,details||null)}catch(e){console.error('[Dashboard audit]',e.message)}}
function actor(req){return req.get('x-dashboard-user')||'dashboard-admin'}

app.get('/health',(req,res)=>res.json({ok:true,service:'masterhosting-dashboard'}));
app.use('/api/dashboard',auth);

app.get('/api/dashboard/overview',async(req,res)=>{
  const out={guilds:0,members:0,tickets:0,warns:0,commands:0,ptero:!!ptero,bot:{online:false}};
  try{const g=(await discord.get(`/guilds/${GUILD_ID}?with_counts=true`)).data;out.guilds=1;out.members=guildMemberCount(g);out.bot={online:true,name:g.name,id:g.id}}catch{}
  try{out.tickets=db.prepare('SELECT COUNT(*) c FROM tickets').get().c}catch{}
  try{out.warns=db.prepare('SELECT COUNT(*) c FROM warns').get().c}catch{}
  try{out.commands=db.prepare("SELECT COUNT(*) c FROM logs WHERE action LIKE 'CMD%'").get().c}catch{}
  res.json(out);
});

app.get('/api/dashboard/members',async(req,res)=>{try{const r=await discord.get(`/guilds/${GUILD_ID}/members?limit=1000`);const members=r.data.map(m=>({id:m.user.id,tag:m.user.discriminator&&m.user.discriminator!=='0'?`${m.user.username}#${m.user.discriminator}`:m.user.username,roles:m.roles?.length||0}));res.json({members})}catch{res.status(502).json({error:'Impossible de récupérer les membres Discord'})}});
app.get('/api/dashboard/tickets',(req,res)=>res.json({tickets:db.prepare('SELECT channel_id,owner_id,assigned_to,opened_at FROM tickets ORDER BY opened_at DESC LIMIT 200').all()}));
app.get('/api/dashboard/giveaways',(req,res)=>res.json({giveaways:db.prepare('SELECT message_id,prize,winner_count,ends_at,ended FROM giveaways ORDER BY ends_at DESC LIMIT 200').all()}));
app.get('/api/dashboard/logs',(req,res)=>res.json({logs:db.prepare('SELECT action,user,details,created_at FROM logs ORDER BY id DESC LIMIT 250').all()}));
app.get('/api/dashboard/moderation',(req,res)=>res.json({warns:db.prepare('SELECT COUNT(*) c FROM warns').get().c,bans:db.prepare("SELECT COUNT(*) c FROM logs WHERE action='BAN'").get().c,kicks:db.prepare("SELECT COUNT(*) c FROM logs WHERE action='KICK'").get().c}));

app.get('/api/dashboard/ptero',async(req,res)=>{if(!ptero)return res.json({connected:false});try{const [s,n]=await Promise.all([ptero.get('/servers?per_page=1'),ptero.get('/nodes?per_page=1')]);res.json({connected:true,servers:s.data.meta?.pagination?.total||0,nodes:n.data.meta?.pagination?.total||0})}catch{res.json({connected:false})}});

async function discordAction(req,res,type){
  const id=String(req.params.id||'');if(!/^\d{15,25}$/.test(id))return res.status(400).json({error:'ID Discord invalide'});
  const reason=String(req.body?.reason||'Action effectuée depuis MasterHosting').slice(0,512);
  const headers={'X-Audit-Log-Reason':encodeURIComponent(reason)};
  try{
    if(type==='ban')await discord.put(`/guilds/${GUILD_ID}/bans/${id}`,{delete_message_seconds:0},{headers});
    if(type==='kick')await discord.delete(`/guilds/${GUILD_ID}/members/${id}`,{headers});
    if(type==='timeout')await discord.patch(`/guilds/${GUILD_ID}/members/${id}`,{communication_disabled_until:new Date(Date.now()+Math.min(Math.max(Number(req.body.minutes)||5,1),40320)*60000).toISOString()},{headers});
    log(type.toUpperCase(),actor(req),`target:${id} reason:${reason}`);res.json({ok:true});
  }catch(e){res.status(e.response?.status===404?404:502).json({error:'Discord a refusé l’action ou le membre est introuvable.'})}
}
app.post('/api/dashboard/members/:id/ban',(req,res)=>discordAction(req,res,'ban'));
app.post('/api/dashboard/members/:id/kick',(req,res)=>discordAction(req,res,'kick'));
app.post('/api/dashboard/members/:id/timeout',(req,res)=>discordAction(req,res,'timeout'));

app.get('/dashboard',(req,res)=>res.sendFile(path.join(process.cwd(),'dashboard','index.html')));
app.listen(PORT,HOST,()=>console.log(`[Dashboard] http://${HOST}:${PORT}/dashboard`));
