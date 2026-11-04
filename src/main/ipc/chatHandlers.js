/**
 * Saved chats (chat mode) and the agent's conversation history behind them.
 * @module main/ipc/chatHandlers
 */

const { z } = require('zod');
const { withDebugLog } = require('../utils/logger');
const ChatStore = require('../services/chatStore');

const id = z.string().regex(ChatStore.ID);
const chat = z.object({
  id,
  title: z.string().max(200).optional(),
  project: z.object({ folder: z.string().max(4096), file: z.string().max(4096), name: z.string().max(200) }).nullable().optional(),
  mode: z.string().max(20).optional(),
  model: z.string().max(200).nullable().optional(),
  status: z.string().max(20).nullable().optional(),
  preview: z.string().max(400).optional(),
  createdAt: z.number().optional(),
  messages: z.array(z.unknown()).max(2000).optional(),
  history: z.array(z.unknown()).max(4000).optional(),
});

/**
 * @param {import('electron').IpcMain} ipcMain
 * @param {{ chatStore: ChatStore, aiAgent: import('../services/ai/agent') }} ctx
 */
function register(ipcMain, ctx) {
  const { chatStore, aiAgent } = ctx;
  const fail = (error) => ({ success: false, error: error?.message || String(error) });

  ipcMain.handle('chats:list', withDebugLog('chats:list', async () => {
    try {
      return { success: true, data: await chatStore.list() };
    } catch (error) {
      return fail(error);
    }
  }));

  ipcMain.handle('chats:get', withDebugLog('chats:get', async (event, chatId) => {
    if (!id.safeParse(chatId).success) return fail('Invalid chat id');
    const data = await chatStore.get(chatId).catch(() => null);
    return data ? { success: true, data } : fail('No such chat');
  }));

  ipcMain.handle('chats:save', withDebugLog('chats:save', async (event, payload) => {
    const parsed = chat.safeParse(payload);
    if (!parsed.success) return fail('Invalid chat');
    try {
      return { success: true, data: await chatStore.save(parsed.data) };
    } catch (error) {
      return fail(error);
    }
  }));

  ipcMain.handle('chats:rename', withDebugLog('chats:rename', async (event, chatId, title) => {
    if (!id.safeParse(chatId).success || typeof title !== 'string') return fail('Invalid input');
    const data = await chatStore.rename(chatId, title).catch(() => null);
    return data ? { success: true, data } : fail('No such chat');
  }));

  ipcMain.handle('chats:delete', withDebugLog('chats:delete', async (event, chatId) => {
    if (!id.safeParse(chatId).success) return fail('Invalid chat id');
    return { success: await chatStore.remove(chatId).catch(() => false) };
  }));

  // The agent's working memory for the open chat: saved with it, restored on switch.
  ipcMain.handle('ai:get-history', withDebugLog('ai:get-history', async () => ({
    success: true,
    data: JSON.parse(JSON.stringify(aiAgent.getHistory())),
  })));

  ipcMain.handle('ai:set-history', withDebugLog('ai:set-history', async (event, history) => {
    if (!Array.isArray(history) || history.length > 4000) return fail('Invalid history');
    const valid = history.every((m) => m && typeof m === 'object' && ['user', 'assistant', 'tool', 'system'].includes(m.role));
    if (!valid) return fail('Invalid history');
    aiAgent.clearHistory();
    aiAgent.conversationHistory = history;
    return { success: true };
  }));
}

module.exports = { register };
