'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const envPath = fs.existsSync(path.join(__dirname, '.env')) ? path.join(__dirname, '.env') : path.join(__dirname, 'env');
require('dotenv').config({ path: envPath });

const PORT = Number(process.env.PORT || 3009);
const ROOT = __dirname;
const STATE_FILE = path.join(ROOT, 'forum-state.json');
const AUTH_MEDIA_DIR = path.join(ROOT, 'assets', 'uploads');
const SECRET_FILE = path.join(ROOT, 'database', '.forum-jwt.secret');
function loadStableJwtSecret() {
  const configured = String(process.env.JWT_SECRET || '').trim();
  if (configured.length >= 32) return configured;
  try {
    fs.mkdirSync(path.dirname(SECRET_FILE), { recursive: true });
    if (fs.existsSync(SECRET_FILE)) {
      const existing = fs.readFileSync(SECRET_FILE, 'utf8').trim();
      if (existing.length >= 64) return existing;
    }
    const generated = crypto.randomBytes(48).toString('hex');
    fs.writeFileSync(SECRET_FILE, generated + '\n', { mode: 0o600, flag: 'wx' });
    return generated;
  } catch (err) {
    if (process.env.NODE_ENV === 'production') throw new Error('JWT_SECRET ausente e não foi possível persistir um segredo estável. Configure JWT_SECRET.');
    console.warn('[forum] JWT_SECRET temporário apenas para desenvolvimento:', err.message);
    return crypto.randomBytes(48).toString('hex');
  }
}
const JWT_SECRET = loadStableJwtSecret();
const COOKIE_NAME = process.env.SESSION_COOKIE_NAME || 'brazuca_forum_token';
// O upload de vídeo usa Base64, que aumenta o tamanho do arquivo em cerca de 33%.
const MAX_BODY = 140 * 1024 * 1024;
const PRESENCE_TTL_MS = 60_000;
const presenceSessions = new Map();

const mime = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.ogg': 'video/ogg',
  '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8', '.ico': 'image/x-icon', '.sql': 'text/plain; charset=utf-8'
};

const dbConfig = {
  host: process.env.DB_HOST || process.env.MYSQL_HOST || process.env.DATABASE_HOST,
  port: Number(process.env.DB_PORT || process.env.MYSQL_PORT || process.env.DATABASE_PORT || 3306),
  user: process.env.DB_USER || process.env.MYSQL_USER || process.env.DATABASE_USER,
  password: process.env.DB_PASSWORD || process.env.MYSQL_PASSWORD || process.env.DATABASE_PASSWORD,
  database: process.env.DB_NAME || process.env.MYSQL_DATABASE || process.env.DATABASE_NAME,
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 10),
  connectTimeout: Number(process.env.DB_CONNECT_TIMEOUT || 10000),
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
  charset: 'utf8mb4'
};
const mysqlEnabled = Boolean(dbConfig.host && dbConfig.user && dbConfig.database);
const pool = mysqlEnabled ? mysql.createPool(dbConfig) : null;
let schemaCache = null;

function mysqlErrorInfo(err) {
  const code = String(err?.code || 'UNKNOWN');
  if (code === 'ER_ACCESS_DENIED_ERROR') return { code, error: 'MySQL recusou o usuário/senha configurados.', hint: 'Confira DB_USER/DB_PASSWORD e permita o usuário a partir da rede/container do fórum.' };
  if (code === 'ECONNREFUSED') return { code, error: 'MySQL recusou a conexão.', hint: 'Confira DB_HOST/DB_PORT e se o banco está acessível pela rede Docker.' };
  if (code === 'ETIMEDOUT') return { code, error: 'Tempo esgotado ao conectar no MySQL.', hint: 'Confira endpoint, firewall e rede Docker.' };
  if (code === 'ER_BAD_DB_ERROR') return { code, error: 'Banco MySQL não encontrado ou sem permissão.', hint: 'Confira DB_NAME e as permissões do usuário.' };
  return { code, error: 'Falha de comunicação com o MySQL.', hint: 'Consulte o console do fórum para o código do erro.' };
}

const authRate = new Map();
function rateLimit(req, bucket, max = 10, windowMs = 15 * 60 * 1000) {
  const clientIp = requestIpKey(req);
  if (!clientIp) return true; // evita bloquear todos os jogadores se o proxy não repassar o IP real
  const key = `${bucket}:${clientIp}`;
  const now = Date.now();
  const current = authRate.get(key);
  if (!current || now - current.startedAt > windowMs) { authRate.set(key, { startedAt: now, count: 1 }); return true; }
  current.count += 1;
  return current.count <= max;
}
function requireRateLimit(req, res, bucket, max) {
  if (rateLimit(req, bucket, max)) return true;
  sendJson(res, 429, { ok:false, error:'Muitas tentativas. Aguarde alguns minutos e tente novamente.' }, { 'Retry-After':'900' });
  return false;
}
function hashVerificationCode(code) { return crypto.createHash('sha256').update(String(code)).digest('hex'); }
function maskEmail(email) {
  const [local, domain] = String(email || '').split('@');
  if (!domain) return '';
  return `${(local || '').slice(0,2)}***@${domain}`;
}
function getAuthUser(req) {
  try { const token = parseCookies(req)[COOKIE_NAME]; return token ? jwt.verify(token, JWT_SECRET) : null; } catch { return null; }
}

let transporter = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}

function securityHeaders(extra = {}) {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    ...extra
  };
}
function sendJson(res, code, payload, headers = {}) {
  res.writeHead(code, securityHeaders({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }));
  res.end(JSON.stringify(payload));
}
function sendText(res, code, text) {
  res.writeHead(code, securityHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }));
  res.end(text);
}
function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').map(v => v.trim()).filter(Boolean).map(v => {
    const i = v.indexOf('='); return [decodeURIComponent(v.slice(0, i)), decodeURIComponent(v.slice(i + 1))];
  }));
}
function setAuthCookie(res, token) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${secure}`);
}
function clearAuthCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > MAX_BODY) reject(new Error('Payload muito grande')); });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('JSON inválido')); } });
    req.on('error', reject);
  });
}
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 100 * 1024 * 1024) return reject(new Error('Payload muito grande'));
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function safeName(value) {
  const v = String(value || '').trim();
  if (!/^[a-zA-Z0-9_]+$/.test(v)) return null;
  return v;
}
async function query(sql, params = []) {
  if (!pool) throw new Error('MySQL não configurado');
  const [rows] = await pool.execute(sql, params);
  return rows;
}

async function addColumnIfMissing(table, column, definition){
  if(!pool) return;
  const rows = await query('SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=? LIMIT 1',[table,column]);
  if(!rows.length) await query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
}
async function ensureBrazucaForumColumns(){
  if(!pool || !(await tableExists('players'))) return;
  await addColumnIfMissing('players','forum_email','VARCHAR(160) NULL');
  await addColumnIfMissing('players','forum_wl','TINYINT NOT NULL DEFAULT 0');
  await addColumnIfMissing('players','forum_registered_at','DATETIME NULL');
  await query(`CREATE TABLE IF NOT EXISTS forum_email_verifications (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    player_id INT NOT NULL,
    username VARCHAR(32) NOT NULL,
    email VARCHAR(160) NOT NULL,
    code_hash CHAR(64) NOT NULL,
    request_ip VARCHAR(64) NULL,
    attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
    expires_at DATETIME NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_forum_verify_player (player_id),
    INDEX idx_forum_verify_email (email),
    INDEX idx_forum_verify_expiry (expires_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await query(`CREATE TABLE IF NOT EXISTS forum_state_snapshots (
    id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
    state_json LONGTEXT NOT NULL,
    revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
    updated_by VARCHAR(64) NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await query(`CREATE TABLE IF NOT EXISTS forum_audit_log (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    actor_player_id INT NULL,
    actor_username VARCHAR(32) NULL,
    action VARCHAR(48) NOT NULL,
    meta_json LONGTEXT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX(actor_player_id), INDEX(action), INDEX(created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  // Migra instalações que já tinham a tabela de auditoria do fórum antigo.
  await addColumnIfMissing('forum_audit_log','actor_player_id','INT NULL');
  await addColumnIfMissing('forum_audit_log','meta_json','LONGTEXT NULL');
  await query('DELETE FROM forum_email_verifications WHERE expires_at <= NOW()').catch(() => {});
  await migrateLegacyForumState().catch(err => console.warn('[forum] falha na migração do estado legado:', err.message));
}
async function tableExists(name) {
  const rows = await query('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1', [name]);
  return rows.length > 0;
}
async function columnsOf(table) {
  const rows = await query('SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [table]);
  return rows.map(r => r.COLUMN_NAME);
}
function pickColumn(cols, explicit, candidates) {
  const forced = safeName(explicit);
  if (forced && forced !== 'AUTO' && cols.includes(forced)) return forced;
  const lower = new Map(cols.map(c => [c.toLowerCase(), c]));
  for (const c of candidates) if (lower.has(c.toLowerCase())) return lower.get(c.toLowerCase());
  return null;
}
async function discoverSchema() {
  if (schemaCache) return schemaCache;
  if (!pool) return null;
  const accountCandidates = [process.env.FORUM_ACCOUNTS_TABLE, 'players', 'accounts', 'usuarios', 'users', 'contas', 'characters', 'personagens'].filter(Boolean);
  let accountTable = null;
  for (const tRaw of accountCandidates) {
    const t = safeName(tRaw); if (!t || t === 'AUTO') continue;
    if (await tableExists(t)) { accountTable = t; break; }
  }
  if (!accountTable) {
    const rows = await query("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND (TABLE_NAME LIKE '%player%' OR TABLE_NAME LIKE '%account%' OR TABLE_NAME LIKE '%usuario%' OR TABLE_NAME LIKE '%user%' OR TABLE_NAME LIKE '%conta%') LIMIT 1");
    accountTable = rows[0]?.TABLE_NAME || null;
  }
  if (!accountTable) return null;
  const cols = await columnsOf(accountTable);
  const schema = {
    accountTable,
    id: pickColumn(cols, process.env.FORUM_ID_COLUMN, ['id','ID','player_id','account_id','uid']),
    username: pickColumn(cols, process.env.FORUM_USERNAME_COLUMN, ['username','user','nome','name','Nick','nick','login','player_name','personagem']),
    email: pickColumn(cols, process.env.FORUM_EMAIL_COLUMN, ['forum_email','email','mail','e_mail']),
    password: pickColumn(cols, process.env.FORUM_PASSWORD_COLUMN, ['password','senha','pass','hash','password_hash']),
    rg: pickColumn(cols, process.env.FORUM_RG_COLUMN, ['rg','RG','registro','documento','passport','passaporte']),
    money: pickColumn(cols, process.env.FORUM_MONEY_COLUMN, ['money','dinheiro','cash','saldo','grana']),
    level: pickColumn(cols, process.env.FORUM_LEVEL_COLUMN, ['level','nivel','lvl']),
    admin: pickColumn(cols, process.env.FORUM_ADMIN_COLUMN, ['admin','Admin','cargo','rank','staff','helper','adm']),
    skin: pickColumn(cols, process.env.FORUM_SKIN_COLUMN, ['skin','Skin','skin_id']),
    whitelist: pickColumn(cols, process.env.FORUM_WL_COLUMN, ['forum_wl','whitelist','wl','white_list','liberado','aprovado','approved','allowlist']),
    created: pickColumn(cols, process.env.FORUM_CREATED_COLUMN, ['created_at','createdAt','data_criacao','register_date'])
  };
  schemaCache = schema;
  return schema;
}
function normalizeRole(value) {
  const raw = String(value ?? '').trim();
  const v = raw.toLowerCase();
  const n = Number(raw);
  // Espelha os cargos da GM: CEO => Fundador, ADM => Administrador, HELPER => Suporte.
  if (['fundador','founder','owner','ceo','dono'].some(x => v.includes(x)) || n >= 3) return 'Fundador';
  if (['admin','adm','administrador'].some(x => v.includes(x)) || n === 2) return 'Administrador';
  if (['helper','suporte','mod','moderador'].some(x => v.includes(x)) || n === 1) return 'Suporte';
  return 'Membro';
}
function forumRoleLevel(role) {
  return { Membro: 0, Suporte: 1, Administrador: 2, Fundador: 3 }[normalizeRole(role)] ?? 0;
}
function resolveForumRole(databaseRole, forumRole) {
  const database = normalizeRole(databaseRole);
  const forum = normalizeRole(forumRole);
  return forumRoleLevel(forum) > forumRoleLevel(database) ? forum : database;
}
async function verifyPassword(input, stored) {
  const pass = String(input || '');
  const hash = String(stored || '');
  if (!hash) return false;
  if (hash.startsWith('$2a$') || hash.startsWith('$2b$') || hash.startsWith('$2y$')) return bcrypt.compare(pass, hash);
  const md5 = crypto.createHash('md5').update(pass).digest('hex');
  const sha256 = crypto.createHash('sha256').update(pass).digest('hex');
  // Nunca aceitar senha em texto puro no banco. Compatibilidade legada fica limitada a hashes MD5/SHA-256 ou bcrypt.
  return hash.toLowerCase() === md5 || hash.toLowerCase() === sha256;
}
async function findGameUser(identifier) {
  const schema = await discoverSchema();
  if (!schema?.username) return null;
  const where = [schema.username];
  const params = [identifier];
  if (schema.email) { where.push(schema.email); params.push(identifier); }
  const selectCols = Object.values(schema).filter(Boolean).filter((v, i, a) => a.indexOf(v) === i && v !== schema.accountTable).map(c => `\`${c}\``).join(', ');
  const rows = await query(`SELECT ${selectCols || '*'} FROM \`${schema.accountTable}\` WHERE ${where.map(c => `\`${c}\` = ?`).join(' OR ')} LIMIT 1`, params);
  if (!rows.length) return null;
  const r = rows[0];
  return {
    id: r[schema.id] || r[schema.username], username: r[schema.username], displayName: r[schema.username], email: schema.email ? r[schema.email] : null,
    password: schema.password ? r[schema.password] : null, cargo: normalizeRole(schema.admin ? r[schema.admin] : 0), rg: schema.rg ? r[schema.rg] : null,
    money: schema.money ? Number(r[schema.money] || 0) : 0, level: schema.level ? Number(r[schema.level] || 0) : 0, skin: schema.skin ? r[schema.skin] : null, whitelist: schema.whitelist ? Number(r[schema.whitelist] || 0) : 0,
    source: 'mysql-brazuca'
  };
}
async function getGameOverview() {
  const schema = await discoverSchema();
  const base = { mysql: Boolean(pool), connected: false, serverName: 'Brazuca RP', members: 0, characters: 0, online: getPresenceSummary().onlineCount, staff: 0, schema };
  if (!schema?.accountTable) return base;
  const [countRows, staffRows] = await Promise.all([
    query(`SELECT COUNT(*) total FROM \`${schema.accountTable}\``),
    schema.admin ? query(`SELECT COUNT(*) total FROM \`${schema.accountTable}\` WHERE \`${schema.admin}\` IS NOT NULL AND \`${schema.admin}\` <> 0 AND \`${schema.admin}\` <> ''`) : Promise.resolve([{ total: 0 }])
  ]);
  base.connected = true; base.members = Number(countRows[0]?.total || 0); base.characters = base.members; base.staff = Number(staffRows[0]?.total || 0);
  return base;
}
function readLegacySharedState() { try { return fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8') || '{}') : {}; } catch { return {}; } }
async function getForumAssignedRole(username, fallbackRole) {
  try {
    const state = await readSharedState();
    const forumUser = (state.users || []).find(user => sameForumUser(user?.username, username));
    return forumUser?.cargo ? normalizeRole(forumUser.cargo) : normalizeRole(fallbackRole);
  } catch {
    return normalizeRole(fallbackRole);
  }
}
function sanitizeState(state) {
  const clean = state && typeof state === 'object' ? { ...state } : {};
  delete clean._revision;
  delete clean._baseRevision;
  if (Array.isArray(clean.users)) clean.users = clean.users.map(u => { const x = { ...u }; delete x.password; delete x.verificationCode; return x; });
  for (const key of ['users','topics','downloadItems','subforums','activityLog','deletedTopicIds','deletedSubforumIds','deletedUserIds']) {
    if (clean[key] != null && !Array.isArray(clean[key])) clean[key] = [];
  }
  return clean;
}
async function migrateLegacyForumState() {
  if (!pool) return;
  const rows = await query('SELECT revision FROM forum_state_snapshots WHERE id=1 LIMIT 1');
  if (rows.length) return;
  const legacy = sanitizeState(readLegacySharedState());
  await query('INSERT INTO forum_state_snapshots(id,state_json,revision,updated_by) VALUES(1,?,1,?)', [JSON.stringify({ ...legacy, savedAt: Number(legacy.savedAt || Date.now()) }), 'migration']);
}
async function readSharedState() {
  if (!pool) return { ...sanitizeState(readLegacySharedState()), _revision: 0 };
  const rows = await query('SELECT state_json, revision, UNIX_TIMESTAMP(updated_at)*1000 AS updated_ms FROM forum_state_snapshots WHERE id=1 LIMIT 1');
  if (!rows.length) { await migrateLegacyForumState(); return readSharedState(); }
  let state = {};
  try { state = JSON.parse(rows[0].state_json || '{}'); } catch { state = {}; }
  state = sanitizeState(state);
  state.savedAt = Math.max(Number(state.savedAt || 0), Number(rows[0].updated_ms || 0));
  state._revision = Number(rows[0].revision || 0);
  return state;
}
function isForumModerator(actor) {
  return ['Fundador','Administrador','Suporte'].includes(normalizeRole(actor?.cargo));
}
function isForumAdministrator(actor) {
  return ['Fundador','Administrador'].includes(normalizeRole(actor?.cargo));
}
function sameForumUser(a, b) { return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase(); }
function safeForumRoleForActor(actor) { return normalizeRole(actor?.cargo); }
function replyIdentity(reply) {
  if (!reply || typeof reply !== 'object') return '';
  if (reply.id != null) return `id:${reply.id}`;
  if (reply.author && reply.createdAt != null) return `${String(reply.author).toLowerCase()}|${reply.createdAt}`;
  return `${String(reply.author||'').toLowerCase()}|${String(reply.createdAt||reply.date||'')}|${String(reply.content||'')}`;
}
function mergeMemberReplies(currentReplies, proposedReplies, actorName) {
  const out = Array.isArray(currentReplies) ? currentReplies.map(r => ({...r})) : [];
  const positions = new Map(out.map((r,i) => [replyIdentity(r), i]));
  for (const proposed of Array.isArray(proposedReplies) ? proposedReplies : []) {
    if (!sameForumUser(proposed?.author, actorName)) continue;
    const normalized = { ...proposed, author: actorName };
    const key = replyIdentity(normalized);
    if (key && positions.has(key)) {
      const idx = positions.get(key);
      if (sameForumUser(out[idx]?.author, actorName)) out[idx] = { ...out[idx], content:String(normalized.content||'').slice(0,20000) };
      continue;
    }
    normalized.cargo = 'Membro';
    out.push(normalized);
    if (key) positions.set(key, out.length - 1);
  }
  return out.slice(-1000);
}
function authorizeForumStateChange(currentState, proposedState, actor) {
  const current = sanitizeState(currentState || {});
  const proposed = sanitizeState(proposedState || {});
  if (isForumAdministrator(actor)) return proposed;

  const actorName = String(actor?.username || '').trim();
  const actorId = String(actor?.id ?? '');
  const moderator = isForumModerator(actor);
  const out = { ...current };
  out.savedAt = Date.now();
  // Estrutura global e moderação nunca são decididas pelo navegador de um membro.
  out.config = current.config || {};
  out.downloadItems = Array.isArray(current.downloadItems) ? current.downloadItems : [];
  const currentSubforums = Array.isArray(current.subforums) ? current.subforums : [];
  const requestedSubforumDeletes = new Set((proposed.deletedSubforumIds || []).map(String));
  if (moderator) {
    const proposedSubforums = Array.isArray(proposed.subforums) ? proposed.subforums : currentSubforums;
    out.subforums = proposedSubforums.filter(subforum => !requestedSubforumDeletes.has(String(subforum?.id)));
    out.deletedSubforumIds = [...new Set([...(current.deletedSubforumIds || []).map(String), ...requestedSubforumDeletes])];
  } else {
    out.subforums = currentSubforums;
    out.deletedSubforumIds = Array.isArray(current.deletedSubforumIds) ? current.deletedSubforumIds : [];
  }
  out.activityLog = Array.isArray(current.activityLog) ? current.activityLog : [];

  const currentUsers = Array.isArray(current.users) ? current.users : [];
  const proposedUsers = Array.isArray(proposed.users) ? proposed.users : [];
  out.users = currentUsers.map(existing => {
    if (!sameForumUser(existing?.username, actorName) && String(existing?.id ?? '') !== actorId) return existing;
    const mine = proposedUsers.find(u => sameForumUser(u?.username, actorName) || String(u?.id ?? '') === actorId) || {};
    return {
      ...existing,
      id: existing?.id ?? actor?.id,
      username: existing?.username || actorName,
      cargo: safeForumRoleForActor(actor),
      email: existing?.email || actor?.email || null,
      active: existing?.active !== false,
      displayName: String(mine.displayName || existing?.displayName || actorName).slice(0,32),
      avatar: String(mine.avatar || existing?.avatar || '').slice(0,200000),
      signature: String(mine.signature || existing?.signature || '').slice(0,1000),
      notifications: Array.isArray(mine.notifications) ? mine.notifications.slice(-300) : (existing?.notifications || [])
    };
  });
  if (!out.users.some(u => sameForumUser(u?.username, actorName) || String(u?.id ?? '') === actorId)) {
    const mine = proposedUsers.find(u => sameForumUser(u?.username, actorName) || String(u?.id ?? '') === actorId) || {};
    out.users.push({ id:actor?.id, username:actorName, displayName:String(mine.displayName||actorName).slice(0,32), email:actor?.email||null, cargo:safeForumRoleForActor(actor), active:true, emailVerified:true, avatar:String(mine.avatar||'').slice(0,200000), signature:String(mine.signature||'').slice(0,1000), notifications:[] });
  }
  out.deletedUserIds = Array.isArray(current.deletedUserIds) ? current.deletedUserIds : [];

  const allowedSubforums = new Map((out.subforums || []).map(sf => [String(sf.id), sf]));
  const proposedTopics = Array.isArray(proposed.topics) ? proposed.topics : [];
  const currentTopics = Array.isArray(current.topics) ? current.topics : [];
  const requestedDeletes = new Set((proposed.deletedTopicIds || []).map(Number));
  const acceptedDeletes = new Set((current.deletedTopicIds || []).map(Number));
  const resultTopics = [];

  for (const existing of currentTopics) {
    const id = Number(existing?.id);
    const mine = sameForumUser(existing?.author, actorName);
    if (requestedDeletes.has(id) && (mine || moderator)) { acceptedDeletes.add(id); continue; }
    const incoming = proposedTopics.find(t => Number(t?.id) === id);
    if (!incoming) { resultTopics.push(existing); continue; }
    if (mine || moderator) {
      const locked = Boolean(existing.resolved);
      const canModify = !locked;
      const canResolve = moderator && Boolean(incoming.resolved);
      resultTopics.push({
        ...existing,
        title:canModify ? String(incoming.title ?? existing.title ?? '').slice(0,180) : existing.title,
        content:canModify ? String(incoming.content ?? existing.content ?? '').slice(0,40000) : existing.content,
        author:existing.author || actorName,
        cargo:existing.cargo || safeForumRoleForActor(actor),
        pinned:moderator ? Boolean(incoming.pinned) : Boolean(existing.pinned),
        subforumId:moderator && allowedSubforums.has(String(incoming.subforumId)) ? incoming.subforumId : existing.subforumId,
        replies:canModify ? mergeMemberReplies(existing.replies, incoming.replies, actorName) : existing.replies,
        resolved:locked || canResolve,
        resolvedAt:locked ? existing.resolvedAt : (canResolve ? (incoming.resolvedAt || Date.now()) : undefined),
        resolvedBy:locked ? existing.resolvedBy : (canResolve ? (incoming.resolvedBy || actorName) : undefined)
      });
    } else {
      resultTopics.push({ ...existing, replies:mergeMemberReplies(existing.replies, incoming.replies, actorName) });
    }
  }

  for (const incoming of proposedTopics) {
    const id = Number(incoming?.id);
    if (currentTopics.some(t => Number(t?.id) === id) || !sameForumUser(incoming?.author, actorName)) continue;
    const sf = allowedSubforums.get(String(incoming?.subforumId || ''));
    if (!sf || (!moderator && String(sf.createTopicsAllowed || 'all') !== 'all')) continue;
    resultTopics.push({ ...incoming, author:actorName, cargo:safeForumRoleForActor(actor), pinned:false, title:String(incoming.title||'').slice(0,180), content:String(incoming.content||'').slice(0,40000), replies:mergeMemberReplies([], incoming.replies, actorName) });
  }
  out.topics = resultTopics.filter(t => !acceptedDeletes.has(Number(t?.id)));
  out.deletedTopicIds = [...acceptedDeletes];
  return out;
}
async function writeSharedState(state, actor) {
  let clean = sanitizeState(state);
  clean.savedAt = Date.now();
  if (!pool) {
    if (process.env.NODE_ENV === 'production') {
      const err = new Error('Persistência MySQL do fórum indisponível. Escrita recusada para evitar split-brain/perda de dados.');
      err.status = 503;
      throw err;
    }
    // Somente desenvolvimento local: compatibilidade com o snapshot antigo.
    fs.writeFileSync(STATE_FILE, JSON.stringify(clean, null, 2));
    return { ...clean, _revision: 0 };
  }
  const expected = Number(state?._baseRevision ?? state?._revision ?? 0);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute('SELECT state_json, revision FROM forum_state_snapshots WHERE id=1 FOR UPDATE');
    let currentState = {};
    if (rows.length) { try { currentState = JSON.parse(rows[0].state_json || '{}'); } catch {} }
    clean = authorizeForumStateChange(currentState, clean, actor);
    clean.savedAt = Date.now();
    if (!rows.length) await conn.execute('INSERT INTO forum_state_snapshots(id,state_json,revision,updated_by) VALUES(1,?,1,?)', [JSON.stringify(clean), String(actor?.username || '').slice(0,64)]);
    else {
      const currentRevision = Number(rows[0].revision || 0);
      if (expected && expected !== currentRevision) {
        let latest = {}; try { latest = JSON.parse(rows[0].state_json || '{}'); } catch {}
        await conn.rollback();
        return { conflict: true, state: { ...sanitizeState(latest), _revision: currentRevision } };
      }
      await conn.execute('UPDATE forum_state_snapshots SET state_json=?, revision=revision+1, updated_by=? WHERE id=1', [JSON.stringify(clean), String(actor?.username || '').slice(0,64)]);
    }
    await conn.execute('INSERT INTO forum_audit_log(actor_player_id,actor_username,action,meta_json) VALUES(?,?,?,?)', [actor?.id || null, String(actor?.username || '').slice(0,32) || null, 'forum_state_save', JSON.stringify({ expectedRevision: expected })]);
    await conn.commit();
    const [out] = await conn.execute('SELECT revision FROM forum_state_snapshots WHERE id=1');
    return { ...clean, _revision: Number(out[0]?.revision || 1) };
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally { conn.release(); }
}
async function publicSharedState(req) {
  const state = await readSharedState();
  const auth = getAuthUser(req);
  const canSeeEmails = auth && ['Fundador','Administrador'].includes(normalizeRole(auth.cargo));
  if (!canSeeEmails && Array.isArray(state.users)) state.users = state.users.map(u => { const x = { ...u }; delete x.email; return x; });
  return state;
}
function getPresenceSummary() {
  const now = Date.now();
  for (const [id, entry] of presenceSessions) if (!entry || now - entry.updatedAt > PRESENCE_TTL_MS) presenceSessions.delete(id);
  const users = [...new Set([...presenceSessions.values()].map(e => e.username).filter(Boolean))];
  return { onlineCount: users.length, users };
}
async function sendVerificationEmail(email, code, username) {
  if (!transporter) throw new Error('SMTP não configurado');
  const fromName = process.env.MAIL_FROM_NAME || 'Brazuca RP Fórum';
  const fromAddress = process.env.MAIL_FROM || process.env.SMTP_USER;
  await transporter.sendMail({
    from: `${fromName} <${fromAddress}>`, to: email, subject: 'Código de confirmação do Fórum Brazuca RP',
    html: `<div style="font-family:Arial;background:#020617;color:#fff;padding:24px;border-radius:16px"><h2 style="color:#00f0ff">Brazuca RP</h2><p>Olá, <b>${String(username || 'jogador').replace(/[<>]/g,'')}</b>.</p><p>Seu código:</p><div style="font-size:34px;letter-spacing:6px;color:#00f0ff;font-weight:800">${code}</div><p>Ele expira em 10 minutos.</p></div>`
  });
}

function playerKeyForum(name){ return String(name||'').trim().toLowerCase().replace(/[^a-z0-9_\-.]/g,'').slice(0,32); }
function requestIpKey(req){
  const raw = String(req.headers['cf-connecting-ip'] || req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim().replace(/^::ffff:/,'');
  if (!raw || raw === '::1' || raw === '127.0.0.1') return '';
  if (/^10\./.test(raw) || /^192\.168\./.test(raw) || /^172\.(1[6-9]|2\d|3[01])\./.test(raw)) return '';
  return raw.slice(0,64);
}
async function findApiPlayer(username){
  if(!mysqlEnabled || !pool) return null;
  const raw = String(username || '').trim();
  const key = playerKeyForum(raw);
  const [rows] = await pool.query('SELECT * FROM players WHERE username_key=? OR LOWER(username)=LOWER(?) OR LOWER(forum_email)=LOWER(?) LIMIT 1',[key, raw, raw]);
  return rows[0] || null;
}
async function verifyApiPassword(password, player){
  if(!player || !player.password_hash || !player.salt) return false;
  const stored = String(player.password_hash);
  let calculated = '';
  try {
    if (stored.startsWith('scrypt$')) calculated = 'scrypt$' + crypto.scryptSync(String(password), String(player.salt), 32, { N:16384, r:8, p:1 }).toString('hex');
    else calculated = crypto.createHash('sha256').update(String(player.salt)+':'+String(password)).digest('hex');
    const a = Buffer.from(calculated), b = Buffer.from(stored);
    return a.length === b.length && crypto.timingSafeEqual(a,b);
  } catch { return false; }
}

function publicForumUserFromPlayer(player, emailOverride){
  const forumRole = normalizeRole(player.admin_role ?? player.admin ?? player.staff ?? player.rank ?? 0);
  return {
    id: player.id, username: player.username, displayName: player.username,
    email: emailOverride || player.forum_email || player.email || null,
    cargo: forumRole, game_role: player.admin_role || player.admin || 0,
    isFounder: forumRole === 'Fundador', isAdmin: ['Fundador','Administrador'].includes(forumRole),
    whitelist: Number(player.forum_wl || player.whitelist || 0), source:'mysql-brazuca'
  };
}

async function routeApi(req, res, pathname) {
  if (pathname === '/api/auth-media' && req.method === 'POST') {
    const user = getAuthUser(req);
    if (!user || !['Fundador', 'Administrador'].includes(normalizeRole(user.cargo))) {
      return sendJson(res, 403, { ok:false, error:'Apenas administradores podem enviar a mídia de login.' });
    }
    const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    let content;
    let extension;
    if (/^(?:video\/(?:mp4|webm|ogg)|image\/(?:png|jpeg|webp|gif))$/.test(contentType)) {
      content = await readRawBody(req);
      extension = contentType.split('/')[1].replace('jpeg', 'jpg');
    } else {
      const body = await readBody(req);
      const dataUrl = String(body.data || '');
      const match = dataUrl.match(/^data:((?:video\/(?:mp4|webm|ogg)|image\/(?:png|jpeg|webp|gif)));base64,([A-Za-z0-9+/=]+)$/i);
      if (!match) return sendJson(res, 400, { ok:false, error:'Envie uma imagem PNG, JPG, WEBP, GIF ou vídeo MP4, WEBM ou OGG válido.' });
      content = Buffer.from(match[2], 'base64');
      extension = match[1].split('/')[1].toLowerCase().replace('jpeg', 'jpg');
    }
    const isImageUpload = /^image\//.test(contentType) || /^image\//.test(String(extension ? `image/${extension}` : ''));
    const maxUploadSize = isImageUpload ? 8 * 1024 * 1024 : 100 * 1024 * 1024;
    if (!content.length || content.length > maxUploadSize) return sendJson(res, 413, { ok:false, error:`A ${isImageUpload ? 'imagem' : 'mídia'} deve ter no máximo ${isImageUpload ? '8 MB' : '100 MB'}.` });
    await fs.promises.mkdir(AUTH_MEDIA_DIR, { recursive:true });
    const filename = `auth-media-${Date.now()}-${crypto.randomBytes(5).toString('hex')}.${extension}`;
    await fs.promises.writeFile(path.join(AUTH_MEDIA_DIR, filename), content, { flag:'wx' });
    return sendJson(res, 200, { ok:true, url:`/assets/uploads/${filename}`, type:isImageUpload ? 'image' : 'video' });
  }
  if (pathname === '/api/health') {
    if (!pool) return sendJson(res, 503, { ok:false, mysql:false, error:'MySQL não configurado', time:new Date().toISOString() });
    try {
      const [rows] = await pool.query('SELECT DATABASE() AS db');
      return sendJson(res, 200, { ok:true, mysql:true, connected:true, database:rows[0]?.db || null, time:new Date().toISOString() });
    } catch (e) {
      return sendJson(res, 503, { ok:false, mysql:true, connected:false, ...mysqlErrorInfo(e), time:new Date().toISOString() });
    }
  }
  if (pathname === '/api/brazuca/overview' && req.method === 'GET') {
    try { return sendJson(res, 200, { ok: true, data: await getGameOverview() }); }
    catch (e) { return sendJson(res, 200, { ok: false, data: { mysql: mysqlEnabled, connected: false, ...mysqlErrorInfo(e), online: getPresenceSummary().onlineCount } }); }
  }

  if (pathname === '/api/auth/forum-register' && req.method === 'POST') {
    if (!requireRateLimit(req, res, 'forum-register', 8)) return;
    if (!pool) return sendJson(res, 503, { ok:false, error:'Banco de dados indisponível.' });
    const body = await readBody(req);
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const email = String(body.email || '').trim().toLowerCase();
    await ensureBrazucaForumColumns();
    if (!username || !password || !email) return sendJson(res, 400, { ok:false, error:'Nome, senha e e-mail são obrigatórios.' });
    if (password.length < 6) return sendJson(res, 400, { ok:false, error:'A senha precisa ter pelo menos 6 caracteres.' });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return sendJson(res, 400, { ok:false, error:'E-mail inválido.' });
    const ipKey = requestIpKey(req);
    const player = await findApiPlayer(username);
    if (!player) return sendJson(res, 404, { ok:false, error:'Crie sua conta primeiro no Launcher/servidor Brazuca.' });
    if (!(await verifyApiPassword(password, player))) return sendJson(res, 401, { ok:false, error:'A senha precisa ser a mesma usada no Launcher/servidor.' });
    if (Number(player.forum_wl || 0) === 1) return sendJson(res, 409, { ok:false, error:'Sua WL já está liberada. Use a aba Entrar.' });

    if (ipKey) {
      const [ipRows] = await pool.query('SELECT id,username FROM players WHERE forum_wl=1 AND register_ip=? AND id<>? LIMIT 1', [ipKey, player.id]);
      if (ipRows.length) return sendJson(res, 409, { ok:false, error:'Este IP já liberou uma whitelist.' });
    }
    const [emailRows] = await pool.query('SELECT id,username FROM players WHERE forum_wl=1 AND LOWER(forum_email)=LOWER(?) AND id<>? LIMIT 1', [email, player.id]);
    if (emailRows.length) return sendJson(res, 409, { ok:false, error:'Este e-mail já está vinculado a outra conta com WL.' });
    if (!transporter) return sendJson(res, 503, { ok:false, error:'Confirmação por e-mail indisponível. Configure o SMTP do fórum.' });

    const code = String(crypto.randomInt(100000, 1000000));
    const codeHash = hashVerificationCode(code);
    await pool.query('DELETE FROM forum_email_verifications WHERE player_id=? OR LOWER(email)=LOWER(?)', [player.id, email]);
    await pool.query('INSERT INTO forum_email_verifications (player_id,username,email,code_hash,request_ip,expires_at) VALUES (?,?,?,?,?,DATE_ADD(NOW(),INTERVAL 10 MINUTE))', [player.id, player.username, email, codeHash, ipKey || null]);
    try {
      await sendVerificationEmail(email, code, player.username);
    } catch (e) {
      await pool.query('DELETE FROM forum_email_verifications WHERE player_id=?', [player.id]).catch(() => {});
      console.error('[SMTP] Falha ao enviar verificação:', e.message);
      return sendJson(res, 503, { ok:false, error:'Não foi possível enviar o código de confirmação. Verifique o SMTP do fórum.' });
    }
    return sendJson(res, 200, { ok:true, verification_required:true, username:player.username, email:maskEmail(email), expires_in:600, message:'Código de 6 dígitos enviado. Confirme o e-mail para liberar a WL.' });
  }

  if (pathname === '/api/auth/verify-code' && req.method === 'POST') {
    if (!requireRateLimit(req, res, 'verify-code', 12)) return;
    if (!pool) return sendJson(res, 503, { ok:false, error:'Banco de dados indisponível.' });
    const body = await readBody(req);
    const email = String(body.email || '').trim().toLowerCase();
    const username = String(body.username || '').trim();
    const code = String(body.code || '').trim();
    if (!email || !username || !/^\d{6}$/.test(code)) return sendJson(res, 400, { ok:false, error:'Informe usuário, e-mail e o código de 6 dígitos.' });
    await ensureBrazucaForumColumns();
    const [rows] = await pool.query('SELECT * FROM forum_email_verifications WHERE LOWER(email)=LOWER(?) AND LOWER(username)=LOWER(?) LIMIT 1', [email, username]);
    const pending = rows[0];
    if (!pending) return sendJson(res, 400, { ok:false, error:'Nenhuma confirmação pendente foi encontrada.' });
    if (new Date(pending.expires_at).getTime() <= Date.now()) {
      await pool.query('DELETE FROM forum_email_verifications WHERE id=?', [pending.id]);
      return sendJson(res, 400, { ok:false, error:'Código expirado. Faça o registro novamente para receber outro.' });
    }
    if (Number(pending.attempts || 0) >= 5) {
      await pool.query('DELETE FROM forum_email_verifications WHERE id=?', [pending.id]);
      return sendJson(res, 429, { ok:false, error:'Limite de tentativas atingido. Solicite um novo código.' });
    }
    const receivedHash = hashVerificationCode(code);
    const expected = Buffer.from(String(pending.code_hash), 'hex');
    const received = Buffer.from(receivedHash, 'hex');
    const valid = expected.length === received.length && crypto.timingSafeEqual(expected, received);
    if (!valid) {
      await pool.query('UPDATE forum_email_verifications SET attempts=attempts+1 WHERE id=?', [pending.id]);
      return sendJson(res, 400, { ok:false, error:'Código incorreto.' });
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [players] = await conn.query('SELECT * FROM players WHERE id=? FOR UPDATE', [pending.player_id]);
      const player = players[0];
      if (!player) throw new Error('Conta do jogador não encontrada.');
      const [emailRows] = await conn.query('SELECT id FROM players WHERE forum_wl=1 AND LOWER(forum_email)=LOWER(?) AND id<>? LIMIT 1', [pending.email, player.id]);
      if (emailRows.length) { const err = new Error('Este e-mail já foi vinculado a outra WL.'); err.statusCode = 409; throw err; }
      await conn.query('UPDATE players SET forum_email=?, forum_wl=1, forum_registered_at=COALESCE(forum_registered_at,NOW()), updated_at=NOW() WHERE id=?', [pending.email, player.id]);
      await conn.query('DELETE FROM forum_email_verifications WHERE player_id=?', [player.id]);
      await conn.commit();
      player.forum_email = pending.email; player.forum_wl = 1;
      const publicUser = publicForumUserFromPlayer(player, pending.email);
      const token = jwt.sign(publicUser, JWT_SECRET, { expiresIn:'7d' }); setAuthCookie(res, token);
      return sendJson(res, 200, { ok:true, whitelist:true, message:'E-mail confirmado e WL liberada com sucesso.', user:publicUser });
    } catch (e) {
      await conn.rollback().catch(() => {});
      return sendJson(res, e.statusCode || 500, { ok:false, error:e.statusCode ? e.message : 'Não foi possível concluir a liberação da WL.' });
    } finally { conn.release(); }
  }

  if (pathname === '/api/auth/resend-verification' && req.method === 'POST') {
    if (!requireRateLimit(req, res, 'resend-code', 4)) return;
    if (!pool || !transporter) return sendJson(res, 503, { ok:false, error:'Serviço de confirmação por e-mail indisponível.' });
    const body = await readBody(req);
    const username = String(body.username || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    if (!username || !email) return sendJson(res, 400, { ok:false, error:'Registro pendente não informado.' });
    await ensureBrazucaForumColumns();
    const [rows] = await pool.query('SELECT * FROM forum_email_verifications WHERE LOWER(email)=LOWER(?) AND LOWER(username)=LOWER(?) LIMIT 1', [email, username]);
    const pending = rows[0];
    if (!pending) return sendJson(res, 404, { ok:false, error:'Faça o registro novamente para solicitar outro código.' });
    const code = String(crypto.randomInt(100000, 1000000));
    await pool.query('UPDATE forum_email_verifications SET code_hash=?, attempts=0, expires_at=DATE_ADD(NOW(),INTERVAL 10 MINUTE), created_at=NOW() WHERE id=?', [hashVerificationCode(code), pending.id]);
    try { await sendVerificationEmail(pending.email, code, pending.username); }
    catch (e) { console.error('[SMTP] Falha ao reenviar verificação:', e.message); return sendJson(res, 503, { ok:false, error:'Falha ao reenviar o código.' }); }
    return sendJson(res, 200, { ok:true, email:maskEmail(pending.email), expires_in:600, message:'Novo código enviado. O anterior foi invalidado.' });
  }

  if (pathname === '/api/auth/send-verification' && req.method === 'POST') {
    return sendJson(res, 410, { ok:false, error:'Use o formulário de registro para solicitar um novo código de WL.' });
  }

  if (pathname === '/api/auth/login' && req.method === 'POST') {
    if (!requireRateLimit(req, res, 'login', 12)) return;
    const body = await readBody(req); const identifier = String(body.identifier || body.username || body.email || '').trim(); const password = String(body.password || '');
    if (!identifier || !password) return sendJson(res, 400, { ok: false, error: 'Nick/e-mail e senha são obrigatórios.' });
    await ensureBrazucaForumColumns();
    let user = null;
    let credentialsVerified = false;
    try { user = await findGameUser(identifier); } catch (e) { console.warn('Login MySQL falhou:', e.code || e.message); }
    if (user?.password) credentialsVerified = await verifyPassword(password, user.password);

    // A tabela oficial `players` é a fonte de verdade. Além de suportar o hash
    // scrypt atual da API, isso impede login sem senha quando um schema legado
    // não possui coluna de password e elimina o antigo fallback JSON/local.
    if (!credentialsVerified) {
      const apiPlayer = await findApiPlayer(identifier);
      if (apiPlayer && (await verifyApiPassword(password, apiPlayer))) {
        user = { ...publicForumUserFromPlayer(apiPlayer), money: apiPlayer.money, level: apiPlayer.level, skin: apiPlayer.character_skin || apiPlayer.skin };
        credentialsVerified = true;
      }
    }
    if (!user || !credentialsVerified) return sendJson(res, 401, { ok:false, error:'Conta ou senha inválida no banco do Brazuca.' });
    if (user.source && String(user.source).includes('mysql') && !Number(user.whitelist || 0)) return sendJson(res, 403, { ok:false, error:'Finalize o registro e confirme seu e-mail para liberar a WL.' });
    const databaseRole = normalizeRole(user.cargo);
    const forumRole = await getForumAssignedRole(user.username, databaseRole);
    const effectiveRole = resolveForumRole(databaseRole, forumRole);
    const publicUser = { id:user.id, username:user.username, displayName:user.displayName || user.username, email:user.email, cargo:effectiveRole, game_role:user.game_role || user.cargo, isFounder:effectiveRole === 'Fundador', isAdmin:['Fundador','Administrador'].includes(effectiveRole), rg:user.rg, money:user.money, level:user.level, skin:user.skin, whitelist:user.whitelist || 0, source:user.source };
    const token = jwt.sign(publicUser, JWT_SECRET, { expiresIn:'7d' }); setAuthCookie(res, token);
    return sendJson(res, 200, { ok:true, user:publicUser });
  }
  if (pathname === '/api/auth/me' && req.method === 'GET') {
    const user = getAuthUser(req); return user ? sendJson(res, 200, { ok:true, user }) : sendJson(res, 401, { ok:false, error:'não autenticado' });
  }
  if (pathname === '/api/auth/logout' && req.method === 'POST') { clearAuthCookie(res); return sendJson(res, 200, { ok:true }); }

  if (pathname === '/api/wl/status' && req.method === 'GET') {
    try {
      const user = getAuthUser(req); if (!user) return sendJson(res, 401, { ok:false, error:'não autenticado' });
      const freshPlayer = await findApiPlayer(user.username || user.email);
      const fresh = freshPlayer ? publicForumUserFromPlayer(freshPlayer) : user;
      return sendJson(res, 200, { ok:true, whitelist:Boolean(Number(fresh?.whitelist || 0)), user:fresh });
    } catch (e) { return sendJson(res, 400, { ok:false, error:'Não foi possível consultar a WL.' }); }
  }
  if (pathname === '/api/wl/request' && req.method === 'POST') {
    const user = getAuthUser(req); if (!user) return sendJson(res, 401, { ok:false, error:'não autenticado' });
    return sendJson(res, 409, { ok:false, error:'A WL é liberada automaticamente após confirmar o e-mail no registro.' });
  }
  if (pathname === '/api/forum-state') {
    if (req.method === 'GET') return sendJson(res, 200, await publicSharedState(req));
    if (req.method === 'POST') {
      const user = getAuthUser(req);
      if (!user) return sendJson(res, 401, { ok:false, error:'Faça login para sincronizar alterações do fórum.' });
      let freshPlayer;
      try { freshPlayer = await findApiPlayer(user.username || user.email); }
      catch (e) { const err = new Error('Não foi possível validar sua conta/cargo no MySQL. Alteração recusada.'); err.status = 503; throw err; }
      if (!freshPlayer) return sendJson(res, 403, { ok:false, error:'Conta do jogo não encontrada ou não está mais ativa.' });
      const actor = publicForumUserFromPlayer(freshPlayer);
      const databaseRole = normalizeRole(actor.cargo);
      const forumRole = await getForumAssignedRole(actor.username, databaseRole);
      actor.cargo = resolveForumRole(databaseRole, forumRole);
      const body = await readBody(req);
      const saved = await writeSharedState(body, actor);
      if (saved?.conflict) return sendJson(res, 409, { ok:false, error:'O fórum foi atualizado por outra sessão.', state:saved.state });
      return sendJson(res, 200, { ok:true, revision:saved._revision, savedAt:saved.savedAt });
    }
  }
  if (pathname === '/api/game/profile' && req.method === 'GET') {
    const user = getAuthUser(req);
    if (!user) return sendJson(res, 401, { ok:false, error:'não autenticado' });
    const player = await findApiPlayer(user.username || user.email);
    if (!player) return sendJson(res, 404, { ok:false, error:'Conta do jogo não encontrada.' });
    const playerId = Number(player.id);
    const [characters, bankAccounts, bankCards, bankHistory, vehicles, houses] = await Promise.all([
      tableExists('player_characters').then(ok => ok ? query('SELECT slot,name,age,gender,skin,money,bank,hunger,thirst,sleep,last_played,created_at FROM player_characters WHERE player_id=? ORDER BY slot',[playerId]) : []),
      tableExists('bank_accounts').then(ok => ok ? query('SELECT id,agency,account_number,account_type,status,opened_at FROM bank_accounts WHERE player_id=? LIMIT 1',[playerId]) : []),
      tableExists('bank_cards').then(ok => ok ? query('SELECT id,card_name,card_limit,invoice,status,created_at FROM bank_cards WHERE player_id=? ORDER BY id DESC LIMIT 8',[playerId]) : []),
      tableExists('bank_transactions').then(ok => ok ? query('SELECT type,amount,description,created_at FROM bank_transactions WHERE player_id=? OR target_player_id=? ORDER BY id DESC LIMIT 12',[playerId,playerId]) : []),
      tableExists('player_vehicles').then(ok => ok ? query('SELECT id,model,name,fuel,max_fuel,mileage,insurance,financed,finance_total,finance_paid,plate,stored,locked FROM player_vehicles WHERE player_id=? ORDER BY id DESC LIMIT 24',[playerId]) : []),
      tableExists('houses').then(ok => ok ? query('SELECT id,name,price,locked,interior_type FROM houses WHERE owner_player_id=? AND active=1 ORDER BY id DESC LIMIT 12',[playerId]) : [])
    ]);
    return sendJson(res, 200, { ok:true, account:{ username:player.username, level:Number(player.level||1), xp:Number(player.xp||0), money:Number(player.money||0), bank:Number(player.bank||0), role:player.admin_role||'NONE', whitelist:Number(player.forum_wl||0), selectedCharacterSlot:Number(player.selected_character_slot||1) }, characters, bank:{ account:bankAccounts[0]||null, cards:bankCards, history:bankHistory }, vehicles, houses });
  }
  if (pathname === '/api/presence') {
    if (req.method === 'GET') return sendJson(res, 200, getPresenceSummary());
    if (req.method === 'POST') { const body = await readBody(req); const id = String(body.sessionId || '').slice(0,96); if (!id) return sendJson(res, 400, { ok:false,error:'sessionId obrigatório'}); if (body.action === 'leave') presenceSessions.delete(id); else presenceSessions.set(id, { username:String(body.username || '').slice(0,32) || null, updatedAt:Date.now() }); return sendJson(res, 200, getPresenceSummary()); }
  }
  return false;
}

function serveStatic(req, res, pathname) {
  let urlPath = decodeURIComponent(pathname || '/');
  if (urlPath === '/' || urlPath === '') urlPath = '/Forum bcc.html';
  const safePath = path.resolve(ROOT, '.' + urlPath);
  if (safePath !== ROOT && !safePath.startsWith(ROOT + path.sep)) return sendText(res, 403, 'Forbidden');
  fs.stat(safePath, (err, stats) => {
    if (err || !stats.isFile()) return sendText(res, 404, '404 Not Found');
    const ext = path.extname(safePath).toLowerCase();
    const headers = { 'Content-Type': mime[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400' };
    const range = req.headers.range;
    if (range && /^bytes=\d*-\d*$/.test(range)) {
      const [startText, endText] = range.replace('bytes=', '').split('-');
      const start = startText ? Number(startText) : Math.max(0, stats.size - Number(endText || 0));
      const end = endText ? Number(endText) : stats.size - 1;
      if (start <= end && start >= 0 && end < stats.size) {
        headers['Accept-Ranges'] = 'bytes';
        headers['Content-Range'] = `bytes ${start}-${end}/${stats.size}`;
        headers['Content-Length'] = end - start + 1;
        res.writeHead(206, securityHeaders(headers));
        fs.createReadStream(safePath, { start, end }).pipe(res);
        return;
      }
    }
    headers['Accept-Ranges'] = 'bytes';
    headers['Content-Length'] = stats.size;
    res.writeHead(200, securityHeaders(headers));
    fs.createReadStream(safePath).pipe(res);
  });
}
const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (pathname.startsWith('/api/')) { const handled = await routeApi(req, res, pathname); if (handled !== false) return; }
    serveStatic(req, res, pathname);
  } catch (e) { sendJson(res, Number(e.status || 0) || (e.message === 'Payload muito grande' ? 413 : 400), { ok: false, error: e.message || 'requisição inválida' }); }
});
async function start() {
  if (!pool && process.env.NODE_ENV === 'production') throw new Error('MySQL obrigatório em produção. Configure DB_HOST/DB_USER/DB_PASSWORD/DB_NAME.');
  if (pool) {
    try { await pool.query('SELECT 1'); await ensureBrazucaForumColumns(); }
    catch (e) {
      const info = mysqlErrorInfo(e); console.error(`[MySQL] ${info.code}: ${info.error} ${info.hint}`);
      if (process.env.NODE_ENV === 'production') throw e;
    }
  }
  server.listen(PORT, '0.0.0.0', () => console.log(`Forum Brazuca RP rodando em http://0.0.0.0:${PORT} | MySQL configurado: ${mysqlEnabled ? 'SIM' : 'NÃO'}`));
}
start().catch(err => { console.error('[forum] Falha fatal na inicialização:', err.message); process.exitCode = 1; });
