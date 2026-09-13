import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Vault, AppError, requireText } from './vault.mjs';
import { answer } from './providers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const assets = new Map([['/', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']], ['/style.css', ['style.css', 'text/css']]]);

async function readJSON(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) throw new AppError(415, 'JSONが必要です');
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 24000) throw new AppError(413, 'リクエストが大きすぎます'); chunks.push(chunk); }
  try { const result = JSON.parse(Buffer.concat(chunks).toString()); if (!result || typeof result !== 'object' || Array.isArray(result)) throw 0; return result; }
  catch { throw new AppError(400, 'JSONが不正です'); }
}
export function dateInZone(zone = 'Asia/Tokyo', now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now).map(x => [x.type, x.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export async function createServer(env = process.env) {
  if (!env.AGENT_TOKEN || env.AGENT_TOKEN.length < 32) throw new Error('AGENT_TOKEN must contain at least 32 characters; generate a random token');
  if (!env.VAULT_ROOT) throw new Error('VAULT_ROOT is required');
  const vault = await new Vault(path.resolve(env.VAULT_ROOT)).init();
  const publicOrigin = new URL(env.PUBLIC_ORIGIN || 'http://127.0.0.1:8788');
  const origins = new Set([publicOrigin.origin, ...(env.CLIENT_ORIGIN ? [new URL(env.CLIENT_ORIGIN).origin] : [])]);
  dateInZone(env.TIME_ZONE); // Validate startup configuration.
  const dailyFolder = env.DAILY_FOLDER || 'Daily'; vault.validate(`${dailyFolder}/2000-01-01.md`);
  let active = 0; let windowStart = Date.now(); let requests = 0;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    let counted = false;
    try {
      if (req.headers.host !== publicOrigin.host) throw new AppError(403, 'Hostが許可されていません');
      const origin = req.headers.origin;
      if (origin && !origins.has(origin)) throw new AppError(403, 'Originが許可されていません');
      if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
      const route = new URL(req.url, publicOrigin).pathname;
      if (req.method === 'GET' && assets.has(route)) {
        const [file, type] = assets.get(route);
        res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' }); res.end(await readFile(path.join(here, '../public', file))); return;
      }
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'POST'); res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type'); res.writeHead(204); res.end(); return;
      }
      const expected = Buffer.from(`Bearer ${env.AGENT_TOKEN}`);
      const actual = Buffer.from(req.headers.authorization ?? '');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new AppError(401, '接続トークンを確認してください');
      if (req.method !== 'POST') throw new AppError(405, 'POSTのみ利用できます');
      if (Date.now() - windowStart > 60000) { windowStart = Date.now(); requests = 0; }
      if (++requests > 60 || active >= 4) throw new AppError(429, 'しばらく待って再試行してください');
      active++; counted = true;
      const body = await readJSON(req);
      if (route === '/api/search') { send(200, { sources: await vault.search(body.query) }); return; }
      if (route === '/api/answer') {
        const question = requireText(body.question, '質問');
        const mode = body.mode ?? 'answer';
        if (!['answer', 'draft'].includes(mode)) throw new AppError(400, '不明なモードです');
        const sources = mode === 'answer' ? await vault.search(body.query || question.slice(0, 300)) : [];
        const text = await answer({ provider: body.provider ?? 'local', question, sources, mode, cloudConsent: body.cloudConsent }, env);
        send(200, { text, sources, provider: body.provider ?? 'local', saved: false }); return;
      }
      if (route === '/api/proposals') {
        const destination = body.destination === 'daily' ? `${dailyFolder}/${dateInZone(env.TIME_ZONE)}.md` : body.destination === 'inbox' ? 'Inbox.md' : body.path;
        send(200, await vault.propose(destination, body.content)); return;
      }
      if (route === '/api/confirm') { if (body.confirm !== true) throw new AppError(400, '明示確認が必要です'); send(200, await vault.confirm(requireText(body.id, '提案ID', 100))); return; }
      if (route === '/api/cancel') { send(200, await vault.cancel(requireText(body.id, '提案ID', 100))); return; }
      throw new AppError(404, '見つかりません');
    } catch (e) { if (!res.headersSent) send(e.status ?? 500, { error: e.status ? e.message : 'サーバーエラー。保存の成否はノートを確認してください' }); else res.end(); }
    finally { if (counted) active--; }
  });
  server.requestTimeout = 35000; server.headersTimeout = 10000;
  return server;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8788);
  const server = await createServer();
  server.listen(port, '127.0.0.1', () => console.log(`Local agent listening at http://127.0.0.1:${port}. G2 hardware is not connected in this MVP.`));
}
