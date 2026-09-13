import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function browser() {
  const elements = new Map(); const calls = [];
  const element = id => { if (!elements.has(id)) elements.set(id, { value: id === 'provider' ? 'local' : '', textContent: '', disabled: false }); return elements.get(id); };
  const context = vm.createContext({
    document: { getElementById: element, querySelectorAll: () => [] },
    window: { addEventListener() {} }, sessionStorage: { getItem: () => null, setItem() {} },
    waitForEvenAppBridge: () => new Promise(() => {}), G2Bridge: class {},
    __RELAY_ORIGIN__: 'https://relay.example.invalid', AbortSignal, Date, Uint8Array, DataView,
    fetch: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      const result = url.endsWith('/pair/claim') ? { deviceToken: 'device', expiresAt: Date.now() + 60000 }
        : url.endsWith('/api/proposals') ? { id: 'proposal', path: 'Inbox.md', content: calls.at(-1).body.content, expiresAt: Date.now() + 60000 }
        : url.endsWith('/api/confirm') ? { saved: true, path: 'Inbox.md' }
        : { sources: [{ path: 'Inbox.md', line: 1, excerpt: 'note' }] };
      return { ok: true, json: async () => result };
    },
  });
  const source = (await readFile(new URL('../client/main.js', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '');
  vm.runInContext(source, context); await new Promise(resolve => setImmediate(resolve));
  element('code').value = 'ABC'; await element('pair').onclick();
  return { context, element, calls };
}
test('G2 client requires transcript review and separate proposal confirmation before write', async () => {
  const { element, calls } = await browser(); element('input').value = '短い記録';
  await element('inbox').onclick(); assert.equal(calls.length, 1);
  await element('click').onclick(); assert.ok(calls.at(-1).url.endsWith('/api/proposals'));
  assert.ok(!calls.some(call => call.url.endsWith('/api/confirm')));
  await element('click').onclick(); assert.ok(calls.at(-1).url.endsWith('/api/confirm')); assert.equal(calls.at(-1).body.confirm, true);
  assert.match(element('screen').textContent, /保存しました/);
});
test('G2 client cannot confirm long text until final page and back cancels proposal', async () => {
  const { element, calls } = await browser(); element('input').value = '長い記録'.repeat(100);
  await element('inbox').onclick(); await element('click').onclick(); assert.equal(calls.length, 1);
  for (let i = 0; i < 8; i++) await element('next').onclick(); await element('click').onclick();
  assert.ok(calls.at(-1).url.endsWith('/api/proposals'));
  await element('click').onclick(); assert.ok(!calls.some(call => call.url.endsWith('/api/confirm')));
  await element('back').onclick(); assert.ok(calls.at(-1).url.endsWith('/api/cancel'));
  assert.match(element('screen').textContent, /音声でノート検索/);
});
