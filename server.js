import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import session from 'express-session';
import connectSqlite3 from 'connect-sqlite3';
import Database from 'better-sqlite3';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const env = (name, fallback = '') => process.env[name] ?? fallback;
const port = Number(env('PORT', '3000'));
const appOrigin = env('APP_ORIGIN', `http://localhost:${port}`);
const dbFile = path.resolve(__dirname, env('DATABASE_FILE', './data/futmancos.sqlite'));
fs.mkdirSync(path.dirname(dbFile), { recursive: true });
const db = new Database(dbFile);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0,
    auth_user_id TEXT UNIQUE,
    phone TEXT NOT NULL DEFAULT '', age INTEGER NOT NULL DEFAULT 0,
    position TEXT NOT NULL DEFAULT 'Meio-Campo', foot TEXT NOT NULL DEFAULT 'Direita',
    height REAL NOT NULL DEFAULT 1.7, paid_month TEXT NOT NULL DEFAULT '',
    photo TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS app_state (id INTEGER PRIMARY KEY CHECK (id=1), state_json TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS baba_attendance (
    game_day TEXT NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('presence','checkin')), created_at TEXT NOT NULL,
    PRIMARY KEY (game_day,user_id,kind)
  );
  CREATE TABLE IF NOT EXISTS baba_votes (
    game_day TEXT NOT NULL, voter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    player_email TEXT NOT NULL, attr_key TEXT NOT NULL, stars INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
    created_at TEXT NOT NULL,
    PRIMARY KEY (game_day,voter_id,player_email,attr_key)
  );
  CREATE TABLE IF NOT EXISTS baba_matches (
    id TEXT PRIMARY KEY, game_day TEXT NOT NULL, game_data TEXT NOT NULL,
    voting_open INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
`);
if (!db.prepare('PRAGMA table_info(users)').all().some(column => column.name === 'auth_user_id')) {
  db.exec('ALTER TABLE users ADD COLUMN auth_user_id TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_auth_user_id_unique ON users(auth_user_id)');
}
if (!db.prepare('PRAGMA table_info(users)').all().some(column => column.name === 'photo')) db.exec("ALTER TABLE users ADD COLUMN photo TEXT NOT NULL DEFAULT ''");

const app = express();
const SQLiteStore = connectSqlite3(session);
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '5mb' }));
app.use(session({
  store: new SQLiteStore({ db: path.basename(dbFile), dir: path.dirname(dbFile) }),
  name: 'futmancos.sid', secret: env('SESSION_SECRET', 'development-only-change-me'),
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: env('NODE_ENV') === 'production', maxAge: 1000 * 60 * 60 * 24 * 14 }
}));
app.use(express.static(path.join(__dirname, 'public')));

const monthKey = (date = new Date()) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit'
}).format(date);
const saoPauloDay = (date = new Date()) => Number(new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Sao_Paulo', day: '2-digit'
}).format(date));
let fee = Number(db.prepare('SELECT value FROM settings WHERE key=?').get('monthly_fee')?.value || env('MONTHLY_FEE', '50.00'));
const supabaseUrl = env('SUPABASE_URL');
const supabaseAnonKey = env('SUPABASE_ANON_KEY');

const userPublic = row => ({ id: row.id, name: row.name, email: row.email, phone: row.phone, age: row.age, pos: row.position, foot: row.foot, height: row.height, photo: row.photo || '', isAdmin: !!row.is_admin, paidMonth: row.paid_month });
const currentUser = req => req.session.userId ? db.prepare('SELECT * FROM users WHERE id=?').get(req.session.userId) : null;
const requireUser = (req, res, next) => { req.user = currentUser(req); if (!req.user) return res.status(401).json({ error: 'Entre na sua conta para continuar.' }); next(); };
const requireAdmin = (req, res, next) => { if (!req.user?.is_admin) return res.status(403).json({ error: 'Acesso restrito à administração.' }); next(); };

app.get('/api/auth/me', (req, res) => {
  const row = currentUser(req);
  res.json({ user: row ? userPublic(row) : null });
});
app.post('/api/auth/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));

app.post('/api/auth/sync', async (req, res) => {
  if (!supabaseUrl || !supabaseAnonKey) return res.status(503).json({ error: 'Configure a URL do Supabase e a chave anon no servidor.' });
  const token = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Entre na conta do Supabase para continuar.' });
  try {
    const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data: authData, error: authError } = await supabaseUser.auth.getUser(token);
    if (authError || !authData.user?.email) return res.status(401).json({ error: 'Sessão Supabase inválida ou expirada.' });
    const authUser = authData.user;
    const { data: profile, error: profileError } = await supabaseUser.from('profiles')
      .select('id,email,name,phone,age,position,foot,height,is_admin').eq('id', authUser.id).single();
    if (profileError || !profile) return res.status(409).json({ error: 'Perfil não encontrado. Verifique se a tabela e o gatilho do Supabase foram instalados.' });
    const email = authUser.email.toLowerCase();
    let local = db.prepare('SELECT * FROM users WHERE auth_user_id=?').get(authUser.id)
      || db.prepare('SELECT * FROM users WHERE lower(email)=?').get(email);
    if (local) {
      db.prepare('UPDATE users SET auth_user_id=?,name=?,email=?,is_admin=?,phone=?,age=?,position=?,foot=?,height=? WHERE id=?')
        .run(authUser.id, profile.name, email, profile.is_admin ? 1 : 0, profile.phone || '', profile.age || 0, profile.position || 'Meio-Campo', profile.foot || 'Direita', profile.height || 1.7, local.id);
    } else {
      const inserted = db.prepare('INSERT INTO users (auth_user_id,name,email,password_hash,is_admin,phone,age,position,foot,height,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(authUser.id, profile.name, email, '', profile.is_admin ? 1 : 0, profile.phone || '', profile.age || 0, profile.position || 'Meio-Campo', profile.foot || 'Direita', profile.height || 1.7, new Date().toISOString());
      local = db.prepare('SELECT * FROM users WHERE id=?').get(Number(inserted.lastInsertRowid));
    }
    req.session.userId = local.id;
    res.json({ user: userPublic(db.prepare('SELECT * FROM users WHERE id=?').get(local.id)) });
  } catch {
    res.status(502).json({ error: 'Não foi possível sincronizar sua conta do Supabase.' });
  }
});

function billingStatus(row, now = new Date()) {
  const month = monthKey(now), day = saoPauloDay(now);
  if (row.paid_month === month) return { status: 'paid', month, paidMonth: row.paid_month, dueDay: 12, fee };
  return { status: day <= 12 ? 'pending' : 'overdue', month, paidMonth: row.paid_month, dueDay: 12, fee };
}
app.get('/api/payments/status', requireUser, (req, res) => res.json(billingStatus(req.user)));
app.get('/api/shared-state', requireUser, (req, res) => {
  const row = db.prepare('SELECT state_json,updated_at FROM app_state WHERE id=1').get();
  const state = row ? JSON.parse(row.state_json) : null;
  if (state && !req.user.is_admin) state.players = state.players.map(({ phone, paid, paidMonth, paymentStatus, ...player }) => player);
  res.json({ state, updatedAt: row?.updated_at || null });
});
app.put('/api/shared-state', requireUser, requireAdmin, (req, res) => {
  const incoming = req.body?.state;
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return res.status(400).json({ error: 'Os dados compartilhados enviados não são válidos.' });
  const state = {
    players: Array.isArray(incoming.players) ? incoming.players.map(({ pass, password, ...player }) => player) : [],
    arenas: Array.isArray(incoming.arenas) ? incoming.arenas : [],
    transactions: Array.isArray(incoming.transactions) ? incoming.transactions : [],
    matchHistory: Array.isArray(incoming.matchHistory) ? incoming.matchHistory : [],
    presentPlayers: Array.isArray(incoming.presentPlayers) ? incoming.presentPlayers : [],
    checkedInPlayers: Array.isArray(incoming.checkedInPlayers) ? incoming.checkedInPlayers : [],
    mediaLinks: incoming.mediaLinks && typeof incoming.mediaLinks === 'object' ? incoming.mediaLinks : {},
    monthlyFee: Number(incoming.monthlyFee) || fee,
    nextGame: incoming.nextGame && typeof incoming.nextGame === 'object' ? incoming.nextGame : null
  };
  const updatedAt = new Date().toISOString();
  db.prepare('INSERT INTO app_state (id,state_json,updated_at) VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET state_json=excluded.state_json,updated_at=excluded.updated_at')
    .run(JSON.stringify(state), updatedAt);
  res.json({ ok: true, updatedAt });
});
app.get('/api/baba/attendance', requireUser, (req, res) => {
  const day = String(req.query.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return res.status(400).json({ error: 'Informe a data do baba.' });
  const rows = db.prepare('SELECT a.kind,u.id,u.email,u.name,u.position FROM baba_attendance a JOIN users u ON u.id=a.user_id WHERE a.game_day=? ORDER BY a.created_at,u.name').all(day);
  res.json({ attendees: rows.map(row => ({ kind: row.kind, userId: row.id, email: row.email, name: row.name, position: row.position })) });
});
app.post('/api/baba/attendance', requireUser, (req, res) => {
  const day = String(req.body?.date || ''), kind = String(req.body?.kind || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !['presence','checkin'].includes(kind)) return res.status(400).json({ error: 'Informe o baba e a ação de presença corretamente.' });
  const now = new Date().toISOString();
  if (kind === 'presence') {
    const existing = db.prepare('SELECT 1 FROM baba_attendance WHERE game_day=? AND user_id=? AND kind=?').get(day, req.user.id, 'presence');
    db.transaction(() => {
      if (existing) db.prepare('DELETE FROM baba_attendance WHERE game_day=? AND user_id=?').run(day, req.user.id);
      else db.prepare('INSERT OR IGNORE INTO baba_attendance (game_day,user_id,kind,created_at) VALUES (?,?,?,?)').run(day, req.user.id, kind, now);
    })();
  } else {
    const present = db.prepare('SELECT 1 FROM baba_attendance WHERE game_day=? AND user_id=? AND kind=?').get(day, req.user.id, 'presence');
    if (!present) return res.status(409).json({ error: 'Marque presença no grupo antes de fazer o check-in.' });
    db.prepare('INSERT OR IGNORE INTO baba_attendance (game_day,user_id,kind,created_at) VALUES (?,?,?,?)').run(day, req.user.id, kind, now);
  }
  const rows = db.prepare('SELECT a.kind,u.id,u.email,u.name,u.position FROM baba_attendance a JOIN users u ON u.id=a.user_id WHERE a.game_day=? ORDER BY a.created_at,u.name').all(day);
  res.json({ attendees: rows.map(row => ({ kind: row.kind, userId: row.id, email: row.email, name: row.name, position: row.position })) });
});
app.get('/api/baba/votes', requireUser, (req, res) => {
  const day = String(req.query.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return res.status(400).json({ error: 'Informe a data da votação.' });
  const rows = db.prepare('SELECT player_email,attr_key,stars,voter_id FROM baba_votes WHERE game_day=?').all(day);
  res.json({ votes: rows.map(row => ({ playerEmail: row.player_email, attrKey: row.attr_key, stars: row.stars })), myVotes: rows.filter(row => row.voter_id === req.user.id).map(row => ({ playerEmail: row.player_email, attrKey: row.attr_key, stars: row.stars })) });
});
app.post('/api/baba/votes', requireUser, (req, res) => {
  const day = String(req.body?.date || ''), playerEmail = String(req.body?.playerEmail || '').trim().toLowerCase();
  const attrKey = String(req.body?.attrKey || ''), stars = Number(req.body?.stars);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !playerEmail || !['rit','dri','chu','def','pas','fis'].includes(attrKey) || !Number.isInteger(stars) || stars < 1 || stars > 5) return res.status(400).json({ error: 'Os dados do voto não são válidos.' });
  const closedGames = db.prepare('SELECT game_data FROM baba_matches WHERE game_day=? AND voting_open=1').all(day);
  if (!closedGames.length) return res.status(409).json({ error: 'O ADM ainda não encerrou os jogos desse dia.' });
  const attended = db.prepare('SELECT 1 FROM baba_attendance WHERE game_day=? AND user_id=? AND kind="checkin"').get(day, req.user.id);
  const wasCheckedIn = closedGames.some(row => { try { return (JSON.parse(row.game_data).checkedInEmails || []).map(email => String(email).toLowerCase()).includes(req.user.email.toLowerCase()); } catch { return false; } });
  if (!attended && !wasCheckedIn) return res.status(403).json({ error: 'Somente jogadores com check-in neste baba podem votar.' });
  if (playerEmail === req.user.email.toLowerCase()) return res.status(400).json({ error: 'Você não pode votar na sua própria cartinha.' });
  const targetCheckedIn = closedGames.some(row => { try { return (JSON.parse(row.game_data).checkedInEmails || []).map(email => String(email).toLowerCase()).includes(playerEmail); } catch { return false; } });
  if (!targetCheckedIn) return res.status(404).json({ error: 'O jogador avaliado não está na lista de check-in deste baba.' });
  try {
    db.prepare('INSERT INTO baba_votes (game_day,voter_id,player_email,attr_key,stars,created_at) VALUES (?,?,?,?,?,?)').run(day, req.user.id, playerEmail, attrKey, stars, new Date().toISOString());
  } catch (error) {
    if (String(error.code || '').startsWith('SQLITE_CONSTRAINT')) return res.status(409).json({ error: 'Você já votou neste atributo para esse jogador neste baba.' });
    throw error;
  }
  res.json({ ok: true });
});
app.get('/api/baba/matches', requireUser, (req, res) => {
  const rows = db.prepare('SELECT game_data,voting_open FROM baba_matches ORDER BY game_day DESC, created_at DESC').all();
  res.json({ matches: rows.map(row => ({ ...JSON.parse(row.game_data), votingOpen: !!row.voting_open })) });
});
app.post('/api/admin/baba/matches', requireUser, requireAdmin, (req, res) => {
  const match = req.body?.match;
  if (!match || !match.id || !/^\d{4}-\d{2}-\d{2}$/.test(String(match.gameDay || ''))) return res.status(400).json({ error: 'Informe uma partida e uma data válidas.' });
  const id = String(match.id), gameDay = String(match.gameDay), now = new Date().toISOString();
  db.prepare('INSERT INTO baba_matches (id,game_day,game_data,voting_open,created_at) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET game_data=excluded.game_data')
    .run(id, gameDay, JSON.stringify(match), match.votingOpen ? 1 : 0, now);
  res.json({ ok: true, id });
});
app.put('/api/admin/baba/matches/:date/close', requireUser, requireAdmin, (req, res) => {
  const date = String(req.params.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Informe uma data válida.' });
  const result = db.prepare('UPDATE baba_matches SET voting_open=1 WHERE game_day=?').run(date);
  if (!result.changes) return res.status(404).json({ error: 'Não há jogos salvos para essa data.' });
  res.json({ ok: true, games: result.changes });
});

app.get('/api/admin/members', requireUser, requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT id,name,email,phone,is_admin,paid_month,created_at FROM users ORDER BY name').all();
  res.json({ members: rows.map(row => ({ ...userPublic(row), paymentStatus: billingStatus(row).status })) });
});
app.put('/api/profile/photo', requireUser, (req, res) => {
  const photo = String(req.body?.photo || '');
  if (photo && (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(photo) || photo.length > 500_000)) return res.status(400).json({ error: 'A foto deve ser PNG, JPG ou WebP e ter até 350 KB.' });
  db.prepare('UPDATE users SET photo=? WHERE id=?').run(photo, req.user.id);
  res.json({ ok: true });
});
app.put('/api/admin/members/:id/photo', requireUser, requireAdmin, (req, res) => {
  const photo = String(req.body?.photo || '');
  const member = db.prepare('SELECT id FROM users WHERE id=?').get(req.params.id);
  if (!member) return res.status(404).json({ error: 'Associado não encontrado.' });
  if (photo && (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(photo) || photo.length > 500_000)) return res.status(400).json({ error: 'A foto deve ser PNG, JPG ou WebP e ter até 350 KB.' });
  db.prepare('UPDATE users SET photo=? WHERE id=?').run(photo, member.id);
  res.json({ ok: true });
});

app.put('/api/admin/members/:id/payment', requireUser, requireAdmin, (req, res) => {
  const member = db.prepare('SELECT id FROM users WHERE id=?').get(req.params.id);
  if (!member) return res.status(404).json({ error: 'Associado não encontrado.' });
  const month = monthKey();
  db.prepare('UPDATE users SET paid_month=? WHERE id=?').run(month, member.id);
  res.json({ ok: true, month, status: 'paid' });
});

app.put('/api/admin/monthly-fee', requireUser, requireAdmin, (req, res) => {
  const amount = Number(req.body?.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10000) return res.status(400).json({ error: 'Informe um valor mensal válido.' });
  fee = Math.round(amount * 100) / 100;
  db.prepare('INSERT INTO settings (key,value) VALUES ("monthly_fee",?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(String(fee));
  res.json({ monthlyFee: fee });
});

app.put('/api/admin/payment-info', requireUser, requireAdmin, (req, res) => {
  const pixKey = String(req.body?.pixKey || '').trim();
  const qrDataUrl = String(req.body?.qrDataUrl || '');
  if (pixKey.length > 200) return res.status(400).json({ error: 'A chave Pix deve ter no máximo 200 caracteres.' });
  if (qrDataUrl && (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(qrDataUrl) || qrDataUrl.length > 900_000)) {
    return res.status(400).json({ error: 'O QR Code deve ser uma imagem PNG, JPG ou WebP com até aproximadamente 650 KB.' });
  }
  db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('pix_key', pixKey);
  db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('pix_qr_data_url', qrDataUrl);
  res.json({ ok: true, pixKey, hasQr: !!qrDataUrl });
});

app.get('/api/config', (req, res) => res.json({
  monthlyFee: fee,
  whatsapp: env('WHATSAPP_ADMIN', '5575998572594'),
  pixKey: db.prepare('SELECT value FROM settings WHERE key=?').get('pix_key')?.value || '',
  pixQrDataUrl: db.prepare('SELECT value FROM settings WHERE key=?').get('pix_qr_data_url')?.value || ''
}));
app.listen(port, () => console.log(`Futmancos API listening on ${port}`));


