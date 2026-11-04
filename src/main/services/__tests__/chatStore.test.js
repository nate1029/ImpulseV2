const fs = require('fs');
const os = require('os');
const path = require('path');
const ChatStore = require('../chatStore');

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'impulse-chats-'));

describe('ChatStore', () => {
  test('saves, lists newest first, reads back and survives a restart', async () => {
    const where = dir();
    const store = new ChatStore(where);
    await store.save({ id: 'c_aaaaaaaaaa', title: 'Blink', messages: [{ role: 'user', text: 'blink' }], history: [{ role: 'user', content: 'blink' }] });
    await new Promise((r) => setTimeout(r, 5));
    await store.save({ id: 'c_bbbbbbbbbb', title: 'Fade', project: { folder: '/tmp/fade', file: '/tmp/fade/fade.ino', name: 'fade' } });
    expect((await store.list()).map((c) => c.id)).toEqual(['c_bbbbbbbbbb', 'c_aaaaaaaaaa']);

    const fresh = new ChatStore(where);
    const blink = await fresh.get('c_aaaaaaaaaa');
    expect(blink.title).toBe('Blink');
    expect(blink.messages).toEqual([{ role: 'user', text: 'blink' }]);
    expect(blink.history).toEqual([{ role: 'user', content: 'blink' }]);
    expect((await fresh.get('c_bbbbbbbbbb')).project.name).toBe('fade');
  });

  test('renames and deletes', async () => {
    const store = new ChatStore(dir());
    await store.save({ id: 'c_cccccccccc', title: 'Old' });
    await store.rename('c_cccccccccc', '  New name  ');
    expect((await store.get('c_cccccccccc')).title).toBe('New name');
    expect(await store.remove('c_cccccccccc')).toBe(true);
    expect(await store.get('c_cccccccccc')).toBeNull();
    expect(await store.list()).toEqual([]);
  });

  test('ids that could leave the folder are refused', async () => {
    const store = new ChatStore(dir());
    await expect(store.save({ id: '../../etc/passwd' })).rejects.toThrow('Invalid chat id');
    expect(await store.get('../x')).toBeNull();
    expect(await store.remove('c_../../x')).toBe(false);
  });

  test('unknown fields are cleaned and titles are capped', async () => {
    const store = new ChatStore(dir());
    const meta = await store.save({ id: 'c_dddddddddd', title: 'x'.repeat(500), mode: 'nonsense', status: 'weird' });
    expect(meta.title.length).toBe(120);
    expect(meta.mode).toBe('agent');
    expect(meta.status).toBeNull();
  });
});
