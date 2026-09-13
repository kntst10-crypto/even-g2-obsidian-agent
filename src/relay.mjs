import http from 'node:http';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { AppError, requireText } from './vault.mjs';
import { answer } from './providers.mjs';
import { transcribe } from './transcribe.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const COMMANDS = new Set(['search', 'proposals', 'confirm', 'cancel']);

// Single-process, volatile broker. No disk/database/body logging. Restart revokes all pairs.
export class RelayBroker {
  constructor({ now = Date.now, jobTtl = 45000, pairTtl = 300000, sessionTtl = 86400000, limit = 1000 } = {}) {
    Object.assign(this, { now, jobTtl, pairTtl, sessionTtl, limit });
    this.sessions = new Map(); this.credentials = new Map(); this.pairs = new Map();
  }
  prune() {
    for (const [key, item] of this.pairs) if (item.expiresAt <= this.now()) this.pairs.delete(key);
    for (const session of this.sessions.values()) {
      if (session.expiresAt <= this.now()) { this.revoke(session); continue; }
      for (const job of session.jobs.values()) if (job.expiresAt <= this.now()) this.finish(session, job, null, new AppError(504, 'PCの応答が期限切れです。保存操作の場合はノートを確認し、再実行しないでください'));
    }
  }
  create() {
    this.prune();
    if (this.sessions.size >= this.limit) throw new AppError(429, '接続数の上限です');
    const connectorToken = token(), code = randomBytes(9).toString('hex').toUpperCase();
    const session = { id: randomUUID(), expiresAt: this.now() + this.sessionTtl, jobs: new Map(), keys: [], lastPoll: 0 };
    const key = digest(connectorToken); session.keys.push(key);
    this.sessions.set(session.id, session); this.credentials.set(key, { session, role: 'connector' });
    this.pairs.set(digest(code), { session, expiresAt: this.now() + this.pairTtl });
    return { connectorToken, code, expiresAt: this.now() + this.pairTtl, sessionExpiresAt: session.expiresAt };
  }
  claim(code) {
    this.prune(); const key = digest(requireText(code, '接続コード', 30).replaceAll('-', '').toUpperCase());
    const pair = this.pairs.get(key);
    if (!pair) throw new AppError(401, '接続コードが無効または期限切れです');
    this.pairs.delete(key);
    const deviceToken = token(), credential = digest(deviceToken);
    pair.session.keys.push(credential); this.credentials.set(credential, { session: pair.session, role: 'device' });
    return { deviceToken, expiresAt: pair.session.expiresAt };
  }
  authenticate(value, role) {
    this.prune(); const credential = this.credentials.get(digest(value || ''));
    if (!credential || (role && credential.role !== role)) throw new AppError(401, '再ペアリングが必要です');
    return credential.session;
  }
  revoke(session) {
    for (const key of session.keys) this.credentials.delete(key);
    for (const [key, pair] of this.pairs) if (pair.session === session) this.pairs.delete(key);
    for (const job of session.jobs.values()) this.finish(session, job, null, new AppError(401, '接続が解除されました'));
    this.sessions.delete(session.id);
  }
  command(session, action, body) {
    if (!COMMANDS.has(action)) throw new AppError(400, '未対応の操作です');
    if (session.jobs.size >= 4) throw new AppError(429, 'PCの処理完了を待ってください');
    if (this.now() - session.lastPoll > 15000) throw new AppError(503, 'PCコネクターがオフラインです');
    return new Promise((resolve, reject) => {
      const job = { id: randomUUID(), action, body, expiresAt: this.now() + this.jobTtl, delivered: false, resolve, reject };
      job.timer = setTimeout(() => this.finish(session, job, null, new AppError(504, '応答期限切れ。保存の成否はノートで確認してください')), this.jobTtl);
      job.timer.unref?.(); session.jobs.set(job.id, job);
    });
  }
  poll(session) {
    session.lastPoll = this.now(); this.prune();
    const job = [...session.jobs.values()].find(item => !item.delivered);
    if (!job) return { job: null };
    job.delivered = true; // Never redeliver a possibly-executed write.
    return { job: { id: job.id, action: job.action, body: job.body, expiresAt: job.expiresAt } };
  }
  result(session, id, result, error) {
    const job = session.jobs.get(id);
    if (!job || !job.delivered) throw new AppError(409, '処理は期限切れまたは完了済みです');
    this.finish(session, job, result, error ? new AppError([400, 409, 413, 429].includes(error.status) ? error.status : 502, String(error.message || 'PCでエラーが発生しました').slice(0, 300)) : null);
  }
  finish(session, job, result, error) {
    if (!session.jobs.delete(job.id)) return;
    clearTimeout(job.timer); job.body = null;
    if (error) job.reject(error); else job.resolve(result);
  }
  close() { for (const session of this.sessions.values()) this.revoke(session); }
}

async function readBody(req, max = 24000) {
  let length = 0; const chunks = [];
  for await (const chunk of req) { length += chunk.length; if (length > max) throw new AppError(413, '送信データが大きすぎます'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}

export function createRelay(env = process.env, { broker = new RelayBroker(), ai = answer, speech = transcribe, audit = () => {} } = {}) {
  const origin = new URL(env.RELAY_ORIGIN || 'http://127.0.0.1:8790');
  if (origin.protocol !== 'https:' && !(env.ALLOW_INSECURE_LOCAL === 'true' && ['127.0.0.1', 'localhost'].includes(origin.hostname))) throw new Error('RELAY_ORIGIN must be HTTPS');
  const allowed = new Set([origin.origin, ...(env.CLIENT_ORIGINS || '').split(',').filter(Boolean)]);
  const rates = new Map(); let globalWindow = 0, globalCount = 0, aiActive = 0;
  const server = http.createServer(async (req, res) => {
    const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    let status = 500, action = 'unknown';
    try {
      const route = new URL(req.url, origin).pathname;
      if (req.method === 'GET' && route === '/health') { status = 200; send(200, { ok: true, service: 'Vault Lens', storage: 'volatile' }); return; }
      if (req.headers.origin && !allowed.has(req.headers.origin)) throw new AppError(403, 'Originは許可されていません');
      if (req.headers.origin) { res.setHeader('Access-Control-Allow-Origin', req.headers.origin); res.setHeader('Vary', 'Origin'); }
      if (req.method === 'OPTIONS') { res.setHeader('Access-Control-Allow-Methods', 'POST'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Audio-Consent'); status = 204; res.writeHead(204); res.end(); return; }
      if (req.method !== 'POST') throw new AppError(405, 'POSTが必要です');
      const now = Date.now();
      if (now - globalWindow > 60000) { globalWindow = now; globalCount = 0; rates.clear(); }
      if (++globalCount > 6000) throw new AppError(429, '混雑しています');
      const rawToken = (req.headers.authorization || '').replace(/^Bearer /, '');
      // Never trust client-controlled forwarding headers for security decisions.
      const rateKey = route.startsWith('/pair/') ? 'pair-global' : digest(rawToken);
      const count = (rates.get(rateKey) || 0) + 1; rates.set(rateKey, count);
      if (count > (route.startsWith('/pair/') ? 30 : 180)) throw new AppError(429, '操作回数の上限です');
      if (route === '/api/transcribe') {
        action = 'transcribe'; broker.authenticate(rawToken, 'device');
        if (req.headers['content-type'] !== 'audio/wav' || req.headers['x-audio-consent'] !== 'true') throw new AppError(400, '音声送信の同意が必要です');
        if (aiActive >= 4) throw new AppError(429, 'AIが混雑しています');
        aiActive++; try { const text = await speech(await readBody(req, 960044), env); status = 200; send(200, { text }); } finally { aiActive--; } return;
      }
      if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new AppError(415, 'JSONが必要です');
      let body; try { body = JSON.parse((await readBody(req)).toString()); } catch (e) { if (e.status) throw e; throw new AppError(400, 'JSONが不正です'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError(400, 'JSON objectが必要です');
      let result;
      if (route === '/pair/create') {
        action = 'pair-create';
        if (env.PUBLIC_PAIRING !== 'true' && (!env.ONBOARDING_TOKEN || digest(rawToken) !== digest(env.ONBOARDING_TOKEN))) throw new AppError(403, '運営者の接続許可が必要です');
        result = broker.create();
      } else if (route === '/pair/claim') { action = 'pair-claim'; result = broker.claim(body.code); }
      else if (route === '/pair/revoke') { action = 'pair-revoke'; broker.revoke(broker.authenticate(rawToken)); result = { revoked: true }; }
      else if (route === '/connector/poll') { action = 'poll'; result = broker.poll(broker.authenticate(rawToken, 'connector')); }
      else if (route === '/connector/result') { action = 'result'; broker.result(broker.authenticate(rawToken, 'connector'), body.id, body.result, body.error); result = { accepted: true }; }
      else {
        const session = broker.authenticate(rawToken, 'device'); action = route.replace('/api/', '');
        if (action === 'answer') {
          const question = requireText(body.question, '質問');
          const mode = body.mode || 'answer'; if (!['answer', 'draft'].includes(mode)) throw new AppError(400, 'モードが不正です');
          const sources = mode === 'answer' ? (await broker.command(session, 'search', { query: body.query || question.slice(0, 300) })).sources : [];
          if (aiActive >= 4) throw new AppError(429, 'AIが混雑しています');
          aiActive++; try { result = { text: await ai({ provider: body.provider || 'local', question, sources, mode, cloudConsent: body.cloudConsent }, env), sources, saved: false }; } finally { aiActive--; }
        } else result = await broker.command(session, action, body);
      }
      status = 200; send(200, result);
    } catch (error) { status = error.status || 500; send(status, { error: error.status ? error.message : '中継エラー。保存操作はノートで成否を確認してください' }); }
    finally { if (action !== 'poll') audit({ action: new Set(['pair-create', 'pair-claim', 'pair-revoke', 'result', 'search', 'proposals', 'confirm', 'cancel', 'answer', 'transcribe']).has(action) ? action : 'unknown', status, time: new Date().toISOString() }); }
  });
  const prune = setInterval(() => broker.prune(), 5000); prune.unref();
  server.on('close', () => { clearInterval(prune); broker.close(); });
  server.requestTimeout = 60000; server.headersTimeout = 10000;
  return server;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createRelay(process.env, { audit: event => console.log(JSON.stringify(event)) }).listen(Number(process.env.PORT || 8790), '0.0.0.0', () => console.log('Vault Lens relay ready; payload logging disabled'));
}
