const $ = id => document.getElementById(id);
let pages = ['ローカル接続トークンを入力して、検索してください。'];
let page = 0; let latest = ''; let pending = null;
function render() { $('display').textContent = pages[page]; $('pageNumber').textContent = `${page + 1} / ${pages.length}`; }
function show(text, sources = []) {
  latest = text; const chars = Array.from(text); pages = [];
  for (let i = 0; i < chars.length; i += 150) pages.push(chars.slice(i, i + 150).join(''));
  if (!pages.length) pages = ['結果なし']; page = 0; render();
  $('sources').textContent = sources.map((s, i) => `[${i + 1}] ${s.path}:${s.line}`).join('\n');
}
async function api(route, payload) {
  const response = await fetch('/api/' + route, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${$('token').value}` }, body: JSON.stringify(payload) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || '接続エラー'); return data;
}
function action(id, fn) {
  $(id).addEventListener('click', async () => {
    $(id).disabled = true; $('status').textContent = '処理中…';
    try { await fn(); $('status').textContent = '完了'; } catch (e) { $('status').textContent = e.message; }
    finally { $(id).disabled = false; }
  });
}
action('search', async () => {
  const data = await api('search', { query: $('query').value });
  show(data.sources.map((s, i) => `[${i + 1}] ${s.path}\n${s.excerpt}`).join('\n\n') || '該当ノートなし', data.sources);
});
for (const mode of ['answer', 'draft']) action(mode, async () => {
  const data = await api('answer', { question: $('question').value, query: $('query').value, provider: $('provider').value, cloudConsent: $('consent').checked, mode });
  $('consent').checked = false; show(data.text, data.sources);
});
$('prev').onclick = () => { page = Math.max(0, page - 1); render(); };
$('next').onclick = () => { page = Math.min(pages.length - 1, page + 1); render(); };
$('copyDraft').onclick = () => { $('content').value = latest; };
action('propose', async () => {
  if (pending) await api('cancel', { id: pending.id });
  pending = null; $('confirmation').hidden = true;
  pending = await api('proposals', { destination: $('destination').value, path: $('path').value, content: $('content').value });
  $('proposal').textContent = `${pending.path}\n\n${pending.content}\n\n5分以内に確認してください。編集欄を変更してもこの提案は変わりません。`;
  $('confirmation').hidden = false;
});
action('confirm', async () => {
  if (!pending) throw new Error('先に追記内容を確認してください');
  const data = await api('confirm', { id: pending.id, confirm: true });
  pending = null; $('confirmation').hidden = true; show(`保存しました: ${data.path}`);
});
action('cancel', async () => {
  if (pending) await api('cancel', { id: pending.id }); pending = null; $('confirmation').hidden = true;
});
render();
