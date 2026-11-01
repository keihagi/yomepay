// Plain JSON files on disk, one file per record, inside YOMEPAY_DATA_DIR. Media files sit in media/.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const KINDS = ['submissions', 'settlements', 'penalties', 'exemptions', 'challenges', 'notifications'];
export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{2,95}$/;

export const newId = prefix => `${prefix}-${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;

export async function createStore(dir) {
  await Promise.all([...KINDS, 'media'].map(k => fs.mkdir(path.join(dir, k), { recursive: true })));

  const file = (kind, id) => {
    if (!KINDS.includes(kind) || !ID_RE.test(String(id))) throw Object.assign(new Error(`Invalid id: ${id}`), { status: 400 });
    return path.join(dir, kind, `${id}.json`);
  };
  const writeAtomic = async (f, data) => {
    const tmp = `${f}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, f);
  };

  return {
    dir,
    mediaDir: path.join(dir, 'media'),
    async list(kind) {
      const names = (await fs.readdir(path.join(dir, kind))).filter(n => n.endsWith('.json'));
      const out = [];
      for (const n of names) {
        try { out.push(JSON.parse(await fs.readFile(path.join(dir, kind, n), 'utf8'))); }
        catch (e) { console.warn(`[store] skipped ${kind}/${n}: ${e.message}`); }
      }
      return out;
    },
    async get(kind, id) {
      try { return JSON.parse(await fs.readFile(file(kind, id), 'utf8')); }
      catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    },
    async has(kind, id) {
      return fs.access(file(kind, id)).then(() => true, () => false);
    },
    async put(kind, obj) {
      await writeAtomic(file(kind, obj.id), JSON.stringify(obj, null, 2) + '\n');
      return obj;
    },
    async remove(kind, id) {
      await fs.rm(file(kind, id), { force: true });
    },
    mediaPath(name) {
      if (!/^[A-Za-z0-9][A-Za-z0-9-]{2,95}\.(jpg|webm|mp4)$/.test(name)) throw Object.assign(new Error('Invalid media name'), { status: 400 });
      return path.join(dir, 'media', name);
    },
    async putMedia(name, buf) {
      const f = this.mediaPath(name);
      await writeAtomic(f, buf);
      return f;
    },
  };
}
