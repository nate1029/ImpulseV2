/**
 * Saved chats for chat mode: an index (title, project, times) plus one file
 * per chat with what was shown and the agent's history, so reopening a chat
 * continues the same conversation. Stored in <userData>/chats.
 * @module main/services/chatStore
 */

const fsp = require('fs').promises;
const path = require('path');

const ID = /^c_[a-z0-9]{8,40}$/;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_CHATS = 500;

const clip = (s, n) => (typeof s === 'string' ? s.slice(0, n) : '');

function cleanMeta(meta) {
  const project = meta.project && typeof meta.project === 'object'
    ? { folder: clip(meta.project.folder, 4096), file: clip(meta.project.file, 4096), name: clip(meta.project.name, 120) }
    : null;
  return {
    id: meta.id,
    title: clip(meta.title, 120) || 'New chat',
    project: project?.folder ? project : null,
    mode: ['agent', 'plan', 'debug'].includes(meta.mode) ? meta.mode : 'agent',
    model: clip(meta.model, 120) || null,
    status: ['ok', 'error', 'stopped', 'working'].includes(meta.status) ? meta.status : null,
    preview: clip(meta.preview, 200),
    createdAt: Number(meta.createdAt) || Date.now(),
    updatedAt: Number(meta.updatedAt) || Date.now(),
  };
}

class ChatStore {
  /** @param {string} dir */
  constructor(dir) {
    this.dir = dir;
    this.indexFile = path.join(dir, 'index.json');
    this.index = null;
    this.writing = Promise.resolve();
  }

  async load() {
    if (this.index) return this.index;
    try {
      const raw = JSON.parse(await fsp.readFile(this.indexFile, 'utf8'));
      this.index = Array.isArray(raw) ? raw.filter((m) => ID.test(m?.id)).map(cleanMeta) : [];
    } catch {
      this.index = [];
    }
    return this.index;
  }

  /** Writes happen one at a time, through a temporary file. */
  queue(fn) {
    this.writing = this.writing.then(fn, fn);
    return this.writing;
  }

  async writeAtomic(file, data) {
    await fsp.mkdir(this.dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, data, 'utf8');
    await fsp.rename(tmp, file);
  }

  async list() {
    const index = await this.load();
    return [...index].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async get(id) {
    if (!ID.test(id)) return null;
    const meta = (await this.load()).find((m) => m.id === id);
    if (!meta) return null;
    try {
      const body = JSON.parse(await fsp.readFile(path.join(this.dir, `${id}.json`), 'utf8'));
      return { ...meta, messages: Array.isArray(body.messages) ? body.messages : [], history: Array.isArray(body.history) ? body.history : [] };
    } catch {
      return { ...meta, messages: [], history: [] };
    }
  }

  /**
   * Create or update a chat.
   * @param {{ id: string, title?: string, project?: object, mode?: string, model?: string, status?: string, preview?: string, createdAt?: number, messages?: unknown[], history?: unknown[] }} chat
   */
  async save(chat) {
    if (!chat || !ID.test(chat.id)) throw new Error('Invalid chat id');
    const body = JSON.stringify({ messages: Array.isArray(chat.messages) ? chat.messages : [], history: Array.isArray(chat.history) ? chat.history : [] });
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw new Error('This chat is too large to save. Start a new chat.');
    const index = await this.load();
    const existing = index.find((m) => m.id === chat.id);
    const meta = cleanMeta({ ...existing, ...chat, createdAt: existing?.createdAt ?? chat.createdAt, updatedAt: Date.now() });
    if (existing) Object.assign(existing, meta);
    else index.push(meta);
    // Keep the newest chats only.
    if (index.length > MAX_CHATS) {
      index.sort((a, b) => b.updatedAt - a.updatedAt);
      for (const old of index.splice(MAX_CHATS)) fsp.rm(path.join(this.dir, `${old.id}.json`), { force: true }).catch(() => {});
    }
    await this.queue(async () => {
      await this.writeAtomic(path.join(this.dir, `${chat.id}.json`), body);
      await this.writeAtomic(this.indexFile, JSON.stringify(this.index));
    });
    return meta;
  }

  async rename(id, title) {
    const index = await this.load();
    const meta = index.find((m) => m.id === id);
    if (!meta) return null;
    meta.title = clip(String(title || '').trim(), 120) || meta.title;
    await this.queue(() => this.writeAtomic(this.indexFile, JSON.stringify(this.index)));
    return meta;
  }

  async remove(id) {
    if (!ID.test(id)) return false;
    const index = await this.load();
    const at = index.findIndex((m) => m.id === id);
    if (at < 0) return false;
    index.splice(at, 1);
    await this.queue(async () => {
      await this.writeAtomic(this.indexFile, JSON.stringify(this.index));
      await fsp.rm(path.join(this.dir, `${id}.json`), { force: true });
    });
    return true;
  }

  /** For tests: forget the cached index. */
  reset() {
    this.index = null;
  }
}

ChatStore.ID = ID;

module.exports = ChatStore;
