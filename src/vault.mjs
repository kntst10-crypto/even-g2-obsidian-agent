import { constants } from 'node:fs';
import { lstat, readdir, realpath, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export class AppError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function requireText(value, label, max = 4000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new AppError(400, `${label}を確認してください（1〜${max}文字）`);
  return value.trim();
}
const hash = value => createHash('sha256').update(value).digest('hex');
const MAX_NOTE = 1024 * 1024;

export class Vault {
  constructor(root, { ttlMs = 300000, now = Date.now } = {}) {
    this.root = root; this.ttlMs = ttlMs; this.now = now; this.pending = new Map(); this.lock = Promise.resolve();
  }
  async init() {
    this.root = await realpath(this.root);
    if (!(await lstat(this.root)).isDirectory()) throw new Error('VAULT_ROOT must be a directory');
    return this;
  }
  validate(relative) {
    requireText(relative, 'ノートパス', 500);
    const parts = relative.split('/');
    if (path.isAbsolute(relative) || relative.includes('\\') || /[:\x00-\x1f]/.test(relative) || parts.some(p => !p || p.startsWith('.')) || !relative.endsWith('.md')) throw new AppError(400, '公開Markdownノートの相対パスのみ使用できます');
    return parts;
  }
  async resolve(relative, createParents = false) {
    const parts = this.validate(relative); let current = this.root;
    for (const component of parts.slice(0, -1)) {
      current = path.join(current, component);
      let stat;
      try { stat = await lstat(current); } catch (e) {
        if (e.code !== 'ENOENT') throw e;
        if (!createParents) return path.join(this.root, ...parts);
        await mkdir(current, { mode: 0o700 }); stat = await lstat(current);
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new AppError(400, 'リンクまたは非ディレクトリを経由できません');
    }
    const target = path.join(this.root, ...parts);
    try {
      const stat = await lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) throw new AppError(400, '通常の単独Markdownファイルのみ利用できます');
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    return target;
  }
  async read(relative) {
    const target = await this.resolve(relative); let handle;
    try {
      handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink > 1 || stat.size > MAX_NOTE) throw new AppError(400, 'ノートが大きすぎるか読み取れません');
      const text = await handle.readFile('utf8');
      return { text, hash: hash(text) };
    } catch (e) { if (e.code === 'ENOENT') return { text: '', hash: null }; throw e; }
    finally { await handle?.close(); }
  }
  async search(query, limit = 5) {
    const words = requireText(query, '検索語', 300).toLocaleLowerCase().split(/\s+/);
    const results = []; let count = 0;
    const walk = async (dir, prefix = '', depth = 0) => {
      if (depth > 12) return;
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
        if (++count > 5000) throw new AppError(413, '検索対象が5000件を超えました。対象Vaultを分けてください');
        const relative = prefix + entry.name;
        if (entry.isDirectory()) { await walk(path.join(dir, entry.name), relative + '/', depth + 1); continue; }
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
        let note;
        try { note = await this.read(relative); } catch (e) { if (e.status === 400) continue; throw e; }
        const full = (relative + '\n' + note.text).toLocaleLowerCase();
        const score = words.reduce((n, w) => n + (full.includes(w) ? 1 : 0) + (relative.toLocaleLowerCase().includes(w) ? 2 : 0), 0);
        if (!score) continue;
        const lines = note.text.split('\n');
        const match = lines.findIndex(line => words.some(w => line.toLocaleLowerCase().includes(w)));
        const line = Math.max(0, match - 1);
        results.push({ path: relative, score, line: line + 1, excerpt: lines.slice(line, line + 8).join('\n').slice(0, 1000) });
      }
    };
    await walk(this.root);
    return results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit);
  }
  prune() { for (const [id, p] of this.pending) if (p.expiresAt <= this.now()) this.pending.delete(id); }
  async propose(relative, content) {
    content = requireText(content, '追記内容'); this.prune();
    if (this.pending.size >= 100) throw new AppError(429, '未確認の提案が多すぎます');
    const before = await this.read(relative);
    const proposal = { id: randomUUID(), path: relative, content, baseHash: before.hash, expiresAt: this.now() + this.ttlMs };
    this.pending.set(proposal.id, proposal);
    return { id: proposal.id, path: relative, content, expiresAt: proposal.expiresAt };
  }
  async cancel(id) { this.pending.delete(id); return { cancelled: true }; }
  async confirm(id) {
    const run = async () => {
      this.prune(); const proposal = this.pending.get(id);
      if (!proposal) throw new AppError(409, '提案が期限切れ、実行済み、または取り消し済みです');
      const target = await this.resolve(proposal.path, true);
      const before = await this.read(proposal.path);
      if (before.hash !== proposal.baseHash) { this.pending.delete(id); throw new AppError(409, 'ノートが変更されました。再度提案を作って確認してください'); }
      let handle;
      try {
        const flags = proposal.baseHash === null
          ? constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW
          : constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW;
        handle = await open(target, flags, 0o600);
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink > 1 || stat.size > MAX_NOTE) throw new AppError(409, '保存先が変わりました');
        if (proposal.baseHash !== null && hash(await handle.readFile('utf8')) !== proposal.baseHash) throw new AppError(409, 'ノートが変更されました');
        // Consume BEFORE writing: a retry must never silently duplicate an append.
        this.pending.delete(id);
        await handle.writeFile('\n\n' + proposal.content + '\n', 'utf8');
        await handle.sync();
        return { saved: true, path: proposal.path };
      } catch (e) { if (e.code === 'EEXIST') throw new AppError(409, '保存先が新規作成されました。再提案してください'); throw e; }
      finally { await handle?.close(); }
    };
    const result = this.lock.then(run); this.lock = result.catch(() => {}); return result;
  }
}
