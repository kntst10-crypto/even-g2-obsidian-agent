import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Vault, AppError, requireText } from './vault.mjs';
import { dateInZone } from './server.mjs';

export async function executeJob(vault, job, env = process.env) {
  if (!job || job.expiresAt <= Date.now()) throw new AppError(409, '処理が期限切れです');
  const body = job.body;
  if (job.action === 'search') return { sources: await vault.search(body.query) };
  if (job.action === 'proposals') {
    const target = body.destination === 'daily' ? `${env.DAILY_FOLDER || 'Daily'}/${dateInZone(env.TIME_ZONE)}.md` : body.destination === 'inbox' ? 'Inbox.md' : body.path;
    return vault.propose(target, body.content);
  }
  if (job.action === 'confirm') { if (body.confirm !== true) throw new AppError(400, '明示確認が必要です'); return vault.confirm(requireText(body.id, '提案ID', 100)); }
  if (job.action === 'cancel') return vault.cancel(requireText(body.id, '提案ID', 100));
  throw new AppError(400, '許可されていない操作です');
}

export async function runConnector(env = process.env, { signal, log = console.log, request = fetch } = {}) {
  if (!env.VAULT_ROOT || !env.RELAY_ORIGIN) throw new Error('VAULT_ROOT and RELAY_ORIGIN are required');
  const origin = new URL(env.RELAY_ORIGIN);
  if (origin.href !== `${origin.origin}/` || (origin.protocol !== 'https:' && !(env.ALLOW_INSECURE_LOCAL === 'true' && ['localhost', '127.0.0.1'].includes(origin.hostname)))) throw new Error('Fixed HTTPS origin required');
  const vault = await new Vault(path.resolve(env.VAULT_ROOT)).init();
  let credential = env.CONNECTOR_TOKEN;
  const call = async (route, body, auth = credential) => {
    const response = await request(origin.origin + route, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth || ''}` }, body: JSON.stringify(body), redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) });
    const result = await response.json(); if (!response.ok) throw new AppError(response.status, result.error); return result;
  };
  if (!credential) {
    const pair = await call('/pair/create', {}, env.ONBOARDING_TOKEN); credential = pair.connectorToken;
    log(`Vault Lens 接続コード: ${pair.code.match(/.{1,6}/g).join('-')}（5分以内にEvenアプリへ入力）`);
    log('コードと接続情報を他人に共有しないでください。24時間または中継再起動後に再ペアリングが必要です。');
  }
  const prune = setInterval(() => vault.prune(), 5000); prune.unref();
  try {
    while (!signal?.aborted) {
      try {
        const { job } = await call('/connector/poll', {});
        if (job) {
          let result, error;
          try { result = await executeJob(vault, job, env); } catch (e) { error = { status: e.status || 500, message: e.status ? e.message : 'PCの処理に失敗しました' }; }
          // If receipt fails, never rerun a write. Relay also never redelivers a job.
          try { await call('/connector/result', { id: job.id, result, error }); }
          catch { log('結果の受領を確認できません。保存操作の場合はノートを確認してください。自動再実行はしません。'); }
        }
        await delay(1000, undefined, { signal });
      } catch (e) {
        if (signal?.aborted) break;
        if ([401, 403].includes(e.status)) throw new Error('接続が無効です。コネクターを再起動して再ペアリングしてください');
        log('中継に接続できません。5秒後に接続のみ再試行します。'); await delay(5000, undefined, { signal });
      }
    }
  } finally { clearInterval(prune); vault.pending.clear(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const stop = new AbortController(); process.on('SIGINT', () => stop.abort()); process.on('SIGTERM', () => stop.abort());
  await runConnector(process.env, { signal: stop.signal });
}
