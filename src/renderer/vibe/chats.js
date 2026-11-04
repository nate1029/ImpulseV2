// The open chat and the saved ones. A chat is a conversation plus, once code
// is written, a project folder. Saving includes the agent's history, so
// reopening a chat continues it where it left off.

const SAVE_DELAY_MS = 600;

const newId = () => `c_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

/** Words a cut title shouldn't end on. */
const TRAILING = new Set(['and', 'or', 'the', 'a', 'an', 'to', 'with', 'of', 'for', 'in', 'on', 'at', 'then', 'that', 'it', 'is', 'my', 'from', 'by', 'so']);

/** First words of the first message, as a title. */
export function titleFrom(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return 'New chat';
  const all = clean.split(' ');
  const words = all.slice(0, 8);
  // A cut title ends on a word that means something ("every 500 ms", not "… ms and").
  if (all.length > 8) while (words.length > 3 && TRAILING.has(words.at(-1).toLowerCase().replace(/[^a-z]/g, ''))) words.pop();
  const joined = words.join(' ');
  const cut = joined.length > 56 ? `${joined.slice(0, 55).trimEnd()}…` : joined;
  return cut.charAt(0).toUpperCase() + cut.slice(1);
}

/** A folder name for a chat's project: letters, digits and underscores. */
export function projectNameFrom(text) {
  const stop = new Set(['a', 'an', 'the', 'and', 'or', 'with', 'to', 'of', 'on', 'in', 'for', 'my', 'me', 'make', 'build', 'create', 'please', 'that', 'it', 'using', 'every', 'when', 'from', 'i', 'want', 'can', 'you', 'is', 'this']);
  const words = String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w && !stop.has(w)).slice(0, 4);
  const name = words.join('_').replace(/^_+|_+$/g, '').slice(0, 40);
  return /^[a-z0-9]/.test(name) ? name : `project_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
}

export function createChats(api = window.electronAPI) {
  const listeners = new Set();
  let list = [];
  let current = blank();
  let timer = null;
  let saving = Promise.resolve();
  let hidden = new Set();

  function blank() {
    return { id: null, title: 'New chat', project: null, mode: 'agent', model: null, status: null, preview: '', messages: [], createdAt: Date.now() };
  }

  const emit = (what) => listeners.forEach((fn) => fn(what));

  async function refreshList() {
    const res = await api.chats.list().catch(() => null);
    if (res?.success) list = res.data;
    emit('list');
  }

  async function saveNow() {
    clearTimeout(timer);
    timer = null;
    const chat = current;
    if (!chat.id || !chat.messages.length) return;
    saving = saving.then(async () => {
      const history = await api.ai.getHistory().catch(() => null);
      const last = [...chat.messages].reverse().find((m) => m.role === 'assistant');
      const res = await api.chats.save({
        id: chat.id,
        title: chat.title,
        project: chat.project,
        mode: chat.mode,
        model: chat.model,
        status: chat.status,
        preview: (last?.text || chat.messages.at(-1)?.text || '').slice(0, 200),
        createdAt: chat.createdAt,
        messages: chat.messages,
        history: chat === current && history?.success ? history.data : (chat.history || []),
      }).catch(() => null);
      if (res?.success) {
        const at = list.findIndex((m) => m.id === chat.id);
        if (at >= 0) list[at] = res.data;
        else list.unshift(res.data);
        emit('list');
      }
    });
    return saving;
  }

  function scheduleSave() {
    clearTimeout(timer);
    timer = setTimeout(saveNow, SAVE_DELAY_MS);
  }

  return {
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    get list() { return list.filter((c) => !hidden.has(c.id)); },
    get current() { return current; },
    load: refreshList,

    /** Make sure the open chat has an id (it gets one with its first message). */
    begin(firstText) {
      if (!current.id) {
        current.id = newId();
        current.createdAt = Date.now();
        current.title = titleFrom(firstText);
        emit('current');
      }
      return current;
    },

    add(message) {
      const record = { id: `m_${Math.random().toString(36).slice(2, 10)}`, at: Date.now(), ...message };
      current.messages.push(record);
      scheduleSave();
      emit('messages');
      return record;
    },

    update(messageId, patch) {
      const m = current.messages.find((x) => x.id === messageId);
      if (!m) return;
      Object.assign(m, patch);
      scheduleSave();
    },

    set(patch) {
      Object.assign(current, patch);
      scheduleSave();
      emit('current');
    },

    save: saveNow,

    /** A blank chat: the agent forgets the open conversation. */
    async startNew() {
      await saveNow();
      await api.ai.clearHistory?.().catch(() => {});
      current = blank();
      emit('current');
      emit('messages');
    },

    async open(id) {
      if (current.id === id) return current;
      await saveNow();
      const res = await api.chats.get(id).catch(() => null);
      if (!res?.success) return null;
      const chat = res.data;
      await api.ai.setHistory(chat.history || []).catch(() => {});
      current = { ...chat, messages: chat.messages || [] };
      delete current.history;
      emit('current');
      emit('messages');
      return current;
    },

    async rename(id, title) {
      const res = await api.chats.rename(id, title).catch(() => null);
      if (res?.success) {
        if (current.id === id) current.title = res.data.title;
        const at = list.findIndex((m) => m.id === id);
        if (at >= 0) list[at] = res.data;
        emit('list');
        emit('current');
      }
    },

    /**
     * Hide a chat now and delete it once `undo` hasn't been used.
     * @returns {{ undo: () => void, commit: () => Promise<void> }}
     */
    remove(id) {
      hidden.add(id);
      emit('list');
      const wasOpen = current.id === id;
      if (wasOpen) {
        clearTimeout(timer);
        current = blank();
        api.ai.clearHistory?.().catch(() => {});
        emit('current');
        emit('messages');
      }
      let done = false;
      return {
        undo: () => {
          if (done) return;
          done = true;
          hidden.delete(id);
          emit('list');
        },
        commit: async () => {
          if (done) return;
          done = true;
          await api.chats.remove(id).catch(() => {});
          hidden.delete(id);
          list = list.filter((c) => c.id !== id);
          emit('list');
        },
      };
    },

    /** For tests. */
    _reset() {
      list = [];
      hidden = new Set();
      current = blank();
    },
  };
}
