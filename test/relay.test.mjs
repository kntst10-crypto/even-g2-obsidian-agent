import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RelayBroker, createRelay } from '../src/relay.mjs';
import { executeJob, runConnector } from '../src/connector.mjs';
import { Vault } from '../src/vault.mjs';
import { transcribe } from '../src/transcribe.mjs';
import { setTimeout as delay } from 'node:timers/promises';

function fixture(options) {
  const broker = new RelayBroker(options); const pair = broker.create(); const claim = broker.claim(pair.code);
  return { broker, pair, claim, session: broker.authenticate(pair.connectorToken, 'connector') };
}
test('pair code is single use and roles cannot impersonate each other', () => {
  const { broker, pair, claim } = fixture();
  assert.throws(() => broker.claim(pair.code), /無効/);
  assert.throws(() => broker.authenticate(pair.connectorToken, 'device'), /ペアリング/);
  assert.throws(() => broker.authenticate(claim.deviceToken, 'connector'), /ペアリング/);
  broker.close();
});
test('pair TTL and session revocation invalidate all credentials', () => {
  let now = 100; const broker = new RelayBroker({ now: () => now, pairTtl: 10 }); const pair = broker.create();
  now += 11; assert.throws(() => broker.claim(pair.code), /無効/);
  const next = broker.create(); const claim = broker.claim(next.code); broker.revoke(broker.authenticate(next.connectorToken));
  assert.throws(() => broker.authenticate(claim.deviceToken), /ペアリング/); broker.close();
});
test('jobs are delivered only once; payload removed immediately on reply', async () => {
  const { broker, session } = fixture(); broker.poll(session);
  const response = broker.command(session, 'search', { query: 'private' });
  const first = broker.poll(session).job; assert.equal(first.body.query, 'private');
  assert.equal(broker.poll(session).job, null);
  broker.result(session, first.id, { sources: [] }); assert.deepEqual(await response, { sources: [] });
  assert.equal(session.jobs.size, 0); assert.throws(() => broker.result(session, first.id, {}), /完了/); broker.close();
});
test('separate clients cannot poll or complete another session job', async () => {
  const { broker, session } = fixture(); broker.poll(session);
  const secondPair = broker.create(), second = broker.authenticate(secondPair.connectorToken);
  const response = broker.command(session, 'search', { query: 'private' }); const job = broker.poll(session).job;
  assert.equal(broker.poll(second).job, null); assert.throws(() => broker.result(second, job.id, {}), /期限/);
  broker.result(session, job.id, { sources: [] }); await response; broker.close();
});
test('expired jobs delete bodies and reject without retrying a write', async () => {
  let now = 100; const { broker, session } = fixture({ now: () => now, jobTtl: 10 }); broker.poll(session);
  const result = broker.command(session, 'confirm', { id: 'p', confirm: true });
  const rejected = assert.rejects(result, /期限/); const job = session.jobs.values().next().value;
  now += 11; broker.prune(); await rejected; assert.equal(job.body, null); assert.equal(session.jobs.size, 0); broker.close();
});
test('offline connector and unsupported operations fail before queueing', () => {
  const { broker, session } = fixture();
  assert.throws(() => broker.command(session, 'confirm', {}), /オフライン/);
  assert.throws(() => broker.command(session, 'shell', {}), /未対応/); broker.close();
});
test('connector never writes before explicit confirmation and blocks expired commands', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vault-relay-'));
  try {
    const vault = await new Vault(root).init(); const job = (action, body) => ({ action, body, expiresAt: Date.now() + 5000 });
    const proposal = await executeJob(vault, job('proposals', { destination: 'inbox', content: '記録' }));
    await assert.rejects(readFile(path.join(root, 'Inbox.md')), { code: 'ENOENT' });
    await assert.rejects(executeJob(vault, job('confirm', { id: proposal.id })), /明示/);
    assert.equal((await executeJob(vault, job('confirm', { id: proposal.id, confirm: true }))).saved, true);
    assert.match(await readFile(path.join(root, 'Inbox.md'), 'utf8'), /記録/);
    await assert.rejects(executeJob(vault, job('confirm', { id: proposal.id, confirm: true })), /実行済み/);
    await assert.rejects(executeJob(vault, { ...job('search', {}), expiresAt: 0 }), /期限/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('HTTPS enforced unless explicit local-only development configuration', () => {
  assert.throws(() => createRelay({ RELAY_ORIGIN: 'http://relay.example.com' }), /HTTPS/);
});
test('relay HTTP gates pairing, CORS and recording consent; audit has no request bodies', async () => {
  const records = [];
  const server = createRelay({ RELAY_ORIGIN: 'http://127.0.0.1', ALLOW_INSECURE_LOCAL: 'true', ONBOARDING_TOKEN: 'a'.repeat(32) }, { audit: row => records.push(row) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body, auth = '', extra = {}) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}`, ...extra }, body: JSON.stringify(body) });
  try {
    assert.equal((await post('/pair/create', {})).status, 403);
    const pair = await (await post('/pair/create', {}, 'a'.repeat(32))).json();
    assert.equal((await post('/pair/claim', { code: pair.code }, '', { Origin: 'https://evil.example' })).status, 403);
    const claim = await (await post('/pair/claim', { code: pair.code })).json();
    assert.equal((await post('/connector/poll', {}, claim.deviceToken)).status, 401);
    assert.equal((await post('/api/transcribe', {}, claim.deviceToken)).status, 400);
    assert.ok(records.every(row => Object.keys(row).sort().join() === 'action,status,time'));
    assert.ok(!JSON.stringify(records).includes(pair.code));
  } finally { await new Promise(resolve => server.close(resolve)); }
});
test('real HTTP outbound connector end-to-end proposes and saves one append', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vault-e2e-'));
  const server = createRelay({ RELAY_ORIGIN: 'http://127.0.0.1', ALLOW_INSECURE_LOCAL: 'true', PUBLIC_PAIRING: 'true' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const base = `http://127.0.0.1:${server.address().port}`;
  const stop = new AbortController(); let connector;
  const post = async (route, body, auth = '') => { const response = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` }, body: JSON.stringify(body) }); const data = await response.json(); assert.equal(response.status, 200, JSON.stringify(data)); return data; };
  try {
    const pair = await post('/pair/create', {}), claim = await post('/pair/claim', { code: pair.code });
    connector = runConnector({ RELAY_ORIGIN: base, ALLOW_INSECURE_LOCAL: 'true', VAULT_ROOT: root, CONNECTOR_TOKEN: pair.connectorToken }, { signal: stop.signal, log: () => {} });
    await delay(100);
    const proposal = await post('/api/proposals', { destination: 'inbox', content: '統合テスト記録' }, claim.deviceToken);
    const saved = await post('/api/confirm', { id: proposal.id, confirm: true }, claim.deviceToken); assert.equal(saved.saved, true);
    const found = await post('/api/search', { query: '統合テスト' }, claim.deviceToken); assert.equal(found.sources[0].path, 'Inbox.md');
  } finally { stop.abort(); await connector?.catch(() => {}); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); }
});
test('speech API refuses cloud-disabled and malformed audio without network access', async () => {
  const request = () => { throw new Error('must not call'); };
  await assert.rejects(transcribe(Buffer.alloc(400), {}, request), /有効化/);
  await assert.rejects(transcribe(Buffer.alloc(400), { ALLOW_CLOUD: 'true', OPENAI_API_KEY: 'test', OPENAI_TRANSCRIBE_MODEL: 'test' }, request), /WAV/);
});
test('speech sends canonical WAV only to fixed OpenAI origin, with server-side key', async () => {
  const wav = Buffer.alloc(364); wav.write('RIFF', 0); wav.writeUInt32LE(356, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(320, 40);
  const env = { ALLOW_CLOUD: 'true', OPENAI_API_KEY: 'server-secret', OPENAI_TRANSCRIBE_MODEL: 'configured-model' };
  const result = await transcribe(wav, env, async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/audio/transcriptions'); assert.equal(options.headers.Authorization, 'Bearer server-secret');
    assert.equal(options.body.get('model'), 'configured-model'); assert.equal(options.body.get('file').size, 364); assert.equal(options.redirect, 'error');
    return { ok: true, json: async () => ({ text: '  日本語の記録  ' }) };
  });
  assert.equal(result, '日本語の記録');
});
