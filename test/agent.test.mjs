import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, symlink, link, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Vault } from '../src/vault.mjs';
import { answer } from '../src/providers.mjs';
import { createServer, dateInZone } from '../src/server.mjs';

async function fixture(t, options) {
  const root = await mkdtemp(path.join(tmpdir(), 'vault-lens-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'Inbox.md'), '# Inbox\nサンプル案件の資料を確認');
  return { root, vault: await new Vault(root, options).init() };
}
test('Japanese search returns source location and excludes hidden files', async t => {
  const { root, vault } = await fixture(t);
  await mkdir(path.join(root, '.obsidian')); await writeFile(path.join(root, '.obsidian', 'secret.md'), 'サンプル案件');
  const results = await vault.search('サンプル案件');
  assert.equal(results.length, 1); assert.equal(results[0].path, 'Inbox.md'); assert.equal(results[0].line, 1);
});
test('proposing does not modify vault; confirmation appends once', async t => {
  const { root, vault } = await fixture(t); const before = await readFile(path.join(root, 'Inbox.md'), 'utf8');
  const p = await vault.propose('Inbox.md', '次の作業');
  assert.equal(await readFile(path.join(root, 'Inbox.md'), 'utf8'), before);
  assert.equal((await vault.confirm(p.id)).saved, true);
  assert.equal(await readFile(path.join(root, 'Inbox.md'), 'utf8'), before + '\n\n次の作業\n');
  await assert.rejects(vault.confirm(p.id), { status: 409 });
});
test('new Daily Note is created only after confirmation', async t => {
  const { root, vault } = await fixture(t); const p = await vault.propose('Daily/2026-09-13.md', '新しいメモ');
  await assert.rejects(readFile(path.join(root, 'Daily/2026-09-13.md')), { code: 'ENOENT' });
  await vault.confirm(p.id); assert.match(await readFile(path.join(root, 'Daily/2026-09-13.md'), 'utf8'), /新しいメモ/);
});
test('cancelled and expired proposals cannot execute', async t => {
  let now = 0; const { vault } = await fixture(t, { ttlMs: 10, now: () => now });
  const p = await vault.propose('Inbox.md', 'cancel'); await vault.cancel(p.id); await assert.rejects(vault.confirm(p.id), { status: 409 });
  const q = await vault.propose('Inbox.md', 'expire'); now = 11; await assert.rejects(vault.confirm(q.id), { status: 409 });
});
test('changed note invalidates proposal without overwriting', async t => {
  const { root, vault } = await fixture(t); const p = await vault.propose('Inbox.md', 'append');
  await writeFile(path.join(root, 'Inbox.md'), 'external edit'); await assert.rejects(vault.confirm(p.id), { status: 409 });
  assert.equal(await readFile(path.join(root, 'Inbox.md'), 'utf8'), 'external edit');
});
test('concurrent confirmation cannot duplicate an append', async t => {
  const { root, vault } = await fixture(t); const p = await vault.propose('Inbox.md', 'unique-marker');
  const results = await Promise.allSettled([vault.confirm(p.id), vault.confirm(p.id)]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal((await readFile(path.join(root, 'Inbox.md'), 'utf8')).split('unique-marker').length, 2);
});
test('reject traversal, absolute, hidden, non-Markdown, colon, and backslash paths', async t => {
  const { vault } = await fixture(t);
  for (const p of ['../outside.md', '/tmp/a.md', '.obsidian/config.md', 'note.json', 'C:/x.md', 'a\\b.md', 'a//b.md']) await assert.rejects(vault.propose(p, 'blocked'), { status: 400 });
});
test('reject symlink directories, symlink files and hardlinks', async t => {
  const { root, vault } = await fixture(t);
  await symlink(path.join(root, 'Inbox.md'), path.join(root, 'alias.md'));
  await symlink(tmpdir(), path.join(root, 'linked-dir'));
  await assert.rejects(vault.propose('alias.md', 'blocked'), { status: 400 });
  await assert.rejects(vault.propose('linked-dir/outside.md', 'blocked'), { status: 400 });
  await link(path.join(root, 'Inbox.md'), path.join(root, 'hard.md'));
  await assert.rejects(vault.propose('hard.md', 'blocked'), { status: 400 });
});
test('local mode never calls the network', async () => {
  let called = false; const request = () => { called = true; throw new Error('network'); };
  assert.match(await answer({ provider: 'local', question: 'q', sources: [] }, {}, request), /該当ノート/);
  assert.equal(called, false);
});
test('cloud requires both server opt-in and request consent', async () => {
  const input = { provider: 'openai', question: 'q', sources: [{ path: 'Inbox.md', line: 1, excerpt: 'x' }] };
  await assert.rejects(answer({ ...input, cloudConsent: true }, {}), { status: 403 });
  await assert.rejects(answer(input, { ALLOW_CLOUD: 'true' }), { status: 403 });
});
test('OpenAI adapter keeps keys in headers and disables response storage', async () => {
  let captured;
  const request = async (url, options) => { captured = { url, options }; return { ok: true, json: async () => ({ output: [{ type: 'message', content: [{ type: 'output_text', text: '回答[1]' }] }] }) }; };
  const output = await answer({ provider: 'openai', cloudConsent: true, question: 'q', sources: [{ path: 'Inbox.md', line: 1, excerpt: '資料' }] }, { ALLOW_CLOUD: 'true', OPENAI_API_KEY: 'test-key', OPENAI_MODEL: 'configured-model' }, request);
  assert.equal(output, '回答[1]'); assert.equal(captured.url, 'https://api.openai.com/v1/responses');
  assert.equal(captured.options.headers.Authorization, 'Bearer test-key'); assert.equal(JSON.parse(captured.options.body).store, false);
  assert.ok(!captured.options.body.includes('test-key'));
});
test('Claude adapter uses Messages and reads text blocks', async () => {
  let captured;
  const request = async (url, options) => { captured = { url, options }; return { ok: true, json: async () => ({ content: [{ type: 'text', text: '下書き' }] }) }; };
  const output = await answer({ provider: 'claude', cloudConsent: true, question: 'draft', mode: 'draft', sources: [] }, { ALLOW_CLOUD: 'true', ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_MODEL: 'configured-model' }, request);
  assert.equal(output, '下書き'); assert.equal(captured.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(captured.options.headers['anthropic-version'], '2023-06-01');
});
test('Daily date follows configured timezone', () => {
  assert.equal(dateInZone('Asia/Tokyo', new Date('2026-09-13T16:00:00Z')), '2026-09-14');
});
test('HTTP API enforces auth, origin, explicit confirmation and supports search', async t => {
  const { root } = await fixture(t); const token = 'test-only-token-not-secret-123456789';
  const server = await createServer({ AGENT_TOKEN: token, VAULT_ROOT: root, PUBLIC_ORIGIN: 'http://127.0.0.1' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (route, body, extra = {}) => new Promise((resolve, reject) => {
    const req = http.request(base + route, { method: 'POST', headers: { Host: '127.0.0.1', 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...extra } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, json: async () => JSON.parse(Buffer.concat(chunks).toString()) }));
    }); req.on('error', reject); req.end(JSON.stringify(body));
  });
  assert.equal((await request('/api/search', { query: 'サンプル' }, { Authorization: 'wrong' })).status, 401);
  assert.equal((await request('/api/search', { query: 'サンプル' }, { Origin: 'https://evil.example' })).status, 403);
  const res = await request('/api/search', { query: 'サンプル' }); assert.equal(res.status, 200); assert.equal((await res.json()).sources.length, 1);
  const proposal = await (await request('/api/proposals', { destination: 'inbox', content: 'HTTP追記' })).json();
  assert.equal((await request('/api/confirm', { id: proposal.id })).status, 400);
  assert.equal((await request('/api/confirm', { id: proposal.id, confirm: true })).status, 200);
});
