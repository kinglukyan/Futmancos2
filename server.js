import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const env = (name, fallback = '') => process.env[name] ?? fallback;
const port = Number(env('PORT', '3000'));
const supabaseUrl = env('SUPABASE_URL');
const supabaseServiceKey = env('SUPABASE_SERVICE_ROLE_KEY');
const supabase = supabaseUrl && supabaseServiceKey
  ? createClient(supabaseUrl, supabaseServiceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  : null;

const app = express();
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const monthKey = (date = new Date()) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit'
}).format(date);
const saoPauloDay = (date = new Date()) => Number(new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Sao_Paulo', day: '2-digit'
}).format(date));
const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
const userPublic = row => ({
  id: row.id, name: row.name, email: row.email, phone: row.phone, age: row.age,
  pos: row.position, foot: row.foot, height: row.height, photo: row.photo || '',
  isAdmin: !!row.is_admin, paidMonth: row.paid_month || ''
});

async function setting(key) {
  if (!supabase) return null;
  const { data, error } = await supabase.from('settings').select('value').eq('key', key).maybeSingle();
  if (error) throw error;
  return data?.value ?? null;
}
async function saveSetting(key, value) {
  const { error } = await supabase.from('settings').upsert({ key, value: String(value) }, { onConflict: 'key' });
  if (error) throw error;
}
async function getFee() {
  return Number(await setting('monthly_fee')) || Number(env('MONTHLY_FEE', '50.00'));
}
function billingStatus(row, fee, now = new Date()) {
  const month = monthKey(now), day = saoPauloDay(now);
  if (row.paid_month === month) return { status: 'paid', month, paidMonth: row.paid_month, dueDay: 12, fee };
  return { status: day <= 12 ? 'pending' : 'overdue', month, paidMonth: row.paid_month || '', dueDay: 12, fee };
}

// Every API request is authorized with the Supabase access token. No local
// session or database file is required, so Render's free filesystem is safe.
async function authenticate(req, res, next) {
  if (!supabase) return res.status(503).json({ error: 'O servidor precisa da URL do Supabase e da chave secreta de servidor.' });
  const token = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Entre na sua conta para continuar.' });
  try {
    const { data: authData, error: authError } = await supabase.auth.getUser(token);
    if (authError || !authData.user) return res.status(401).json({ error: 'Sua sessão expirou. Entre novamente.' });
    const { data: profile, error: profileError } = await supabase.from('profiles').select('*').eq('id', authData.user.id).maybeSingle();
    if (profileError) throw profileError;
    if (!profile) return res.status(409).json({ error: 'Perfil não encontrado no Supabase. Confira a configuração do cadastro.' });
    req.user = profile;
    next();
  } catch (error) {
    next(error);
  }
}
function requireAdmin(req, res, next) {
  if (!req.user?.is_admin) return res.status(403).json({ error: 'Acesso restrito à administração.' });
  next();
}
function requireDatabase(req, res, next) {
  if (!supabase) return res.status(503).json({ error: 'Configure SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no servidor.' });
  next();
}

app.get('/api/health', (_req, res) => res.status(supabase ? 200 : 503).json({ ok: !!supabase }));
app.get('/api/auth/me', authenticate, (_req, res) => res.json({ user: userPublic(_req.user) }));
app.post('/api/auth/logout', (_req, res) => res.json({ ok: true }));

app.post('/api/auth/sync', requireDatabase, async (req, res, next) => {
  const token = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Entre na conta do Supabase para continuar.' });
  try {
    const { data: authData, error: authError } = await supabase.auth.getUser(token);
    if (authError || !authData.user?.email) return res.status(401).json({ error: 'Sessão Supabase inválida ou expirada.' });
    const { data: profile, error } = await supabase.from('profiles').select('*').eq('id', authData.user.id).maybeSingle();
    if (error) throw error;
    if (!profile) return res.status(409).json({ error: 'Perfil não encontrado. Verifique se a migração de perfis foi executada no Supabase.' });
    res.json({ user: userPublic(profile) });
  } catch (error) { next(error); }
});

app.get('/api/payments/status', authenticate, requireDatabase, async (req, res, next) => {
  try { res.json(billingStatus(req.user, await getFee())); } catch (error) { next(error); }
});

app.get('/api/shared-state', authenticate, requireDatabase, async (req, res, next) => {
  try {
    const { data: row, error } = await supabase.from('app_state').select('state_json,updated_at').eq('id', 1).maybeSingle();
    if (error) throw error;
    const state = row?.state_json || null;
    if (state && !req.user.is_admin) state.players = state.players.map(({ phone, paid, paidMonth, paymentStatus, ...player }) => player);
    res.json({ state, updatedAt: row?.updated_at || null });
  } catch (error) { next(error); }
});
app.put('/api/shared-state', authenticate, requireAdmin, requireDatabase, async (req, res, next) => {
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
    monthlyFee: Number(incoming.monthlyFee) || await getFee(),
    nextGame: incoming.nextGame && typeof incoming.nextGame === 'object' ? incoming.nextGame : null
  };
  try {
    const updatedAt = new Date().toISOString();
    const { error } = await supabase.from('app_state').upsert({ id: 1, state_json: state, updated_at: updatedAt }, { onConflict: 'id' });
    if (error) throw error;
    res.json({ ok: true, updatedAt });
  } catch (error) { next(error); }
});

async function attendanceRows(day) {
  const { data: rows, error } = await supabase.from('baba_attendance').select('kind,user_id,created_at').eq('game_day', day).order('created_at');
  if (error) throw error;
  if (!rows.length) return [];
  const ids = [...new Set(rows.map(row => row.user_id))];
  const { data: profiles, error: profileError } = await supabase.from('profiles').select('id,email,name,position').in('id', ids);
  if (profileError) throw profileError;
  const byId = new Map(profiles.map(profile => [profile.id, profile]));
  return rows.map(row => ({ row, profile: byId.get(row.user_id) })).filter(item => item.profile)
    .sort((a, b) => a.row.created_at.localeCompare(b.row.created_at) || a.profile.name.localeCompare(b.profile.name))
    .map(({ row, profile }) => ({ kind: row.kind, userId: profile.id, email: profile.email, name: profile.name, position: profile.position }));
}
app.get('/api/baba/attendance', authenticate, requireDatabase, async (req, res, next) => {
  const day = String(req.query.date || '');
  if (!validDate(day)) return res.status(400).json({ error: 'Informe a data do baba.' });
  try { res.json({ attendees: await attendanceRows(day) }); } catch (error) { next(error); }
});
app.post('/api/baba/attendance', authenticate, requireDatabase, async (req, res, next) => {
  const day = String(req.body?.date || ''), kind = String(req.body?.kind || '');
  if (!validDate(day) || !['presence', 'checkin'].includes(kind)) return res.status(400).json({ error: 'Informe o baba e a ação de presença corretamente.' });
  try {
    const { data: existing, error: existingError } = await supabase.from('baba_attendance').select('id').eq('game_day', day).eq('user_id', req.user.id).eq('kind', 'presence').maybeSingle();
    if (existingError) throw existingError;
    if (kind === 'presence' && existing) {
      const { error } = await supabase.from('baba_attendance').delete().eq('game_day', day).eq('user_id', req.user.id);
      if (error) throw error;
    } else if (kind === 'checkin') {
      if (!existing) return res.status(409).json({ error: 'Marque presença no grupo antes de fazer o check-in.' });
      const { error } = await supabase.from('baba_attendance').upsert({ game_day: day, user_id: req.user.id, kind }, { onConflict: 'game_day,user_id,kind', ignoreDuplicates: true });
      if (error) throw error;
    } else {
      const { error } = await supabase.from('baba_attendance').upsert({ game_day: day, user_id: req.user.id, kind }, { onConflict: 'game_day,user_id,kind', ignoreDuplicates: true });
      if (error) throw error;
    }
    res.json({ attendees: await attendanceRows(day) });
  } catch (error) { next(error); }
});

app.get('/api/baba/votes', authenticate, requireDatabase, async (req, res, next) => {
  const day = String(req.query.date || '');
  if (!validDate(day)) return res.status(400).json({ error: 'Informe a data da votação.' });
  try {
    const { data: rows, error } = await supabase.from('baba_votes').select('player_email,attr_key,stars,voter_id').eq('game_day', day);
    if (error) throw error;
    res.json({ votes: rows.map(row => ({ playerEmail: row.player_email, attrKey: row.attr_key, stars: row.stars })), myVotes: rows.filter(row => row.voter_id === req.user.id).map(row => ({ playerEmail: row.player_email, attrKey: row.attr_key, stars: row.stars })) });
  } catch (error) { next(error); }
});
app.post('/api/baba/votes', authenticate, requireDatabase, async (req, res, next) => {
  const day = String(req.body?.date || ''), playerEmail = String(req.body?.playerEmail || '').trim().toLowerCase();
  const attrKey = String(req.body?.attrKey || ''), stars = Number(req.body?.stars);
  if (!validDate(day) || !playerEmail || !['rit', 'dri', 'chu', 'def', 'pas', 'fis'].includes(attrKey) || !Number.isInteger(stars) || stars < 1 || stars > 5) return res.status(400).json({ error: 'Os dados do voto não são válidos.' });
  try {
    const { data: closedGames, error: gamesError } = await supabase.from('baba_matches').select('game_data').eq('game_day', day).eq('voting_open', true);
    if (gamesError) throw gamesError;
    if (!closedGames.length) return res.status(409).json({ error: 'O ADM ainda não encerrou os jogos desse dia.' });
    const { data: attendance, error: attendanceError } = await supabase.from('baba_attendance').select('id').eq('game_day', day).eq('user_id', req.user.id).eq('kind', 'checkin').maybeSingle();
    if (attendanceError) throw attendanceError;
    const emailsInGame = email => closedGames.some(row => (row.game_data?.checkedInEmails || []).some(item => String(item).toLowerCase() === email));
    if (!attendance && !emailsInGame(req.user.email.toLowerCase())) return res.status(403).json({ error: 'Somente jogadores com check-in neste baba podem votar.' });
    if (playerEmail === req.user.email.toLowerCase()) return res.status(400).json({ error: 'Você não pode votar na sua própria cartinha.' });
    if (!emailsInGame(playerEmail)) return res.status(404).json({ error: 'O jogador avaliado não está na lista de check-in deste baba.' });
    const { error } = await supabase.from('baba_votes').insert({ game_day: day, voter_id: req.user.id, player_email: playerEmail, attr_key: attrKey, stars });
    if (error?.code === '23505') return res.status(409).json({ error: 'Você já votou neste atributo para esse jogador neste baba.' });
    if (error) throw error;
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.get('/api/baba/matches', authenticate, requireDatabase, async (_req, res, next) => {
  try {
    const { data: rows, error } = await supabase.from('baba_matches').select('game_data,voting_open').order('game_day', { ascending: false }).order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ matches: rows.map(row => ({ ...row.game_data, votingOpen: row.voting_open })) });
  } catch (error) { next(error); }
});
app.post('/api/admin/baba/matches', authenticate, requireAdmin, requireDatabase, async (req, res, next) => {
  const match = req.body?.match;
  if (!match || !match.id || !validDate(match.gameDay)) return res.status(400).json({ error: 'Informe uma partida e uma data válidas.' });
  try {
    const { data: existing, error: findError } = await supabase.from('baba_matches').select('voting_open').eq('id', String(match.id)).maybeSingle();
    if (findError) throw findError;
    const { error } = await supabase.from('baba_matches').upsert({ id: String(match.id), game_day: match.gameDay, game_data: match, voting_open: existing?.voting_open || false }, { onConflict: 'id' });
    if (error) throw error;
    res.json({ ok: true, id: String(match.id) });
  } catch (error) { next(error); }
});
app.put('/api/admin/baba/matches/:date/close', authenticate, requireAdmin, requireDatabase, async (req, res, next) => {
  const date = String(req.params.date || '');
  if (!validDate(date)) return res.status(400).json({ error: 'Informe uma data válida.' });
  try {
    const { data, error } = await supabase.from('baba_matches').update({ voting_open: true }).eq('game_day', date).select('id');
    if (error) throw error;
    if (!data.length) return res.status(404).json({ error: 'Não há jogos salvos para essa data.' });
    res.json({ ok: true, games: data.length });
  } catch (error) { next(error); }
});

app.get('/api/admin/members', authenticate, requireAdmin, requireDatabase, async (_req, res, next) => {
  try {
    const [{ data: rows, error }, fee] = await Promise.all([supabase.from('profiles').select('*').order('name'), getFee()]);
    if (error) throw error;
    res.json({ members: rows.map(row => ({ ...userPublic(row), paymentStatus: billingStatus(row, fee).status })) });
  } catch (error) { next(error); }
});
app.delete('/api/admin/members/:id', authenticate, requireAdmin, requireDatabase, async (req, res, next) => {
  const memberId = String(req.params.id || '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(memberId)) {
    return res.status(400).json({ error: 'Identificador de associado invÃ¡lido.' });
  }
  if (memberId === req.user.id) return res.status(409).json({ error: 'VocÃª nÃ£o pode excluir a prÃ³pria conta de administrador.' });
  try {
    const { data: member, error: memberError } = await supabase.from('profiles').select('id,name,email,is_admin').eq('id', memberId).maybeSingle();
    if (memberError) throw memberError;
    if (!member) return res.status(404).json({ error: 'Associado nÃ£o encontrado.' });

    if (member.is_admin) {
      const { count, error: countError } = await supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('is_admin', true);
      if (countError) throw countError;
      if ((count ?? 0) <= 1) return res.status(409).json({ error: 'NÃ£o Ã© possÃ­vel excluir o Ãºltimo administrador da associaÃ§Ã£o.' });
    }

    // Remove the account's cached roster and attendance references before the
    // Auth deletion, while preserving historical match records and finances.
    const { data: stateRow, error: stateReadError } = await supabase.from('app_state').select('state_json,updated_at').eq('id', 1).maybeSingle();
    if (stateReadError) throw stateReadError;
    let previousState = null;
    let cleanedState = null;
    if (stateRow?.state_json) {
      previousState = stateRow.state_json;
      const players = Array.isArray(previousState.players) ? previousState.players : [];
      const email = String(member.email || '').toLowerCase();
      const belongsToMember = player => String(player.serverId || player.authUserId || '') === memberId || (!!email && String(player.email || '').toLowerCase() === email);
      const localIds = new Set(players.filter(belongsToMember).map(player => String(player.id)));
      cleanedState = {
        ...previousState,
        players: players.filter(player => !belongsToMember(player)),
        presentPlayers: (Array.isArray(previousState.presentPlayers) ? previousState.presentPlayers : []).filter(id => !localIds.has(String(id))),
        checkedInPlayers: (Array.isArray(previousState.checkedInPlayers) ? previousState.checkedInPlayers : []).filter(id => !localIds.has(String(id)))
      };
      const { error: stateWriteError } = await supabase.from('app_state').update({ state_json: cleanedState, updated_at: new Date().toISOString() }).eq('id', 1);
      if (stateWriteError) throw stateWriteError;
    }

    const { error: deleteError } = await supabase.auth.admin.deleteUser(memberId);
    if (deleteError) {
      if (previousState) await supabase.from('app_state').update({ state_json: previousState, updated_at: stateRow.updated_at }).eq('id', 1);
      throw deleteError;
    }
    res.json({ ok: true, id: memberId, name: member.name });
  } catch (error) { next(error); }
});
function validatePhoto(photo) {
  return !photo || (/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(photo) && photo.length <= 500_000);
}
app.put('/api/profile/photo', authenticate, requireDatabase, async (req, res, next) => {
  const photo = String(req.body?.photo || '');
  if (!validatePhoto(photo)) return res.status(400).json({ error: 'A foto deve ser PNG, JPG ou WebP e ter até 350 KB.' });
  try {
    const { error } = await supabase.from('profiles').update({ photo }).eq('id', req.user.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (error) { next(error); }
});
app.put('/api/admin/members/:id/photo', authenticate, requireAdmin, requireDatabase, async (req, res, next) => {
  const photo = String(req.body?.photo || '');
  if (!validatePhoto(photo)) return res.status(400).json({ error: 'A foto deve ser PNG, JPG ou WebP e ter até 350 KB.' });
  try {
    const { data: member, error: findError } = await supabase.from('profiles').select('id').eq('id', req.params.id).maybeSingle();
    if (findError) throw findError;
    if (!member) return res.status(404).json({ error: 'Associado não encontrado.' });
    const { error } = await supabase.from('profiles').update({ photo }).eq('id', member.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.put('/api/admin/members/:id/payment', authenticate, requireAdmin, requireDatabase, async (req, res, next) => {
  try {
    const { data: member, error: findError } = await supabase.from('profiles').select('id').eq('id', req.params.id).maybeSingle();
    if (findError) throw findError;
    if (!member) return res.status(404).json({ error: 'Associado não encontrado.' });
    const month = monthKey();
    const { error } = await supabase.from('profiles').update({ paid_month: month }).eq('id', member.id);
    if (error) throw error;
    res.json({ ok: true, month, status: 'paid' });
  } catch (error) { next(error); }
});
app.put('/api/admin/monthly-fee', authenticate, requireAdmin, requireDatabase, async (req, res, next) => {
  const amount = Number(req.body?.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10000) return res.status(400).json({ error: 'Informe um valor mensal válido.' });
  try {
    const fee = Math.round(amount * 100) / 100;
    await saveSetting('monthly_fee', fee);
    res.json({ monthlyFee: fee });
  } catch (error) { next(error); }
});
app.put('/api/admin/payment-info', authenticate, requireAdmin, requireDatabase, async (req, res, next) => {
  const pixKey = String(req.body?.pixKey || '').trim();
  const qrDataUrl = String(req.body?.qrDataUrl || '');
  if (pixKey.length > 200) return res.status(400).json({ error: 'A chave Pix deve ter no máximo 200 caracteres.' });
  if (qrDataUrl && (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(qrDataUrl) || qrDataUrl.length > 900_000)) return res.status(400).json({ error: 'O QR Code deve ser uma imagem PNG, JPG ou WebP com até aproximadamente 650 KB.' });
  try {
    const { error } = await supabase.from('settings').upsert([{ key: 'pix_key', value: pixKey }, { key: 'pix_qr_data_url', value: qrDataUrl }], { onConflict: 'key' });
    if (error) throw error;
    res.json({ ok: true, pixKey, hasQr: !!qrDataUrl });
  } catch (error) { next(error); }
});
app.get('/api/config', requireDatabase, async (_req, res, next) => {
  try {
    const [monthlyFee, pixKey, pixQrDataUrl] = await Promise.all([getFee(), setting('pix_key'), setting('pix_qr_data_url')]);
    res.json({ monthlyFee, whatsapp: env('WHATSAPP_ADMIN', '5575998572594'), pixKey: pixKey || '', pixQrDataUrl: pixQrDataUrl || '' });
  } catch (error) { next(error); }
});

app.use((error, _req, res, _next) => {
  console.error('Futmancos API error:', error);
  res.status(500).json({ error: 'O servidor não conseguiu concluir a solicitação. Confira as tabelas e as variáveis do Supabase.' });
});

app.listen(port, '0.0.0.0', () => console.log(`Futmancos API listening on ${port}`));
