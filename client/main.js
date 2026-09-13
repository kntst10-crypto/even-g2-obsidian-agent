import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk';
import { G2Bridge } from '../src/g2-bridge.mjs';
import './style.css';

const ORIGIN = __RELAY_ORIGIN__;
const $ = id => document.getElementById(id);
const menu = ['音声でノート検索', '音声でInboxに追記', '音声でDailyに追記', '音声で根拠付き回答'];
let sdk, glasses, credential = '', expiresAt = 0, mode = 'root', selected = 0, page = 0, pages = [], busy = false, pendingAudio, transcript = '', proposal, action = 'search';
const split = text => Array.from(String(text)).reduce((all, char) => { if (all.at(-1).length >= 150) all.push(''); all[all.length - 1] += char; return all; }, ['']);
function errorMessage(error) { return error?.message || '処理に失敗しました'; }
async function show(text) { $('screen').textContent = text; await glasses?.display(text); }
function paired() { return credential && expiresAt > Date.now(); }
async function home() {
  mode = 'root'; page = 0; pendingAudio = null; transcript = ''; proposal = null;
  await show(paired() ? `Vault Lens\n${menu.map((item, index) => `${index === selected ? '>' : ' '} ${item}`).join('\n')}\n上下:選択 タップ:録音\nダブルタップ:終了` : 'Vault Lens\n初回設定が必要です。\nスマホのEvenアプリで\nPCの接続コードを入力。\nダブルタップ:終了');
}
async function renderPages() {
  const hint = mode === 'proposal' ? (page === pages.length - 1 ? 'タップ:この内容を保存' : '下へ:続きを確認') : mode === 'transcript' ? (page === pages.length - 1 ? 'タップ:実行 / 戻る:破棄' : '下へ:続きを確認') : 'ダブルタップ:戻る';
  await show(`Vault Lens ${page + 1}/${pages.length}\n${pages[page]}\n${hint}`);
}
async function paged(text, nextMode = 'result') { pages = split(text); page = 0; mode = nextMode; await renderPages(); }
async function call(route, body) {
  if (route !== '/pair/claim' && !paired()) throw new Error('再ペアリングが必要です');
  const response = await fetch(ORIGIN + route, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credential}` }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(80000) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || '接続エラー'); return data;
}
async function saveSettings() {
  const value = JSON.stringify({ credential, expiresAt, provider: $('provider').value });
  if (sdk) { if (!await sdk.setLocalStorage('vault-lens-settings', value)) throw new Error('設定を保存できませんでした'); }
  else sessionStorage.setItem('vault-lens-settings', value);
  $('paired').textContent = paired() ? `接続済み（有効期限 ${new Date(expiresAt).toLocaleString('ja-JP')}）` : '未接続';
}
async function task(fn) {
  if (busy) return; busy = true; document.querySelectorAll('button').forEach(button => button.disabled = true);
  try { await fn(); $('status').textContent = ''; }
  catch (error) { pendingAudio = null; mode = 'result'; pages = split(errorMessage(error)); page = 0; $('status').textContent = errorMessage(error); try { await renderPages(); } catch {} }
  finally { busy = false; document.querySelectorAll('button').forEach(button => button.disabled = false); }
}
function wav(pcm) {
  const bytes = new Uint8Array(44 + pcm.length), view = new DataView(bytes.buffer);
  for (const [offset, text] of [[0, 'RIFF'], [8, 'WAVE'], [12, 'fmt '], [36, 'data']]) Array.from(text).forEach((char, i) => bytes[offset + i] = char.charCodeAt(0));
  view.setUint32(4, bytes.length - 8, true); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); view.setUint32(40, pcm.length, true); bytes.set(pcm, 44); return bytes;
}
async function recorded(pcm) {
  if (!pcm?.length) { await home(); return; }
  pendingAudio = pcm; mode = 'audio-consent';
  await show('Vault Lens\n録音をOpenAIへ送信して\n文字起こししますか？\nタップ:送信\nダブルタップ:録音を破棄');
}
async function review(text, nextAction) {
  transcript = text.trim(); action = nextAction;
  if (!transcript) throw new Error('内容を入力してください');
  const warning = action === 'answer' && $('provider').value !== 'local' ? `質問と検索抜粋を${$('provider').value === 'openai' ? 'OpenAI' : 'Claude'}へ送信\n` : '';
  await paged(`${warning}${action === 'inbox' || action === 'daily' ? '追記提案を作成（まだ保存しません）' : 'この内容で実行'}\n${transcript}`, 'transcript');
}
async function executeTranscript() {
  await show('Vault Lens\nPCで処理中…');
  if (action === 'inbox' || action === 'daily') {
    proposal = await call('/api/proposals', { destination: action, content: transcript });
    await paged(`追記先: ${proposal.path}\n${proposal.content}\n確認して保存しますか？`, 'proposal');
  } else {
    const result = action === 'answer' ? await call('/api/answer', { question: transcript, provider: $('provider').value, cloudConsent: true }) : await call('/api/search', { query: transcript.slice(0, 300) });
    await paged(result.text || result.sources.map((source, index) => `[${index + 1}] ${source.path}:${source.line}\n${source.excerpt}`).join('\n\n') || '該当ノートがありません');
  }
}
async function gesture(input) {
  if (busy) return;
  await task(async () => {
    if (input === 'double') {
      if (mode === 'root') { if (glasses) await glasses.rootExit(); return; }
      if (glasses?.recording) await glasses.stopRecording({ discard: true });
      if (proposal) { try { await call('/api/cancel', { id: proposal.id }); } catch {} }
      await home(); return;
    }
    if (input === 'next' || input === 'previous') {
      const direction = input === 'next' ? 1 : -1;
      if (mode === 'root') { selected = (selected + direction + menu.length) % menu.length; await home(); }
      else if (['result', 'proposal', 'transcript'].includes(mode)) { page = Math.max(0, Math.min(pages.length - 1, page + direction)); await renderPages(); }
      return;
    }
    if (input !== 'click') return;
    if (mode === 'root') {
      if (!paired()) throw new Error('スマホで先にペアリングしてください');
      if (!glasses) throw new Error('音声入力はG2実機で利用できます。ブラウザでは文字を入力してください');
      action = ['search', 'inbox', 'daily', 'answer'][selected];
      await glasses.startRecording(); mode = 'recording'; await show('Vault Lens\n録音中（最大30秒）\nタップ:停止\nダブルタップ:破棄');
    } else if (mode === 'recording') await recorded(await glasses.stopRecording());
    else if (mode === 'audio-consent') {
      const audio = wav(pendingAudio); pendingAudio = null; await show('Vault Lens\n文字起こし中…');
      const response = await fetch(ORIGIN + '/api/transcribe', { method: 'POST', headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'audio/wav', 'X-Audio-Consent': 'true' }, body: audio, signal: AbortSignal.timeout(40000), redirect: 'error' });
      const data = await response.json(); if (!response.ok) throw new Error(data.error); await review(data.text, action);
    } else if (mode === 'transcript' && page === pages.length - 1) await executeTranscript();
    else if (mode === 'proposal' && page === pages.length - 1) {
      if (proposal.expiresAt <= Date.now()) throw new Error('提案が期限切れです。再作成してください');
      const result = await call('/api/confirm', { id: proposal.id, confirm: true }); proposal = null; await paged(`保存しました\n${result.path}`);
    }
  });
}
$('pair').onclick = () => task(async () => { const result = await call('/pair/claim', { code: $('code').value }); credential = result.deviceToken; expiresAt = result.expiresAt; $('code').value = ''; await saveSettings(); await home(); });
$('revoke').onclick = () => task(async () => { if (paired()) await call('/pair/revoke', {}); credential = ''; expiresAt = 0; await saveSettings(); await home(); });
$('provider').onchange = () => task(saveSettings);
for (const [id, target] of [['search', 'search'], ['ask', 'answer'], ['inbox', 'inbox'], ['daily', 'daily']]) $(id).onclick = () => task(() => review($('input').value, target));
for (const [id, type] of [['previous', 'previous'], ['next', 'next'], ['click', 'click'], ['back', 'double']]) $(id).onclick = () => gesture(type);

async function boot() {
  // Browser development preview must remain usable without an injected native bridge.
  await show('Vault Lens\nG2接続待ち…\nスマホで初回設定を開いてください');
  let restored;
  try { restored = JSON.parse(sessionStorage.getItem('vault-lens-settings') || 'null'); } catch {}
  if (restored) { credential = restored.credential || ''; expiresAt = restored.expiresAt || 0; $('provider').value = restored.provider || 'local'; }
  await home();
  waitForEvenAppBridge().then(async bridge => {
    sdk = bridge;
    glasses = new G2Bridge(bridge, { onGesture: gesture, onAudio: pcm => task(() => recorded(pcm)), onError: error => task(() => { throw error; }) });
    await glasses.start('Vault Lens\n設定を読み込み中…');
    try { const stored = JSON.parse(await sdk.getLocalStorage('vault-lens-settings') || 'null'); if (stored) { credential = stored.credential || ''; expiresAt = stored.expiresAt || 0; $('provider').value = stored.provider || 'local'; } } catch { $('status').textContent = '設定を読み取れません。再接続してください'; }
    $('paired').textContent = paired() ? '接続済み' : '未接続'; await home();
  }).catch(error => { $('status').textContent = errorMessage(error); });
}
window.addEventListener('pagehide', () => { pendingAudio = null; void glasses?.dispose(); });
void boot();
