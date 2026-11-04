/**
 * Impulse IDE - Electron main process.
 * Creates window, initializes services, and registers IPC handlers.
 */

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;

// Data lives in "Impulse IDE". Development builds before 2.0 ran as
// "arduino-ide-cursor": while only that folder holds app data, keep using it
// so settings, sessions and approved folders survive. (Electron creates the
// new folder before this runs, so look for real data, not the folder.)
// Runs before any service module asks for the userData path.
const legacyUserData = path.join(app.getPath('appData'), 'arduino-ide-cursor');
const hasAppData = (dir) => fs.existsSync(path.join(dir, 'Local Storage'));
const explicitProfile = app.commandLine.hasSwitch('user-data-dir');
if (!explicitProfile && !hasAppData(app.getPath('userData')) && hasAppData(legacyUserData)) app.setPath('userData', legacyUserData);

const ArduinoService = require('./services/arduinoService');
const SerialMonitor = require('./services/serialMonitor');
const ErrorMemory = require('./services/errorMemory');
const AIAgent = require('./services/ai/agent');
const { FixCapture } = require('./services/ai/learning/fixCapture');
const { CloudAccount } = require('./services/cloud/account');
const { cloudURL } = require('./services/cloud/config');
const ChatStore = require('./services/chatStore');
const { registerAllIpc } = require('./ipc');
const { debug } = require('./utils/logger');
const notifications = require('./utils/notifications');
const WorkspaceStore = require('./services/workspaceStore');
const { Toolchain } = require('./services/toolchain');
const { Esp32Simulator, bundledQemuDir, packedQemuDir } = require('./services/esp32sim');
const { validatePath } = require('./utils/pathValidator');

const logger = require('./utils/logger');
const { ProblemReporter } = require('./services/problemReporter');

// Where problem reports go: the GitHub repository in package.json.
const pkg = require('../../package.json');
const reportRepo = /github\.com\/([^/]+\/[^/#]+)/.exec(pkg.bugs?.url || '')?.[1]?.replace(/\/issues$/, '') || 'Meet-1010/Impulse-IDE-v2';
const problemReporter = new ProblemReporter({
  userDataDir: app.getPath('userData'),
  logFile: path.join(app.getPath('logs'), 'impulse.log'),
  version: app.getVersion(),
  repo: reportRepo
});

process.on('uncaughtException', (err) => {
  logger.error('uncaughtException', { error: err?.message, stack: err?.stack });
  problemReporter.recordCrash('main', err);
});
process.on('unhandledRejection', (reason) => logger.error('unhandledRejection', { error: reason?.message ?? String(reason) }));
app.on('render-process-gone', (event, webContents, details) => {
  if (details.reason === 'clean-exit') return;
  logger.error('render-process-gone', details);
  problemReporter.recordCrash('renderer', { message: `The window's renderer stopped (${details.reason}, exit code ${details.exitCode}).` });
});

let mainWindow;
let arduinoService;
let serialMonitor;
let errorMemory;
let aiAgent;
let cloudAccount;
let chatStore;
let learning = null;
let workspace;
let esp32sim;

// The view on screen (chat mode or the IDE): the menu's labels follow it.
let shellMode = 'vibe';

const uiState = {
  currentBaudRate: 115200,
  currentSketchPath: null,
  selectedBoard: null,
  selectedPort: null,
  editorCode: '',
  // Monotonic rev that bumps on every real editor change (user keystroke or
  // agent write). Tools that read-then-write capture this and pass it as
  // expectedRev to setEditorCode; the write is rejected if the rev advanced,
  // so a user edit mid-tool is not clobbered.
  editorRev: 0
};

/**
 * Create the main application window and menu.
 */
function createWindow() {
  const iconPath = path.join(__dirname, '../../assets/icon.png');
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    // Below this the chat, its sidebar and a side panel no longer fit side by side.
    minWidth: 960,
    minHeight: 600,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true, // Enhances isolation by running renderer in OS sandbox
      disableBlinkFeatures: 'Auxclick', // Prevent middle-click vulnerabilities
      preload: path.join(__dirname, 'preload.js')
    },
    icon: iconPath
  });

  mainWindow.once('ready-to-show', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
  });

  // A crashed renderer leaves a blank window: offer to reload it.
  mainWindow.webContents.on('render-process-gone', async (event, details) => {
    if (details.reason === 'clean-exit' || !mainWindow || mainWindow.isDestroyed()) return;
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'error',
      buttons: ['Reload', 'Quit'],
      defaultId: 0,
      cancelId: 1,
      title: 'Impulse stopped responding',
      message: 'The Impulse window stopped working.',
      detail: 'Reload to continue where you left off. Your files are saved on disk; after reloading you can report what happened.'
    });
    if (response === 0 && !mainWindow.isDestroyed()) mainWindow.webContents.reload();
    else app.quit();
  });

  // Electron shows no menu on right-click: offer the text edits where they
  // apply (fields, the editor, selected text such as a chat answer). Parts of
  // the UI with their own menus (the simulator canvas) cancel the event first.
  mainWindow.webContents.on('context-menu', (event, params) => {
    const flags = params.editFlags || {};
    const hasSelection = !!params.selectionText?.trim();
    let template;
    if (params.isEditable) {
      template = [
        { role: 'undo', enabled: flags.canUndo },
        { role: 'redo', enabled: flags.canRedo },
        { type: 'separator' },
        { role: 'cut', enabled: flags.canCut },
        { role: 'copy', enabled: flags.canCopy },
        { role: 'paste', enabled: flags.canPaste },
        { type: 'separator' },
        { role: 'selectAll', enabled: flags.canSelectAll },
      ];
    } else if (hasSelection) {
      template = [{ role: 'copy' }, { type: 'separator' }, { role: 'selectAll' }];
    } else {
      return;
    }
    Menu.buildFromTemplate(template).popup({ window: mainWindow });
  });

  // SECURITY: Prevent navigation to external websites within the app
  mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
    const parsedUrl = new URL(navigationUrl);
    // Only allow local file loads or the Vite Dev server
    if (parsedUrl.protocol !== 'file:' && !navigationUrl.startsWith('http://localhost:5173')) {
      event.preventDefault();
      console.warn(`[Security] Blocked navigation attempt to: ${navigationUrl}`);
    }
  });

  // SECURITY: Intercept all new window requests (e.g., target="_blank" links)
  // and securely route them to the user's default OS browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:') {
      shell.openExternal(url);
    } else {
      console.warn(`[Security] Blocked unsafe link open attempt to: ${url}`);
    }
    return { action: 'deny' }; // Never open a new Electron BrowserWindow
  });

  const isDev = process.argv.includes('--dev');
  // Only open DevTools when explicitly requested (IMPULSE_IDE_DEVTOOLS=1),
  // not on every dev launch. Users can always toggle with F12 / Ctrl+Shift+I.
  if (isDev && process.env.IMPULSE_IDE_DEVTOOLS === '1') {
    mainWindow.webContents.openDevTools();
  }

  // Preserve a manual DevTools toggle (the custom app menu replaces Electron's
  // default View menu, which normally provides this).
  // Dev builds only, and not on Ctrl+Shift+I (that's Manage Libraries).
  if (isDev || process.env.IMPULSE_IDE_DEVTOOLS === '1') {
    mainWindow.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      const isF12 = input.key === 'F12';
      const isAltModI = input.alt && (input.meta || input.control) && input.key.toLowerCase() === 'i';
      if (isF12 || isAltModI) mainWindow.webContents.toggleDevTools();
    });
  }

  // Load the renderer:
  // - Dev mode (--dev): connect to Vite dev server for HMR
  // - Production / start: load from Vite-built output (dist-renderer/)
  const distRenderer = path.join(__dirname, '../../dist-renderer/index.html');

  if (isDev) {
    // In dev mode, Vite dev server must be running (npm run dev:renderer)
    const VITE_DEV_URL = process.env.VITE_DEV_URL || 'http://localhost:5173';
    mainWindow.loadURL(VITE_DEV_URL).catch(() => {
      // Fallback: if Vite dev server isn't running, load the built version
      if (fs.existsSync(distRenderer)) {
        mainWindow.loadFile(distRenderer);
      } else {
        // Last resort: show an error instead of a white screen
        mainWindow.loadURL(`data:text/html,<h2 style="font-family:sans-serif;padding:40px">Renderer not built.</h2><p style="font-family:sans-serif;padding:0 40px">Run <code>npm run build:renderer</code> first, or start the Vite dev server with <code>npm run dev:renderer</code>.</p>`);
      }
    });
  } else if (fs.existsSync(distRenderer)) {
    mainWindow.loadFile(distRenderer);
  } else {
    // Production but dist missing -- show actionable error
    mainWindow.loadURL(`data:text/html,<h2 style="font-family:sans-serif;padding:40px">Renderer not built.</h2><p style="font-family:sans-serif;padding:0 40px">Run <code>npm run build:renderer</code> to build the UI.</p>`);
  }

  // --- Content Security Policy ---
  // Block eval, inline scripts, and restrict origins to what the app actually needs.
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          [
            "default-src 'self'",
            "script-src 'self'",
            "style-src 'self' 'unsafe-inline'",
            "font-src 'self' data:",
            isDev ? "connect-src 'self' ws://localhost:5173 http://localhost:5173" : "connect-src 'self'",
            "img-src 'self' data:",
            "object-src 'none'",
            "base-uri 'self'"
          ].join('; ')
        ]
      }
    });
  });

  buildMenu();

}

function sendMenuAction(action, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('menu:action', action, payload);
  }
}

/**
 * Application menu. It is the single source of keyboard shortcuts: the
 * renderer must not also bind these keys, or they fire twice.
 */
function buildMenu() {
  const isMac = process.platform === 'darwin';
  const recent = workspace ? workspace.getRecent() : [];
  const recentItems = recent.length
    ? [
      ...recent.map(folder => ({
        label: folder.replace(require('os').homedir(), '~'),
        click: () => sendMenuAction('file-open-recent', folder)
      })),
      { type: 'separator' },
      { label: 'Clear Recent', click: () => workspace && workspace.clearRecent() }
    ]
    : [{ label: 'No recent folders', enabled: false }];

  const template = [
    ...(isMac ? [{
      label: 'Impulse',
      submenu: [
        { label: 'About Impulse', click: () => sendMenuAction('help-about') },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'Cmd+,', click: () => sendMenuAction('file-preferences') },
        { type: 'separator' },
        { role: 'hide', label: 'Hide Impulse' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', label: 'Quit Impulse' }
      ]
    }] : []),
    {
      label: 'File',
      submenu: [
        { label: shellMode === 'ide' ? 'New Sketch' : 'New Chat', accelerator: 'CmdOrCtrl+N', click: () => sendMenuAction('file-new') },
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => sendMenuAction('file-open') },
        { label: 'Open Folder…', accelerator: 'CmdOrCtrl+Shift+O', click: () => sendMenuAction('file-open-folder') },
        { label: 'Open Recent', submenu: recentItems },
        { label: 'Examples', click: () => sendMenuAction('file-examples') },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => sendMenuAction('file-save') },
        { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: () => sendMenuAction('file-save-as') },
        { type: 'separator' },
        ...(isMac ? [] : [
          { label: 'Preferences…', accelerator: 'Ctrl+,', click: () => sendMenuAction('file-preferences') },
          { type: 'separator' }
        ]),
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => sendMenuAction('file-close') },
        ...(isMac ? [] : [{ label: 'Quit', accelerator: 'Ctrl+Q', click: () => sendMenuAction('file-quit') }])
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => sendMenuAction('edit-undo') },
        { label: 'Redo', accelerator: isMac ? 'Cmd+Shift+Z' : 'Ctrl+Y', click: () => sendMenuAction('edit-redo') },
        { type: 'separator' },
        { label: 'Cut', accelerator: 'CmdOrCtrl+X', click: () => sendMenuAction('edit-cut') },
        { label: 'Copy', accelerator: 'CmdOrCtrl+C', click: () => sendMenuAction('edit-copy') },
        { label: 'Paste', accelerator: 'CmdOrCtrl+V', click: () => sendMenuAction('edit-paste') },
        { label: 'Select All', accelerator: 'CmdOrCtrl+A', click: () => sendMenuAction('edit-select-all') },
        { type: 'separator' },
        { label: 'Go to Line…', accelerator: 'CmdOrCtrl+L', click: () => sendMenuAction('edit-goto-line') },
        { label: 'Comment/Uncomment', accelerator: 'CmdOrCtrl+/', click: () => sendMenuAction('edit-comment') },
        { label: 'Increase Indent', accelerator: 'CmdOrCtrl+]', click: () => sendMenuAction('edit-increase-indent') },
        { label: 'Decrease Indent', accelerator: 'CmdOrCtrl+[', click: () => sendMenuAction('edit-decrease-indent') },
        { label: 'Auto Format', accelerator: 'CmdOrCtrl+T', click: () => sendMenuAction('edit-format') },
        { type: 'separator' },
        { label: 'Find', accelerator: 'CmdOrCtrl+F', click: () => sendMenuAction('edit-find') },
        { label: 'Find Next', accelerator: 'CmdOrCtrl+G', click: () => sendMenuAction('edit-find-next') },
        { label: 'Find Previous', accelerator: 'CmdOrCtrl+Shift+G', click: () => sendMenuAction('edit-find-prev') },
        { label: 'Replace', accelerator: isMac ? 'Cmd+Alt+F' : 'Ctrl+H', click: () => sendMenuAction('edit-replace') },
        { type: 'separator' },
        { label: 'Increase Font Size', accelerator: 'CmdOrCtrl+=', click: () => sendMenuAction('edit-font-increase') },
        { label: 'Decrease Font Size', accelerator: 'CmdOrCtrl+-', click: () => sendMenuAction('edit-font-decrease') }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: shellMode === 'ide' ? 'Switch to Chat' : 'Switch to IDE', accelerator: 'CmdOrCtrl+E', click: () => sendMenuAction('view-toggle-shell') },
        { type: 'separator' },
        { label: 'Sketchbook', accelerator: 'CmdOrCtrl+Shift+E', click: () => sendMenuAction('view-explorer') },
        { label: 'Source Control', accelerator: 'CmdOrCtrl+Shift+G', click: () => sendMenuAction('view-scm') },
        { label: 'Board Manager', accelerator: 'CmdOrCtrl+Shift+B', click: () => sendMenuAction('view-boards') },
        { label: 'Library Manager', accelerator: 'CmdOrCtrl+Shift+I', click: () => sendMenuAction('tools-manage-libs') },
        { label: '2D Simulator', accelerator: 'CmdOrCtrl+Shift+D', click: () => sendMenuAction('view-simulator') },
        { label: 'AI Assistant', accelerator: 'CmdOrCtrl+Shift+A', click: () => sendMenuAction('view-ai') },
        { type: 'separator' },
        { label: 'Toggle Light/Dark', click: () => sendMenuAction('view-toggle-theme') }
      ]
    },
    {
      label: 'Sketch',
      submenu: [
        { label: 'Verify/Compile', accelerator: 'CmdOrCtrl+R', click: () => sendMenuAction('sketch-verify') },
        { label: 'Upload', accelerator: 'CmdOrCtrl+U', click: () => sendMenuAction('sketch-upload') },
        { label: 'Upload Using Programmer…', accelerator: 'CmdOrCtrl+Shift+U', click: () => sendMenuAction('sketch-upload-programmer') },
        { type: 'separator' },
        { label: 'Run Hardware Tests', accelerator: 'CmdOrCtrl+Shift+T', click: () => sendMenuAction('sketch-run-tests') },
        { label: 'Compare Simulator with Board…', click: () => sendMenuAction('sketch-compare-board') },
        { type: 'separator' },
        { label: 'Export Compiled Binary', accelerator: 'CmdOrCtrl+Alt+S', click: () => sendMenuAction('sketch-export-binary') },
        { label: 'Show Sketch Folder', accelerator: 'CmdOrCtrl+Alt+K', click: () => sendMenuAction('sketch-show-folder') },
        { type: 'separator' },
        { label: 'Include Library', click: () => sendMenuAction('sketch-include-library') },
        { label: 'Add Tab…', click: () => sendMenuAction('sketch-add-tab') },
        { label: 'Add File…', click: () => sendMenuAction('sketch-add-file') }
      ]
    },
    {
      label: 'Debug',
      submenu: [
        { label: 'Start Debugging / Continue', accelerator: 'F5', click: () => sendMenuAction('debug-start') },
        { label: 'Stop Debugging', accelerator: 'Shift+F5', click: () => sendMenuAction('debug-stop') },
        { type: 'separator' },
        { label: 'Step Over', accelerator: 'F10', click: () => sendMenuAction('debug-step-over') },
        { label: 'Step Into', accelerator: 'F11', click: () => sendMenuAction('debug-step-into') },
        { label: 'Step Out', accelerator: 'Shift+F11', click: () => sendMenuAction('debug-step-out') },
        { label: 'Run to Cursor', accelerator: 'CmdOrCtrl+F10', click: () => sendMenuAction('debug-run-to-cursor') },
        { type: 'separator' },
        { label: 'Toggle Breakpoint', accelerator: 'F9', click: () => sendMenuAction('debug-toggle-breakpoint') },
        { label: 'Remove All Breakpoints', click: () => sendMenuAction('debug-clear-breakpoints') }
      ]
    },
    {
      label: 'Tools',
      submenu: [
        { label: 'Auto Format', click: () => sendMenuAction('tools-format') },
        { label: 'Archive Sketch…', click: () => sendMenuAction('tools-archive') },
        { type: 'separator' },
        { label: 'Serial Monitor', accelerator: 'CmdOrCtrl+Shift+M', click: () => sendMenuAction('tools-serial-monitor') },
        { label: 'Serial Plotter', accelerator: 'CmdOrCtrl+Shift+L', click: () => sendMenuAction('tools-serial-plotter') },
        { type: 'separator' },
        { label: 'Board…', click: () => sendMenuAction('tools-board') },
        { label: 'Port…', click: () => sendMenuAction('tools-port') },
        { label: 'Board Options…', click: () => sendMenuAction('tools-board-options') },
        { label: 'PlatformIO Environment…', click: () => sendMenuAction('tools-pio-env') },
        { label: 'Reload Board Data', click: () => sendMenuAction('tools-reload-boards') },
        { label: 'Set Up Arduino Tools…', click: () => sendMenuAction('tools-setup') },
        { label: 'Get Board Info', click: () => sendMenuAction('tools-get-board-info') }
      ]
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Getting Started', click: () => sendMenuAction('help-getting-started') },
        { label: 'Environment', click: () => sendMenuAction('help-environment') },
        { label: 'Troubleshooting', click: () => sendMenuAction('help-troubleshooting') },
        { label: 'Reference', click: () => sendMenuAction('help-reference') },
        { label: 'Find in Reference', accelerator: 'CmdOrCtrl+Shift+F', click: () => sendMenuAction('help-find-reference') },
        { type: 'separator' },
        { label: 'Frequently Asked Questions', click: () => sendMenuAction('help-faq') },
        { label: 'Visit Arduino.cc', click: () => sendMenuAction('help-visit-arduino') },
        { type: 'separator' },
        { label: 'Report a Problem…', click: () => sendMenuAction('help-report-problem') },
        ...(isMac ? [] : [
          { type: 'separator' },
          { label: 'About Impulse', click: () => sendMenuAction('help-about') }
        ])
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  debug('app.whenReady', {});
  // Test and automation copies (smoke, e2e, live checks) stay out of the macOS
  // Dock, so the installed Impulse is the only one people see there.
  if (process.platform === 'darwin' && process.env.IMPULSE_HIDE_DOCK === '1') app.dock?.hide();
  workspace = new WorkspaceStore();
  workspace.restore();
  workspace.on('recent-changed', () => buildMenu());
  ipcMain.on('ui:shell-mode', (event, mode) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return;
    const next = mode === 'ide' ? 'ide' : 'vibe';
    if (next === shellMode) return;
    shellMode = next;
    buildMenu();
  });
  // IMPULSE_TOOLCHAIN_ISOLATED=1 ignores system installs (testing first-run setup).
  const toolchain = new Toolchain({
    managedDir: path.join(app.getPath('userData'), 'toolchain'),
    ignoreSystem: process.env.IMPULSE_TOOLCHAIN_ISOLATED === '1'
  });
  arduinoService = new ArduinoService({ cliPath: toolchain.findCli()?.path || null });
  // Builds and uploads stream to the window as they run (the IDE console, chat mode's build card).
  arduinoService.jobs.on('event', (ev) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('build:event', ev);
  });
  esp32sim = new Esp32Simulator({
    runCli: (args, opts) => arduinoService.runCommand(args, opts),
    dataDir: path.join(app.getPath('userData'), 'emulators'),
    bundledDir: app.isPackaged ? bundledQemuDir() : packedQemuDir(),
  });
  arduinoService.esp32sim = esp32sim;
  serialMonitor = new SerialMonitor();
  errorMemory = new ErrorMemory();
  cloudAccount = new CloudAccount({
    baseURL: cloudURL(),
    file: path.join(app.getPath('userData'), 'impulse-account.json'),
    safeStorage,
    openExternal: (url) => shell.openExternal(url),
    version: app.getVersion(),
  });
  chatStore = new ChatStore(path.join(app.getPath('userData'), 'chats'));
  learning = setupLearning();
  // A build with a cloud address is credits-only: no models on this computer.
  aiAgent = new AIAgent(arduinoService, serialMonitor, errorMemory);
  aiAgent.initializeProviders();
  // The board makers' own pages, cached on disk (knowledge/docs.js).
  if (aiAgent.toolExecutor) {
    const { DocsService } = require('./services/ai/knowledge/docs');
    aiAgent.toolExecutor.docs = new DocsService({ cacheDir: path.join(app.getPath('userData'), 'docs-cache') });
    // Every compile, from anywhere, reports pins the board does not have.
    arduinoService.pinInspector = () => aiAgent.toolExecutor.checkPins();
    arduinoService.sketchLinter = () => aiAgent.toolExecutor.lintSketch(null, { built: true }); // runs after a build that worked
  }
  // Gateway requests say which app version sent them.
  aiAgent.providerOptions = { impulse: { version: app.getVersion() }, 'impulse-openai': { version: app.getVersion() } };
  // One Impulse AI: the server picks the model per turn; the lane takes the account's session.
  aiAgent.router = ({ kind, escalate }) => cloudAccount.route(kind, escalate);
  aiAgent.credential = () => cloudAccount.sessionToken();

  if (aiAgent.toolExecutor) {
    aiAgent.toolExecutor.setUICallbacks({
      getBaudRate: async () => uiState.currentBaudRate,
      setBaudRate: async (baudRate) => {
        uiState.currentBaudRate = baudRate;
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('ui:set-baud-rate', baudRate);
        }
      },
      // Main is authoritative: the renderer pushes editor contents on every
      // change (ui:update-editor-code, debounced to 100 ms), so uiState.editorCode
      // is at most one debounce window stale. The old pseudo-RPC
      // (ui:get-editor-code / ui:editor-code-response with a 1 s timeout
      // fallback) could silently feed the agent the same cached value on a slow
      // renderer; reading the buffer is the fallback.
      getEditorCode: async () => uiState.editorCode || '',
      // Snapshot of the editor rev at read time. Tools pair this with
      // setEditorCode({ expectedRev }) to guard against lost updates when a
      // user edit lands between the agent's read and write.
      getEditorRev: async () => uiState.editorRev || 0,
      setEditorCode: async (code, { expectedRev } = {}) => {
        // Lost-update guard: if the caller held a rev from a prior read and the
        // user has typed since, refuse the write so the agent re-reads and
        // tries again. Backward-compatible: no expectedRev → no check.
        if (expectedRev != null && expectedRev !== (uiState.editorRev || 0)) {
          const err = new Error('Editor changed while the tool was working.');
          err.code = 'STALE_EDITOR';
          err.currentRev = uiState.editorRev || 0;
          throw err;
        }
        uiState.editorCode = code;
        uiState.editorRev = (uiState.editorRev || 0) + 1;
        // The window echoes this write back through ui:update-editor-code; count it as the agent's.
        uiState.lastEditBy = 'agent-pending';
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('ui:set-editor-code', code);
        }
      },
      getCurrentSketchPath: async () => uiState.currentSketchPath,
      saveSketch: async (filePath) => {
        const p = filePath || uiState.currentSketchPath;
        if (!p) throw new Error('No sketch is open to save.');
        const check = validatePath(p, { write: true });
        if (!check.valid) throw new Error(check.error);
        if (uiState.editorCode) await fsp.writeFile(check.resolved, uiState.editorCode, 'utf8');
        return check.resolved;
      },
      confirmUpload: async ({ sketchPath, boardFQBN, port }) => {
        if (!mainWindow || mainWindow.isDestroyed()) return false;
        // Chat mode asks inside the conversation; a system dialog over it is
        // the wrong shape and is easy to miss behind the window.
        if (shellMode === 'vibe') {
          const id = `u_${Date.now().toString(36)}`;
          const answered = new Promise((resolve) => {
            const onReply = (_event, replyId, allowed) => {
              if (replyId !== id) return;
              ipcMain.removeListener('ui:confirm-upload-reply', onReply);
              resolve(!!allowed);
            };
            ipcMain.on('ui:confirm-upload-reply', onReply);
            // The window never answered (it was reloaded): do not upload.
            setTimeout(() => {
              ipcMain.removeListener('ui:confirm-upload-reply', onReply);
              resolve(false);
            }, 120000);
          });
          mainWindow.webContents.send('ui:confirm-upload', { id, sketchPath, boardFQBN, port, name: path.basename(sketchPath) });
          return answered;
        }
        const { response } = await dialog.showMessageBox(mainWindow, {
          type: 'question',
          buttons: ['Upload', 'Cancel'],
          defaultId: 1,
          cancelId: 1,
          title: 'Allow upload to board?',
          message: 'The AI agent wants to upload to your board.',
          detail: `Sketch: ${path.basename(sketchPath)}\nBoard: ${boardFQBN}\nPort: ${port}\n\nAnything wired to the board (motors, relays, heaters) will run the new code.`
        });
        return response === 0;
      },
      getSelectedBoard: async () => uiState.selectedBoard,
      getSelectedPort: async () => uiState.selectedPort,
      getLastCompileResult: async () => uiState.lastCompileResult ?? null,
      getCircuit: async () => uiState.circuit ?? null,
      // Fixes that resolved the same error before: this computer's, then other people's.
      knownFixes: async ({ output, kind, failureCode, board }) => learning?.known({ output, kind, failureCode, board }) ?? null,
      setPlayground: async (content, append) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('playground:update', content, append);
        }
      }
    });
  }

  arduinoService.serialMonitor = serialMonitor;
  // Lines are assembled in the main process and pushed in batches.
  serialMonitor.on('lines', (batch) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('serial:lines', batch);
  });
  serialMonitor.on('cleared', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('serial:cleared');
  });
  serialMonitor.on('data', (data) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('serial:data', data);
  });
  serialMonitor.on('error', (error) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('serial:error', error?.message ?? '');
  });
  serialMonitor.on('connected', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('serial:connected');
  });
  serialMonitor.on('disconnected', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('serial:disconnected');
  });
  serialMonitor.on('reconnecting', (info) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('serial:reconnecting', info);
  });
  serialMonitor.on('reconnected', (info) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('serial:reconnected', info);
  });
  serialMonitor.on('reconnect-failed', (info) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('serial:reconnect-failed', info);
  });

  createWindow();

  // Set up notification manager
  notifications.setMainWindow(mainWindow);

  // Auto-updater (check for updates 5s after launch, then every 4 hours).
  // Each channel is registered exactly once: a partial failure in the real path
  // must not leave a handler behind that the catch path then collides with.
  let updaterService = null;
  try {
    const AutoUpdaterService = require('./services/autoUpdater');
    updaterService = new AutoUpdaterService(mainWindow);
    setTimeout(() => updaterService.checkForUpdates(), 5000);
    setInterval(() => updaterService.checkForUpdates(), 4 * 60 * 60 * 1000);
  } catch (err) {
    console.warn('Auto-updater not available:', err.message);
    updaterService = null;
  }
  ipcMain.handle('updater:check', async () =>
    updaterService ? updaterService.checkForUpdates() : { available: false });
  ipcMain.handle('updater:download', async () =>
    updaterService ? updaterService.downloadUpdate() : { success: false, error: 'Updater not available' });
  ipcMain.handle('updater:install', () =>
    updaterService ? updaterService.quitAndInstall() : { success: false, error: 'Updater not available' });

  const ctx = {
    mainWindow,
    learning,
    arduinoService,
    serialMonitor,
    errorMemory,
    aiAgent,
    cloudAccount,
    chatStore,
    uiState,
    fsp,
    path,
    dialog,
    shell,
    app,
    workspace,
    problemReporter,
    toolchain,
    esp32sim
  };
  registerAllIpc(ipcMain, ctx);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

/**
 * Learning from fixes: a failed build followed by a success is a fix. Kept on
 * this computer; shared with Impulse Cloud when signed in and sharing is on
 * (PRIVACY.md). Known fixes join a failed build's tool result.
 */
function setupLearning() {
  const Store = require('electron-store');
  const prefs = new Store({ name: 'learning', defaults: { share: true } });
  const capture = new FixCapture({ file: path.join(app.getPath('userData'), 'learning.json') });
  capture.on('error', (e) => console.warn('[learning] could not save:', e?.message || e));
  const shareOn = () => prefs.get('share') !== false;

  const share = async (fix) => {
    if (!shareOn() || !cloudAccount?.status().signedIn) return;
    const res = await cloudAccount.shareFix(fix).catch(() => null);
    if (res?.ok) capture.markShared(fix.id);
  };
  capture.on('fix', (fix) => { share(fix).catch(() => {}); });
  // Fixes recorded while signed out or offline go when the account is back.
  const drain = () => { for (const fix of capture.unshared().slice(-20)) share(fix).catch(() => {}); };
  cloudAccount?.on('change', (status) => { if (status.signedIn) drain(); });

  // Every finished build or upload, with the sketch as it was at that moment.
  arduinoService.jobs.on('result', (ev) => {
    try {
      const fqbn = ev.fqbn || uiState.selectedBoard || null;
      const details = aiAgent?.toolExecutor?.boardKnowledge?.cache?.get(fqbn) || null;
      capture.observeBuild({
        kind: ev.kind,
        ok: ev.ok,
        sketchPath: ev.sketchPath,
        fqbn,
        coreVersion: details?.coreVersion || '',
        output: ev.ok ? '' : (ev.error?.output || ev.error?.message || ''),
        failureCode: ev.ok ? '' : (ev.error?.code || ''),
        excerpt: ev.ok ? '' : (ev.error?.excerpt || ''),
        code: uiState.editorCode || '',
        editedBy: uiState.lastEditBy === 'agent' || uiState.lastEditBy === 'agent-pending' ? 'agent' : uiState.lastEditBy === 'user' ? 'user' : null,
        model: aiAgent?.currentProvider?.model || null,
      });
    } catch (error) {
      console.warn('[learning] could not record the build:', error?.message || error);
    }
  });

  return {
    status: () => ({ share: shareOn(), ...capture.stats() }),
    async setShare(on) {
      prefs.set('share', !!on);
      if (on) drain();
      return { share: shareOn(), ...capture.stats() };
    },
    /** Known fixes for a failure: local first, then the cloud's (same board first). */
    async known({ output, kind, failureCode, board }) {
      const local = capture.lookup(output, kind, failureCode);
      const out = { hash: local.hash, seenHere: local.count, local: local.fixes.map((f) => ({ fixedBy: f.fixedBy, board: f.board, diff: f.diff.slice(0, 1200), at: f.at })), shared: [] };
      if (shareOn() && cloudAccount?.status().signedIn) {
        const res = await cloudAccount.knownFixes(local.hash, board).catch(() => null);
        if (res?.ok && res.data) {
          out.sharedCount = res.data.fixes;
          out.sharedUsers = res.data.users;
          out.shared = (res.data.known || []).map((f) => ({ fixedBy: f.fixedBy, board: f.board, coreVersion: f.coreVersion, diff: String(f.diff || '').slice(0, 1200) }));
        }
      }
      return out;
    },
    capture,
  };
}

app.on('will-quit', () => {
  esp32sim?.stopAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

