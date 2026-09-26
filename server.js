import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCipheriv, createHmac, randomBytes, createHash, timingSafeEqual, randomUUID, randomInt } from 'node:crypto';
import express from 'express';
import helmet from 'helmet';
import webpush from 'web-push';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const env = (name, fallback = '') => process.env[name] ?? fallback;
const port = Number(env('PORT', '3000'));
const supabaseUrl = env('SUPABASE_URL');
const supabaseServiceKey = env('SUPABASE_SERVICE_ROLE_KEY');
const adminDeleteCode = env('ADMIN_DELETE_CODE', '8630');
const vapidPublicKey = env('VAPID_PUBLIC_KEY');
const vapidPrivateKey = env('VAPID_PRIVATE_KEY');
const pushEnabled = !!(vapidPublicKey && vapidPrivateKey);
const guestInviteAttempts = new Map();
const leagueMatchLocks = new Set();
if (pushEnabled) webpush.setVapidDetails(env('VAPID_SUBJECT', 'mailto:santoslucasalmeida@gmail.com'), vapidPublicKey, vapidPrivateKey);
const supabase = supabaseUrl && supabaseServiceKey
  ? createClient(supabaseUrl, supabaseServiceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  : null;
function guestCpfHash(cpf) { return createHmac('sha256', supabaseServiceKey || 'missing-server-secret').update(cpf).digest('hex'); }
function encryptGuestCpf(cpf) {
  const key = createHash('sha256').update(`${supabaseServiceKey || 'missing-server-secret'}:futmancos-guest-cpf:v1`).digest();
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(cpf, 'utf8'), cipher.final()]);
  return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${encrypted.toString('base64')}`;
}
function isValidCpf(value) {
  const cpf = String(value || '').replace(/\D/g, '');
  if (!/^\d{11}$/.test(cpf) || /^([0-9])\1{10}$/.test(cpf)) return false;
  for (let length = 9; length <= 10; length++) {
    let sum = 0;
    for (let i = 0; i < length; i++) sum += Number(cpf[i]) * (length + 1 - i);
    const digit = (sum * 10) % 11 % 10;
    if (digit !== Number(cpf[length])) return false;
  }
  return true;
}
async function sendPushUsers(userIds, eventKey, notification) {
  if (!pushEnabled || !supabase || !userIds.length) return;
  const uniqueIds = [...new Set(userIds.filter(Boolean))];
  const [{ data: subscriptions, error: subError }, { data: sentRows, error: sentError }, { data: preferenceRows, error: preferenceError }] = await Promise.all([
    supabase.from('push_subscriptions').select('user_id,endpoint,subscription').in('user_id', uniqueIds),
    supabase.from('notification_deliveries').select('user_id').eq('event_key', eventKey).in('user_id', uniqueIds),
    supabase.from('member_notification_preferences').select('user_id,preferences').in('user_id', uniqueIds)
  ]);
  if (subError) throw subError; if (sentError) throw sentError; if (preferenceError) throw preferenceError;
  const alreadySent = new Set((sentRows || []).map(row => row.user_id));
  const preferencesByUser = new Map((preferenceRows || []).map(row => [row.user_id, row.preferences || {}]));
  const category = String(notification.category || 'baba');
  const targets = (subscriptions || []).filter(item => !alreadySent.has(item.user_id) && preferencesByUser.get(item.user_id)?.[category] !== false);
  const succeeded = new Set();
  await Promise.all(targets.map(async item => {
    try { await webpush.sendNotification(item.subscription, JSON.stringify(notification)); succeeded.add(item.user_id); }
    catch (error) {
      if (error.statusCode === 404 || error.statusCode === 410) await supabase.from('push_subscriptions').delete().eq('endpoint', item.endpoint);
      else console.warn('Falha ao enviar notificação push:', error.message);
    }
  }));
  if (succeeded.size) {
    const rows = [...succeeded].map(user_id => ({ event_key: eventKey, user_id }));
    const { error } = await supabase.from('notification_deliveries').upsert(rows, { onConflict: 'event_key,user_id', ignoreDuplicates: true });
    if (error) throw error;
  }
}
async function sendPushAll(eventKey, notification, exceptUserId = '') {
  if (!pushEnabled || !supabase) return;
  const { data, error } = await supabase.from('push_subscriptions').select('user_id');
  if (error) throw error;
  await sendPushUsers((data || []).map(row => row.user_id).filter(id => id !== exceptUserId), eventKey, notification);
}

const app = express();
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '8mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const monthKey = (date = new Date()) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit'
}).format(date);
const saoPauloDay = (date = new Date()) => Number(new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Sao_Paulo', day: '2-digit'
}).format(date));
const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
const userPublic = row => ({
  id: row.id, name: row.name, nickname: row.nickname || '', email: row.email, phone: row.phone, age: row.age,
  pos: row.position, foot: row.foot, height: row.height, shirt: Number(row.shirt_number) || 0, photo: row.photo || '',
  isAdmin: !!row.is_admin, paidMonth: row.paid_month || ''
});
const isDemoMember = member => {
  const email = String(member?.email || '').toLowerCase();
  const name = String(member?.name || '').trim().toLowerCase();
  return ['lukyan@futmancos.com', 'mateus@futmancos.com'].includes(email) || ['lukyan', 'mateus'].includes(name);
};

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
async function recordCashTransaction(transaction) {
  const { data: row, error: readError } = await supabase.from('app_state').select('state_json').eq('id', 1).maybeSingle();
  if (readError) throw readError;
  const state = row?.state_json || {}, entries = Array.isArray(state.transactions) ? state.transactions : [];
  if (!entries.some(entry => String(entry.id) === String(transaction.id))) state.transactions = [transaction, ...entries];
  else state.transactions = entries;
  const { error } = await supabase.from('app_state').upsert({ id: 1, state_json: state, updated_at: new Date().toISOString() }, { onConflict: 'id' });
  if (error) throw error;
}
async function auditAdminAction(actor, action, entityType, entityId, summary, details = {}) {
  const { error } = await supabase.from('admin_audit_logs').insert({
    actor_id: actor.id, actor_name: actor.name || actor.email || 'Administrador', action,
    entity_type: entityType, entity_id: String(entityId ?? ''), summary, details
  });
  if (error) throw error;
}
async function getFee() {
  return Number(await setting('monthly_fee')) || Number(env('MONTHLY_FEE', '50.00'));
}
function billingStatus(row, fee, now = new Date()) {
  if (String(row?.position || '').toLowerCase().includes('goleiro')) return { status: 'exempt', month: monthKey(now), paidMonth: row.paid_month || '', dueDay: 12, fee: 0 };
  const month = monthKey(now), day = saoPauloDay(now);
  if (row.paid_month === month) return { status: 'paid', month, paidMonth: row.paid_month, dueDay: 12, fee };
  return { status: day <= 12 ? 'pending' : 'overdue', month, paidMonth: row.paid_month || '', dueDay: 12, fee };
}

function leaguePairKey(a, b) { return [String(a), String(b)].sort().join('::'); }
function leagueStandings(league) {
  const table = new Map((league?.participants || []).map(player => [String(player.id), {
    id: String(player.id), name: player.nickname || player.name || 'Jogador', position: player.position || 'Meio-Campo',
    played: 0, wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0, goalDifference: 0, points: 0,
    fatigue: Number(player.fatigue) || 0, trophies: Number(league?.trophies?.[player.id]) || 0
  }]));
  const completed = (league?.matches || []).filter(match => match.status === 'completed');
  for (const match of completed) {
    const home = table.get(String(match.homePlayerId)), away = table.get(String(match.awayPlayerId));
    if (!home || !away) continue;
    const hg = Number(match.homeGoals) || 0, ag = Number(match.awayGoals) || 0;
    home.played++; away.played++; home.goalsFor += hg; home.goalsAgainst += ag; away.goalsFor += ag; away.goalsAgainst += hg;
    if (hg > ag) { home.wins++; home.points += 3; away.losses++; }
    else if (hg < ag) { away.wins++; away.points += 3; home.losses++; }
    else { home.draws++; away.draws++; home.points++; away.points++; }
  }
  for (const row of table.values()) row.goalDifference = row.goalsFor - row.goalsAgainst;
  const rows = [...table.values()];
  const sortBase = (a, b) => b.points - a.points || b.goalDifference - a.goalDifference || b.goalsFor - a.goalsFor;
  rows.sort((a, b) => sortBase(a, b) || a.name.localeCompare(b.name, 'pt-BR'));
  for (let start = 0; start < rows.length;) {
    let end = start + 1;
    while (end < rows.length && sortBase(rows[start], rows[end]) === 0) end++;
    if (end - start > 1) {
      const tied = rows.slice(start, end), ids = new Set(tied.map(row => row.id)), mini = new Map(tied.map(row => [row.id, { points: 0, gd: 0 }]));
      for (const match of completed) {
        const homeId = String(match.homePlayerId), awayId = String(match.awayPlayerId);
        if (!ids.has(homeId) || !ids.has(awayId)) continue;
        const hg = Number(match.homeGoals) || 0, ag = Number(match.awayGoals) || 0;
        mini.get(homeId).gd += hg - ag; mini.get(awayId).gd += ag - hg;
        if (hg > ag) mini.get(homeId).points += 3; else if (hg < ag) mini.get(awayId).points += 3; else { mini.get(homeId).points++; mini.get(awayId).points++; }
      }
      tied.sort((a, b) => mini.get(b.id).points - mini.get(a.id).points || mini.get(b.id).gd - mini.get(a.id).gd || a.name.localeCompare(b.name, 'pt-BR'));
      rows.splice(start, tied.length, ...tied);
    }
    start = end;
  }
  return rows;
}
function scheduleMissingLeagueFixtures(league) {
  league.participants ||= []; league.matches ||= [];
  const existingPairs = new Set(league.matches.map(match => leaguePairKey(match.homePlayerId, match.awayPlayerId)));
  const occupied = new Map();
  let maxRound = 0;
  for (const match of league.matches) {
    const round = Number(match.round) || 1; maxRound = Math.max(maxRound, round);
    if (!occupied.has(round)) occupied.set(round, new Set());
    occupied.get(round).add(String(match.homePlayerId)); occupied.get(round).add(String(match.awayPlayerId));
  }
  const firstNewRound = maxRound ? maxRound + 1 : 1;
  const added = [];
  for (let i = 0; i < league.participants.length; i++) for (let j = i + 1; j < league.participants.length; j++) {
    const home = league.participants[i], away = league.participants[j], pair = leaguePairKey(home.id, away.id);
    if (existingPairs.has(pair)) continue;
    let round = firstNewRound;
    while (occupied.get(round)?.has(String(home.id)) || occupied.get(round)?.has(String(away.id))) round++;
    if (!occupied.has(round)) occupied.set(round, new Set());
    occupied.get(round).add(String(home.id)); occupied.get(round).add(String(away.id));
    const fixture = { id: randomUUID(), round, homePlayerId: String(home.id), awayPlayerId: String(away.id), status: 'pending', createdAt: new Date().toISOString() };
    league.matches.push(fixture); added.push(fixture); existingPairs.add(pair);
  }
  return added.length;
}
async function readLeagueData({ syncMembers = false } = {}) {
  const { data: row, error } = await supabase.from('app_state').select('state_json,updated_at').eq('id', 1).maybeSingle();
  if (error) throw error;
  const state = row?.state_json || {};
  let league = state.league;
  let changed = false;
  if (!league || typeof league !== 'object') {
    league = { season: 1, status: 'active', participants: [], matches: [], history: [], trophies: {}, createdAt: new Date().toISOString() };
    state.league = league; changed = true;
  }
  league.participants = Array.isArray(league.participants) ? league.participants : [];
  league.matches = Array.isArray(league.matches) ? league.matches : [];
  league.history = Array.isArray(league.history) ? league.history : [];
  league.trophies = league.trophies && typeof league.trophies === 'object' ? league.trophies : {};
  if (syncMembers && league.status === 'active') {
    const { data: profiles, error: profileError } = await supabase.from('profiles').select('id,name,nickname,position').order('name');
    if (profileError) throw profileError;
    const byId = new Map(league.participants.map(player => [String(player.id), player]));
    for (const profile of (profiles || []).filter(profile => !isDemoMember(profile))) {
      const id = String(profile.id), existing = byId.get(id);
      if (!existing) {
        const participant = { id, name: profile.name || 'Jogador', nickname: profile.nickname || '', position: profile.position || 'Meio-Campo', fatigue: 0, appearances: 0, joinedAt: new Date().toISOString() };
        league.participants.push(participant); byId.set(id, participant); changed = true;
      } else {
        const nickname = profile.nickname || '', name = profile.name || existing.name, position = profile.position || 'Meio-Campo';
        if (existing.name !== name || existing.nickname !== nickname || existing.position !== position) { Object.assign(existing, { name, nickname, position }); changed = true; }
      }
    }
    if (scheduleMissingLeagueFixtures(league)) changed = true;
  }
  let updatedAt = row?.updated_at || '';
  if (changed) {
    updatedAt = new Date().toISOString();
    const { error: writeError } = await supabase.from('app_state').upsert({ id: 1, state_json: state, updated_at: updatedAt }, { onConflict: 'id' });
    if (writeError) throw writeError;
  }
  return { state, league, updatedAt };
}
async function auditLeagueAdminAction(actor, action, entityId, summary, details) {
  try { await auditAdminAction(actor, action, 'league', entityId, summary, details); }
  catch (error) { console.warn('O campeonato foi salvo, mas o registro de auditoria não está disponível.', error.message); }
}

function leagueAttribute(player, key) {
  const votes = Array.isArray(player?.[`${key}Votes`]) ? player[`${key}Votes`].map(Number).filter(Number.isFinite) : [];
  return votes.length ? Math.round(votes.reduce((sum, value) => sum + value, 0) / votes.length) : 70;
}
function leagueOvr(player) {
  const keys = ['rit','dri','chu','def','pas','fis'];
  const average = keys.reduce((sum, key) => sum + leagueAttribute(player, key), 0) / keys.length;
  const bonus = Math.min(10, Math.floor((Number(player.goals || 0) * 1.5) + Number(player.assists || 0) + Number(player.saves || 0) * 1.2)) + Math.min(5, Math.floor(Number(player.days || 0) * .5));
  return Math.min(99, Math.round(average + bonus));
}
function leagueRole(slot, plan) {
  if (slot === 'gk') return 'gk';
  if (slot.startsWith('def')) return 'def';
  if (slot.startsWith('att')) return 'att';
  if (slot.startsWith('mid')) return 'mid';
  if (slot.startsWith('custom')) { const y = Number(plan.positions?.[slot]?.y ?? 50); return y < 40 ? 'att' : y < 62 ? 'mid' : 'def'; }
  return 'mid';
}
function leaguePositionPenalty(position, role) {
  const p = String(position || '').toLocaleLowerCase('pt-BR'), gk = p.includes('goleiro'), cb = p.includes('zagueiro'), fb = p.includes('lateral'), dm = p.includes('volante'), mid = p.includes('meio') && !dm, fw = p.includes('atacante');
  if (role === 'gk') return gk ? 0 : 50;
  if (gk) return 45;
  if (role === 'def') return cb ? 0 : fb ? 8 : dm ? 12 : mid ? 20 : fw ? 32 : 22;
  if (role === 'mid') return (dm || mid) ? 0 : fb ? 12 : fw ? 16 : cb ? 20 : 20;
  return fw ? 0 : mid ? 15 : dm ? 20 : fb ? 25 : cb ? 35 : 25;
}
function leagueTeamFromPlan(state, userId, league) {
  const plan = state.memberGamePlans?.[String(userId)];
  if (!plan?.slots || Object.keys(plan.slots).length !== 7 || !plan.slots.gk) throw Object.assign(new Error('Os dois associados precisam salvar um time completo com goleiro no Plano de Jogo.'), { status: 409 });
  const roster = Array.isArray(state.players) ? state.players : [], fatigueByCard = league.fatigueByCard || {};
  const used = new Set();
  const players = Object.entries(plan.slots).map(([slot, id]) => {
    const player = roster.find(item => [item.id, item.serverId, item.authUserId].some(value => value != null && String(value) === String(id)));
    if (!player || isDemoMember(player)) throw Object.assign(new Error('Um jogador do time salvo não está mais disponível. Atualize e salve novamente o Plano de Jogo.'), { status: 409 });
    const cardId = String(player.id), role = leagueRole(slot, plan), fatigue = Math.max(0, Math.min(100, Number(fatigueByCard[cardId]) || 0));
    used.add(cardId);
    const attrs = Object.fromEntries(['rit','dri','chu','def','pas','fis'].map(key => [key, leagueAttribute(player, key)]));
    const baseOvr = leagueOvr(player), effectiveOvr = Math.max(1, Math.round(baseOvr * (1 - leaguePositionPenalty(player.pos, role) / 100) * (1 - fatigue / 100)));
    return { id: cardId, name: String(player.nickname || player.name || 'Jogador'), position: String(player.pos || ''), role, baseOvr, effectiveOvr, fatigue, ...attrs };
  });
  const attack = players.reduce((sum, p) => sum + p.effectiveOvr * .32 + p.rit * .12 + p.dri * .18 + p.chu * .24 + p.pas * .14 + (p.role === 'att' ? 2 : 0), 0) / players.length;
  const defense = players.reduce((sum, p) => sum + p.effectiveOvr * .32 + p.def * .45 + p.fis * .23 + (p.role === 'gk' ? 4 : 0), 0) / players.length;
  return { formation: plan.formation, players, used: [...used], attack, defense };
}
function leaguePoisson(lambda) {
  const limit = Math.exp(-Math.max(.05, lambda)); let product = 1, goals = 0;
  do { goals++; product *= Math.random(); } while (product > limit && goals < 8);
  return Math.min(7, goals - 1);
}
function leagueSimulateTeams(home, away) {
  const homeLuck = .9 + Math.random() * .2, awayLuck = .9 + Math.random() * .2;
  const homeGoals = leaguePoisson(Math.max(.1, Math.min(4, 1.2 + (home.attack - away.defense) / 30)) * homeLuck);
  const awayGoals = leaguePoisson(Math.max(.1, Math.min(4, 1.2 + (away.attack - home.defense) / 30)) * awayLuck);
  const goalEvent = (team, side) => {
    const scorers = team.players.filter(player => player.role === 'att' || player.role === 'mid');
    const pool = scorers.length ? scorers : team.players.filter(player => player.role !== 'gk');
    const scorer = pool[randomInt(pool.length)];
    const helpers = team.players.filter(player => player.id !== scorer.id && player.role !== 'gk');
    const assist = helpers.length && Math.random() < .78 ? helpers[randomInt(helpers.length)] : null;
    return { side, scorer: scorer?.name || 'Jogador', assist: assist?.name || '' };
  };
  const events = [...Array(homeGoals)].map(() => goalEvent(home, 'home')).concat([...Array(awayGoals)].map(() => goalEvent(away, 'away'))).map((event, index) => ({ ...event, minute: 2 + index * 2 + randomInt(3) })).sort((a,b) => a.minute - b.minute);
  return { homeGoals, awayGoals, homeLuck, awayLuck, homeStrength: home.attack, awayStrength: away.attack, homeTeam: home, awayTeam: away, goalEvents: events };
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
async function requireBabaAccess(req, res, next) {
  if (req.user?.is_admin || String(req.user?.position || '').toLowerCase().includes('goleiro')) return next();
  try {
    const status = billingStatus(req.user, await getFee());
    if (status.status !== 'paid') return res.status(403).json({ code: 'BILLING_REQUIRED', error: 'A Central do Baba fica disponível após a confirmação da mensalidade. Acesse Mensalidades para regularizar.' });
    next();
  } catch (error) { next(error); }
}
function requireDatabase(req, res, next) {
  if (!supabase) return res.status(503).json({ error: 'Configure SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no servidor.' });
  next();
}

app.get('/api/health', (_req, res) => res.status(supabase ? 200 : 503).json({ ok: !!supabase }));
app.get('/api/auth/me', authenticate, (_req, res) => res.json({ user: userPublic(_req.user) }));
app.post('/api/auth/logout', (_req, res) => res.json({ ok: true }));

app.get('/api/me/guest-code', authenticate, requireDatabase, async (req, res, next) => {
  try {
    const { data: current, error } = await supabase.from('member_guest_codes').select('code').eq('member_id', req.user.id).maybeSingle();
    if (error) throw error;
    if (current) return res.json({ code: current.code });
    for (let attempt = 0; attempt < 25; attempt++) {
      const code = String(randomInt(100000, 1000000));
      const { data, error: insertError } = await supabase.from('member_guest_codes').insert({ member_id: req.user.id, code }).select('code').maybeSingle();
      if (!insertError && data) return res.status(201).json({ code: data.code });
      if (insertError?.code !== '23505') throw insertError;
      const { data: raced } = await supabase.from('member_guest_codes').select('code').eq('member_id', req.user.id).maybeSingle();
      if (raced) return res.json({ code: raced.code });
    }
    return res.status(503).json({ error: 'Não foi possível gerar um código agora. Tente novamente.' });
  } catch (error) { next(error); }
});
app.get('/api/me/notification-preferences', authenticate, requireDatabase, async (req, res, next) => {
  try {
    const { data, error } = await supabase.from('member_notification_preferences').select('preferences').eq('user_id', req.user.id).maybeSingle();
    if (error) throw error;
    res.json({ preferences: { baba: true, payments: true, votes: true, ...(data?.preferences || {}) } });
  } catch (error) { next(error); }
});
app.put('/api/me/notification-preferences', authenticate, requireDatabase, async (req, res, next) => {
  const input = req.body?.preferences || {};
  const preferences = Object.fromEntries(['baba', 'payments', 'votes'].map(key => [key, input[key] !== false]));
  try {
    const { error } = await supabase.from('member_notification_preferences').upsert({ user_id: req.user.id, preferences, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
    if (error) throw error;
    res.json({ preferences });
  } catch (error) { next(error); }
});
app.get('/api/push/public-key', (_req, res) => res.json({ enabled: pushEnabled, publicKey: pushEnabled ? vapidPublicKey : '' }));
app.post('/api/push/subscribe', authenticate, requireDatabase, async (req, res, next) => {
  const subscription = req.body?.subscription;
  const endpoint = String(subscription?.endpoint || '');
  if (!pushEnabled) return res.status(503).json({ error: 'As notificações do celular ainda não foram configuradas no servidor.' });
  if (!endpoint.startsWith('https://') || !subscription?.keys?.p256dh || !subscription?.keys?.auth) return res.status(400).json({ error: 'A assinatura do aparelho não é válida.' });
  try {
    const { error } = await supabase.from('push_subscriptions').upsert({ endpoint, user_id: req.user.id, subscription, updated_at: new Date().toISOString() }, { onConflict: 'endpoint' });
    if (error) throw error;
    res.json({ ok: true });
  } catch (error) { next(error); }
});
app.delete('/api/push/subscribe', authenticate, requireDatabase, async (req, res, next) => {
  const endpoint = String(req.body?.endpoint || '');
  try {
    const { error } = await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint).eq('user_id', req.user.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.post('/api/auth/registration-check', requireDatabase, async (req, res, next) => {
  const cpf = String(req.body?.cpf || '').replace(/\D/g, '');
  const answer = String(req.body?.associationAnswer || '').trim().toLocaleLowerCase('pt-BR');
  if (answer !== 'isaac') return res.status(403).json({ error: 'Resposta de validação incorreta.' });
  if (!isValidCpf(cpf)) return res.status(400).json({ error: 'Informe um CPF válido.' });
  try {
    const { data, error } = await supabase.from('profiles').select('id').eq('cpf_hash', guestCpfHash(cpf)).limit(1);
    if (error) throw error;
    if (data?.length) return res.status(409).json({ error: 'Este CPF já está cadastrado na associação.' });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.post('/api/auth/sync', requireDatabase, async (req, res, next) => {
  const token = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Entre na conta do Supabase para continuar.' });
  try {
    const { data: authData, error: authError } = await supabase.auth.getUser(token);
    if (authError || !authData.user?.email) return res.status(401).json({ error: 'Sessão Supabase inválida ou expirada.' });
    let profile;
    const { data: foundProfile, error } = await supabase.from('profiles').select('*').eq('id', authData.user.id).maybeSingle();
    if (error) throw error;
    profile = foundProfile;
    if (!profile) return res.status(409).json({ error: 'Perfil não encontrado. Verifique se a migração de perfis foi executada no Supabase.' });
    const metadata = authData.user.user_metadata || {};
    const signupNickname = String(metadata.nickname || '').trim().slice(0, 24);
    if (!String(profile.nickname || '').trim() && signupNickname) {
      const { data: updatedProfile, error: nicknameError } = await supabase.from('profiles').update({ nickname: signupNickname }).eq('id', profile.id).select('*').single();
      if (nicknameError) throw nicknameError;
      profile = updatedProfile;
    }
    const rawCpf = String(metadata.cpf || '').replace(/\D/g, '');
    if (!profile.cpf_hash && (rawCpf || metadata.emergency_contact_name || metadata.emergency_contact_phone || metadata.association_answer)) {
      if (String(metadata.association_answer || '').trim().toLocaleLowerCase('pt-BR') !== 'isaac') return res.status(403).json({ error: 'Resposta de validação da associação inválida.' });
      if (!isValidCpf(rawCpf)) return res.status(400).json({ error: 'O CPF informado no cadastro é inválido.' });
      if (!String(metadata.emergency_contact_name || '').trim() || !String(metadata.emergency_contact_phone || '').trim()) return res.status(400).json({ error: 'O nome e o telefone do contato de emergência são obrigatórios.' });
      const { data: duplicate, error: duplicateError } = await supabase.from('profiles').select('id').eq('cpf_hash', guestCpfHash(rawCpf)).neq('id', profile.id).limit(1);
      if (duplicateError) throw duplicateError;
      if (duplicate?.length) return res.status(409).json({ error: 'Este CPF já está cadastrado na associação.' });
      const { data: updatedProfile, error: saveError } = await supabase.from('profiles').update({ cpf_hash: guestCpfHash(rawCpf), cpf_encrypted: encryptGuestCpf(rawCpf), cpf_last4: rawCpf.slice(-4), emergency_contact_name: String(metadata.emergency_contact_name).trim(), emergency_contact_phone: String(metadata.emergency_contact_phone).trim() }).eq('id', profile.id).select('*').single();
      if (saveError) throw saveError;
      profile = updatedProfile;
      const safeMetadata = { ...metadata };
      delete safeMetadata.cpf; delete safeMetadata.emergency_contact_name; delete safeMetadata.emergency_contact_phone; delete safeMetadata.association_answer;
      const { error: cleanupError } = await supabase.auth.admin.updateUserById(authData.user.id, { user_metadata: safeMetadata });
      if (cleanupError) throw cleanupError;
    }
    res.json({ user: userPublic(profile) });
  } catch (error) { next(error); }
});

app.get('/api/payments/status', authenticate, requireDatabase, async (req, res, next) => {
  try {
    const status = billingStatus(req.user, await getFee());
    if (['pending', 'overdue'].includes(status.status)) await sendPushUsers([req.user.id], `billing-${status.status}:${status.month}`, { category: 'payments', title: status.status === 'overdue' ? 'Mensalidade em atraso' : 'Mensalidade pendente', body: status.status === 'overdue' ? 'Fale com um administrador para regularizar o pagamento.' : `A mensalidade vence no dia ${status.dueDay}. Confira a tela Mensalidades.`, url: '/' });
    res.json(status);
  } catch (error) { next(error); }
});

app.get('/api/shared-state', authenticate, requireDatabase, async (req, res, next) => {
  try {
    const { data: row, error } = await supabase.from('app_state').select('state_json,updated_at').eq('id', 1).maybeSingle();
    if (error) throw error;
    const state = row?.state_json || null;
    if (state) {
      delete state.memberGamePlans;
      const babaAccess = req.user.is_admin || String(req.user.position || '').toLowerCase().includes('goleiro') || billingStatus(req.user, await getFee()).status === 'paid';
      if (!babaAccess) { state.presentPlayers = []; state.checkedInPlayers = []; }
      state.players = Array.isArray(state.players) ? state.players.filter(player => !isDemoMember(player)) : [];
      const { data: profiles, error: profilesError } = await supabase.from('profiles').select('id,email,name,nickname,phone,age,position,foot,height,shirt_number,photo').order('name');
      if (profilesError) throw profilesError;
      for (const profile of profiles || []) {
        if (isDemoMember(profile)) continue;
        let player = state.players.find(item => [item.id, item.serverId, item.authUserId].some(id => id != null && String(id) === String(profile.id)) || String(item.email || '').toLowerCase() === String(profile.email || '').toLowerCase());
        if (!player) {
          player = { id: profile.id, goals: 0, assists: 0, saves: 0, matches: 0, days: 0, ritVotes: [70], driVotes: [70], chuVotes: [70], defVotes: [70], pasVotes: [70], fisVotes: [70], voteRecords: [] };
          state.players.push(player);
        }
        Object.assign(player, { id: profile.id, serverId: profile.id, authUserId: profile.id, name: profile.name, nickname: profile.nickname || '', email: profile.email, phone: profile.phone || '', age: Number(profile.age) || 0, pos: profile.position || 'Meio-Campo', foot: profile.foot || 'Direita', height: Number(profile.height) || 1.7, shirt: Number(profile.shirt_number) || 0, photo: profile.photo || player.photo || '' });
      }
      if (Array.isArray(state.transactions)) state.transactions = state.transactions.filter(item => String(item.desc || '') !== 'Mensalidade Lukyan');
      const rosterIds = new Set((row.state_json?.players || []).filter(isDemoMember).map(player => String(player.id)));
      if (Array.isArray(state.presentPlayers)) state.presentPlayers = state.presentPlayers.filter(id => !rosterIds.has(String(id)));
      if (Array.isArray(state.checkedInPlayers)) state.checkedInPlayers = state.checkedInPlayers.filter(id => !rosterIds.has(String(id)));
    }
    if (state && !req.user.is_admin) state.players = state.players.map(({ phone, paid, paidMonth, paymentStatus, ...player }) => player);
    res.json({ state, updatedAt: row?.updated_at || null });
  } catch (error) { next(error); }
});
app.put('/api/shared-state', authenticate, requireAdmin, requireDatabase, async (req, res, next) => {
  const incoming = req.body?.state;
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return res.status(400).json({ error: 'Os dados compartilhados enviados não são válidos.' });
  const state = {
    players: Array.isArray(incoming.players) ? incoming.players.filter(player => !isDemoMember(player)).map(({ pass, password, ...player }) => player) : [],
    arenas: Array.isArray(incoming.arenas) ? incoming.arenas : [],
    transactions: Array.isArray(incoming.transactions) ? incoming.transactions.filter(item => String(item.desc || '') !== 'Mensalidade Lukyan') : [],
    matchHistory: Array.isArray(incoming.matchHistory) ? incoming.matchHistory : [],
    presentPlayers: Array.isArray(incoming.presentPlayers) ? incoming.presentPlayers.filter(id => !(incoming.players || []).some(player => isDemoMember(player) && String(player.id) === String(id))) : [],
    checkedInPlayers: Array.isArray(incoming.checkedInPlayers) ? incoming.checkedInPlayers.filter(id => !(incoming.players || []).some(player => isDemoMember(player) && String(player.id) === String(id))) : [],
    mediaLinks: incoming.mediaLinks && typeof incoming.mediaLinks === 'object' ? incoming.mediaLinks : {},
    cardImageAdjustments: incoming.cardImageAdjustments && typeof incoming.cardImageAdjustments === 'object' ? incoming.cardImageAdjustments : {},
    monthlyFee: Number(incoming.monthlyFee) || await getFee(),
    nextGame: incoming.nextGame && typeof incoming.nextGame === 'object' ? incoming.nextGame : null,
    associationGallery: Array.isArray(incoming.associationGallery) ? incoming.associationGallery.slice(0, 100).filter(item => item && typeof item.url === 'string' && item.url.startsWith('https://')) : [],
  };
  try {
    const { data: previous, error: previousError } = await supabase.from('app_state').select('state_json').eq('id', 1).maybeSingle();
    if (previousError) throw previousError;
    const previousGame = previous?.state_json?.nextGame || null;
    state.league = previous?.state_json?.league || null;
    state.memberGamePlans = previous?.state_json?.memberGamePlans && typeof previous.state_json.memberGamePlans === 'object' ? previous.state_json.memberGamePlans : {};
    const gameWasChanged = JSON.stringify(previousGame) !== JSON.stringify(state.nextGame);
    const updatedAt = new Date().toISOString();
    const { error } = await supabase.from('app_state').upsert({ id: 1, state_json: state, updated_at: updatedAt }, { onConflict: 'id' });
    if (error) throw error;
    if (gameWasChanged && state.nextGame?.date) {
      const description = [state.nextGame.name, state.nextGame.date, state.nextGame.time, state.nextGame.address].filter(Boolean).join(' · ');
      const eventKey = `new-baba:${createHash('sha256').update(JSON.stringify(state.nextGame)).digest('hex').slice(0, 32)}`;
      await sendPushAll(eventKey, { category: 'baba', title: 'Novo baba marcado ou atualizado', body: description || 'Confira a data e o local do próximo baba.', url: '/' }, req.user.id);
    }
    res.json({ ok: true, updatedAt });
  } catch (error) { next(error); }
});

app.get('/api/league', authenticate, requireDatabase, async (_req, res, next) => {
  try {
    const { league } = await readLeagueData({ syncMembers: true });
    const myNotifications = (league.notifications || []).filter(item => item.userId === String(_req.user.id) && !item.read);
    res.json({ league, standings: leagueStandings(league), myNotifications });
  } catch (error) { next(error); }
});

app.post('/api/league/matches/:id/play', authenticate, requireDatabase, async (req, res, next) => {
  const lockKey = String(req.params.id);
  if (leagueMatchLocks.has(lockKey)) return res.status(409).json({ error: 'Esse confronto já está sendo jogado. Atualize a Mancos League.' });
  leagueMatchLocks.add(lockKey);
  try {
    const { state, league, updatedAt } = await readLeagueData();
    if (league.status !== 'active') return res.status(409).json({ error: 'O campeonato está encerrado.' });
    const match = league.matches.find(item => String(item.id) === String(req.params.id));
    if (!match) return res.status(404).json({ error: 'Confronto não encontrado.' });
    if (match.status === 'completed') return res.status(409).json({ error: 'Este confronto já foi encerrado.' });
    if (![String(match.homePlayerId), String(match.awayPlayerId)].includes(String(req.user.id))) return res.status(403).json({ error: 'Você só pode jogar um confronto do seu próprio time.' });
    const homeTeam = leagueTeamFromPlan(state, match.homePlayerId, league), awayTeam = leagueTeamFromPlan(state, match.awayPlayerId, league), simulation = leagueSimulateTeams(homeTeam, awayTeam);
    const now = new Date().toISOString();
    league.fatigueByCard ||= {};
    const allCards = new Set([...(state.players || []).filter(player => !isDemoMember(player)).map(player => String(player.id)), ...homeTeam.used, ...awayTeam.used]);
    for (const cardId of allCards) league.fatigueByCard[cardId] = Math.max(0, (Number(league.fatigueByCard[cardId]) || 0) - 2);
    for (const cardId of new Set([...homeTeam.used, ...awayTeam.used])) league.fatigueByCard[cardId] = Math.min(100, (Number(league.fatigueByCard[cardId]) || 0) + 10);
    match.status = 'completed'; match.homeGoals = simulation.homeGoals; match.awayGoals = simulation.awayGoals; match.playedAt = now;
    match.simulation = { homeStrength: simulation.homeStrength, awayStrength: simulation.awayStrength, homeLuck: simulation.homeLuck, awayLuck: simulation.awayLuck };
    match.goalEvents = simulation.goalEvents;
    match.lineups = { home: homeTeam.players.map(({id,name,position,role,effectiveOvr}) => ({id,name,position,role,effectiveOvr})), away: awayTeam.players.map(({id,name,position,role,effectiveOvr}) => ({id,name,position,role,effectiveOvr})) };
    for (const id of [match.homePlayerId, match.awayPlayerId]) { const member = league.participants.find(item => String(item.id) === String(id)); if (member) member.appearances = (Number(member.appearances) || 0) + 1; }
    const opponentId = String(req.user.id) === String(match.homePlayerId) ? String(match.awayPlayerId) : String(match.homePlayerId);
    const opponent = league.participants.find(item => String(item.id) === opponentId);
    league.notifications ||= [];
    const playerName = league.participants.find(item => String(item.id) === String(req.user.id))?.nickname || req.user.name || 'Seu adversário';
    const actorWon = simulation.homeGoals !== simulation.awayGoals && (simulation.homeGoals > simulation.awayGoals) === (String(req.user.id) === String(match.homePlayerId));
    const noticeBody = simulation.homeGoals === simulation.awayGoals ? `${playerName} empatou com você: ${simulation.homeGoals} × ${simulation.awayGoals}.` : actorWon ? `${playerName} venceu você: ${simulation.homeGoals} × ${simulation.awayGoals}.` : `${playerName} perdeu para você: ${simulation.homeGoals} × ${simulation.awayGoals}.`;
    const notice = { id: randomUUID(), userId: opponentId, matchId: match.id, title: 'Mancos League', body: noticeBody, createdAt: now, read: false };
    league.notifications.push(notice);
    league.notifications = league.notifications.slice(-300);
    const { data: committed, error } = await supabase.from('app_state').update({ state_json: state, updated_at: new Date(Date.now() + randomInt(1, 1000)).toISOString() }).eq('id', 1).eq('updated_at', updatedAt).select('id');
    if (error) throw error;
    if (!committed?.length) return res.status(409).json({ error: 'Este confronto acabou de ser atualizado. Recarregue a Mancos League antes de tentar novamente.' });
    await auditLeagueAdminAction(req.user, 'league_match_completed', match.id, `Rodada ${match.round}: ${simulation.homeGoals} × ${simulation.awayGoals}.`, { season: league.season, homePlayerId: match.homePlayerId, awayPlayerId: match.awayPlayerId, homeGoals: simulation.homeGoals, awayGoals: simulation.awayGoals });
    sendPushUsers([opponentId], `league:${league.season}:${match.id}`, { category: 'league', title: notice.title, body: notice.body, url: '/' }).catch(error => console.warn('Não foi possível enviar aviso da Mancos League:', error.message));
    res.json({ league, standings: leagueStandings(league), match, opponent: { id: opponentId, name: opponent?.nickname || opponent?.name || 'Adversário' } });
  } catch (error) { next(error); }
  finally { leagueMatchLocks.delete(lockKey); }
});

app.post('/api/league/notifications/read', authenticate, requireDatabase, async (req, res, next) => {
  try {
    const { state, league } = await readLeagueData();
    const ids = new Set(Array.isArray(req.body?.ids) ? req.body.ids.map(String) : []);
    for (const item of league.notifications || []) if (item.userId === String(req.user.id) && ids.has(String(item.id))) item.read = true;
    const { error } = await supabase.from('app_state').update({ state_json: state, updated_at: new Date().toISOString() }).eq('id', 1);
    if (error) throw error;
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.put('/api/admin/league/close', authenticate, requireAdmin, requireDatabase, async (req, res, next) => {
  try {
    const { state, league } = await readLeagueData();
    if (league.status !== 'active') return res.status(409).json({ error: 'Este campeonato já está encerrado.' });
    const pending = league.matches.filter(match => match.status !== 'completed');
    if (!league.matches.length || pending.length) return res.status(409).json({ error: `Ainda há ${pending.length} confronto(s) pendente(s).` });
    const standings = leagueStandings(league), champion = standings[0];
    if (!champion) return res.status(409).json({ error: 'Não há participantes para declarar campeão.' });
    league.status = 'closed'; league.closedAt = new Date().toISOString(); league.championId = champion.id;
    league.trophies[champion.id] = (Number(league.trophies[champion.id]) || 0) + 1;
    const championParticipant = league.participants.find(item => String(item.id) === champion.id);
    if (championParticipant) championParticipant.trophies = league.trophies[champion.id];
    league.history.push({ season: league.season, championId: champion.id, championName: champion.name, championNickname: champion.nickname || '', trophyCount: league.trophies[champion.id], standings, matches: league.matches, closedAt: league.closedAt });
    const roster = Array.isArray(state.players) ? state.players : [];
    const card = roster.find(player => [player.id, player.serverId, player.authUserId].some(value => value != null && String(value) === champion.id));
    if (card) card.leagueTrophies = league.trophies[champion.id];
    const { error } = await supabase.from('app_state').update({ state_json: state, updated_at: new Date().toISOString() }).eq('id', 1);
    if (error) throw error;
    await auditLeagueAdminAction(req.user, 'league_season_closed', league.season, `Temporada ${league.season} encerrada. Campeão: ${champion.name}.`, { championId: champion.id, championName: champion.name, standings });
    res.json({ league, standings });
  } catch (error) { next(error); }
});

app.post('/api/admin/league/start-season', authenticate, requireAdmin, requireDatabase, async (req, res, next) => {
  try {
    const { state, league } = await readLeagueData();
    if (league.status !== 'closed') return res.status(409).json({ error: 'Encerre a temporada atual antes de iniciar outra.' });
    const { data: profiles, error: profileError } = await supabase.from('profiles').select('id,name,nickname,position').order('name');
    if (profileError) throw profileError;
    const previousTrophies = league.trophies || {};
    league.season = (Number(league.season) || 0) + 1; league.status = 'active'; league.createdAt = new Date().toISOString();
    delete league.closedAt; delete league.championId;
    league.participants = (profiles || []).filter(profile => !isDemoMember(profile)).map(profile => ({
      id: String(profile.id), name: profile.name || 'Jogador', nickname: profile.nickname || '', position: profile.position || 'Meio-Campo', fatigue: 0, appearances: 0,
      trophies: Number(previousTrophies[profile.id]) || 0, joinedAt: new Date().toISOString()
    }));
    league.matches = [];
    league.fatigueByCard = {};
    scheduleMissingLeagueFixtures(league);
    const { error } = await supabase.from('app_state').update({ state_json: state, updated_at: new Date().toISOString() }).eq('id', 1);
    if (error) throw error;
    await auditLeagueAdminAction(req.user, 'league_season_started', league.season, `Temporada ${league.season} iniciada com ${league.participants.length} participantes.`, { participants: league.participants.length, fixtures: league.matches.length });
    res.json({ league, standings: leagueStandings(league) });
  } catch (error) { next(error); }
});

app.post('/api/admin/league/reset', authenticate, requireAdmin, requireDatabase, async (req, res, next) => {
  try {
    const { state, league } = await readLeagueData();
    const { data: profiles, error: profileError } = await supabase.from('profiles').select('id,name,nickname,position').order('name');
    if (profileError) throw profileError;
    league.season = 1; league.status = 'active'; league.createdAt = new Date().toISOString();
    delete league.closedAt; delete league.championId;
    league.participants = (profiles || []).filter(profile => !isDemoMember(profile)).map(profile => ({ id: String(profile.id), name: profile.name || 'Jogador', nickname: profile.nickname || '', position: profile.position || 'Meio-Campo', fatigue: 0, appearances: 0, trophies: 0, joinedAt: new Date().toISOString() }));
    league.matches = []; league.history = []; league.trophies = {}; league.fatigueByCard = {}; league.notifications = [];
    scheduleMissingLeagueFixtures(league);
    const { error } = await supabase.from('app_state').update({ state_json: state, updated_at: new Date().toISOString() }).eq('id', 1);
    if (error) throw error;
    await auditLeagueAdminAction(req.user, 'league_reset', 'all', 'Mancos League reiniciada pelo administrador.', { participants: league.participants.length, fixtures: league.matches.length });
    res.json({ league, standings: leagueStandings(league), myNotifications: [] });
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
app.post('/api/guests', requireDatabase, async (req, res, next) => {
  const name = String(req.body?.name || '').trim().replace(/\s+/g, ' ');
  const cpf = String(req.body?.cpf || '').replace(/\D/g, '');
  const age = Number(req.body?.age), invitationCode = String(req.body?.invitationCode || '').trim(), honeypot = String(req.body?.website || '');
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (honeypot) return res.status(400).json({ error: 'Cadastro inválido.' });
  if (name.length < 2 || name.length > 80) return res.status(400).json({ error: 'Informe o nome completo do convidado.' });
  if (!isValidCpf(cpf)) return res.status(400).json({ error: 'O CPF informado é inválido. Confira os 11 dígitos.' });
  if (!Number.isInteger(age) || age < 1 || age > 120) return res.status(400).json({ error: 'Informe uma idade válida entre 1 e 120 anos.' });
  if (!/^\d{6}$/.test(invitationCode)) return res.status(400).json({ error: 'Informe o código de convite de seis dígitos fornecido pelo associado.' });
  const attemptKey = req.ip || req.socket.remoteAddress || 'unknown', now = Date.now();
  const attempt = guestInviteAttempts.get(attemptKey) || { count: 0, since: now };
  if (now - attempt.since > 10 * 60 * 1000) { attempt.count = 0; attempt.since = now; }
  if (attempt.count >= 15) return res.status(429).json({ error: 'Muitas tentativas de código. Aguarde alguns minutos e tente novamente.' });
  attempt.count++; guestInviteAttempts.set(attemptKey, attempt);
  try {
    const guestFee = Number(await setting('guest_daily_fee')) || 0;
    const { data: codeRow, error: codeError } = await supabase.from('member_guest_codes').select('member_id').eq('code', invitationCode).maybeSingle();
    if (codeError) throw codeError;
    if (!codeRow) return res.status(400).json({ error: 'Código de convite não encontrado. Peça ao associado para conferir o código no Perfil.' });
    const { data: inviter, error: inviterError } = await supabase.from('profiles').select('id,name,email').eq('id', codeRow.member_id).maybeSingle();
    if (inviterError) throw inviterError;
    if (!inviter || isDemoMember(inviter)) return res.status(400).json({ error: 'Selecione um associado válido como responsável pelo convite.' });
    const { data: guest, error } = await supabase.from('baba_guests').insert({
      name, cpf_hash: guestCpfHash(cpf), cpf_encrypted: encryptGuestCpf(cpf), cpf_last4: cpf.slice(-4), age, invited_by: inviter.id,
      payment_status: 'pending', payment_amount: guestFee
    }).select('id,name,age,created_at').single();
    if (error?.code === '23505') return res.status(409).json({ error: 'Este CPF já está cadastrado como convidado. Fale com a administração se precisar corrigir os dados.' });
    if (error) throw error;
    res.status(201).json({ guest: { ...guest, invitedByName: inviter.name } });
  } catch (error) { next(error); }
});
async function guestAttendanceRows(day, viewer) {
  const { data: guests, error } = await supabase.from('baba_guests').select('id,name,age,invited_by,created_at').order('created_at', { ascending: false });
  if (error) throw error;
  const guestIds = (guests || []).map(guest => guest.id);
  const { data: marked, error: attendanceError } = guestIds.length
    ? await supabase.from('baba_guest_attendance').select('guest_id,kind,marked_by,created_at').eq('game_day', day).in('guest_id', guestIds)
    : { data: [], error: null };
  if (attendanceError) throw attendanceError;
  const attendingIds = new Set((marked || []).map(row => row.guest_id));
  const visible = (guests || []).filter(guest => viewer.is_admin || guest.invited_by === viewer.id || attendingIds.has(guest.id));
  const profileIds = [...new Set(visible.flatMap(guest => [guest.invited_by, ...(marked || []).filter(row => row.guest_id === guest.id).map(row => row.marked_by)].filter(Boolean)))];
  const { data: profiles, error: profilesError } = profileIds.length
    ? await supabase.from('profiles').select('id,name').in('id', profileIds)
    : { data: [], error: null };
  if (profilesError) throw profilesError;
  const profileName = new Map((profiles || []).map(profile => [profile.id, profile.name]));
  return visible.map(guest => {
    const records = (marked || []).filter(row => row.guest_id === guest.id);
    return {
      id: guest.id, name: guest.name, age: viewer.is_admin || guest.invited_by === viewer.id ? guest.age : null,
      invitedBy: profileName.get(guest.invited_by) || 'Associado', invitedById: guest.invited_by,
      presence: records.some(row => row.kind === 'presence'), checkin: records.some(row => row.kind === 'checkin'),
      canManage: !!viewer.is_admin || guest.invited_by === viewer.id
    };
  }).sort((a, b) => Number(b.checkin) - Number(a.checkin) || Number(b.presence) - Number(a.presence) || a.name.localeCompare(b.name));
}
app.get('/api/baba/guests/attendance', authenticate, requireBabaAccess, requireDatabase, async (req, res, next) => {
  const day = String(req.query.date || '');
  if (!validDate(day)) return res.status(400).json({ error: 'Informe a data do baba.' });
  try { res.json({ guests: await guestAttendanceRows(day, req.user) }); } catch (error) { next(error); }
});
app.post('/api/baba/guests/:id/attendance', authenticate, requireBabaAccess, requireDatabase, async (req, res, next) => {
  const day = String(req.body?.date || ''), kind = String(req.body?.kind || ''), guestId = String(req.params.id || '');
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!validDate(day) || !['presence', 'checkin'].includes(kind) || !uuidPattern.test(guestId)) return res.status(400).json({ error: 'Dados de presença/check-in inválidos.' });
  try {
    const { data: guest, error: guestError } = await supabase.from('baba_guests').select('id,invited_by').eq('id', guestId).maybeSingle();
    if (guestError) throw guestError;
    if (!guest) return res.status(404).json({ error: 'Convidado não encontrado.' });
    if (!req.user.is_admin && guest.invited_by !== req.user.id) return res.status(403).json({ error: 'Somente quem convidou ou um ADM pode marcar esta presença.' });
    const { data: presence, error: presenceError } = await supabase.from('baba_guest_attendance').select('id').eq('game_day', day).eq('guest_id', guestId).eq('kind', 'presence').maybeSingle();
    if (presenceError) throw presenceError;
    if (kind === 'presence' && presence) {
      const { error } = await supabase.from('baba_guest_attendance').delete().eq('game_day', day).eq('guest_id', guestId);
      if (error) throw error;
    } else if (kind === 'checkin') {
      if (!presence) return res.status(409).json({ error: 'Marque presença do convidado antes do check-in.' });
      const { error } = await supabase.from('baba_guest_attendance').upsert({ game_day: day, guest_id: guestId, kind, marked_by: req.user.id }, { onConflict: 'game_day,guest_id,kind', ignoreDuplicates: true });
      if (error) throw error;
    } else {
      const { error } = await supabase.from('baba_guest_attendance').upsert({ game_day: day, guest_id: guestId, kind, marked_by: req.user.id }, { onConflict: 'game_day,guest_id,kind', ignoreDuplicates: true });
      if (error) throw error;
    }
    res.json({ guests: await guestAttendanceRows(day, req.user) });
  } catch (error) { next(error); }
});
app.get('/api/baba/attendance', authenticate, requireBabaAccess, requireDatabase, async (req, res, next) => {
  const day = String(req.query.date || '');
  if (!validDate(day)) return res.status(400).json({ error: 'Informe a data do baba.' });
  try { res.json({ attendees: await attendanceRows(day) }); } catch (error) { next(error); }
});
app.post('/api/baba/attendance', authenticate, requireBabaAccess, requireDatabase, async (req, res, next) => {
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

app.get('/api/baba/mode', authenticate, requireBabaAccess, requireDatabase, async (req, res, next) => {
  const day = String(req.query.date || '');
  if (!validDate(day)) return res.status(400).json({ error: 'Informe a data do baba.' });
  try {
    let mode = await setting(`baba_mode_${day}`);
    if (!mode) {
      const { data: openGames, error } = await supabase.from('baba_matches').select('id').eq('game_day', day).eq('voting_open', true).limit(1);
      if (error) throw error;
      mode = openGames?.length ? 'voting' : 'presence';
    }
    if (!['presence', 'game', 'voting'].includes(mode)) mode = 'presence';
    res.json({ date: day, mode });
  } catch (error) { next(error); }
});
app.put('/api/admin/baba/mode', authenticate, requireAdmin, requireDatabase, async (req, res, next) => {
  const day = String(req.body?.date || ''), mode = String(req.body?.mode || '');
  if (!validDate(day) || !['presence', 'game'].includes(mode)) return res.status(400).json({ error: 'Data ou modo inválido.' });
  try {
    let current = await setting(`baba_mode_${day}`);
    if (!current) {
      const { data: openGames, error } = await supabase.from('baba_matches').select('id').eq('game_day', day).eq('voting_open', true).limit(1);
      if (error) throw error;
      if (openGames?.length) current = 'voting';
    }
    if (current === 'voting') return res.status(409).json({ error: 'A votação deste baba já foi liberada; não é possível voltar para outra etapa.' });
    await saveSetting(`baba_mode_${day}`, mode);
    await auditAdminAction(req.user, 'baba_mode_changed', 'baba_day', day, `Modo da Central Baba alterado para ${mode === 'game' ? 'Modo Baba' : 'Presença'} em ${day}.`, { gameDay: day, mode });
    res.json({ ok: true, date: day, mode });
  } catch (error) { next(error); }
});

app.get('/api/gallery', requireDatabase, async (_req, res, next) => {
  try {
    const { data, error } = await supabase.from('app_state').select('state_json').eq('id', 1).maybeSingle();
    if (error) throw error;
    res.json({ images: Array.isArray(data?.state_json?.associationGallery) ? data.state_json.associationGallery : [] });
  } catch (error) { next(error); }
});
app.post('/api/admin/gallery', authenticate, requireAdmin, requireDatabase, async (req, res, next) => {
  const dataUrl = String(req.body?.dataUrl || '');
  const match = dataUrl.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!match || dataUrl.length > 7_000_000) return res.status(400).json({ error: 'Escolha uma imagem JPG, PNG ou WebP de até 5 MB.' });
  try {
    const mime = `image/${match[1]}`;
    const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
    const path = `${new Date().toISOString().slice(0, 10)}/${randomUUID()}.${ext}`;
    const { error: uploadError } = await supabase.storage.from('association-gallery').upload(path, Buffer.from(match[2], 'base64'), { contentType: mime, cacheControl: '31536000', upsert: false });
    if (uploadError) throw uploadError;
    const { data: publicData } = supabase.storage.from('association-gallery').getPublicUrl(path);
    const { data: row, error: readError } = await supabase.from('app_state').select('state_json').eq('id', 1).maybeSingle();
    if (readError) throw readError;
    const state = row?.state_json || {};
    const image = { id: randomUUID(), path, url: publicData.publicUrl, createdAt: new Date().toISOString() };
    state.associationGallery = [image, ...(Array.isArray(state.associationGallery) ? state.associationGallery : [])].slice(0, 100);
    const { error: saveError } = await supabase.from('app_state').upsert({ id: 1, state_json: state, updated_at: new Date().toISOString() }, { onConflict: 'id' });
    if (saveError) throw saveError;
    res.json({ image, images: state.associationGallery });
  } catch (error) { next(error); }
});
app.delete('/api/admin/gallery/:id', authenticate, requireAdmin, requireDatabase, async (req, res, next) => {
  try {
    const { data: row, error: readError } = await supabase.from('app_state').select('state_json').eq('id', 1).maybeSingle();
    if (readError) throw readError;
    const state = row?.state_json || {};
    const images = Array.isArray(state.associationGallery) ? state.associationGallery : [];
    const removed = images.find(item => String(item.id) === String(req.params.id));
    if (!removed) return res.status(404).json({ error: 'Imagem não encontrada.' });
    if (removed.path) { const { error } = await supabase.storage.from('association-gallery').remove([removed.path]); if (error) throw error; }
    state.associationGallery = images.filter(item => String(item.id) !== String(req.params.id));
    const { error: saveError } = await supabase.from('app_state').upsert({ id: 1, state_json: state, updated_at: new Date().toISOString() }, { onConflict: 'id' });
    if (saveError) throw saveError;
    await auditAdminAction(req.user, 'gallery_image_deleted', 'gallery_image', removed.id, 'Imagem removida da galeria da associação.', { imageId: removed.id });
    res.json({ images: state.associationGallery });
  } catch (error) { next(error); }
});
app.post('/api/admin/baba/checkin', authenticate, requireAdmin, requireDatabase, async (req, res, next) => {
  const day = String(req.body?.date || ''), userId = String(req.body?.userId || '');
  if (!validDate(day) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId)) {
    return res.status(400).json({ error: 'Informe uma data e um associado válidos.' });
  }
  try {
    const { data: presence, error: presenceError } = await supabase.from('baba_attendance').select('id').eq('game_day', day).eq('user_id', userId).eq('kind', 'presence').maybeSingle();
    if (presenceError) throw presenceError;
    if (!presence) return res.status(409).json({ error: 'O associado precisa ter confirmado presença antes do check-in.' });
    const { error } = await supabase.from('baba_attendance').upsert({ game_day: day, user_id: userId, kind: 'checkin' }, { onConflict: 'game_day,user_id,kind', ignoreDuplicates: true });
    if (error) throw error;
    res.json({ attendees: await attendanceRows(day) });
  } catch (error) { next(error); }
});

app.get('/api/baba/votes', authenticate, requireBabaAccess, requireDatabase, async (req, res, next) => {
  const day = String(req.query.date || '');
  if (!validDate(day)) return res.status(400).json({ error: 'Informe a data da votação.' });
  try {
    const { data: rows, error } = await supabase.from('baba_votes').select('player_email,attr_key,stars,voter_id').eq('game_day', day);
    if (error) throw error;
    res.json({ votes: rows.map(row => ({ playerEmail: row.player_email, attrKey: row.attr_key, stars: row.stars })), myVotes: rows.filter(row => row.voter_id === req.user.id).map(row => ({ playerEmail: row.player_email, attrKey: row.attr_key, stars: row.stars })) });
  } catch (error) { next(error); }
});
app.get('/api/resenha/weekly-lineup', requireDatabase, async (_req, res, next) => {
  try {
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
    const today = `${parts.find(part => part.type === 'year').value}-${parts.find(part => part.type === 'month').value}-${parts.find(part => part.type === 'day').value}`;
    const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
    const monday = new Date(`${today}T12:00:00Z`); monday.setUTCDate(monday.getUTCDate() - ((weekday + 6) % 7));
    const weekStart = monday.toISOString().slice(0, 10);
    const { data: votes, error: votesError } = await supabase.from('baba_votes').select('player_email,stars').gte('game_day', weekStart).lte('game_day', today).limit(5000);
    if (votesError) throw votesError;
    const voteMap = new Map();
    for (const vote of votes || []) {
      const email = String(vote.player_email || '').trim().toLowerCase();
      if (!email) continue;
      const rating = ({ 1: 60, 2: 70, 3: 75, 4: 80, 5: 85 })[Number(vote.stars)];
      if (!rating) continue;
      const current = voteMap.get(email) || { total: 0, count: 0 };
      current.total += rating; current.count += 1; voteMap.set(email, current);
    }
    const emails = [...voteMap.keys()];
    const { data: profiles, error: profilesError } = emails.length
      ? await supabase.from('profiles').select('id,email,name,nickname,position,photo').in('email', emails)
      : { data: [], error: null };
    if (profilesError) throw profilesError;
    const groupFor = position => {
      const value = String(position || '').toLocaleLowerCase('pt-BR');
      if (value.includes('goleiro')) return 'keeper';
      if (value.includes('zague') || value.includes('later') || value.includes('defens')) return 'defense';
      if (value.includes('atac') || value.includes('ponta') || value.includes('centroav')) return 'attack';
      return 'midfield';
    };
    const candidates = (profiles || []).map(profile => {
      const totals = voteMap.get(String(profile.email || '').toLowerCase());
      if (!totals) return null;
      return { id: profile.id, name: profile.nickname || profile.name || 'Associado', position: profile.position || 'Meio-Campo', photo: /^https:\/\//i.test(profile.photo || '') ? profile.photo : '', ovr: Math.round(totals.total / totals.count), voteCount: totals.count, group: groupFor(profile.position) };
    }).filter(Boolean).sort((a, b) => b.ovr - a.ovr || b.voteCount - a.voteCount || a.name.localeCompare(b.name, 'pt-BR'));
    const slots = [
      { id: 'gk', label: 'GOL', group: 'keeper' },
      { id: 'def1', label: 'DEF', group: 'defense' }, { id: 'def2', label: 'DEF', group: 'defense' },
      { id: 'mid1', label: 'MEI', group: 'midfield' }, { id: 'mid2', label: 'MEI', group: 'midfield' }, { id: 'mid3', label: 'MEI', group: 'midfield' },
      { id: 'att', label: 'ATA', group: 'attack' }
    ];
    const used = new Set();
    const lineup = slots.map(slot => {
      const player = candidates.find(item => item.group === slot.group && !used.has(String(item.id)));
      if (player) used.add(String(player.id));
      return { ...slot, player: player ? { id: player.id, name: player.name, position: player.position, photo: player.photo, ovr: player.ovr } : null };
    });
    res.set('Cache-Control', 'public, max-age=20, stale-while-revalidate=40');
    res.json({ weekStart, votes: (votes || []).length, lineup });
  } catch (error) { next(error); }
});
app.post('/api/baba/votes', authenticate, requireBabaAccess, requireDatabase, async (req, res, next) => {
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

app.get('/api/baba/matches', authenticate, requireBabaAccess, requireDatabase, async (_req, res, next) => {
  try {
    const { data: rows, error } = await supabase.from('baba_matches').select('game_data,voting_open').order('game_day', { ascending: false }).order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ matches: rows.map(row => ({ ...row.game_data, votingOpen: row.voting_open })) });
  } catch (error) { next(error); }
});
app.get('/api/baba/draws', authenticate, requireBabaAccess, requireDatabase, async (req, res, next) => {
  const date = String(req.query.date || '');
  if (!validDate(date)) return res.status(400).json({ error: 'Informe a data do baba.' });
  try {
    const { data, error } = await supabase.from('baba_draws').select('id,game_day,draw_order,selected_count,draw_data,finalized,created_at').eq('game_day', date).order('draw_order');
    if (error) throw error;
    res.json({ draws: (data || []).map(row => ({ ...row.draw_data, id: row.id, gameDay: row.game_day, drawOrder: row.draw_order, selectedCount: row.selected_count, finalized: row.finalized, createdAt: row.created_at })) });
  } catch (error) { next(error); }
});
app.post('/api/admin/baba/draws', authenticate, requireAdmin, requireDatabase, async (req, res, next) => {
  const gameDay = String(req.body?.gameDay || ''), selectedCount = Number(req.body?.selectedCount), submitted = req.body?.players;
  if (!validDate(gameDay) || !Number.isInteger(selectedCount) || selectedCount < 2 || selectedCount > 30 || !Array.isArray(submitted) || submitted.length !== selectedCount) return res.status(400).json({ error: 'O sorteio precisa de uma data e da quantidade correta de jogadores.' });
  const ids = submitted.map(player => String(player.userId || ''));
  if (new Set(ids).size !== ids.length || ids.some(id => !/^[0-9a-f-]{36}$/i.test(id))) return res.status(400).json({ error: 'A lista do sorteio contém jogador inválido ou duplicado.' });
  const assignedKeeperIds = Array.isArray(req.body?.assignedKeeperIds) ? req.body.assignedKeeperIds.map(String) : [];
  if (assignedKeeperIds.length !== 2 || new Set(assignedKeeperIds).size !== 2 || assignedKeeperIds.some(id => !ids.includes(id))) return res.status(400).json({ error: 'Selecione dois goleiros diferentes que estejam incluídos neste sorteio.' });
  try {
    const { data: attendance, error: attendanceError } = await supabase.from('baba_attendance').select('user_id').eq('game_day', gameDay).eq('kind', 'checkin').in('user_id', ids);
    if (attendanceError) throw attendanceError;
    if (new Set((attendance || []).map(row => row.user_id)).size !== ids.length) return res.status(409).json({ error: 'Todos os sorteados precisam ter check-in neste baba.' });
    const { data: profiles, error: profilesError } = await supabase.from('profiles').select('id,name,email,position,shirt_number').in('id', ids);
    if (profilesError) throw profilesError;
    const byId = new Map((profiles || []).map(player => [player.id, player]));
    const players = submitted.map(player => {
      const profile = byId.get(String(player.userId));
      if (!profile) return null;
      return { userId: profile.id, name: profile.name, email: profile.email, position: profile.position, shirt: Number(profile.shirt_number) || 0, ovr: Math.max(1, Math.min(99, Number(player.ovr) || 70)), team: player.team === 'B' ? 'B' : 'A', isKeeper: assignedKeeperIds.includes(profile.id), goals: 0, assists: 0, saves: 0 };
    });
    if (players.some(player => !player)) return res.status(400).json({ error: 'Não foi possível carregar todos os jogadores sorteados.' });
    const { data: last, error: lastError } = await supabase.from('baba_draws').select('draw_order').eq('game_day', gameDay).order('draw_order', { ascending: false }).limit(1).maybeSingle();
    if (lastError) throw lastError;
    const drawOrder = Number(last?.draw_order || 0) + 1, id = randomUUID();
    if (assignedKeeperIds.some(id => !players.some(player => player.userId === id)) || players.filter(player => player.isKeeper && player.team === 'A').length !== 1 || players.filter(player => player.isKeeper && player.team === 'B').length !== 1) return res.status(400).json({ error: 'O sorteio deve ter um goleiro em cada time.' });
    const drawData = { players, assignedKeeperIds, winner: '', scoreA: null, scoreB: null, drawOrder };
    const { error } = await supabase.from('baba_draws').insert({ id, game_day: gameDay, draw_order: drawOrder, selected_count: selectedCount, draw_data: drawData, created_by: req.user.id });
    if (error) throw error;
    await auditAdminAction(req.user, 'team_draw_created', 'baba_draw', id, `Sorteio ${drawOrder} criado para ${gameDay}.`, { gameDay, drawOrder, players: players.map(player => ({ id: player.userId, name: player.name, position: player.position, team: player.team, ovr: player.ovr, isKeeper: player.isKeeper })) });
    res.status(201).json({ draw: { ...drawData, id, gameDay, drawOrder, selectedCount, finalized: false } });
  } catch (error) { next(error); }
});
app.put('/api/admin/baba/draws/:id', authenticate, requireAdmin, requireDatabase, async (req, res, next) => {
  const submitted = req.body?.players, assignedKeeperIds = Array.isArray(req.body?.assignedKeeperIds) ? req.body.assignedKeeperIds.map(String) : [];
  if (!Array.isArray(submitted) || assignedKeeperIds.length !== 2 || new Set(assignedKeeperIds).size !== 2) return res.status(400).json({ error: 'Informe os times e dois goleiros diferentes.' });
  try {
    const { data: row, error: readError } = await supabase.from('baba_draws').select('id,game_day,selected_count,draw_order,draw_data,finalized').eq('id', req.params.id).maybeSingle();
    if (readError) throw readError;
    if (!row) return res.status(404).json({ error: 'Sorteio não encontrado.' });
    if (row.finalized) return res.status(409).json({ error: 'Partida já finalizada; não é possível refazer os times.' });
    const current = row.draw_data?.players || [], currentIds = current.map(player => String(player.userId));
    const ids = submitted.map(player => String(player.userId || ''));
    if (ids.length !== row.selected_count || new Set(ids).size !== ids.length || ids.some(id => !currentIds.includes(id)) || currentIds.some(id => !ids.includes(id))) return res.status(400).json({ error: 'Refazer os times mantém exatamente os mesmos jogadores sorteados.' });
    const byId = new Map(current.map(player => [String(player.userId), player]));
    const players = submitted.map(item => {
      const player = byId.get(String(item.userId));
      return { ...player, ovr: Math.max(1, Math.min(99, Number(item.ovr) || player.ovr || 70)), team: item.team === 'B' ? 'B' : item.team === 'A' ? 'A' : '', isKeeper: assignedKeeperIds.includes(String(item.userId)) };
    });
    if (players.some(player => !player.team) || assignedKeeperIds.some(id => !ids.includes(id)) || players.filter(player => player.isKeeper && player.team === 'A').length !== 1 || players.filter(player => player.isKeeper && player.team === 'B').length !== 1) return res.status(400).json({ error: 'O sorteio deve ter um goleiro em cada time.' });
    const drawData = { ...row.draw_data, players, assignedKeeperIds };
    const { error } = await supabase.from('baba_draws').update({ draw_data: drawData }).eq('id', row.id).eq('finalized', false);
    if (error) throw error;
    await auditAdminAction(req.user, 'team_draw_redone', 'baba_draw', row.id, `Times do sorteio ${row.draw_order} refeitos em ${row.game_day}.`, { gameDay: row.game_day, drawOrder: row.draw_order, teams: players.map(player => ({ id: player.userId, name: player.name, team: player.team, ovr: player.ovr, isKeeper: player.isKeeper })) });
    res.json({ ok: true, draw: { ...drawData, id: row.id, gameDay: row.game_day, drawOrder: row.draw_order, selectedCount: row.selected_count, finalized: false } });
  } catch (error) { next(error); }
});
app.put('/api/admin/baba/draws/:id/finalize', authenticate, requireAdmin, requireDatabase, async (req, res, next) => {
  const id = String(req.params.id || ''), winner = String(req.body?.winner || ''), stats = req.body?.stats;
  if (!['A', 'B', 'draw'].includes(winner) || !Array.isArray(stats)) return res.status(400).json({ error: 'Escolha o time vencedor e informe os dados dos jogadores.' });
  try {
    const { data: row, error: readError } = await supabase.from('baba_draws').select('id,game_day,draw_data,finalized').eq('id', id).maybeSingle();
    if (readError) throw readError;
    if (!row) return res.status(404).json({ error: 'Sorteio não encontrado.' });
    if (row.finalized) return res.status(409).json({ error: 'Os dados deste sorteio já foram finalizados.' });
    const drafted = row.draw_data?.players || [];
    const statsById = new Map(stats.map(item => [String(item.userId), item]));
    if (statsById.size !== drafted.length || drafted.some(player => !statsById.has(String(player.userId)))) return res.status(400).json({ error: 'Informe gols, assistências e defesas de todos os jogadores sorteados.' });
    const players = drafted.map(player => {
      const item = statsById.get(String(player.userId));
      return { ...player, goals: Math.min(99, Math.max(0, Math.floor(Number(item.goals) || 0))), assists: Math.min(99, Math.max(0, Math.floor(Number(item.assists) || 0))), saves: Math.min(999, Math.max(0, Math.floor(Number(item.saves) || 0))) };
    });
    const scoreA = players.filter(player => player.team === 'A').reduce((sum, player) => sum + player.goals, 0);
    const scoreB = players.filter(player => player.team === 'B').reduce((sum, player) => sum + player.goals, 0);
    const date = new Date(`${row.game_day}T12:00:00`).toLocaleDateString('pt-BR');
    const match = { id, gameDay: row.game_day, date, scoreA, scoreB, winner, teamA: players.filter(player => player.team === 'A').map(player => player.name), teamB: players.filter(player => player.team === 'B').map(player => player.name), checkedInIds: players.map(player => player.userId), checkedInEmails: players.map(player => player.email), checkedInPlayersData: players.map(player => ({ email: player.email, name: player.name, pos: player.position })), stats: players.map(({ userId, email, name, team, goals, assists, saves, isKeeper, position }) => ({ playerId: userId, email, name, team, goals, assists, saves, isKeeper, position })), votingOpen: false, drawOrder: row.draw_data?.drawOrder || 0 };
    const drawData = { ...row.draw_data, players, winner, scoreA, scoreB };
    const [{ error: drawError }, { error: matchError }] = await Promise.all([
      supabase.from('baba_draws').update({ draw_data: drawData, finalized: true }).eq('id', id),
      supabase.from('baba_matches').upsert({ id, game_day: row.game_day, game_data: match, voting_open: false }, { onConflict: 'id' })
    ]);
    if (drawError) throw drawError; if (matchError) throw matchError;
    await auditAdminAction(req.user, 'match_result_recorded', 'baba_draw', id, `Resultado do sorteio ${row.game_day}: ${scoreA} × ${scoreB}.`, { gameDay: row.game_day, scoreA, scoreB, winner, players: players.map(player => ({ id: player.userId, name: player.name, team: player.team, goals: player.goals, assists: player.assists, saves: player.saves })) });
    res.json({ ok: true, draw: { ...drawData, id, gameDay: row.game_day, finalized: true }, match });
  } catch (error) { next(error); }
});
app.put('/api/admin/baba/draws/:id/correct', authenticate, requireAdmin, requireDatabase, async (req, res, next) => {
  const id = String(req.params.id || ''), winner = String(req.body?.winner || ''), stats = req.body?.stats;
  if (!['A', 'B', 'draw'].includes(winner) || !Array.isArray(stats)) return res.status(400).json({ error: 'Escolha o vencedor e informe as estatísticas corrigidas.' });
  try {
    const { data: row, error: readError } = await supabase.from('baba_draws').select('id,game_day,draw_data,finalized,draw_order').eq('id', id).maybeSingle();
    if (readError) throw readError;
    if (!row) return res.status(404).json({ error: 'Sorteio não encontrado.' });
    if (!row.finalized) return res.status(409).json({ error: 'Finalize o resultado antes de corrigi-lo.' });
    const oldPlayers = row.draw_data?.players || [];
    const statsById = new Map(stats.map(item => [String(item.userId), item]));
    if (statsById.size !== oldPlayers.length || oldPlayers.some(player => !statsById.has(String(player.userId)))) return res.status(400).json({ error: 'Informe gols, assistências e defesas de todos os jogadores desta partida.' });
    const players = oldPlayers.map(player => {
      const item = statsById.get(String(player.userId));
      return { ...player, goals: Math.min(99, Math.max(0, Math.floor(Number(item.goals) || 0))), assists: Math.min(99, Math.max(0, Math.floor(Number(item.assists) || 0))), saves: Math.min(999, Math.max(0, Math.floor(Number(item.saves) || 0))) };
    });
    const scoreA = players.filter(player => player.team === 'A').reduce((sum, player) => sum + player.goals, 0);
    const scoreB = players.filter(player => player.team === 'B').reduce((sum, player) => sum + player.goals, 0);
    const date = new Date(`${row.game_day}T12:00:00`).toLocaleDateString('pt-BR');
    const drawData = { ...row.draw_data, players, winner, scoreA, scoreB };
    const { data: matchRow, error: matchReadError } = await supabase.from('baba_matches').select('game_data,voting_open').eq('id', id).maybeSingle();
    if (matchReadError) throw matchReadError;
    const match = {
      ...(matchRow?.game_data || {}), id, gameDay: row.game_day, date, scoreA, scoreB, winner,
      teamA: players.filter(player => player.team === 'A').map(player => player.name),
      teamB: players.filter(player => player.team === 'B').map(player => player.name),
      checkedInIds: players.map(player => player.userId), checkedInEmails: players.map(player => player.email),
      checkedInPlayersData: players.map(player => ({ email: player.email, name: player.name, pos: player.position })),
      stats: players.map(({ userId, email, name, team, goals, assists, saves, isKeeper, position }) => ({ playerId: userId, email, name, team, goals, assists, saves, isKeeper, position })),
      votingOpen: !!matchRow?.voting_open, drawOrder: row.draw_order
    };

    const { error: drawError } = await supabase.from('baba_draws').update({ draw_data: drawData }).eq('id', id).eq('finalized', true);
    if (drawError) throw drawError;
    const { error: matchError } = await supabase.from('baba_matches').upsert({ id, game_day: row.game_day, game_data: match, voting_open: !!matchRow?.voting_open }, { onConflict: 'id' });
    if (matchError) throw matchError;

    const { data: stateRow, error: stateReadError } = await supabase.from('app_state').select('state_json').eq('id', 1).maybeSingle();
    if (stateReadError) throw stateReadError;
    if (stateRow?.state_json) {
      const state = stateRow.state_json;
      const roster = Array.isArray(state.players) ? state.players : [];
      const oldById = new Map(oldPlayers.map(player => [String(player.userId), player]));
      for (const corrected of players) {
        const rosterPlayer = roster.find(player => [player.serverId, player.authUserId, player.id].some(value => value != null && String(value) === String(corrected.userId)) || (!!corrected.email && String(player.email || '').toLowerCase() === String(corrected.email).toLowerCase()));
        if (!rosterPlayer) continue;
        const previous = oldById.get(String(corrected.userId));
        for (const key of ['goals', 'assists', 'saves']) rosterPlayer[key] = Math.max(0, (Number(rosterPlayer[key]) || 0) - (Number(previous?.[key]) || 0) + (Number(corrected[key]) || 0));
      }
      const { error: stateError } = await supabase.from('app_state').update({ state_json: state, updated_at: new Date().toISOString() }).eq('id', 1);
      if (stateError) throw stateError;
    }

    const snapshot = result => ({ winner: result.winner, scoreA: result.scoreA, scoreB: result.scoreB, players: result.players.map(player => ({ id: player.userId, name: player.name, team: player.team, goals: player.goals, assists: player.assists, saves: player.saves })) });
    const oldSummary = snapshot({ winner: row.draw_data.winner, scoreA: row.draw_data.scoreA, scoreB: row.draw_data.scoreB, players: oldPlayers });
    const newSummary = snapshot(drawData);
    await auditAdminAction(req.user, 'match_result_corrected', 'baba_draw', id, `Resultado corrigido em ${row.game_day}: ${Number(oldSummary.scoreA) || 0} × ${Number(oldSummary.scoreB) || 0} → ${scoreA} × ${scoreB}.`, { gameDay: row.game_day, oldResult: oldSummary, newResult: newSummary });
    res.json({ ok: true, draw: { ...drawData, id, gameDay: row.game_day, drawOrder: row.draw_order, finalized: true }, match });
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
    await auditAdminAction(req.user, 'match_result_recorded', 'baba_match', match.id, `Resultado salvo para ${match.gameDay}: ${Number(match.scoreA) || 0} × ${Number(match.scoreB) || 0}.`, { gameDay: match.gameDay, scoreA: Number(match.scoreA) || 0, scoreB: Number(match.scoreB) || 0, teamA: match.teamA || [], teamB: match.teamB || [] });
    res.json({ ok: true, id: String(match.id) });
  } catch (error) { next(error); }
});
app.put('/api/admin/baba/matches/:id/correct', authenticate, requireAdmin, requireDatabase, async (req, res, next) => {
  const id = String(req.params.id || ''), winner = String(req.body?.winner || ''), stats = req.body?.stats;
  if (!['A', 'B', 'draw'].includes(winner) || !Array.isArray(stats)) return res.status(400).json({ error: 'Escolha o vencedor e informe as estatísticas corrigidas.' });
  try {
    const { data: draw } = await supabase.from('baba_draws').select('id').eq('id', id).maybeSingle();
    if (draw) return res.status(409).json({ error: 'Este resultado pertence ao sorteador. Atualize a página e use a correção do sorteio.' });
    const { data: row, error: readError } = await supabase.from('baba_matches').select('id,game_day,game_data,voting_open').eq('id', id).maybeSingle();
    if (readError) throw readError;
    if (!row) return res.status(404).json({ error: 'Partida não encontrada.' });
    const oldMatch = row.game_data || {}, oldStats = Array.isArray(oldMatch.stats) ? oldMatch.stats : [];
    if (!oldStats.length) return res.status(409).json({ error: 'Esta partida não possui estatísticas individuais para corrigir.' });
    const keyFor = item => String(item.playerId ?? item.userId ?? item.email ?? item.name ?? '');
    const statsByKey = new Map(stats.map(item => [keyFor(item), item]));
    if (statsByKey.size !== oldStats.length || oldStats.some(item => !statsByKey.has(keyFor(item)))) return res.status(400).json({ error: 'Informe gols, assistências e defesas de todos os jogadores.' });
    const nextStats = oldStats.map(player => {
      const item = statsByKey.get(keyFor(player));
      return { ...player, goals: Math.min(99, Math.max(0, Math.floor(Number(item.goals) || 0))), assists: Math.min(99, Math.max(0, Math.floor(Number(item.assists) || 0))), saves: Math.min(999, Math.max(0, Math.floor(Number(item.saves) || 0))) };
    });
    const scoreA = nextStats.filter(player => player.team === 'A').reduce((sum, player) => sum + player.goals, 0);
    const scoreB = nextStats.filter(player => player.team === 'B').reduce((sum, player) => sum + player.goals, 0);
    const nextMatch = { ...oldMatch, id, gameDay: row.game_day, scoreA, scoreB, winner, stats: nextStats, votingOpen: !!row.voting_open };
    const { error: updateError } = await supabase.from('baba_matches').update({ game_data: nextMatch }).eq('id', id);
    if (updateError) throw updateError;
    const { data: stateRow, error: stateReadError } = await supabase.from('app_state').select('state_json').eq('id', 1).maybeSingle();
    if (stateReadError) throw stateReadError;
    if (stateRow?.state_json) {
      const state = stateRow.state_json, roster = Array.isArray(state.players) ? state.players : [];
      for (const player of nextStats) {
        const previous = oldStats.find(item => keyFor(item) === keyFor(player));
        const member = roster.find(item => (player.playerId && [item.serverId, item.authUserId, item.id].some(value => value != null && String(value) === String(player.playerId))) || (player.email && String(item.email || '').toLowerCase() === String(player.email).toLowerCase()));
        if (member) for (const key of ['goals', 'assists', 'saves']) member[key] = Math.max(0, (Number(member[key]) || 0) - (Number(previous?.[key]) || 0) + (Number(player[key]) || 0));
      }
      const { error: stateError } = await supabase.from('app_state').update({ state_json: state, updated_at: new Date().toISOString() }).eq('id', 1);
      if (stateError) throw stateError;
    }
    const summary = match => ({ winner: match.winner, scoreA: Number(match.scoreA) || 0, scoreB: Number(match.scoreB) || 0, stats: match.stats.map(player => ({ playerId: player.playerId, email: player.email, name: player.name, team: player.team, goals: Number(player.goals) || 0, assists: Number(player.assists) || 0, saves: Number(player.saves) || 0 })) });
    await auditAdminAction(req.user, 'match_result_corrected', 'baba_match', id, `Resultado corrigido em ${row.game_day}: ${Number(oldMatch.scoreA) || 0} × ${Number(oldMatch.scoreB) || 0} → ${scoreA} × ${scoreB}.`, { gameDay: row.game_day, oldResult: summary(oldMatch), newResult: summary(nextMatch) });
    res.json({ ok: true, match: nextMatch });
  } catch (error) { next(error); }
});
app.put('/api/admin/baba/matches/:date/close', authenticate, requireAdmin, requireDatabase, async (req, res, next) => {
  const date = String(req.params.date || '');
  if (!validDate(date)) return res.status(400).json({ error: 'Informe uma data válida.' });
  try {
    const { data: draws, error: drawsError } = await supabase.from('baba_draws').select('id,finalized').eq('game_day', date);
    if (drawsError) throw drawsError;
    if (draws?.length && draws.some(draw => !draw.finalized)) return res.status(409).json({ error: 'Finalize gols, assistências e defesas de todos os sorteios antes de liberar a votação.' });
    const { data, error } = await supabase.from('baba_matches').update({ voting_open: true }).eq('game_day', date).select('id');
    if (error) throw error;
    if (!data.length) return res.status(404).json({ error: 'Não há jogos salvos para essa data.' });
    await saveSetting(`baba_mode_${date}`, 'voting');
    await sendPushAll(`votes-open:${date}`, { category: 'votes', title: 'Votação das cartinhas liberada', body: 'O ADM encerrou os jogos do dia. Avalie as cartinhas dos jogadores que participaram.', url: '/' }, req.user.id);
    await auditAdminAction(req.user, 'voting_opened', 'baba_day', date, `Votação pós-baba liberada para ${date}.`, { gameDay: date, games: data.length });
    res.json({ ok: true, games: data.length, mode: 'voting' });
  } catch (error) { next(error); }
});

app.put('/api/admin/baba/matches/:date/finish-voting', authenticate, requireAdmin, requireDatabase, async (req, res, next) => {
  const date = String(req.params.date || '');
  if (!validDate(date)) return res.status(400).json({ error: 'Informe uma data válida.' });
  try {
    const { data: votes, error: votesError } = await supabase.from('baba_votes').select('voter_id').eq('game_day', date);
    if (votesError) throw votesError;
    const evaluations = votes?.length || 0, voters = new Set((votes || []).map(vote => vote.voter_id)).size;
    const { data, error } = await supabase.from('baba_matches').update({ voting_open: false }).eq('game_day', date).eq('voting_open', true).select('id');
    if (error) throw error;
    if (!data?.length) return res.status(409).json({ error: 'Não há votação aberta para essa data.' });
    await auditAdminAction(req.user, 'voting_closed', 'baba_day', date, `Votação pós-baba encerrada para ${date}: ${evaluations} avaliações de ${voters} jogadores.`, { gameDay: date, games: data.length, evaluations, voters });
    res.json({ ok: true, games: data.length, evaluations, voters });
  } catch (error) { next(error); }
});

app.get('/api/admin/baba/matches/:date/voting-summary', authenticate, requireAdmin, requireDatabase, async (req, res, next) => {
  const date = String(req.params.date || '');
  if (!validDate(date)) return res.status(400).json({ error: 'Informe uma data válida.' });
  try {
    const { data: votes, error } = await supabase.from('baba_votes').select('voter_id').eq('game_day', date);
    if (error) throw error;
    res.json({ evaluations: votes?.length || 0, voters: new Set((votes || []).map(vote => vote.voter_id)).size });
  } catch (error) { next(error); }
});

app.get('/api/admin/audit-log', authenticate, requireAdmin, requireDatabase, async (_req, res, next) => {
  try {
    const { data, error } = await supabase.from('admin_audit_logs').select('id,actor_id,actor_name,action,entity_type,entity_id,summary,details,created_at').order('created_at', { ascending: false }).limit(1000);
    if (error) throw error;
    res.json({ entries: data || [] });
  } catch (error) { next(error); }
});

app.get('/api/admin/members', authenticate, requireAdmin, requireDatabase, async (_req, res, next) => {
  try {
    const [{ data: rows, error }, fee] = await Promise.all([supabase.from('profiles').select('*').order('name'), getFee()]);
    if (error) throw error;
    res.json({ members: rows.map(row => ({ ...userPublic(row), paymentStatus: billingStatus(row, fee).status })) });
  } catch (error) { next(error); }
});
app.get('/api/admin/guests', authenticate, requireAdmin, requireDatabase, async (_req, res, next) => {
  try {
    const { data: guests, error } = await supabase.from('baba_guests').select('id,name,cpf_last4,age,invited_by,created_at,payment_status,payment_amount').order('created_at', { ascending: false });
    if (error) throw error;
    const inviterIds = [...new Set((guests || []).map(guest => guest.invited_by).filter(Boolean))];
    const { data: profiles, error: profileError } = inviterIds.length
      ? await supabase.from('profiles').select('id,name').in('id', inviterIds)
      : { data: [], error: null };
    if (profileError) throw profileError;
    const names = new Map((profiles || []).map(profile => [profile.id, profile.name]));
    res.json({ guests: (guests || []).map(guest => ({ ...guest, cpfMasked: `***.***.***-${guest.cpf_last4}`, invitedByName: names.get(guest.invited_by) || 'Associado removido' })) });
  } catch (error) { next(error); }
});
app.put('/api/admin/guests/:id/payment', authenticate, requireAdmin, requireDatabase, async (req, res, next) => {
  try {
    const { data: guest, error: readError } = await supabase.from('baba_guests').select('id,name,payment_status,payment_amount,created_at').eq('id', req.params.id).maybeSingle();
    if (readError) throw readError;
    if (!guest) return res.status(404).json({ error: 'Convidado não encontrado.' });
    const newlyPaid = guest.payment_status !== 'paid';
    if (newlyPaid) {
      const { error } = await supabase.from('baba_guests').update({ payment_status: 'paid' }).eq('id', guest.id);
      if (error) throw error;
    }
    const date = new Date().toISOString().slice(0, 10);
    await recordCashTransaction({ id: `guest-${guest.id}`, type: 'entrada', category: 'Diária Convidado', value: Number(guest.payment_amount) || 0, desc: `Pix convidado — ${guest.name}`, date });
    if (newlyPaid) await auditAdminAction(req.user, 'guest_payment_confirmed', 'guest', guest.id, `Pix do convidado ${guest.name} confirmado.`, { name: guest.name, amount: Number(guest.payment_amount) || 0 });
    res.json({ ok: true, paymentStatus: 'paid' });
  } catch (error) { next(error); }
});
app.delete('/api/admin/guests/:id', authenticate, requireAdmin, requireDatabase, async (req, res, next) => {
  const guestId = String(req.params.id || '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(guestId)) return res.status(400).json({ error: 'Identificador de convidado inválido.' });
  try {
    const { data, error } = await supabase.from('baba_guests').delete().eq('id', guestId).select('id,name,age');
    if (error) throw error;
    if (!data?.length) return res.status(404).json({ error: 'Convidado não encontrado.' });
    await auditAdminAction(req.user, 'guest_deleted', 'guest', guestId, `Convidado ${data[0].name} excluído.`, { name: data[0].name, age: data[0].age });
    res.json({ ok: true, id: guestId });
  } catch (error) { next(error); }
});
app.delete('/api/admin/transactions/:id', authenticate, requireAdmin, requireDatabase, async (req, res, next) => {
  const submitted = Buffer.from(String(req.body?.adminCode || ''));
  const expected = Buffer.from(adminDeleteCode);
  if (submitted.length !== expected.length || !timingSafeEqual(submitted, expected)) return res.status(403).json({ error: 'Código de administração incorreto.' });
  const transactionId = String(req.params.id || '');
  if (!transactionId || transactionId.length > 120) return res.status(400).json({ error: 'Identificador da transação inválido.' });
  try {
    const { data: row, error: readError } = await supabase.from('app_state').select('state_json').eq('id', 1).maybeSingle();
    if (readError) throw readError;
    if (!row) return res.status(404).json({ error: 'Caixa ainda não possui transações compartilhadas.' });
    const state = row.state_json || {}, current = Array.isArray(state.transactions) ? state.transactions : [];
    const deletedTransaction = current.find(item => String(item.id) === transactionId);
    const next = current.filter(item => String(item.id) !== transactionId);
    if (next.length === current.length) return res.status(404).json({ error: 'Transação não encontrada no caixa compartilhado.' });
    state.transactions = next;
    const { error } = await supabase.from('app_state').update({ state_json: state, updated_at: new Date().toISOString() }).eq('id', 1);
    if (error) throw error;
    await auditAdminAction(req.user, 'cash_transaction_deleted', 'cash_transaction', transactionId, `Transação do caixa excluída: ${deletedTransaction?.desc || transactionId}.`, { description: deletedTransaction?.desc || '', amount: Number(deletedTransaction?.value) || 0, category: deletedTransaction?.category || '', type: deletedTransaction?.type || '' });
    res.json({ ok: true, transactions: next });
  } catch (error) { next(error); }
});
app.delete('/api/admin/members/:id', authenticate, requireAdmin, requireDatabase, async (req, res, next) => {
  const memberId = String(req.params.id || '');
  const submittedCodeBuffer = Buffer.from(String(req.body?.adminCode || ''));
  const expectedCodeBuffer = Buffer.from(adminDeleteCode);
  const validAdminCode = submittedCodeBuffer.length === expectedCodeBuffer.length && timingSafeEqual(submittedCodeBuffer, expectedCodeBuffer);
  if (!validAdminCode) return res.status(403).json({ error: 'Código de administração incorreto.' });
  if (!memberId || memberId.length > 128) return res.status(400).json({ error: 'Identificador invÃ¡lido.' });
  try {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(memberId);
    let member = null;
    if (isUuid) {
      const { data, error: memberError } = await supabase.from('profiles').select('id,name,email,is_admin').eq('id', memberId).maybeSingle();
      if (memberError) throw memberError;
      member = data;
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
      const email = String(member?.email || '').toLowerCase();
      const belongsToMember = player => [player.serverId, player.authUserId, player.id].some(id => id != null && String(id) === memberId) || (!!email && String(player.email || '').toLowerCase() === email);
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

    if (member) {
    const { error: deleteError } = await supabase.auth.admin.deleteUser(memberId);
    if (deleteError) {
      if (previousState) await supabase.from('app_state').update({ state_json: previousState, updated_at: stateRow.updated_at }).eq('id', 1);
      throw deleteError;
    }
    }
    if (member || cleanedState) await auditAdminAction({ ...req.user, id: memberId === req.user.id ? null : req.user.id }, 'member_deleted', 'member', memberId, `Associado ${member?.name || memberId} excluído${member ? ' da conta' : ' da lista local compartilhada'}.`, { name: member?.name || '', email: member?.email || '', deletedAccount: !!member, removedFromSharedRoster: !!cleanedState });
    res.json({ ok: true, id: memberId, name: member?.name || "", deletedAccount: !!member, deletedSelf: memberId === req.user.id });
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
app.put('/api/profile/card', authenticate, requireDatabase, async (req, res, next) => {
  const mode = String(req.body?.mode || '');
  const photo = String(req.body?.photo || '');
  const adjustment = req.body?.adjustment || {};
  const scale = Number(adjustment.scale), x = Number(adjustment.x), y = Number(adjustment.y);
  if (!['profile', 'custom'].includes(mode)) return res.status(400).json({ error: 'Escolha a foto do perfil ou uma nova foto.' });
  if (mode === 'custom' && (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(photo) || photo.length > 2_100_000)) return res.status(400).json({ error: 'A nova foto deve ser PNG, JPG ou WebP de até 1,5 MB.' });
  if (!Number.isInteger(scale) || scale < 70 || scale > 160 || !Number.isInteger(x) || x < -60 || x > 60 || !Number.isInteger(y) || y < -80 || y > 80) return res.status(400).json({ error: 'Os ajustes de tamanho e posição estão fora do limite permitido.' });
  try {
    const { data: row, error: readError } = await supabase.from('app_state').select('state_json').eq('id', 1).maybeSingle();
    if (readError) throw readError;
    if (!row?.state_json) return res.status(404).json({ error: 'A lista de associados ainda não está disponível.' });
    const state = row.state_json;
    const roster = Array.isArray(state.players) ? state.players : [];
    let player = roster.find(item => [item.serverId, item.authUserId, item.id].some(id => id != null && String(id) === String(req.user.id)) || String(item.email || '').toLowerCase() === String(req.user.email || '').toLowerCase());
    if (!player) {
      player = { id: req.user.id, serverId: req.user.id, authUserId: req.user.id, name: req.user.name, email: req.user.email, age: req.user.age || 0, foot: req.user.foot || 'Direita', pos: req.user.position || 'Meio-Campo', height: Number(req.user.height) || 1.7, shirt: Number(req.user.shirt_number) || 0, photo: req.user.photo || '', goals: 0, assists: 0, saves: 0, matches: 0, days: 0, ritVotes: [70], driVotes: [70], chuVotes: [70], defVotes: [70], pasVotes: [70], fisVotes: [70] };
      roster.push(player);
      state.players = roster;
    }
    player.cardPhotoMode = mode;
    player.cardPhoto = mode === 'custom' ? photo : '';
    player.cardImageAdjustment = { scale, x, y };
    const { error: writeError } = await supabase.from('app_state').update({ state_json: state, updated_at: new Date().toISOString() }).eq('id', 1);
    if (writeError) throw writeError;
    res.json({ ok: true, cardPhotoMode: mode, cardImageAdjustment: player.cardImageAdjustment });
  } catch (error) { next(error); }
});
app.get('/api/profile/game-plan', authenticate, requireDatabase, async (req, res, next) => {
  try {
    const { data: row, error } = await supabase.from('app_state').select('state_json').eq('id', 1).maybeSingle();
    if (error) throw error;
    const plan = row?.state_json?.memberGamePlans?.[req.user.id] || null;
    res.json({ plan });
  } catch (error) { next(error); }
});
app.put('/api/profile/game-plan', authenticate, requireDatabase, async (req, res, next) => {
  const formation = String(req.body?.plan?.formation || '');
  const allowedSlots = {
    '2-3-1': ['gk','def1','def2','mid1','mid2','mid3','att1'], '3-2-1': ['gk','def1','def2','def3','mid1','mid2','att1'], '2-2-2': ['gk','def1','def2','mid1','mid2','att1','att2'],
    '1-4-1': ['gk','def1','mid1','mid2','mid3','mid4','att1'], '1-3-2': ['gk','def1','mid1','mid2','mid3','att1','att2'], '1-2-3': ['gk','def1','mid1','mid2','att1','att2','att3'],
    '2-1-3': ['gk','def1','def2','mid1','att1','att2','att3'], '3-1-2': ['gk','def1','def2','def3','mid1','att1','att2'], '4-1-1': ['gk','def1','def2','def3','def4','mid1','att1'],
    '3-3-0': ['gk','def1','def2','def3','mid1','mid2','mid3'], '2-4-0': ['gk','def1','def2','mid1','mid2','mid3','mid4'], '0-3-3': ['gk','mid1','mid2','mid3','att1','att2','att3'],
    custom: ['gk','custom1','custom2','custom3','custom4','custom5','custom6']
  };
  const slots = req.body?.plan?.slots;
  const submittedPositions = req.body?.plan?.positions;
  if (!allowedSlots[formation] || !slots || typeof slots !== 'object' || Array.isArray(slots)) return res.status(400).json({ error: 'Formação ou escalação inválida.' });
  const entries = Object.entries(slots);
  if (entries.length > 7 || entries.some(([slot, playerId]) => !allowedSlots[formation].includes(slot) || typeof playerId !== 'string' || !playerId || playerId.length > 128) || new Set(entries.map(([, playerId]) => playerId)).size !== entries.length) return res.status(400).json({ error: 'A escalação deve ter até 6 jogadores de linha, 1 goleiro e nenhum jogador repetido.' });
  const positions = {};
  if (formation === 'custom') {
    for (let index = 1; index <= 6; index++) {
      const position = submittedPositions?.[`custom${index}`];
      const x = Number(position?.x), y = Number(position?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 8 || x > 92 || y < 8 || y > 82) return res.status(400).json({ error: 'As posições personalizadas precisam ficar dentro do campo.' });
      positions[`custom${index}`] = { x, y };
    }
  }
  try {
    const { data: row, error: readError } = await supabase.from('app_state').select('state_json').eq('id', 1).maybeSingle();
    if (readError) throw readError;
    if (!row?.state_json) return res.status(404).json({ error: 'A lista de jogadores ainda não está disponível.' });
    const roster = Array.isArray(row.state_json.players) ? row.state_json.players.filter(player => !isDemoMember(player)) : [];
    const rosterIds = new Set(roster.flatMap(player => [player.id, player.serverId, player.authUserId].filter(value => value != null).map(String)));
    if (entries.some(([, playerId]) => !rosterIds.has(playerId))) return res.status(400).json({ error: 'Uma das cartinhas escolhidas não está mais disponível. Atualize o plano e tente novamente.' });
    const state = row.state_json;
    state.memberGamePlans = state.memberGamePlans && typeof state.memberGamePlans === 'object' ? state.memberGamePlans : {};
    state.memberGamePlans[req.user.id] = { formation, slots: Object.fromEntries(entries), ...(formation === 'custom' ? { positions } : {}), updatedAt: new Date().toISOString() };
    const { error: writeError } = await supabase.from('app_state').update({ state_json: state, updated_at: new Date().toISOString() }).eq('id', 1);
    if (writeError) throw writeError;
    res.json({ ok: true, plan: state.memberGamePlans[req.user.id] });
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

app.put('/api/admin/members/:id/profile', authenticate, requireAdmin, requireDatabase, async (req, res, next) => {
  const name = String(req.body?.name || '').trim();
  const nickname = String(req.body?.nickname || '').trim().slice(0, 24);
  const age = Number(req.body?.age), height = Number(req.body?.height);
  const position = String(req.body?.position || '');
  const foot = String(req.body?.foot || '');
  if (!name || name.length > 40 || !Number.isInteger(age) || age < 10 || age > 100 || !Number.isFinite(height) || height < 1.2 || height > 2.3 || !['Goleiro','Zagueiro','Lateral','Meio-Campo','Volante','Atacante'].includes(position) || !['Direita','Esquerda','Ambidestro'].includes(foot)) return res.status(400).json({ error: 'Confira nome, apelido, idade, posição, altura e melhor pé.' });
  try {
    const { data: member, error: findError } = await supabase.from('profiles').select('id,name,nickname,age,position,foot,height').eq('id', req.params.id).maybeSingle();
    if (findError) throw findError;
    if (!member) return res.status(404).json({ error: 'Associado não encontrado.' });
    const updated = { name, nickname, age, position, foot, height: Number(height.toFixed(2)) };
    const { error } = await supabase.from('profiles').update(updated).eq('id', member.id);
    if (error) throw error;
    await auditAdminAction(req.user, 'member_profile_updated', 'member', member.id, `Dados e apelido de ${name} atualizados.`, { before: member, after: updated });
    res.json({ ok: true, profile: updated });
  } catch (error) { next(error); }
});

app.put('/api/admin/members/:id/shirt-number', authenticate, requireAdmin, requireDatabase, async (req, res, next) => {
  const shirtNumber = Number(req.body?.shirtNumber);
  if (!Number.isInteger(shirtNumber) || shirtNumber < 0 || shirtNumber > 99) {
    return res.status(400).json({ error: 'O número da camisa deve ser de 1 a 99, ou 0 para sem número.' });
  }
  try {
    const { data: member, error: findError } = await supabase.from('profiles').select('id').eq('id', req.params.id).maybeSingle();
    if (findError) throw findError;
    if (!member) return res.status(404).json({ error: 'Associado não encontrado.' });
    if (shirtNumber > 0) {
      const { data: duplicate, error: duplicateError } = await supabase.from('profiles').select('id').eq('shirt_number', shirtNumber).neq('id', member.id).limit(1);
      if (duplicateError) throw duplicateError;
      if (duplicate?.length) return res.status(409).json({ error: 'Esse número de camisa já está atribuído a outro jogador.' });
    }
    const { error } = await supabase.from('profiles').update({ shirt_number: shirtNumber }).eq('id', member.id);
    if (error) throw error;
    res.json({ ok: true, shirtNumber });
  } catch (error) { next(error); }
});

app.put('/api/admin/members/:id/payment', authenticate, requireAdmin, requireDatabase, async (req, res, next) => {
  try {
    const { data: member, error: findError } = await supabase.from('profiles').select('id,name,position,paid_month').eq('id', req.params.id).maybeSingle();
    if (findError) throw findError;
    if (!member) return res.status(404).json({ error: 'Associado não encontrado.' });
    if (String(member.position || '').toLowerCase().includes('goleiro')) return res.status(409).json({ error: 'Goleiros são isentos da mensalidade; use o Custo GO quando houver cobrança extra.' });
    const month = monthKey();
    const alreadyPaid = member.paid_month === month;
    const { error } = await supabase.from('profiles').update({ paid_month: month }).eq('id', member.id);
    if (error) throw error;
    const amount = await getFee();
    await recordCashTransaction({ id: `membership-${member.id}-${month}`, type: 'entrada', category: 'Mensalidade', value: amount, desc: `Mensalidade ${month} — ${member.name}`, date: `${month}-01` });
    if (!alreadyPaid) await auditAdminAction(req.user, 'member_payment_confirmed', 'member', member.id, `Mensalidade de ${member.name} confirmada (${month}).`, { name: member.name, month, amount });
    res.json({ ok: true, month, status: 'paid', amount });
  } catch (error) { next(error); }
});
app.put('/api/admin/monthly-fee', authenticate, requireAdmin, requireDatabase, async (req, res, next) => {
  const amount = Number(req.body?.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10000) return res.status(400).json({ error: 'Informe um valor mensal válido.' });
  try {
    const [oldMonthlyFee, oldGuestFee, oldCustoGoFee, oldToggle, oldDescription] = await Promise.all([setting('monthly_fee'), setting('guest_daily_fee'), setting('keeper_event_fee'), setting('custo_go_enabled'), setting('custo_go_description')]);
    const guestFee = Number(req.body?.guestFee ?? oldGuestFee ?? 0);
    const custoGoFee = Number(req.body?.custoGoFee ?? oldCustoGoFee ?? 0);
    const custoGoDescription = String(req.body?.custoGoDescription ?? oldDescription ?? '').trim();
    const custoGoEnabled = typeof req.body?.custoGoEnabled === 'boolean' ? req.body.custoGoEnabled : String(oldToggle || 'false').toLowerCase() === 'true';
    if (!Number.isFinite(guestFee) || guestFee < 0 || guestFee > 5000) return res.status(400).json({ error: 'Informe um valor válido para a diária do convidado.' });
    if (!Number.isFinite(custoGoFee) || custoGoFee < 0 || custoGoFee > 5000) return res.status(400).json({ error: 'Informe um valor válido para o Custo GO.' });
    if (custoGoDescription.length > 100) return res.status(400).json({ error: 'A descrição do Custo GO deve ter até 100 caracteres.' });
    if (custoGoEnabled && custoGoFee <= 0) return res.status(400).json({ error: 'Defina um valor maior que zero antes de mostrar o Custo GO aos goleiros.' });
    if (custoGoEnabled && !custoGoDescription) return res.status(400).json({ error: 'Informe o motivo do Custo GO antes de mostrá-lo aos goleiros.' });
    const fee = Math.round(amount * 100) / 100;
    const guestDailyFee = Math.round(guestFee * 100) / 100, extraFee = Math.round(custoGoFee * 100) / 100;
    await Promise.all([saveSetting('monthly_fee', fee), saveSetting('guest_daily_fee', guestDailyFee), saveSetting('keeper_event_fee', extraFee), saveSetting('custo_go_enabled', custoGoEnabled), saveSetting('custo_go_description', custoGoDescription)]);
    await auditAdminAction(req.user, 'billing_settings_updated', 'settings', 'association-billing', 'Configurações de mensalidade e Custo GO atualizadas.', {
      previous: { monthlyFee: Number(oldMonthlyFee) || 0, guestFee: Number(oldGuestFee) || 0, custoGoFee: Number(oldCustoGoFee) || 0, custoGoEnabled: String(oldToggle || 'false').toLowerCase() === 'true', custoGoDescription: oldDescription || '' },
      next: { monthlyFee: fee, guestFee: guestDailyFee, custoGoFee: extraFee, custoGoEnabled, custoGoDescription }
    });
    res.json({ monthlyFee: fee, guestFee: guestDailyFee, custoGoFee: extraFee, custoGoEnabled, custoGoDescription });
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
    const [monthlyFee, guestFee, custoGoFee, custoGoEnabled, custoGoDescription, pixKey, pixQrDataUrl] = await Promise.all([getFee(), setting('guest_daily_fee'), setting('keeper_event_fee'), setting('custo_go_enabled'), setting('custo_go_description'), setting('pix_key'), setting('pix_qr_data_url')]);
    res.json({ monthlyFee, guestFee: Number(guestFee) || 0, custoGoFee: Number(custoGoFee) || 0, custoGoEnabled: String(custoGoEnabled || 'false').toLowerCase() === 'true', custoGoDescription: custoGoDescription || '', whatsapp: env('WHATSAPP_ADMIN', '5575998572594'), pixKey: pixKey || '', pixQrDataUrl: pixQrDataUrl || '' });
  } catch (error) { next(error); }
});

app.use((error, _req, res, _next) => {
  console.error('Futmancos API error:', error);
  res.status(500).json({ error: 'O servidor não conseguiu concluir a solicitação. Confira as tabelas e as variáveis do Supabase.' });
});

async function checkScheduledPushes() {
  if (!pushEnabled || !supabase) return;
  try {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const dayNumber = saoPauloDay(), month = monthKey();
    const { data: stateRow, error: stateError } = await supabase.from('app_state').select('state_json').eq('id', 1).maybeSingle();
    if (stateError) throw stateError;
    const nextGame = stateRow?.state_json?.nextGame;
    if (nextGame?.date === today) {
      const label = [nextGame.name, nextGame.time, nextGame.address].filter(Boolean).join(' · ');
      await sendPushAll(`baba-day:${today}`, { category: 'baba', title: 'Hoje tem baba!', body: label || 'Confira a Central Baba para ver o local e confirmar presença.', url: '/' });
    }
    const { data: members, error: membersError } = await supabase.from('profiles').select('id,email,name,position,paid_month,is_admin');
    if (membersError) throw membersError;
    const fee = await getFee();
    for (const member of (members || []).filter(row => !isDemoMember(row))) {
      const status = billingStatus(member, fee).status;
      if (status === 'pending' && dayNumber <= 12) await sendPushUsers([member.id], `billing-pending:${month}`, { category: 'payments', title: 'Mensalidade pendente', body: 'A mensalidade está disponível e vence no dia 12. Confira os dados Pix no app.', url: '/' });
      else if (status === 'overdue' && dayNumber > 12) await sendPushUsers([member.id], `billing-overdue:${month}`, { category: 'payments', title: 'Mensalidade em atraso', body: 'Fale com um administrador pelo WhatsApp para regularizar o pagamento.', url: '/' });
    }
  } catch (error) { console.warn('Não foi possível verificar os avisos agendados:', error.message); }
}
const pushReminderTimer = setInterval(checkScheduledPushes, 60 * 60 * 1000);
pushReminderTimer.unref?.();
setTimeout(checkScheduledPushes, 20_000).unref?.();

app.listen(port, '0.0.0.0', () => console.log(`Futmancos API listening on ${port}`));
