import { AppError } from './vault.mjs';

export async function transcribe(wav, env = process.env, request = fetch) {
  if (env.ALLOW_CLOUD !== 'true' || !env.OPENAI_API_KEY || !env.OPENAI_TRANSCRIBE_MODEL) throw new AppError(503, 'サーバーで音声AIが有効化されていません');
  if (wav.length < 364 || wav.length > 960044 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE' || wav.toString('ascii', 12, 16) !== 'fmt ' || wav.readUInt32LE(16) !== 16 || wav.readUInt16LE(20) !== 1 || wav.readUInt16LE(22) !== 1 || wav.readUInt32LE(24) !== 16000 || wav.readUInt16LE(34) !== 16 || wav.toString('ascii', 36, 40) !== 'data' || wav.readUInt32LE(40) !== wav.length - 44) throw new AppError(400, '16kHz/16bit/mono、30秒以内のWAVが必要です');
  const form = new FormData(); form.append('file', new Blob([wav], { type: 'audio/wav' }), 'recording.wav'); form.append('model', env.OPENAI_TRANSCRIBE_MODEL); form.append('language', 'ja');
  let response;
  try { response = await request('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` }, body: form, redirect: 'error', signal: AbortSignal.timeout(30000) }); }
  catch { throw new AppError(502, '文字起こしに接続できませんでした'); }
  if (!response.ok) throw new AppError(502, '文字起こしに失敗しました');
  const data = await response.json();
  if (typeof data.text !== 'string' || !data.text.trim() || data.text.length > 4000) throw new AppError(502, '音声を読み取れませんでした');
  return data.text.trim();
}
