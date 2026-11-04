// ============================================
// Impulse IDE - Renderer
// Modern UI with Activity Bar & Panels
// ============================================

import { getCodeMirror } from './codemirror-ref.js';
import { SimulationManager } from './simulation/index.js';
import { askDialog, confirmDialog, preferencesDialog, reportProblemDialog, boardOptionsDialog, aboutDialog } from './dialog.js';
import { baseFqbn, composeFqbn, effectiveChoices, suggestedChoices, loadChoices, saveChoices, describePort, sortPorts } from './board-options.js';
import { ensureToolchain } from './setup.js';
import { runSimulatorCheck, renderTestReport, renderVerifyCard, isSimulatableBoard, simulationContext } from './verify.js';
import { boardForFqbn, simulationTarget, simulatedBoardsText } from './simulation/boards.js';
import { attachPinInsights } from './pin-insights.js';
import { attachBreakpoints } from './breakpoints.js';
import { setupSourceControl } from './source-control.js';
import { detectBaud, diffSerial, captureBoardSerial, renderCompareReport } from './compare.js';
import { runHeadless } from './simulation/headless.js';
import { EXAMPLES } from './simulation/examples.js';
import { sketchBlockFrom } from './answer-code.js';
import { programOf } from './simulation/runners.js';
import { createChatOrb, COPY as ORB_COPY } from './morph-orb/morph-orb.js';
import { pickDetectedBoard } from './board-detect.js';
import { renderMarkdown } from './markdown.js';

// UI State — exposed on window so other modules (validation.js, etc.) can access it
// without relying on bundler scope-hoisting accidents.
const state = window.state = {
    cliInstalled: false,
    boards: [],
    ports: [],
    serialPorts: [],
    serialConnected: false,
    currentSketch: null,
    currentFile: null,
    editor: null,
    // Multi-file tabs: [{ path, content, name }]
    openFiles: [],
    activeTabIndex: -1,
    aiPanelOpen: false,
    aiPanelCollapsed: false,
    aiPanelMinimized: false,
    aiPanelWidth: 400,
    aiProviderConfigured: false,
    aiMode: 'agent',
    aiModelSuggestion: null,
    aiTokensUsed: 0,       // cumulative input tokens this session
    aiCompacting: false,   // guard against concurrent compaction
    apiKeyModalProvider: null,
    folderRoot: null,
    // PlatformIO project the open file belongs to: { root, envs, env, cli, error } (see main/services/platformio.js)
    pio: null,
    expandedDirs: new Set(),
    installedLibs: new Map(),
    libSearchResults: [],
    activePanel: 'explorer',
    sidebarCollapsed: false,
    darkMode: false,
    // Serial Plotter state
    plotter: {
        data: [],          // Array of { timestamp, values: number[] }
        maxPoints: 500,
        paused: false,
        animFrameId: null,
        channelCount: 0,
        running: false
    },
    // Context awareness state
    context: {
        activeFile: null,
        selectedBoard: null,
        selectedPort: null,
        lastCompileResult: null,
        currentBaudRate: 115200,
        serialConnected: false
    },
};

// ============================================
// Initialization
// ============================================
document.addEventListener('DOMContentLoaded', async () => {
    if (typeof window.electronAPI === 'undefined') {
        const msg = 'Preload did not run — electronAPI is missing. Restart the app or run via npm start / npm run dev.';
        console.error(msg);
        document.body.innerHTML = '<div style="font-family:sans-serif;padding:40px;max-width:520px;"><h2>Impulse IDE</h2><p style="color:#c00;">' + msg + '</p><p>Check the terminal and DevTools console for errors.</p></div>';
        return;
    }
    if (!getCodeMirror()) {
        const msg = 'CodeMirror failed to load. Check the console for module errors.';
        console.error(msg);
        document.body.innerHTML = '<div style="font-family:sans-serif;padding:40px;max-width:520px;"><h2>Impulse IDE</h2><p style="color:#c00;">' + msg + '</p></div>';
        return;
    }
    try {
        setupBuildStream();
        // Chat mode hides the IDE, so the board picker lives outside it.
        const boardModal = document.getElementById('boardPortModal');
        if (boardModal) document.body.appendChild(boardModal);
        setupShellSwitch();
        // Theme and account wiring needs nothing loaded: usable while the boards load.
        setupFooterThemeToggle();
        setupAccountButton();
        initializeCodeMirror();
        restoreEditorPrefs();
        attachPinInsights(state.editor, {
            getWiring: () => window.simManager?.getWiring?.() ?? null,
            onIssues: (issues) => window.dispatchEvent(new CustomEvent('impulse:pin-issues', { detail: issues }))
        });
        window.impulse.breakpoints = attachBreakpoints(state.editor, {
            getFile: () => state.currentFile,
            announce: announceStatus,
            onChange: () => {
                window.simManager?.onBreakpointsChanged?.();
                if (state.activePanel === 'debug') updateDebugPanel();
            }
        });
        // First run (or a missing core): offer to install the Arduino tools.
        await ensureToolchain();
        await checkArduinoCLI();
        await loadBoards();
        await loadPorts();
        await restoreAIPreferences();
        await ensureAIModel({ quiet: true });
        window.electronAPI.cloud.onStatus(followAccount);
        await restoreSession();

        setupNativeMenuListener();
        setupActivityBar();
        setupSidebarCollapse();
        setupEventListeners();
        setupSerialListeners();
        setupAIListeners();
        setupUIStateSync();
        setupOutputTabs();
        setupKeyboardShortcuts();
        syncDropdowns();
        setupAIPanelOverlay();
        setupAIPanelResize();
        setupChatOrb();
        setupContextAwareness();
        setupSerialButtons();
        setupSerialPlotter();
        setupPlayground();
        setupAutoSave();
        setupResizers();
        restoreAIPanelState();
        setupCodeBlockActions();
        setupRevertButtonHandler();
        setupUpdater();
        startPortAutoRefresh();
        document.getElementById('statusPio')?.addEventListener('click', choosePioEnv);
        sourceControl = setupSourceControl({
            // The open folder, or the current sketch's folder.
            getFolder: () => state.folderRoot || (state.currentFile ? state.currentFile.replace(/[/\\][^/\\]+$/, '') : null),
            log: logToConsole
        });
        if (state.currentFile) syncPlatformio(state.currentFile);

        logToConsole('Impulse IDE initialized', 'info');
    } catch (err) {
        console.error('Impulse IDE init error:', err);
        const existing = document.getElementById('init-error-msg');
        if (!existing) {
            const div = document.createElement('div');
            div.id = 'init-error-msg';
            div.style.cssText = 'position:fixed;top:0;left:0;right:0;padding:12px;background:#c00;color:#fff;font-family:sans-serif;z-index:9999;';
            div.textContent = 'Init error: ' + (err && err.message ? err.message : String(err)) + ' — check DevTools console.';
            document.body.prepend(div);
        }
    }
});

// ============================================
// Activity Bar & Panel Switching
// ============================================
function setupActivityBar() {
    const activityIcons = document.querySelectorAll('.activity-icon[data-panel]');

    activityIcons.forEach(icon => {
        icon.addEventListener('click', () => {
            const panelId = icon.dataset.panel;

            // If clicking the same panel, toggle sidebar
            if (state.activePanel === panelId && !state.sidebarCollapsed) {
                toggleSidebar();
                return;
            }

            // Expand sidebar if collapsed
            if (state.sidebarCollapsed) {
                toggleSidebar();
            }

            // Switch to the panel
            switchPanel(panelId);
        });

        // Double click to collapse sidebar
        icon.addEventListener('dblclick', () => {
            if (!state.sidebarCollapsed) {
                toggleSidebar();
            }
        });
    });

    // AI toggle is now in top toolbar (aiAgentTab)
}

function switchPanel(panelId) {
    state.activePanel = panelId;

    // Update activity icons
    document.querySelectorAll('.activity-icon[data-panel]').forEach(icon => {
        icon.classList.toggle('active', icon.dataset.panel === panelId);
    });

    // Update sidebar panels
    document.querySelectorAll('.sidebar-panel').forEach(panel => {
        panel.classList.remove('active');
    });

    const targetPanel = document.getElementById(`${panelId}Panel`);
    if (targetPanel) {
        targetPanel.classList.add('active');
    }

    // Load data for specific panels
    if (panelId === 'libraries') {
        loadInstalledLibs();
    }
    if (panelId === 'boards') {
        loadInstalledCores();
    }
    if (panelId === 'debug') {
        updateDebugPanel();
    }
    if (panelId === 'search') {
        document.getElementById('searchInput')?.focus();
    }
    if (panelId === 'scm') {
        sourceControl?.refresh();
    }

    // If user opens Serial panel, also show Serial output tab
    if (panelId === 'serial') {
        document.querySelector('.output-tab[data-tab="serial"]')?.click();
    }
}

function setupSidebarCollapse() {
    const collapseButtons = document.querySelectorAll('.sidebar-collapse-btn');
    collapseButtons.forEach(btn => {
        btn.addEventListener('click', toggleSidebar);
    });
}

function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    state.sidebarCollapsed = !state.sidebarCollapsed;

    if (sidebar) {
        sidebar.classList.toggle('collapsed', state.sidebarCollapsed);
        // Clear inline width/flexBasis so CSS can control width (collapsed => 0, expanded => var(--sidebar-width))
        sidebar.style.width = '';
        sidebar.style.flexBasis = '';
    }
}

// ============================================
// Keyboard Shortcuts
// ============================================
// Shortcuts live in the native application menu (main.js) so they work with
// Cmd on macOS and never fire twice. Nothing to bind here.
function setupKeyboardShortcuts() {}

// ============================================
// Native application menu (File, Edit, Sketch, Tools, Help)
// ============================================
function setupNativeMenuListener() {
    if (window.electronAPI?.menu?.onAction) {
        window.electronAPI.menu.onAction((action, payload) => {
            handleMenuAction(action, payload);
        });
    }
    // Something crashed last session: offer to report it.
    window.electronAPI?.problem?.pendingCrash?.().then((crash) => {
        if (!crash) return;
        window.notifications?.show({
            id: `crash-${crash.id}`,
            type: 'warning',
            title: 'Impulse hit a problem last time',
            message: crash.kind === 'renderer' ? 'The window stopped working.' : 'An unexpected error occurred.',
            persistent: true,
            actions: [
                { id: 'report', label: 'Report…', callback: () => reportProblem(crash) },
                { id: 'dismiss', label: 'Dismiss', callback: () => window.electronAPI.problem.dismissCrash(crash.id) }
            ]
        });
    }).catch(() => { /* reporting is best effort */ });
}

/** Help › Report a Problem: review the details, then open a GitHub issue. */
async function reportProblem(crash = null) {
    const res = await window.electronAPI?.problem?.details?.(crash?.id || null).catch(() => null);
    const answer = await reportProblemDialog({ details: res?.details || '', crash });
    if (!answer) return;
    const sent = await window.electronAPI.problem.report({ ...answer, crashId: crash?.id || null }).catch(e => ({ success: false, error: e.message }));
    if (sent?.success) window.notifications?.success('Your report is open in the browser. Submit it there to send it.');
    else window.notifications?.error(`Could not open the report: ${sent?.error || 'unknown error'}`);
}

// The focused plain text field, or null if focus is elsewhere (e.g. CodeMirror).
function focusedTextField() {
    const el = document.activeElement;
    if (!el) return null;
    const tag = el.tagName;
    if ((tag === 'INPUT' || tag === 'TEXTAREA') && !el.closest('.CodeMirror')) return el;
    return null;
}

// Cut/copy/paste that works in every text field, not just the code editor.
// Needed because the Edit-menu accelerators swallow Cmd+X/C/V before the DOM
// sees them, and execCommand('paste') is a no-op in Electron renderers.
async function editClipboardAction(kind) {
    const field = focusedTextField();

    if (kind === 'paste') {
        const text = await window.electronAPI.clipboard.readText();
        if (!text) return;
        if (field) {
            const start = field.selectionStart ?? field.value.length;
            const end = field.selectionEnd ?? field.value.length;
            field.setRangeText(text, start, end, 'end');
            field.dispatchEvent(new Event('input', { bubbles: true }));
        } else if (activeEditor()) {
            activeEditor().replaceSelection(text);
            activeEditor().focus();
        }
        return;
    }

    // cut / copy
    let selected = '';
    // Text selected on the page (a chat answer, the console) when no field or
    // the code editor has the focus.
    const pageSelection = window.getSelection();
    const pageText = pageSelection && !pageSelection.isCollapsed ? pageSelection.toString() : '';
    const editorFocused = !!document.activeElement?.closest?.('.CodeMirror');
    if (field) {
        selected = field.value.slice(field.selectionStart ?? 0, field.selectionEnd ?? 0);
        if (kind === 'cut' && selected) {
            field.setRangeText('', field.selectionStart, field.selectionEnd, 'start');
            field.dispatchEvent(new Event('input', { bubbles: true }));
        }
    } else if (pageText && !editorFocused) {
        selected = pageText;
    } else if (activeEditor()) {
        const ed = activeEditor();
        selected = ed.getSelection();
        if (kind === 'cut' && selected) ed.replaceSelection('');
    }
    if (selected) await window.electronAPI.clipboard.writeText(selected);
}

// Menu actions that need the IDE's panels: in chat mode they open the IDE first.
const IDE_MENU_ACTIONS = new Set([
    'file-open', 'file-examples', 'file-save-as', 'view-scm', 'view-explorer', 'view-boards',
    'sketch-upload-programmer', 'sketch-run-tests', 'sketch-compare-board', 'sketch-export-binary',
    'sketch-include-library', 'sketch-add-tab', 'sketch-add-file', 'tools-archive', 'tools-manage-libs',
    'tools-serial-plotter', 'tools-get-board-info', 'tools-pio-env', 'debug-start', 'debug-step-over',
    'debug-step-into', 'debug-step-out', 'debug-run-to-cursor', 'debug-toggle-breakpoint',
    'debug-clear-breakpoints'
]);

/** Chat mode's version of a menu action. Returns true when it was handled. */
function chatModeMenuAction(action, payload) {
    const shell = window.impulse.shell;
    if (!shell) return false;
    switch (action) {
        case 'file-new':
            shell.newChat();
            return true;
        case 'file-open-folder':
        case 'file-sketchbook':
            shell.openFolder();
            return true;
        case 'file-open-recent':
            if (typeof payload === 'string') shell.openFolder(payload);
            return true;
        case 'file-close':
            shell.closeBench();
            return true;
        case 'view-ai':
            shell.focusComposer();
            return true;
        case 'view-simulator':
            shell.toggleBench('sim');
            return true;
        case 'tools-serial-monitor':
            shell.openBench('serial');
            return true;
        case 'sketch-verify':
            shell.boardAction('verify');
            return true;
        case 'sketch-upload':
            shell.boardAction('upload');
            return true;
        case 'tools-board':
        case 'tools-port':
            openBoardPortModal();
            return true;
        default:
            if (!IDE_MENU_ACTIONS.has(action)) return false;
            shell.setMode('ide');
            return false;
    }
}

async function handleMenuAction(action, payload) {
    if (action === 'view-toggle-shell') {
        window.impulse.shell?.setMode(inChatMode() ? 'ide' : 'vibe');
        return;
    }
    if (inChatMode() && chatModeMenuAction(action, payload)) return;
    switch (action) {
        // File
        case 'file-new':
            newSketch();
            break;
        case 'file-open':
            openFile();
            break;
        case 'file-open-recent':
            if (typeof payload === 'string') loadFolder(payload);
            break;
        case 'file-open-folder':
            openFolder();
            break;
        case 'file-examples':
            showExamplesDropdown();
            break;
        case 'file-sketchbook':
            openFolder();
            break;
        case 'file-save':
            saveFile();
            break;
        case 'file-save-as':
            saveFileAs();
            break;
        case 'file-preferences':
            showPreferences();
            break;
        case 'file-close':
            closeCurrentTab();
            break;
        case 'file-quit':
            if (typeof window.electronAPI !== 'undefined' && window.electronAPI.app?.quit) {
                window.electronAPI.app.quit();
            } else {
                logToConsole('Quit: use window close or Alt+F4', 'info');
            }
            break;
        // Edit
        case 'edit-undo':
            if (window.simManager?.handleEditAction('undo')) break;
            if (focusedTextField()) document.execCommand('undo');
            else activeEditor()?.undo();
            break;
        case 'edit-redo':
            if (window.simManager?.handleEditAction('redo')) break;
            if (focusedTextField()) document.execCommand('redo');
            else activeEditor()?.redo();
            break;
        case 'edit-cut':
            if (window.simManager?.handleEditAction('cut')) break;
            editClipboardAction('cut');
            break;
        case 'edit-copy':
            if (window.simManager?.handleEditAction('copy')) break;
            editClipboardAction('copy');
            break;
        case 'edit-paste':
            if (window.simManager?.handleEditAction('paste')) break;
            editClipboardAction('paste');
            break;
        case 'edit-select-all': {
            if (window.simManager?.handleEditAction('select-all')) break;
            const field = focusedTextField();
            if (field) field.select();
            else if (activeEditor()) activeEditor().execCommand('selectAll');
            else if (inChatMode()) document.execCommand('selectAll');
            break;
        }
        case 'edit-goto-line':
            gotoLine();
            break;
        case 'edit-comment':
            toggleComment();
            break;
        case 'edit-increase-indent':
            activeEditor()?.indentSelection('add');
            break;
        case 'edit-decrease-indent':
            activeEditor()?.indentSelection('subtract');
            break;
        case 'edit-format':
            autoFormat();
            break;
        case 'edit-find':
            findInEditor();
            break;
        case 'edit-find-next':
            findNext();
            break;
        case 'edit-find-prev':
            findPrev();
            break;
        case 'edit-replace':
            activeEditor()?.execCommand('replace');
            break;
        // View
        case 'view-scm':
            if (state.sidebarCollapsed) toggleSidebar();
            switchPanel('scm');
            break;
        case 'view-explorer':
            if (state.sidebarCollapsed) toggleSidebar();
            switchPanel('explorer');
            break;
        case 'view-boards':
            if (state.sidebarCollapsed) toggleSidebar();
            switchPanel('boards');
            break;
        case 'view-simulator':
            toggleSimView();
            break;
        case 'view-ai':
            toggleAIPanel();
            break;
        case 'view-toggle-theme':
            document.getElementById('themeToggleBtn')?.click();
            break;
        case 'edit-font-increase':
            increaseEditorFontSize();
            break;
        case 'edit-font-decrease':
            decreaseEditorFontSize();
            break;
        // Sketch
        case 'sketch-verify':
            compileSketch();
            break;
        case 'sketch-upload':
            uploadSketch();
            break;
        case 'sketch-upload-programmer':
            uploadUsingProgrammer();
            break;
        case 'sketch-run-tests':
            runHardwareTests();
            break;
        case 'tools-pio-env':
            choosePioEnv();
            break;
        case 'debug-start':
            window.impulse.showSimulator();
            window.simManager?.debugStart();
            break;
        case 'debug-stop':
            if (window.simManager?.debug) window.simManager.stop();
            break;
        case 'debug-step-over':
            window.simManager?.debugAction('stepOver');
            break;
        case 'debug-step-into':
            window.simManager?.debugAction('stepInto');
            break;
        case 'debug-step-out':
            window.simManager?.debugAction('stepOut');
            break;
        case 'debug-run-to-cursor':
            window.simManager?.debugRunToCursor();
            break;
        case 'debug-toggle-breakpoint':
            window.impulse.breakpoints?.toggle();
            break;
        case 'debug-clear-breakpoints':
            window.impulse.breakpoints?.clearAll();
            break;
        case 'sketch-compare-board':
            compareSimulatorWithBoard();
            break;
        case 'sketch-export-binary':
            exportCompiledBinary();
            break;
        case 'sketch-show-folder':
            showSketchFolder();
            break;
        case 'sketch-include-library':
            if (state.sidebarCollapsed) toggleSidebar();
            switchPanel('libraries');
            break;
        case 'sketch-add-tab':
            addTabToSketch();
            break;
        case 'sketch-add-file':
            addFileToSketch();
            break;
        // Tools
        case 'tools-format':
            autoFormat();
            break;
        case 'tools-archive':
            archiveSketch();
            break;
        case 'tools-manage-libs':
            if (state.sidebarCollapsed) toggleSidebar();
            switchPanel('libraries');
            break;
        case 'tools-serial-monitor':
            document.querySelector('.output-tab[data-tab="serial"]')?.click();
            if (state.sidebarCollapsed) toggleSidebar();
            switchPanel('serial');
            break;
        case 'tools-serial-plotter':
            // The serial panel first (it brings its own output tab to the
            // front), then the plotter tab, so the plotter is what stays shown.
            if (state.sidebarCollapsed) toggleSidebar();
            switchPanel('serial');
            showOutputTab('plotter');
            break;
        case 'tools-board':
            document.getElementById('boardPortDropdown')?.click();
            break;
        case 'tools-port':
            document.getElementById('boardPortDropdown')?.click();
            break;
        case 'tools-reload-boards':
            loadBoards();
            loadPorts();
            break;
        case 'tools-get-board-info':
            getBoardInfo();
            break;
        // Help — open Arduino docs in browser
        case 'help-getting-started':
            openHelpUrl('https://docs.arduino.cc/learn/getting-started');
            break;
        case 'help-environment':
            openHelpUrl('https://docs.arduino.cc/learn/development/welcome-to-arduino');
            break;
        case 'help-troubleshooting':
            openHelpUrl('https://support.arduino.cc/hc/en-us');
            break;
        case 'help-reference':
            openHelpUrl('https://www.arduino.cc/reference/en/');
            break;
        case 'help-find-reference':
            openFindInReference();
            break;
        case 'help-faq':
            openHelpUrl('https://support.arduino.cc/hc/en-us/categories/360000522940-FAQ');
            break;
        case 'help-visit-arduino':
            openHelpUrl('https://www.arduino.cc');
            break;
        case 'help-about':
            showAbout();
            break;
        case 'help-report-problem':
            reportProblem();
            break;
        case 'tools-board-options':
            openBoardOptions();
            break;
        case 'tools-setup':
            if (await ensureToolchain({ force: true })) {
                await checkArduinoCLI();
                await loadBoards();
                await loadPorts();
            }
            break;
        default:
            break;
    }
}

async function newSketch() {
    if (!window.electronAPI?.dialog?.saveNewSketch) {
        showWelcomeState();
        state.folderRoot = null;
        const label = document.getElementById('folderLabel');
        if (label) label.innerHTML = `<span class="folder-icon">${ICONS.folder}</span><span>No folder open</span>`;
        document.getElementById('fileTree').innerHTML = '';
        logToConsole('New sketch — open a folder to start', 'info');
        return;
    }
    try {
        const result = await window.electronAPI.dialog.saveNewSketch();
        if (result.canceled || !result.success) {
            if (!result.canceled) logToConsole(result.error || 'Could not create sketch', 'error');
            return;
        }
        state.folderRoot = result.folderPath;
        state.expandedDirs.clear();
        const label = document.getElementById('folderLabel');
        const name = result.folderPath.split(/[/\\]/).pop() || result.folderPath;
        if (label) label.innerHTML = `<span class="folder-icon">${ICONS.folder}</span><span>${escapeHtml(name)}</span>`;
        await renderFileTree(result.folderPath);
        const fileResult = await window.electronAPI.file.read(result.filePath);
        const content = fileResult.success ? fileResult.content : '';
        const fileName = result.sketchName || result.filePath.split(/[/\\]/).pop();
        showEditor();
        addOrFocusFile(result.filePath, content, fileName);
        switchToTab(state.openFiles.length - 1);
        saveSession();
        logToConsole(`New sketch created: ${fileName}`, 'success');
    } catch (e) {
        logToConsole(`New sketch error: ${e.message}`, 'error');
    }
}

async function openFile() {
    try {
        const result = await window.electronAPI.dialog.openFile();
        if (result.success && result.filePath) {
            const fileResult = await window.electronAPI.file.read(result.filePath);
            if (fileResult.success) {
                const name = result.filePath.split(/[/\\]/).pop();
                const ext = (name.split('.').pop() || '').toLowerCase();
                if (['ino', 'h', 'hpp', 'cpp', 'c', 'txt', 'json'].includes(ext) && state.editor) {
                    showEditor();
                    addOrFocusFile(result.filePath, fileResult.content, name);
                    switchToTab(state.openFiles.length - 1);
                    logToConsole(`Opened: ${name}`, 'success');
                } else {
                    logToConsole('Unsupported file type for editing', 'warning');
                }
            }
        }
    } catch (e) {
        logToConsole(`Open file error: ${e.message}`, 'error');
    }
}

// ============================================
// Playground Panel
// ============================================
function setupPlayground() {
    const entriesEl = document.getElementById('playgroundEntries');
    const clearBtn = document.getElementById('playgroundClearBtn');

    if (!entriesEl) return;

    // Show empty state initially
    showPlaygroundEmpty();

    function showPlaygroundEmpty() {
        entriesEl.innerHTML = '<div class="panel-empty playground-empty"><strong>No hardware tasks yet</strong><span>When Impulse AI runs a task on your board, each step shows here.</span></div>';
    }

    function addEntry(content) {
        // Remove empty state if present
        const emptyEl = entriesEl.querySelector('.playground-empty');
        if (emptyEl) emptyEl.remove();

        const entry = document.createElement('div');
        entry.className = 'playground-entry';

        const header = document.createElement('div');
        header.className = 'playground-entry-header';
        const now = new Date();
        header.textContent = `Step ${entriesEl.querySelectorAll('.playground-entry').length + 1} — ${now.toLocaleTimeString()}`;

        const body = document.createElement('div');
        body.textContent = content;

        entry.appendChild(header);
        entry.appendChild(body);
        entriesEl.appendChild(entry);

        // Auto-scroll to bottom
        entriesEl.scrollTop = entriesEl.scrollHeight;
    }

    function replaceAll(content) {
        entriesEl.innerHTML = '';
        addEntry(content);
    }

    function switchToPlaygroundTab() {
        const tabs = document.querySelectorAll('.output-tab');
        tabs.forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.output-content').forEach(c => c.classList.remove('active'));

        const playgroundTab = document.querySelector('.output-tab[data-tab="playground"]');
        const playgroundContent = document.getElementById('playgroundOutput');
        if (playgroundTab) playgroundTab.classList.add('active');
        if (playgroundContent) playgroundContent.classList.add('active');

        // Hide serial input row
        const serialInputRow = document.getElementById('serialInputRow');
        if (serialInputRow) serialInputRow.style.display = 'none';

        // Stop plotter rendering
        if (typeof stopPlotterRendering === 'function') stopPlotterRendering();
    }

    // Listen for playground updates from the AI agent via IPC
    if (window.electronAPI && window.electronAPI.ui && window.electronAPI.ui.onPlaygroundUpdate) {
        window.electronAPI.ui.onPlaygroundUpdate((content, append) => {
            if (append === false) {
                replaceAll(content);
            } else {
                addEntry(content);
            }
            // Auto-switch to the Playground tab
            switchToPlaygroundTab();
        });
    }

    // Clear button
    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            showPlaygroundEmpty();
        });
    }
}

// Auto-save current file every 30 seconds
function setupAutoSave() {
    setInterval(() => {
        if (!state.currentFile || !state.editor) return;
        const file = state.activeTabIndex >= 0 && state.openFiles[state.activeTabIndex] ? state.openFiles[state.activeTabIndex] : null;
        if (!file) return;
        // Only autosave tabs the user actually edited — never write a freshly
        // loaded/blank editor over the file on disk.
        if (!file.dirty) return;
        const code = state.editor.getValue();
        if (file.content === code) { file.dirty = false; return; }
        saveFile();
    }, 30000);
}

async function saveFile({ quiet = false } = {}) {
    if (!state.currentFile) {
        if (!quiet) logToConsole('No file open to save', 'warning');
        return false;
    }
    // The editor holds the active tab, so it is saved to the active tab's file
    // (never to the sketch's .ino while a .h or .cpp tab is open).
    const target = state.currentFile;
    if (!state.editor || !target) return false;
    const code = state.editor.getValue();
    try {
        const result = await window.electronAPI.file.save(target, code);
        if (!result?.success) {
            logToConsole(`Save failed: ${result?.error || 'unknown error'}`, 'error');
            return false;
        }
        if (state.activeTabIndex >= 0 && state.openFiles[state.activeTabIndex]) {
            state.openFiles[state.activeTabIndex].content = code;
            state.openFiles[state.activeTabIndex].dirty = false;
        }
        if (!quiet) logToConsole('Saved', 'success');
        if (state.activePanel === 'scm') sourceControl?.refresh();
        return true;
    } catch (e) {
        logToConsole(`Save error: ${e.message}`, 'error');
        return false;
    }
}

async function saveFileAs() {
    if (!state.currentFile && !state.editor) {
        logToConsole('No file open', 'warning');
        return;
    }
    const content = state.editor ? state.editor.getValue() : (state.activeTabIndex >= 0 && state.openFiles[state.activeTabIndex] ? state.openFiles[state.activeTabIndex].content : '');
    if (!window.electronAPI?.dialog?.saveAsSketch) {
        logToConsole('Save As: open a folder and save there', 'info');
        return;
    }
    try {
        const result = await window.electronAPI.dialog.saveAsSketch(content);
        if (result.canceled || !result.success) {
            if (!result.canceled) logToConsole(result.error || 'Save As failed', 'error');
            return;
        }
        state.folderRoot = result.folderPath;
        state.expandedDirs.clear();
        const label = document.getElementById('folderLabel');
        const name = result.folderPath.split(/[/\\]/).pop() || result.folderPath;
        if (label) label.innerHTML = `<span class="folder-icon">${ICONS.folder}</span><span>${escapeHtml(name)}</span>`;
        await renderFileTree(result.folderPath);
        const fileName = result.sketchName || result.filePath.split(/[/\\]/).pop();
        showEditor();
        addOrFocusFile(result.filePath, content, fileName);
        switchToTab(state.openFiles.length - 1);
        saveSession();
        logToConsole(`Saved as: ${fileName}`, 'success');
    } catch (e) {
        logToConsole(`Save As error: ${e.message}`, 'error');
    }
}

async function showPreferences() {
    const result = await preferencesDialog({
        theme: document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark',
        fontSize: editorFontSize,
        tabSize: state.editor?.getOption('indentUnit') || 2
    });
    if (!result) return;
    const currentTheme = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    if (result.theme !== currentTheme) document.getElementById('themeToggleBtn')?.click();
    setEditorFontSize(result.fontSize);
    if (state.editor) {
        state.editor.setOption('indentUnit', result.tabSize);
        state.editor.setOption('tabSize', result.tabSize);
    }
    try { localStorage.setItem('impulse-editor-prefs', JSON.stringify({ fontSize: result.fontSize, tabSize: result.tabSize })); } catch { /* storage unavailable */ }
}

function closeCurrentTab() {
    if (state.activeTabIndex >= 0) closeTab(state.activeTabIndex);
    else logToConsole('No tab to close', 'info');
}

function gotoLine() {
    const ed = activeEditor();
    if (!ed) return;
    ed.focus();
    ed.execCommand('jumpToLine');
}

function toggleComment() {
    const ed = activeEditor();
    if (!ed) return;
    const range = { from: ed.getCursor('from'), to: ed.getCursor('to') };
    const lineFrom = range.from.line;
    const lineTo = range.to.line;
    const lineText = ed.getLine(lineFrom);
    const isComment = /^\s*\/\//.test(lineText);
    ed.operation(() => {
        for (let i = lineFrom; i <= lineTo; i++) {
            const text = ed.getLine(i);
            if (isComment) {
                const newText = text.replace(/^\s*\/\/\s?/, '');
                ed.replaceRange(newText, { line: i, ch: 0 }, { line: i, ch: text.length });
            } else {
                ed.replaceRange('// ' + text, { line: i, ch: 0 }, { line: i, ch: 0 });
            }
        }
    });
}

// Re-indent every line from the C/C++ mode's own rules (CodeMirror 5 has no
// full formatter). Idempotent: pressing it twice changes nothing.
function autoFormat() {
    const ed = activeEditor();
    if (!ed) return;
    const cursor = ed.getCursor();
    ed.operation(() => {
        for (let i = 0; i < ed.lineCount(); i++) ed.indentLine(i, 'smart');
    });
    ed.setCursor(cursor);
}

function findInEditor() {
    const ed = activeEditor();
    if (!ed) return;
    ed.focus();
    ed.execCommand('find');
}

function findNext() {
    activeEditor()?.execCommand('findNext');
}

function findPrev() {
    activeEditor()?.execCommand('findPrev');
}

let editorFontSize = 13;
function setEditorFontSize(px) {
    editorFontSize = Math.max(10, Math.min(24, Math.round(px) || 13));
    for (const ed of [state.editor, linkedEditor]) {
        ed?.getWrapperElement().style.setProperty('font-size', `${editorFontSize}px`);
        ed?.refresh();
    }
    try {
        const prefs = JSON.parse(localStorage.getItem('impulse-editor-prefs') || '{}');
        localStorage.setItem('impulse-editor-prefs', JSON.stringify({ ...prefs, fontSize: editorFontSize }));
    } catch { /* storage unavailable */ }
}
function increaseEditorFontSize() { setEditorFontSize(editorFontSize + 1); }
function decreaseEditorFontSize() { setEditorFontSize(editorFontSize - 1); }

function restoreEditorPrefs() {
    try {
        const prefs = JSON.parse(localStorage.getItem('impulse-editor-prefs') || '{}');
        if (prefs.fontSize) setEditorFontSize(prefs.fontSize);
        if (prefs.tabSize && state.editor) {
            state.editor.setOption('indentUnit', prefs.tabSize);
            state.editor.setOption('tabSize', prefs.tabSize);
        }
    } catch { /* storage unavailable */ }
}

function requireSketchAndBoard() {
    if (!state.currentSketch) {
        logToConsole('Open a sketch first', 'warning');
        return false;
    }
    if (!state.selectedBoard) {
        logToConsole('Select a board first', 'warning');
        document.getElementById('boardPortDropdown')?.click();
        return false;
    }
    return true;
}

async function exportCompiledBinary() {
    if (!requireSketchAndBoard()) return;
    if (!await saveFile({ quiet: true })) return;
    logToConsole('Exporting compiled binary…', 'info');
    const res = await window.electronAPI.arduino.exportBinaries(state.currentSketch, await fqbnFor(state.selectedBoard));
    if (!res?.success) {
        logToConsole(res?.error || 'Export failed', 'error');
        return;
    }
    logToConsole(`Exported ${res.files.length} file(s) to ${res.outputDir}`, 'success');
    window.electronAPI.shell?.showItemInFolder(res.outputDir);
}

// The simulator compiles from disk, so it saves the open file first.
/** Save every edited tab (the active one from the editor) before a build. */
async function saveAllFiles() {
    if (state.editor && state.currentFile && !await saveFile({ quiet: true })) return false;
    for (const [i, file] of state.openFiles.entries()) {
        if (i === state.activeTabIndex || !file.dirty) continue;
        const result = await window.electronAPI.file.save(file.path, file.content).catch(e => ({ success: false, error: e.message }));
        if (!result?.success) {
            logToConsole(`Save failed for ${file.name || file.path}: ${result?.error || 'unknown error'}`, 'error');
            return false;
        }
        file.dirty = false;
    }
    renderFileTabs();
    return true;
}

window.saveActiveFile = () => saveAllFiles();

function showOutputTab(name) {
    const outputPanel = document.getElementById('outputPanel');
    if (outputPanel && outputPanel.style.display === 'none') outputPanel.style.display = '';
    document.querySelector(`.output-tab[data-tab="${name}"]`)?.click();
}

let hardwareTestsRunning = false;
async function runHardwareTests() {
    if (hardwareTestsRunning) return;
    if (!state.currentSketch) {
        logToConsole('Open a sketch first', 'warning');
        return;
    }
    const container = document.getElementById('testsOutput');
    showOutputTab('tests');
    hardwareTestsRunning = true;
    try {
        if (!await saveAllFiles()) return;
        const context = simulationContext();
        container.innerHTML = `<p class="tests-hint">Compiling for the simulated ${escapeHtml(context.label)}…</p>`;
        const result = await runSimulatorCheck({
            sketchPath: state.currentSketch,
            code: state.editor.getValue(),
            context,
            onStage: (stage) => {
                if (stage === 'run') container.innerHTML = `<p class="tests-hint">Running on the simulated ${escapeHtml(context.label)} with your circuit…</p>`;
            }
        });
        renderTestReport(container, result);
        if (!isSimulatableBoard(state.selectedBoard)) {
            const note = document.createElement('p');
            note.className = 'tests-hint';
            note.textContent = `Your upload board can't be simulated, so these checks ran on the simulator's ${context.label}.`;
            container.prepend(note);
        }
        logToConsole(`Hardware tests: ${result.ok ? 'passed' : 'failed'}`, result.ok ? 'success' : 'warning');
    } finally {
        hardwareTestsRunning = false;
    }
}

const COMPARE_SECONDS = 4;
async function compareSimulatorWithBoard() {
    if (hardwareTestsRunning) return;
    if (!requireSketchAndBoard()) return;
    const simBoard = boardForFqbn(state.selectedBoard);
    if (!simBoard) {
        logToConsole(`The simulator runs ${simulatedBoardsText()}, so only those can be compared.`, 'warning');
        return;
    }
    if (!state.selectedPort) {
        logToConsole('Connect the board and select its port first', 'warning');
        document.getElementById('boardPortDropdown')?.click();
        return;
    }
    const mode = await askDialog({
        title: 'Compare simulator with board',
        message: `Runs the sketch for ${COMPARE_SECONDS} s in the simulator and on the board at ${state.selectedPort}, then compares the serial output line by line.`,
        options: [
            { value: 'upload', label: 'Upload this sketch, then compare' },
            { value: 'as-is', label: 'The board already runs this sketch' }
        ],
        confirmLabel: 'Compare'
    });
    if (!mode) return;

    const container = document.getElementById('testsOutput');
    showOutputTab('tests');
    hardwareTestsRunning = true;
    try {
        if (!await saveAllFiles()) return;
        const code = state.editor.getValue();
        const baud = detectBaud(code);
        container.innerHTML = '<p class="tests-hint">Running in the simulator…</p>';
        const target = simulationTarget(state.selectedBoard);
        const compiled = await window.electronAPI.arduino.compileHex(state.currentSketch, target?.fqbn || state.selectedBoard,
            target?.properties ? { properties: target.properties } : undefined);
        if (!compiled?.success) {
            container.innerHTML = '';
            const pre = document.createElement('pre');
            pre.className = 'tests-error';
            pre.textContent = compiled?.error || 'Compilation failed';
            container.appendChild(pre);
            return;
        }
        const context = simulationContext();
        const circuit = context.board === simBoard.id ? context.circuit : null;
        const sim = await runHeadless(programOf(compiled), { seconds: COMPARE_SECONDS, board: simBoard.id, mcu: simulationTarget(state.selectedBoard)?.mcu, circuit });

        if (mode === 'upload') {
            container.innerHTML = '<p class="tests-hint">Uploading to the board…</p>';
            await window.electronAPI.serial.disconnect().catch(() => {});
            const up = await window.electronAPI.arduino.upload(state.currentSketch, await fqbnFor(state.selectedBoard), state.selectedPort);
            if (!up?.success) {
                container.innerHTML = '';
                const pre = document.createElement('pre');
                pre.className = 'tests-error';
                pre.textContent = up?.error || 'Upload failed';
                container.appendChild(pre);
                return;
            }
            await new Promise(r => setTimeout(r, 1500));
        }

        container.innerHTML = `<p class="tests-hint">Listening to the board at ${baud} baud…</p>`;
        let boardText;
        try {
            // Opening the port resets an UNO, so both runs start from power-on.
            boardText = await captureBoardSerial(state.selectedPort, baud, COMPARE_SECONDS);
        } catch (err) {
            container.innerHTML = '';
            const pre = document.createElement('pre');
            pre.className = 'tests-error';
            pre.textContent = err.message;
            container.appendChild(pre);
            return;
        }
        renderCompareReport(container, { diff: diffSerial(sim.serial, boardText), baud, seconds: COMPARE_SECONDS, port: state.selectedPort });
    } finally {
        hardwareTestsRunning = false;
    }
}

async function uploadUsingProgrammer() {
    if (!requireSketchAndBoard()) return;
    const list = await window.electronAPI.arduino.listProgrammers(state.selectedBoard);
    const programmers = list?.data || [];
    if (programmers.length === 0) {
        logToConsole('This board has no programmers listed. Install its core in the board manager.', 'warning');
        return;
    }
    const programmerId = await askDialog({
        title: 'Upload using programmer',
        message: 'Burns the sketch through an ISP programmer and overwrites the bootloader.',
        options: programmers.map(p => ({ value: p.id, label: p.name, hint: p.id })),
        confirmLabel: 'Upload'
    });
    if (!programmerId) return;
    if (!await saveFile({ quiet: true })) return;
    logToConsole(`Uploading with programmer ${programmerId}…`, 'info');
    const res = await window.electronAPI.arduino.uploadWithProgrammer(state.currentSketch, await fqbnFor(state.selectedBoard), programmerId, state.selectedPort || '');
    if (res?.success) logToConsole('Upload using programmer finished', 'success');
    else logToConsole(res?.error || 'Upload using programmer failed', 'error');
}

function showSketchFolder() {
    const pathToShow = state.currentSketch || state.folderRoot;
    if (pathToShow && window.electronAPI?.shell?.showItemInFolder) {
        window.electronAPI.shell.showItemInFolder(pathToShow).then((r) => {
            if (r && !r.success) logToConsole(r.error || 'Could not show folder', 'warning');
        }).catch(() => logToConsole('Could not show sketch folder', 'warning'));
    } else if (state.folderRoot) {
        logToConsole(`Sketch folder: ${state.folderRoot}`, 'info');
    } else {
        logToConsole('Open a folder or sketch first', 'warning');
    }
}

async function addFileToSketch() {
    if (!state.folderRoot) {
        logToConsole('Open a sketch folder first', 'warning');
        return;
    }
    const result = await window.electronAPI.dialog.openFile();
    if (!result?.success || !result.filePath) return;
    const read = await window.electronAPI.file.read(result.filePath);
    if (!read?.success) {
        logToConsole(read?.error || 'Could not read file', 'error');
        return;
    }
    const name = result.filePath.split(/[/\\]/).pop();
    const sep = state.folderRoot.includes('\\') ? '\\' : '/';
    const target = state.folderRoot.replace(/[/\\]$/, '') + sep + name;
    const saved = await window.electronAPI.file.save(target, read.content);
    if (!saved?.success) {
        logToConsole(saved?.error || 'Could not copy file into the sketch', 'error');
        return;
    }
    showEditor();
    addOrFocusFile(target, read.content, name);
    switchToTab(state.openFiles.length - 1);
    await renderFileTree(state.folderRoot);
    logToConsole(`Added ${name} to the sketch`, 'success');
}

async function addTabToSketch() {
    if (!state.folderRoot) {
        logToConsole('Open a sketch folder first', 'warning');
        return;
    }
    const existingNames = state.openFiles.map(f => f.name);
    let defaultName = 'tab2.ino';
    for (let i = 2; i < 100; i++) {
        if (!existingNames.includes(`tab${i}.ino`)) {
            defaultName = `tab${i}.ino`;
            break;
        }
    }
    const name = await askDialog({
        title: 'New tab',
        input: {
            value: defaultName,
            validate: (v) => {
                if (!v) return 'Enter a file name.';
                if (/[\\/:*?"<>|]/.test(v)) return 'File names can’t contain \\ / : * ? " < > |';
                const finalName = /\.(ino|h|hpp|c|cpp)$/i.test(v) ? v : v + '.ino';
                return existingNames.includes(finalName) ? 'A tab with that name already exists.' : null;
            }
        },
        confirmLabel: 'Create'
    });
    if (!name) return;
    let base = name.trim();
    if (!/\.(ino|h|hpp|c|cpp)$/i.test(base)) base += '.ino';
    const sep = state.folderRoot.includes('\\') ? '\\' : '/';
    const root = state.folderRoot.endsWith(sep) ? state.folderRoot : state.folderRoot + sep;
    const filePath = root + base;
    const content = '';
    try {
        const result = await window.electronAPI.file.save(filePath, content);
        if (!result || !result.success) {
            logToConsole(result?.error || 'Could not create file', 'error');
            return;
        }
        showEditor();
        addOrFocusFile(filePath, content, base);
        switchToTab(state.openFiles.length - 1);
        await renderFileTree(state.folderRoot);
        logToConsole(`Added tab: ${base}`, 'success');
    } catch (e) {
        logToConsole(`Add tab error: ${e.message}`, 'error');
    }
}

async function archiveSketch() {
    if (!state.currentSketch) {
        logToConsole('Open a sketch first', 'warning');
        return;
    }
    if (!await saveFile({ quiet: true })) return;
    const res = await window.electronAPI.arduino.archiveSketch(state.currentSketch);
    if (res?.canceled) return;
    if (res?.success) {
        logToConsole(`Archived to ${res.archivePath}`, 'success');
        window.electronAPI.shell?.showItemInFolder(res.archivePath);
    } else {
        logToConsole(res?.error || 'Archive failed', 'error');
    }
}

async function getBoardInfo() {
    const port = state.selectedPort || document.getElementById('portSelectSidebar')?.value;
    if (!port) {
        logToConsole('Choose a port first (the board manager, or Tools › Port).', 'warning');
        window.notifications?.warning?.('Plug the board in and choose its port first, then ask for its info.');
        document.getElementById('boardPortDropdown')?.click();
        return;
    }
    const res = await window.electronAPI.arduino.boardInfo(port);
    if (!res?.success) {
        logToConsole(res?.error || 'Could not read board info', 'error');
        return;
    }
    const { info } = res;
    const lines = [
        `Port: ${info.port} (${info.protocol})`,
        info.vid ? `VID: ${info.vid}   PID: ${info.pid}` : 'VID/PID: not reported',
        info.serialNumber ? `Serial number: ${info.serialNumber}` : null,
        info.boards.length ? `Detected: ${info.boards.map(b => `${b.name} (${b.fqbn})`).join(', ')}` : 'Detected board: unknown (generic USB serial)'
    ].filter(Boolean);
    await askDialog({ title: 'Board info', message: lines.join('\n'), confirmLabel: 'Done', cancelLabel: 'Close' });
}

async function showAbout() {
    const version = await window.electronAPI.app?.getVersion?.().catch(() => null);
    await aboutDialog({ version, readDoc: (name) => window.electronAPI.app.readDoc(name) });
}

function openHelpUrl(url) {
    if (typeof window.electronAPI !== 'undefined' && window.electronAPI.openExternal) {
        window.electronAPI.openExternal(url).catch(() => logToConsole('Could not open link', 'warning'));
    }
}

function openFindInReference() {
    let term = '';
    if (state.editor) {
        const sel = state.editor.getSelection();
        if (sel && sel.length) term = sel;
        else {
            const cursor = state.editor.getCursor();
            const token = state.editor.getTokenAt ? state.editor.getTokenAt(cursor) : null;
            if (token && token.string) term = token.string;
        }
    }
    const base = 'https://www.arduino.cc/reference/en/';
    const url = term ? `${base}?q=${encodeURIComponent(term)}` : base;
    openHelpUrl(url);
}

// ============================================
// Footer & theme toggle (dark/light)
// ============================================
/** The theme, for both views (icons follow CSS [data-theme]). */
function setTheme(dark) {
    state.darkMode = dark;
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    localStorage.setItem('arduino-ide-theme', dark ? 'dark' : 'light');
}

function setupFooterThemeToggle() {
    // Restore saved theme (shell-boot.js applied it before the first paint)
    state.darkMode = localStorage.getItem('arduino-ide-theme') !== 'light';
    document.getElementById('themeToggleBtn')?.addEventListener('click', () => setTheme(!state.darkMode));
}

// ============================================
// Auto-updater UI
// ============================================
function setupUpdater() {
    if (!window.electronAPI?.updater) return;

    const banner = document.getElementById('updaterBanner');
    const textEl = document.getElementById('updaterBannerText');
    const downloadBtn = document.getElementById('updaterDownloadBtn');
    const restartBtn = document.getElementById('updaterRestartBtn');
    const dismissBtn = document.getElementById('updaterDismissBtn');

    if (!banner || !textEl) return;

    function showBanner(message, showDownload, showRestart) {
        banner.classList.remove('hidden');
        textEl.textContent = message;
        if (downloadBtn) {
            downloadBtn.classList.toggle('hidden', !showDownload);
        }
        if (restartBtn) {
            restartBtn.classList.toggle('hidden', !showRestart);
        }
    }

    function hideBanner() {
        banner.classList.add('hidden');
    }

    window.electronAPI.updater.onStatus((status, data) => {
        // Chat mode shows its own update notice.
        window.dispatchEvent(new CustomEvent('impulse:update-status', { detail: { status, data: data || null } }));
        if (status === 'available') {
            const version = data?.version ? ` (${data.version})` : '';
            showBanner(`Update available${version}.`, true, false);
        } else if (status === 'progress') {
            const pct = data?.percent != null ? data.percent : 0;
            showBanner(`Downloading update… ${pct}%`, false, false);
        } else if (status === 'downloaded') {
            showBanner('Update ready. Restart the app to install.', false, true);
        } else if (status === 'error') {
            showBanner(data?.message || 'Update check failed.', false, false);
        } else if (status === 'checking' || status === 'not-available') {
            hideBanner();
        }
    });

    downloadBtn?.addEventListener('click', () => {
        window.electronAPI.updater.download();
    });
    restartBtn?.addEventListener('click', () => {
        window.electronAPI.updater.install();
    });
    dismissBtn?.addEventListener('click', hideBanner);
}

/** The Chat | IDE switch in the IDE's top row. */
function setupShellSwitch() {
    const chat = document.getElementById('shellChatBtn');
    const ide = document.getElementById('shellIdeBtn');
    chat?.addEventListener('click', () => window.impulse.shell?.setMode('vibe'));
    ide?.addEventListener('click', () => window.impulse.shell?.setMode('ide'));
    const sync = () => {
        const vibe = inChatMode();
        chat?.setAttribute('aria-pressed', String(vibe));
        ide?.setAttribute('aria-pressed', String(!vibe));
    };
    window.addEventListener('impulse:shell-changed', sync);
    sync();
}

// ============================================
// Account (Impulse Cloud)
// ============================================
/** The person icon in the IDE's activity bar: the same account menu as chat mode. */
function setupAccountButton() {
    const userBtn = document.getElementById('userBtn');
    const dot = document.getElementById('userStatusDot');
    if (!userBtn) return;
    userBtn.setAttribute('aria-haspopup', 'menu');
    userBtn.setAttribute('aria-expanded', 'false');
    userBtn.addEventListener('click', () => window.impulse.account?.accountMenu(userBtn));
    const sync = (status) => {
        userBtn.title = status?.signedIn ? `${status.user?.email || 'Account'} · credits and plan` : 'Sign in to Impulse';
        userBtn.setAttribute('aria-label', userBtn.title);
        if (dot) dot.classList.toggle('active', !!status?.signedIn);
    };
    window.electronAPI.cloud.onStatus(sync);
    window.electronAPI.cloud.status().then(sync).catch(() => {});
}

// ============================================
// Dropdown Synchronization
// ============================================
function syncDropdowns() {
    // Board/Port selectors are now only in sidebar
    const boardSelectSidebar = document.getElementById('boardSelectSidebar');
    const portSelectSidebar = document.getElementById('portSelectSidebar');

    if (boardSelectSidebar) {
        boardSelectSidebar.addEventListener('change', (e) => {
            state.selectedBoard = e.target.value;
            state.context.selectedBoard = e.target.value;
            announceBoard();
            window.electronAPI.ui.updateBoard(e.target.value);
            const board = state.boards.find(b => b.fqbn === e.target.value);
            updateBoardPortDisplay(board?.name || null, state.selectedPort || null);
            updateAIContext();
            saveSession();
            loadSavedBoardPortOptions();
        });
    }

    if (portSelectSidebar) {
        portSelectSidebar.addEventListener('change', (e) => {
            state.selectedPort = e.target.value;
            state.context.selectedPort = e.target.value;
            window.electronAPI.ui.updatePort(e.target.value);
            syncBoardFqbn();
            const board = state.boards.find(b => b.fqbn === state.selectedBoard);
            updateBoardPortDisplay(board?.name || null, e.target.value || null);
            updateAIContext();
            saveSession();
            loadSavedBoardPortOptions();
        });
    }
}

// ============================================
// CodeMirror Editor
// ============================================
let arduinoHintRegistered = false;

function registerArduinoHint(CodeMirror) {
    if (arduinoHintRegistered) return;
    arduinoHintRegistered = true;
    CodeMirror.registerHelper("hint", "arduino", function (editor, options) {
        const keywords = [
            "setup", "loop", "if", "else", "while", "for", "switch", "case", "break", "continue", "return",
            "pinMode", "digitalWrite", "digitalRead", "analogRead", "analogWrite",
            "Serial", "begin", "println", "print", "available", "read", "write", "flush",
            "delay", "millis", "micros", "delayMicroseconds",
            "HIGH", "LOW", "INPUT", "OUTPUT", "INPUT_PULLUP",
            "int", "float", "char", "bool", "void", "String", "const", "static", "unsigned", "long", "byte",
            "true", "false", "null", "include", "define"
        ];

        const cur = editor.getCursor();
        const token = editor.getTokenAt(cur);
        const start = token.start;
        const end = cur.ch;
        const word = token.string.slice(0, end - start);

        if (!word.match(/^[a-zA-Z0-9_]+$/)) return { list: [], from: CodeMirror.Pos(cur.line, start), to: CodeMirror.Pos(cur.line, end) };

        const list = keywords.filter(k => k.toLowerCase().startsWith(word.toLowerCase()));

        const anyword = CodeMirror.hint.anyword(editor, options);
        if (anyword && anyword.list) {
            anyword.list.forEach(w => {
                if (!list.includes(w)) list.push(w);
            });
        }

        return {
            list: list,
            from: CodeMirror.Pos(cur.line, start),
            to: CodeMirror.Pos(cur.line, end)
        };
    });
}

// Generic trailing-edge debounce.
function debounce(fn, ms) {
    let timer = null;
    return (...args) => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { timer = null; fn(...args); }, ms);
    };
}

// Debounced editor->main sync. Editor 'change' fires on every keystroke; pushing
// IPC + recomputing context each time caused typing lag, so coalesce them.
// Main treats uiState.editorCode as the source of truth for tool reads, so the
// debounce window is the staleness floor the agent can ever see.
const scheduleEditorSync = debounce(() => {
    if (!state.editor) return;
    window.electronAPI.ui.updateEditorCode(state.editor.getValue());
    updateAIContext();
}, 100);

// Mark the active tab dirty on a real user edit. Programmatic setValue (tab
// switch, AI edits, session restore) uses origin 'setValue' and must NOT mark
// dirty — otherwise a freshly-loaded/blank editor could be autosaved over the
// real file on disk (the "open file wiped clean" bug).
function markActiveTabDirty() {
    if (state.activeTabIndex >= 0 && state.openFiles[state.activeTabIndex]) {
        state.openFiles[state.activeTabIndex].dirty = true;
    }
}

function initializeCodeMirror() {
    const CodeMirror = getCodeMirror();
    if (!CodeMirror) return;

    const textarea = document.getElementById('codeEditor');
    if (!textarea) return;

    registerArduinoHint(CodeMirror);

    state.editor = CodeMirror.fromTextArea(textarea, {
        mode: 'text/x-arduino',
        theme: 'default',
        lineNumbers: true,
        indentUnit: 2,
        tabSize: 2,
        indentWithTabs: false,
        autoCloseBrackets: true,
        matchBrackets: true,
        lineWrapping: true,
        styleActiveLine: true,
        extraKeys: { "Ctrl-Space": "autocomplete" },
        hintOptions: { hint: CodeMirror.hint.arduino },
        // The search and go-to-line bars' words, in the app's voice.
        phrases: {
            'Jump to line:': 'Go to line',
            '(Use line:column or scroll% syntax)': 'A line, or line:column',
            'Search:': 'Find',
            '(Use /re/ syntax for regexp search)': 'Text, or /pattern/ for a regular expression',
            'Replace:': 'Replace',
            'Replace all:': 'Replace all',
            'With:': 'With',
            'Replace?': 'Replace this one?',
        }
    });
    // CodeMirror types into a hidden textarea; give it a name for screen readers.
    state.editor.getInputField().setAttribute('aria-label', 'Code editor');

    state.editor.on('change', (cm, changeObj) => {
        // Only user edits (not programmatic setValue) mark the tab dirty.
        if (changeObj && changeObj.origin && changeObj.origin !== 'setValue') {
            markActiveTabDirty();
        }
        scheduleEditorSync();
    });

    // Initially show welcome state, hide editor
    showWelcomeState();
}

// Show/hide welcome state vs editor
function showWelcomeState() {
    const welcomeState = document.getElementById('welcomeState');
    const editorWrapper = document.getElementById('editorWrapper');

    if (welcomeState) welcomeState.style.display = 'flex';
    if (editorWrapper) editorWrapper.style.display = 'none';

    state.openFiles = [];
    state.activeTabIndex = -1;
    state.currentFile = null;
    state.currentSketch = null;
    announceSketch();
    renderFileTabs();
}

function showEditor() {
    const welcomeState = document.getElementById('welcomeState');
    const editorWrapper = document.getElementById('editorWrapper');

    if (welcomeState) welcomeState.style.display = 'none';
    if (editorWrapper) editorWrapper.style.display = 'block';

    // Refresh CodeMirror to fix any display issues
    if (state.editor) {
        setTimeout(() => state.editor.refresh(), 10);
    }
}

// ============================================
// Event Listeners Setup
// ============================================
function setupEventListeners() {
    // Open folder (sidebar button + welcome-screen button)
    document.getElementById('openFolder')?.addEventListener('click', openFolder);
    document.getElementById('welcomeOpenFolder')?.addEventListener('click', openFolder);

    // Refresh ports (sidebar only, toolbar removed)
    document.getElementById('refreshPortsSidebar')?.addEventListener('click', loadPorts);

    setupBoardManagerPanel();
    setupExamplesDropdown();
    setupDebugPanel();
    setupSearchPanel();

    // Compile and Upload
    document.getElementById('compileBtn')?.addEventListener('click', compileSketch);
    document.getElementById('uploadBtn')?.addEventListener('click', uploadSketch);

    // Board/Port Selector
    setupBoardPortSelector();

    // Serial monitor
    document.getElementById('toggleSerial')?.addEventListener('click', toggleSerial);
    document.getElementById('sendSerial')?.addEventListener('click', sendSerialData);
    document.getElementById('serialInput')?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') sendSerialData();
    });

    // Baud rate change handler (shared for both sidebar and serial monitor dropdowns)
    async function handleBaudRateChange(baudRate) {
        state.context.currentBaudRate = baudRate;
        window.electronAPI.ui.updateBaudRate(baudRate);
        updateAIContext();

        // Sync both dropdowns
        const sidebarBaud = document.getElementById('baudRate');
        const serialBaud = document.getElementById('serialBaudRate');
        if (sidebarBaud) sidebarBaud.value = baudRate.toString();
        if (serialBaud) serialBaud.value = baudRate.toString();

        // If serial is connected, reconnect with new baud rate
        if (state.serialConnected) {
            const port = document.getElementById('portSelectSidebar')?.value;
            if (port) {
                logToConsole(`Changing baud rate to ${baudRate}...`, 'info');
                await window.electronAPI.serial.disconnect();
                // Small delay to ensure port is released
                await new Promise(resolve => setTimeout(resolve, 200));
                await window.electronAPI.serial.connect(port, baudRate);
            }
        }
    }

    // Sidebar baud rate dropdown
    document.getElementById('baudRate')?.addEventListener('change', async (e) => {
        const baudRate = parseInt(e.target.value);
        await handleBaudRateChange(baudRate);
    });

    // Serial monitor toolbar baud rate dropdown
    document.getElementById('serialBaudRate')?.addEventListener('change', async (e) => {
        const baudRate = parseInt(e.target.value);
        await handleBaudRateChange(baudRate);
    });

    // Serial monitor clear button
    document.getElementById('serialClearBtn')?.addEventListener('click', () => {
        const contentArea = document.querySelector('#serialOutput .serial-output-content');
        if (contentArea) {
            contentArea.innerHTML = '';
        }
    });

    // Library Manager
    document.getElementById('libSearchBtn')?.addEventListener('click', () => libSearch());
    document.getElementById('libSearchInput')?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') libSearch();
    });
    document.getElementById('libUpdateIndex')?.addEventListener('click', libUpdateIndex);
}

// ============================================
// Serial Monitor Listeners
// ============================================

// Lines arrive whole and batched from the main process (serialMonitor.js
// assembles them), so the pane keeps up with a fast sketch and loses nothing
// while another view is on screen.
let serialAtBottom = true;
const SERIAL_MAX_LINES = 5000;

/** The scrollable area of the Serial Monitor pane, made on first use. */
function serialContentArea() {
    const outputEl = document.getElementById('serialOutput');
    if (!outputEl) return null;
    let area = outputEl.querySelector('.serial-output-content');
    if (!area) {
        area = document.createElement('div');
        area.className = 'serial-output-content';
        area.tabIndex = 0;
        outputEl.appendChild(area);
        area.addEventListener('scroll', () => {
            serialAtBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 24;
        });
    }
    return area;
}

const SERIAL_PREFIX = { tx: '[TX]', error: '[ERR]', info: '[INFO]', rx: '[RX]' };

/**
 * Render a batch of lines in one go: one fragment, one trim and one scroll,
 * so a sketch printing at 115200 cannot make the window fall behind.
 * @param {{ at?: string, text: string, kind?: 'rx'|'tx'|'info'|'error' }[]} lines
 */
function renderSerialLines(lines) {
    if (!lines?.length) return;
    const area = serialContentArea();
    if (!area) return;
    const fragment = document.createDocumentFragment();
    for (const entry of lines) {
        const kind = entry.kind || 'rx';
        const time = new Date(entry.at || Date.now()).toLocaleTimeString();
        const row = document.createElement('div');
        row.className = `serial-line ${kind === 'rx' ? '' : kind === 'tx' ? 'sent' : kind}`.trim();
        row.textContent = `[${time}] ${SERIAL_PREFIX[kind] || SERIAL_PREFIX.rx} ${entry.text}`;
        fragment.appendChild(row);
        if (kind === 'rx') feedPlotterData(entry.text);
    }
    area.appendChild(fragment);
    while (area.childElementCount > SERIAL_MAX_LINES) area.firstElementChild.remove();
    if (serialAtBottom) area.scrollTop = area.scrollHeight;
}

/** Everything chat mode's serial pane listens to goes through one event. */
function publishSerialLines(lines) {
    if (!lines?.length) return;
    window.dispatchEvent(new CustomEvent('impulse:serial-lines', { detail: lines }));
}

function setupSerialListeners() {
    // Whole lines, batched by the main process.
    window.electronAPI.serial.onLines((batch) => {
        renderSerialLines(batch);
        publishSerialLines(batch);
    });
    window.electronAPI.serial.onCleared(() => {
        serialContentArea()?.replaceChildren();
        window.dispatchEvent(new CustomEvent('impulse:serial-cleared'));
    });
    // What the board printed before this window was ready (or while another view had the pane).
    window.electronAPI.serial.history(500).then((res) => {
        if (res?.success && res.data?.length) {
            renderSerialLines(res.data);
            publishSerialLines(res.data);
        }
    }).catch(() => {});

    window.electronAPI.serial.onError((error) => {
        appendSerialOutput(`Error: ${error}`, new Date().toISOString(), 'error');
        logToConsole(`Serial Error: ${error}`, 'error');
    });

    window.electronAPI.serial.onConnected(() => {
        state.serialConnected = true;
        state.context.serialConnected = true;
        serialAtBottom = true;
        updateSerialUI(true);
        updateAIContext();
        appendSerialOutput('Connected to serial port', new Date().toISOString(), 'info');
        logToConsole('Serial port connected', 'success');
    });

    window.electronAPI.serial.onDisconnected(() => {
        state.serialConnected = false;
        state.context.serialConnected = false;
        updateSerialUI(false);
        updateAIContext();
        appendSerialOutput('Disconnected from serial port', new Date().toISOString(), 'info');
        logToConsole('Serial port disconnected', 'info');
    });
}

// ============================================
// AI Panel Listeners
// ============================================
function setupAIListeners() {
    document.getElementById('aiModeSelect')?.addEventListener('change', (e) => {
        state.aiMode = e.target.value;
        saveAIPreferences();
    });
    document.getElementById('aiCompactBtn')?.addEventListener('click', compactConversation);
    // The welcome (starters) as it is before the first message, for New chat.
    state.aiWelcomeHtml = state.aiWelcomeHtml || document.querySelector('#aiMessages .ai-welcome')?.outerHTML || '';
    document.getElementById('aiNewChatBtn')?.addEventListener('click', newChat);
    document.getElementById('aiStopBtn')?.addEventListener('click', stopAIMessage);
    document.getElementById('aiPanel')?.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && chatOrb?.busy()) {
            e.preventDefault();
            stopAIMessage();
        }
    });
    document.getElementById('aiSend')?.addEventListener('click', sendAIMessage);
    document.getElementById('aiInput')?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            sendAIMessage();
        }
    });
}

// ============================================
// UI State Sync
// ============================================
function setupUIStateSync() {
    window.electronAPI.ui.onSetEditorCode((code) => {
        if (state.editor) {
            state.editor.setValue(code);
        }
    });

    window.electronAPI.ui.onSetBaudRate((baudRate) => {
        const sidebarBaud = document.getElementById('baudRate');
        const serialBaud = document.getElementById('serialBaudRate');
        if (sidebarBaud) sidebarBaud.value = baudRate.toString();
        if (serialBaud) serialBaud.value = baudRate.toString();
    });
}

// ============================================
// Output Tabs
// ============================================
function setupOutputTabs() {
    const tabs = document.querySelectorAll('.output-tab');
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const tabName = tab.dataset.tab;

            tabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');

            document.querySelectorAll('.output-content').forEach(c => c.classList.remove('active'));
            const content = document.getElementById(`${tabName}Output`);
            if (content) content.classList.add('active');

            // Show serial input for serial and plotter tabs
            const serialInputRow = document.getElementById('serialInputRow');
            if (serialInputRow) {
                serialInputRow.style.display = (tabName === 'serial' || tabName === 'plotter') ? 'flex' : 'none';
            }

            // Start/stop plotter rendering
            if (tabName === 'plotter') {
                startPlotterRendering();
            } else {
                stopPlotterRendering();
            }
        });
    });
}

// ============================================
// Arduino CLI Functions
// ============================================
async function checkArduinoCLI() {
    const statusEl = document.getElementById('cliStatus');
    if (statusEl) statusEl.textContent = 'Checking CLI...';

    try {
        const result = await window.electronAPI.arduino.checkCLI();
        if (result.success && result.installed) {
            state.cliInstalled = true;
            if (statusEl) {
                statusEl.innerHTML = '<span style="color: var(--accent-green);">●</span> Arduino CLI Ready';
                statusEl.className = 'cli-status success';
            }
            logToConsole('Arduino CLI detected and ready', 'success');
        } else {
            state.cliInstalled = false;
            if (statusEl) {
                statusEl.innerHTML = '<span style="color: var(--accent-red);">●</span> CLI Not Found';
                statusEl.className = 'cli-status error';
            }
            logToConsole('Arduino CLI not found. Please install arduino-cli', 'error');
        }
    } catch (error) {
        state.cliInstalled = false;
        if (statusEl) {
            statusEl.innerHTML = '<span style="color: var(--accent-red);">●</span> CLI Error';
            statusEl.className = 'cli-status error';
        }
        logToConsole(`CLI check error: ${error.message}`, 'error');
    }
}

async function loadBoards() {
    // Only load into sidebar (board/port removed from top toolbar)
    const selects = [
        document.getElementById('boardSelectSidebar')
    ].filter(Boolean);

    selects.forEach(select => {
        select.innerHTML = '<option value="">Loading boards...</option>';
    });

    try {
        const result = await window.electronAPI.arduino.listBoards();
        if (result.success && result.data) {
            state.boards = result.data;
            const options = '<option value="">Select Board...</option>' +
                result.data.map(board =>
                    `<option value="${escapeHtml(board.fqbn)}">${escapeHtml(board.name)}</option>`
                ).join('');

            selects.forEach(select => {
                select.innerHTML = options;
            });
            logToConsole(`Loaded ${result.data.length} boards`, 'info');

            // Update board/port display if selection exists
            if (state.selectedBoard) {
                const selectedBoard = result.data.find(b => b.fqbn === state.selectedBoard);
                if (selectedBoard) {
                    updateBoardPortDisplay(selectedBoard.name, state.selectedPort);
                }
            }
        } else {
            selects.forEach(select => {
                select.innerHTML = '<option value="">Error loading boards</option>';
            });
            logToConsole(`Failed to load boards: ${result.error || 'Unknown error'}`, 'error');
        }
    } catch (error) {
        selects.forEach(select => {
            select.innerHTML = '<option value="">Error loading boards</option>';
        });
        logToConsole(`Error loading boards: ${error.message}`, 'error');
    }
}

async function loadPorts() {
    // Only load into sidebar (board/port removed from top toolbar)
    const selects = [
        document.getElementById('portSelectSidebar')
    ].filter(Boolean);

    selects.forEach(select => {
        select.innerHTML = '<option value="">Scanning ports...</option>';
    });

    try {
        const result = await window.electronAPI.arduino.listPorts();
        if (result.success && result.data) {
            state.ports = result.data;

            let options;
            if (result.data.length === 0) {
                options = '<option value="">No ports found</option>';
                logToConsole('No serial ports detected', 'warning');
            } else {
                options = '<option value="">Choose a port…</option>' +
                    sortPorts(result.data).map(port =>
                        `<option value="${escapeHtml(port.port)}">${escapeHtml(port.port)} - ${escapeHtml(describePort(port))}</option>`
                    ).join('');
                logToConsole(`Found ${result.data.length} port(s)`, 'info');
            }

            selects.forEach(select => {
                select.innerHTML = options;
            });

            // Update board/port display if selection exists
            if (state.selectedBoard && state.selectedPort) {
                const selectedBoard = state.boards.find(b => b.fqbn === state.selectedBoard);
                if (selectedBoard) {
                    updateBoardPortDisplay(selectedBoard.name, state.selectedPort);
                }
            }
        } else {
            selects.forEach(select => {
                select.innerHTML = '<option value="">Error loading ports</option>';
            });
            logToConsole(`Failed to load ports: ${result.error || 'Unknown error'}`, 'error');
        }
    } catch (error) {
        selects.forEach(select => {
            select.innerHTML = '<option value="">Error loading ports</option>';
        });
        logToConsole(`Error loading ports: ${error.message}`, 'error');
    }
}

// Live port detection: poll for plugged/unplugged devices so a USB cable
// inserted after launch is picked up without restarting the IDE.
let _lastPortsSignature = null;

async function refreshPortsQuiet() {
    // Don't disrupt an active serial session or an in-progress selection.
    if (state.serialConnected) return;
    const sel = document.getElementById('portSelectSidebar');
    if (sel && document.activeElement === sel) return;

    let result;
    try {
        result = await window.electronAPI.arduino.listPorts();
    } catch (_) { return; }
    if (!result || !result.success || !Array.isArray(result.data)) return;

    const ports = result.data;
    const sig = ports.map(p => p.port).sort().join('|');
    if (sig === _lastPortsSignature) return; // no change
    // The first successful poll is the baseline: sync the list without
    // announcing ports that were already plugged in at launch.
    const isBaseline = _lastPortsSignature === null;

    const added = isBaseline ? [] : ports.filter(p => !state.ports.some(o => o.port === p.port));
    const removed = isBaseline ? [] : state.ports.filter(o => !ports.some(p => p.port === o.port));
    _lastPortsSignature = sig;
    state.ports = ports;

    if (sel) {
        const current = sel.value;
        sel.innerHTML = ports.length === 0
            ? '<option value="">No ports found</option>'
            : '<option value="">Choose a port…</option>' + sortPorts(ports).map(p =>
                `<option value="${escapeHtml(p.port)}">${escapeHtml(p.port)} - ${escapeHtml(describePort(p))}</option>`
            ).join('');
        if (current && ports.some(p => p.port === current)) {
            sel.value = current; // keep the user's selection
        } else if (current) {
            // The selected port was unplugged.
            state.selectedPort = '';
            state.context.selectedPort = '';
        }
    }

    added.forEach(p => logToConsole(`Detected new port: ${p.port}${p.board ? ` (${p.board})` : ''}`, 'success'));
    removed.forEach(p => logToConsole(`Port removed: ${p.port}`, 'warning'));
    window.dispatchEvent(new CustomEvent('impulse:board-display'));
    window.dispatchEvent(new CustomEvent('impulse:serial-state'));

    const pick = pickDetectedBoard({
        ports, added, isBaseline,
        selectedBoard: state.selectedBoard, selectedPort: state.selectedPort,
        installed: (fqbn) => state.boards.some(b => b.fqbn === fqbn),
    });
    if (pick) applyDetectedBoard(pick);
}

/** Select a connected board (and its port) as if it had been picked from the menus. */
function applyDetectedBoard(pick) {
    const boardSel = document.getElementById('boardSelectSidebar');
    const portSel = document.getElementById('portSelectSidebar');
    if (pick.fqbn && !pick.keepBoard) {
        state.selectedBoard = pick.fqbn;
        state.context.selectedBoard = pick.fqbn;
        if (boardSel) boardSel.value = pick.fqbn;
        announceBoard();
    }
    state.selectedPort = pick.port;
    state.context.selectedPort = pick.port;
    if (portSel) portSel.value = pick.port;
    window.electronAPI.ui.updatePort(pick.port);
    syncBoardFqbn();
    const board = state.boards.find(b => b.fqbn === state.selectedBoard);
    updateBoardPortDisplay(board?.name || null, pick.port);
    updateAIContext();
    saveSession();
    loadSavedBoardPortOptions();
    if (!pick.fqbn) {
        const names = pick.choices.slice(0, 3).map(b => b.name).join(', ') + (pick.choices.length > 3 ? '…' : '');
        logToConsole(`A board on ${pick.port} could be ${names}. Choose which in the board menu.`, 'warning');
        window.notifications?.info?.(`Board connected on ${pick.port}. Choose which board it is in the board menu.`);
        return;
    }
    const sim = boardForFqbn(pick.fqbn) ? ' The simulator follows it.' : '';
    const msg = pick.keepBoard
        ? `${pick.name} found on ${pick.port}: port selected.`
        : `${pick.name} ${pick.reason === 'plugged-in' ? 'plugged in' : 'connected'} on ${pick.port}: selected for upload.${sim}`;
    logToConsole(msg, 'success');
    window.notifications?.info?.(msg);
}

function startPortAutoRefresh() {
    setInterval(refreshPortsQuiet, 3000);
}

// ============================================
// Board Manager (install/uninstall cores)
// ============================================
function setupBoardManagerPanel() {
    const searchInput = document.getElementById('coreSearchInput');
    const searchBtn = document.getElementById('coreSearchBtn');

    if (searchBtn) searchBtn.addEventListener('click', runCoreSearch);
    if (searchInput) searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') runCoreSearch(); });
}

async function loadInstalledCores() {
    const el = document.getElementById('coreInstalledList');
    if (!el) return;
    el.innerHTML = '<div class="lib-msg">Loading...</div>';
    try {
        const result = await window.electronAPI.arduino.coreList();
        const list = result.success && result.data ? result.data : [];
        if (list.length === 0) {
            el.innerHTML = '<div class="lib-msg">No cores installed. Search above to install (e.g. esp32, arduino:avr).</div>';
            return;
        }
        el.innerHTML = list.map(item => {
            const id = item.id || item.platform?.id || item.name || '';
            const name = item.name || item.platform?.name || id;
            const ver = item.installed || item.version || '';
            return `<div class="core-item installed">
                <span class="core-name">${escapeHtml(name)}</span>
                <span class="core-version">${escapeHtml(ver)}</span>
                <button type="button" class="btn-small core-uninstall-btn" data-core-id="${escapeHtml(id)}">Uninstall</button>
            </div>`;
        }).join('');
        el.querySelectorAll('.core-uninstall-btn').forEach(btn => {
            btn.addEventListener('click', () => coreUninstallClick(btn.dataset.coreId));
        });
    } catch (e) {
        el.innerHTML = `<div class="lib-msg error">${escapeHtml(e.message)}</div>`;
    }
}

async function runCoreSearch() {
    const input = document.getElementById('coreSearchInput');
    const el = document.getElementById('coreSearchResults');
    if (!el) return;
    const keyword = (input?.value || '').trim() || 'arduino';
    el.innerHTML = '<div class="lib-msg">Searching...</div>';
    try {
        const result = await window.electronAPI.arduino.coreSearch(keyword);
        const list = result.success && result.data ? result.data : [];
        if (list.length === 0) {
            el.innerHTML = '<div class="lib-msg">No results. Try "esp32", "samd", or "arduino".</div>';
            return;
        }
        el.innerHTML = list.slice(0, 30).map(item => {
            const id = item.id || item.platform?.id || item.name || '';
            const name = item.name || item.platform?.name || id;
            const latest = item.latest || item.version || '';
            return `<div class="core-item">
                <span class="core-name">${escapeHtml(name)}</span>
                <span class="core-version">${escapeHtml(latest)}</span>
                <button type="button" class="btn-small core-install-btn" data-core-id="${escapeHtml(id)}">Install</button>
            </div>`;
        }).join('');
        el.querySelectorAll('.core-install-btn').forEach(btn => {
            btn.addEventListener('click', () => coreInstallClick(btn.dataset.coreId));
        });
    } catch (e) {
        el.innerHTML = `<div class="lib-msg error">${escapeHtml(e.message)}</div>`;
    }
}

async function coreInstallClick(coreId) {
    if (!coreId) return;
    logToConsole(`Installing core: ${coreId}...`, 'info');
    const resultsEl = document.getElementById('coreSearchResults');
    if (resultsEl) resultsEl.innerHTML = '<div class="lib-msg">Installing... (may take a minute)</div>';
    try {
        const result = await window.electronAPI.arduino.coreInstall(coreId);
        if (result.success) {
            logToConsole(`Installed: ${coreId}`, 'success');
            await loadBoards();
            loadInstalledCores();
            runCoreSearch();
        } else {
            logToConsole(result.error || 'Install failed', 'error');
            if (resultsEl) resultsEl.innerHTML = `<div class="lib-msg error">${escapeHtml(result.error)}</div>`;
        }
    } catch (e) {
        logToConsole(e.message || 'Install failed', 'error');
        if (resultsEl) resultsEl.innerHTML = `<div class="lib-msg error">${escapeHtml(e.message)}</div>`;
    }
}

async function coreUninstallClick(coreId) {
    if (!coreId) return;
    if (!await confirmDialog('Uninstall core', `Remove "${coreId}" and its boards from this computer?`, { confirmLabel: 'Uninstall', danger: true })) return;
    logToConsole(`Uninstalling: ${coreId}...`, 'info');
    try {
        const result = await window.electronAPI.arduino.coreUninstall(coreId);
        if (result.success) {
            logToConsole(`Uninstalled: ${coreId}`, 'success');
            await loadBoards();
            loadInstalledCores();
        } else {
            logToConsole(result.error || 'Uninstall failed', 'error');
        }
    } catch (e) {
        logToConsole(e.message || 'Uninstall failed', 'error');
    }
}

// ============================================
// Examples (from installed libraries)
// ============================================
function setupExamplesDropdown() {
    const dropdown = document.getElementById('examplesDropdown');
    const closeBtn = document.getElementById('examplesDropdownClose');
    const loadBtn = document.getElementById('examplesDropdownLoad');
    const listEl = document.getElementById('examplesDropdownList');
    const filterInput = document.getElementById('examplesDropdownFilter');

    closeBtn?.addEventListener('click', hideExamplesDropdown);
    loadBtn?.addEventListener('click', () => loadExamplesIntoDropdown(listEl, filterInput?.value?.trim()).catch(() => { }));
    filterInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') loadExamplesIntoDropdown(listEl, filterInput.value.trim()).catch(() => { });
    });
    dropdown?.addEventListener('click', (e) => {
        if (e.target === dropdown) hideExamplesDropdown();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && dropdown?.getAttribute('aria-hidden') !== 'true') hideExamplesDropdown();
    });
}

function showExamplesDropdown() {
    const dropdown = document.getElementById('examplesDropdown');
    if (!dropdown) return;
    dropdown.setAttribute('aria-hidden', 'false');
    dropdown.classList.add('open');
    const listEl = document.getElementById('examplesDropdownList');
    listEl.innerHTML = '<div class="lib-msg">Click "Load examples" to list examples from installed libraries.</div>';
}

function hideExamplesDropdown() {
    const dropdown = document.getElementById('examplesDropdown');
    if (!dropdown) return;
    dropdown.setAttribute('aria-hidden', 'true');
    dropdown.classList.remove('open');
}

async function loadExamplesIntoDropdown(listEl, filter = '') {
    if (!listEl) return;
    listEl.innerHTML = '<div class="lib-msg">Loading examples...</div>';
    try {
        const result = await window.electronAPI.arduino.libExamplesWithPaths(filter || '');
        const examples = result.success && result.data ? result.data : [];
        if (examples.length === 0) {
            listEl.innerHTML = '<div class="lib-msg">No examples found. Install libraries from the library manager, then load again.</div>';
            return;
        }
        listEl.innerHTML = examples.map(ex => {
            const label = ex.library ? `${escapeHtml(ex.library)} → ${escapeHtml(ex.name)}` : escapeHtml(ex.name);
            return `<div class="example-item" data-path="${escapeHtml(ex.path)}" title="${escapeHtml(ex.path)}">
                <span class="example-label">${label}</span>
            </div>`;
        }).join('');
        listEl.querySelectorAll('.example-item').forEach(row => {
            row.addEventListener('click', () => {
                openExampleAtPath(row.dataset.path);
                hideExamplesDropdown();
            });
        });
    } catch (e) {
        listEl.innerHTML = `<div class="lib-msg error">${escapeHtml(e.message)}</div>`;
    }
}

function setupDebugPanel() {
    document.getElementById('debugStartBtn')?.addEventListener('click', () => {
        window.impulse.showSimulator();
        window.simManager?.debugStart();
    });
}

/** The sidebar Debug panel: the board the debugger runs on, and the breakpoints. */
function updateDebugPanel() {
    const labelEl = document.getElementById('debugBoardLabel');
    const board = window.simManager?.board;
    if (labelEl && board) {
        labelEl.textContent = board.family === 'rp2040'
            ? `${board.short}: the debugger runs AVR boards`
            : `Simulated ${board.label}`;
    }
    const listEl = document.getElementById('debugBreakpoints');
    const bps = window.impulse?.breakpoints;
    if (!listEl || !bps) return;
    listEl.innerHTML = '';
    const entries = [...bps.all()].flatMap(([file, lines]) => lines.map(line => ({ file, line })));
    if (!entries.length) {
        listEl.innerHTML = '<div class="lib-msg">No breakpoints yet.</div>';
        return;
    }
    for (const { file, line } of entries) {
        const row = document.createElement('div');
        row.className = 'debug-bp-row';
        row.setAttribute('role', 'listitem');
        const open = document.createElement('button');
        open.type = 'button';
        open.className = 'debug-bp-open';
        open.textContent = `${file.split(/[/\\]/).pop()}:${line}`;
        open.title = file;
        open.addEventListener('click', () => window.impulse.revealLine(file, line));
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'debug-bp-remove';
        remove.setAttribute('aria-label', `Remove breakpoint at line ${line}`);
        remove.textContent = '×';
        remove.addEventListener('click', () => bps.remove(file, line));
        row.append(open, remove);
        listEl.appendChild(row);
    }
}

function setupSearchPanel() {
    const input = document.getElementById('searchInput');
    const btn = document.getElementById('searchBtn');
    const resultsEl = document.getElementById('searchResults');
    btn?.addEventListener('click', () => runSearchInSketch(input?.value, resultsEl));
    input?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') runSearchInSketch(input.value, resultsEl);
    });
}

function runSearchInSketch(query, resultsEl) {
    if (!state.editor || !query || !resultsEl) return;
    const code = state.editor.getValue();
    const lines = code.split('\n');
    const q = query.trim().toLowerCase();
    const hits = [];
    lines.forEach((line, i) => {
        if (line.toLowerCase().includes(q)) hits.push({ line: i + 1, text: line.trim() });
    });
    if (hits.length === 0) {
        resultsEl.innerHTML = '<div class="lib-msg">No matches.</div>';
        return;
    }
    resultsEl.innerHTML = hits.slice(0, 50).map(h =>
        `<div class="search-result-item" data-line="${h.line}"><span class="search-result-line">${h.line}</span> ${escapeHtml(h.text.slice(0, 80))}${h.text.length > 80 ? '…' : ''}</div>`
    ).join('');
    resultsEl.querySelectorAll('.search-result-item').forEach(row => {
        row.addEventListener('click', () => {
            const line = parseInt(row.dataset.line, 10);
            if (state.editor && !isNaN(line)) state.editor.setCursor(line - 1, 0);
        });
    });
}

async function openExampleAtPath(exampleFolderPath) {
    if (!exampleFolderPath) return;
    try {
        const res = await window.electronAPI.folder.list(exampleFolderPath);
        if (!res.success || !res.entries || res.entries.length === 0) {
            logToConsole('Example folder empty or not readable', 'error');
            return;
        }
        const inoFile = res.entries.find(e => !e.isDirectory && e.name.toLowerCase().endsWith('.ino'));
        if (!inoFile) {
            logToConsole('No .ino file found in example', 'error');
            return;
        }
        state.folderRoot = exampleFolderPath;
        state.expandedDirs.clear();
        const label = document.getElementById('folderLabel');
        const name = exampleFolderPath.split(/[/\\]/).pop() || 'Example';
        if (label) label.innerHTML = `<span class="folder-icon">${ICONS.folder}</span><span>${escapeHtml(name)}</span>`;
        await renderFileTree(exampleFolderPath);
        const fileResult = await window.electronAPI.file.read(inoFile.path);
        const content = fileResult.success ? fileResult.content : '';
        showEditor();
        addOrFocusFile(inoFile.path, content, inoFile.name);
        switchToTab(state.openFiles.length - 1);
        saveSession();
        logToConsole(`Opened example: ${inoFile.name}`, 'success');
    } catch (e) {
        logToConsole(`Failed to open example: ${e.message}`, 'error');
    }
}

function escapeHtml(s) {
    if (s == null) return '';
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
}

const svgIcon = (body) => `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICONS = {
    folder: svgIcon('<path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/>'),
    sketch: svgIcon('<path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z"/><path d="M14 3v5h5"/><path d="M10 13l-2 2 2 2M14 13l2 2-2 2"/>'),
    file: svgIcon('<path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z"/><path d="M14 3v5h5"/>'),
    chevron: svgIcon('<path d="M9 6l6 6-6 6"/>'),
    chip: svgIcon('<rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9" y="9" width="6" height="6" rx="1"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>'),
};

function fileIcon(name, isDirectory = false) {
    if (isDirectory) return ICONS.folder;
    return /\.(ino|cpp|c|h|hpp)$/i.test(name) ? ICONS.sketch : ICONS.file;
}

// ============================================
// File Explorer Functions
// ============================================
async function openFolder() {
    try {
        const result = await window.electronAPI.dialog.openFolder();
        if (result.success && result.folderPath) await loadFolder(result.folderPath);
    } catch (error) {
        logToConsole(`Error opening folder: ${error.message}`, 'error');
    }
}

async function loadFolder(folderPath) {
    const res = await window.electronAPI.folder.list(folderPath);
    if (!res?.success) {
        logToConsole(res?.error || `Could not open ${folderPath}`, 'error');
        return false;
    }
    state.folderRoot = folderPath;
    state.expandedDirs.clear();
    const label = document.getElementById('folderLabel');
    const name = folderPath.split(/[/\\]/).pop() || folderPath;
    if (label) label.innerHTML = `<span class="folder-icon">${ICONS.folder}</span><span>${escapeHtml(name)}</span>`;
    if (state.sidebarCollapsed) toggleSidebar();
    switchPanel('explorer');
    await renderFileTree(folderPath);
    saveSession();
    logToConsole(`Opened folder: ${name}`, 'success');
    return true;
}

async function renderFileTree(dirPath) {
    const container = document.getElementById('fileTree');
    if (!container) return;

    const res = await window.electronAPI.folder.list(dirPath);
    if (!res.success) {
        container.innerHTML = `<div class="lib-msg">${escapeHtml(res.error || 'Failed to list')}</div>`;
        return;
    }

    container.innerHTML = '';

    for (const e of (res.entries || [])) {
        const row = document.createElement('div');
        row.className = 'tree-item' + (e.isDirectory ? ' tree-dir' : ' tree-file');
        row.dataset.path = e.path;
        row.dataset.isDir = e.isDirectory;

        const icon = fileIcon(e.name, e.isDirectory);
        const chev = e.isDirectory ? `<span class="tree-chevron">${ICONS.chevron}</span>` : '<span class="tree-spacer"></span>';
        row.innerHTML = `${chev}<span class="tree-icon">${icon}</span><span class="tree-name">${escapeHtml(e.name)}</span>`;

        if (e.isDirectory) {
            row.addEventListener('click', () => toggleTreeDir(e.path, row));
        } else {
            row.addEventListener('click', (ev) => {
                ev.stopPropagation();
                openFileFromTree(e.path);
            });
        }
        container.appendChild(row);
    }
}

function toggleTreeDir(dirPath, rowEl) {
    const was = state.expandedDirs.has(dirPath);

    if (was) {
        state.expandedDirs.delete(dirPath);
        const child = rowEl.nextElementSibling;
        if (child?.classList.contains('tree-children')) child.remove();
        rowEl.querySelector('.tree-chevron').classList.remove('open');
    } else {
        state.expandedDirs.add(dirPath);
        rowEl.querySelector('.tree-chevron').classList.add('open');

        const wrap = document.createElement('div');
        wrap.className = 'tree-children';
        rowEl.after(wrap);

        (async () => {
            const res = await window.electronAPI.folder.list(dirPath);
            wrap.innerHTML = '';

            if (res.success && res.entries) {
                for (const e of res.entries) {
                    const sub = document.createElement('div');
                    sub.className = 'tree-item' + (e.isDirectory ? ' tree-dir' : ' tree-file');
                    sub.dataset.path = e.path;

                    const icon = fileIcon(e.name, e.isDirectory);
                    const chev = e.isDirectory ? `<span class="tree-chevron">${ICONS.chevron}</span>` : '<span class="tree-spacer"></span>';
                    sub.innerHTML = `${chev}<span class="tree-icon">${icon}</span><span class="tree-name">${escapeHtml(e.name)}</span>`;

                    if (e.isDirectory) {
                        sub.addEventListener('click', (ev) => {
                            ev.stopPropagation();
                            toggleTreeDir(e.path, sub);
                        });
                    } else {
                        sub.addEventListener('click', (ev) => {
                            ev.stopPropagation();
                            openFileFromTree(e.path);
                        });
                    }
                    wrap.appendChild(sub);
                }
            }
        })();
    }
}

// ============================================
// Multi-file tab helpers
// ============================================
function renderFileTabs() {
    const container = document.getElementById('fileTabs');
    if (!container) return;

    container.innerHTML = '';

    state.openFiles.forEach((file, index) => {
        const tab = document.createElement('div');
        const active = index === state.activeTabIndex;
        tab.className = 'tab' + (active ? ' active' : '');
        tab.dataset.tabIndex = String(index);
        // A real tab for assistive tech; the × is mouse-only (Cmd/Ctrl+W closes from the keyboard).
        tab.setAttribute('role', 'tab');
        tab.setAttribute('aria-selected', active ? 'true' : 'false');
        tab.setAttribute('aria-label', file.name);
        tab.tabIndex = active ? 0 : -1;

        tab.innerHTML = `
            <span class="tab-icon" aria-hidden="true">${fileIcon(file.name)}</span>
            <span class="tab-name">${escapeHtml(file.name)}</span>
            <span class="tab-close" data-tab-index="${index}" title="Close (Cmd/Ctrl+W)" aria-hidden="true">×</span>
        `;
        tab.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); switchToTab(index); }
        });

        tab.addEventListener('click', (e) => {
            if (e.target.classList.contains('tab-close')) {
                e.stopPropagation();
                closeTab(parseInt(e.target.dataset.tabIndex, 10));
                return;
            }
            switchToTab(index);
        });

        container.appendChild(tab);
    });
}

function addOrFocusFile(filePath, content, name) {
    // Save current tab content before switching
    if (state.editor && state.activeTabIndex >= 0 && state.openFiles[state.activeTabIndex]) {
        state.openFiles[state.activeTabIndex].content = state.editor.getValue();
    }

    const existing = state.openFiles.findIndex(f => f.path === filePath);
    if (existing >= 0) {
        // Already open: just focus it. Keep the in-memory content so unsaved
        // edits aren't clobbered by a fresh disk read.
        state.activeTabIndex = existing;
        renderFileTabs();
        return;
    }

    state.openFiles.push({ path: filePath, content, name });
    // Use switchToTab so the editor actually loads the new file's content.
    // (Simply setting activeTabIndex + renderFileTabs left the old content in
    // the editor, making the new file appear to show the previous file's code.)
    switchToTab(state.openFiles.length - 1);
}

function switchToTab(index) {
    if (index < 0 || index >= state.openFiles.length) return;

    // Save current tab content to state
    if (state.editor && state.activeTabIndex >= 0 && state.openFiles[state.activeTabIndex]) {
        state.openFiles[state.activeTabIndex].content = state.editor.getValue();
    }

    state.activeTabIndex = index;
    const file = state.openFiles[index];

    state.currentFile = file.path;
    const ext = (file.path.split('.').pop() || '').toLowerCase();
    state.currentSketch = isSketchSource(file.path) ? file.path : (state.currentSketch && state.openFiles.some(f => f.path === state.currentSketch) ? state.currentSketch : null);
    if (ext === 'ino') window.electronAPI.ui.updateSketchPath(file.path);
    announceSketch();
    syncPlatformio(file.path);

    if (state.editor) {
        state.editor.setValue(file.content);
        window.electronAPI.ui.updateEditorCode(file.content);
    }

    renderFileTabs();
    updateAIContext();
    saveSession();
}

function closeTab(index) {
    if (index < 0 || index >= state.openFiles.length) return;

    // Save content before closing
    if (state.editor && state.activeTabIndex === index) {
        state.openFiles[index].content = state.editor.getValue();
    }

    state.openFiles.splice(index, 1);

    if (state.openFiles.length === 0) {
        state.activeTabIndex = -1;
        state.currentFile = null;
        state.currentSketch = null;
        announceSketch();
        showWelcomeState();
        saveSession();
        return;
    }

    if (state.activeTabIndex >= state.openFiles.length) {
        state.activeTabIndex = state.openFiles.length - 1;
    } else if (state.activeTabIndex > index) {
        state.activeTabIndex--;
    }

    const file = state.openFiles[state.activeTabIndex];
    state.currentFile = file.path;
    const ext = (file.path.split('.').pop() || '').toLowerCase();
    state.currentSketch = isSketchSource(file.path) ? file.path : (state.openFiles.find(f => isSketchSource(f.path))?.path || null);
    announceSketch();
    if (ext === 'ino') window.electronAPI.ui.updateSketchPath(file.path);

    if (state.editor) {
        state.editor.setValue(file.content);
        window.electronAPI.ui.updateEditorCode(file.content);
    }

    renderFileTabs();
    updateAIContext();
    saveSession();
}

async function openFileFromTree(filePath) {
    try {
        const ext = (filePath.split('.').pop() || '').toLowerCase();
        const canEdit = ['ino', 'h', 'hpp', 'cpp', 'c', 'txt', 'json'].includes(ext);

        const fileResult = await window.electronAPI.file.read(filePath);
        if (!fileResult.success) {
            logToConsole(`Cannot read: ${filePath}`, 'error');
            return;
        }

        const fileName = filePath.split(/[/\\]/).pop();

        if (canEdit && state.editor) {
            showEditor();
            addOrFocusFile(filePath, fileResult.content, fileName);
            switchToTab(state.activeTabIndex);
            state.context.activeFile = filePath;
            updateAIContext();
            logToConsole(`Opened: ${fileName}`, 'success');
        }
    } catch (error) {
        logToConsole(`Error opening file: ${error.message}`, 'error');
    }
}

// ============================================
// Library Manager
// ============================================
async function loadInstalledLibs() {
    try {
        const r = await window.electronAPI.lib.list();
        state.installedLibs.clear();

        if (r.success && r.data?.installed_libraries) {
            r.data.installed_libraries.forEach(lib => {
                state.installedLibs.set(lib.name, { version: lib.version });
            });
        }
        renderLibList('installed', r.success ? r.data?.installed_libraries : []);
    } catch (e) {
        renderLibList('installed', []);
    }
}

async function libSearch() {
    const q = document.getElementById('libSearchInput')?.value?.trim() || '';
    if (!q) {
        renderLibList('search', []);
        return;
    }

    const listEl = document.getElementById('libList');
    if (listEl) listEl.innerHTML = '<div class="lib-msg">Searching...</div>';

    try {
        const r = await window.electronAPI.lib.search(q);
        state.libSearchResults = r?.data?.libraries || [];
        await loadInstalledLibs();
        renderLibList('search', state.libSearchResults);
    } catch (e) {
        if (listEl) listEl.innerHTML = `<div class="lib-msg error">${escapeHtml(e.message || 'Search failed')}</div>`;
    }
}

async function libUpdateIndex() {
    const btn = document.getElementById('libUpdateIndex');
    if (btn) btn.disabled = true;

    try {
        await window.electronAPI.lib.updateIndex();
        logToConsole('Library index updated', 'success');
    } catch (e) {
        logToConsole(`Update index failed: ${e.message}`, 'error');
    }

    if (btn) btn.disabled = false;
}

async function libInstallClick(name, version) {
    const spec = version ? `${name}@${version}` : name;

    try {
        await window.electronAPI.lib.install(spec);
        logToConsole(`Installed: ${spec}`, 'success');
        state.installedLibs.set(name, { version: version || 'latest' });

        if (state.libSearchResults.length) {
            renderLibList('search', state.libSearchResults);
        } else {
            loadInstalledLibs();
        }
    } catch (e) {
        logToConsole(`Install failed: ${e.message}`, 'error');
    }
}

function renderLibList(mode, list) {
    const el = document.getElementById('libList');
    if (!el) return;

    if (!list || list.length === 0) {
        el.innerHTML = `<div class="lib-msg">${mode === 'installed' ? 'No installed libraries.' : 'Search for libraries above'}</div>`;
        return;
    }

    el.innerHTML = '';

    for (const lib of list) {
        const name = lib.name || '';
        const author = lib.author || '';
        const sentence = lib.sentence || '';
        const ver = lib.version || (lib.available_versions && lib.available_versions[0]) || '';
        const versions = lib.available_versions || (ver ? [ver] : []);
        const isInstalled = state.installedLibs.has(name);

        const card = document.createElement('div');
        card.className = 'lib-card';

        // Escape all user-controlled strings to prevent XSS
        const safeName = escapeHtml(name);
        const safeAuthor = escapeHtml(author);
        const safeSentence = escapeHtml(sentence);
        const safeVer = escapeHtml(ver);

        let verOpts = versions.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
        if (!verOpts && ver) verOpts = `<option value="${safeVer}">${safeVer}</option>`;

        const installBtn = isInstalled
            ? `<span class="lib-installed">Installed${lib.version ? ` (${escapeHtml(lib.version)})` : ''}</span>`
            : (verOpts
                ? `<select class="lib-version">${verOpts}</select><button class="lib-install-btn" data-name="${safeName}">Install</button>`
                : '<span class="lib-msg">No version</span>');

        card.innerHTML = `
            <div class="lib-name">${safeName}</div>
            <div class="lib-meta">${safeAuthor}</div>
            <div class="lib-sentence">${safeSentence}</div>
            <div class="lib-actions">${installBtn}</div>
        `;

        el.appendChild(card);

        const btn = card.querySelector('.lib-install-btn');
        if (btn) {
            btn.addEventListener('click', () => {
                const sel = card.querySelector('.lib-version');
                const v = sel ? sel.value : null;
                libInstallClick(name, v);
            });
        }
    }
}

// ============================================
// Compile & Upload
// ============================================
async function compileSketch() {
    const boardFQBN = document.getElementById('boardSelectSidebar')?.value;

    if (!state.currentSketch) {
        logToConsole('Open a sketch first.', 'warning');
        clearProblems();
        showProblem('Open a sketch first: use File › Open, or pick an .ino file in the sidebar.', { note: true });
        return { ok: false, error: 'Open a sketch first.' };
    }

    const pio = inPioProject(state.currentSketch);
    if (!boardFQBN && !pio) {
        logToConsole('Choose a board first.', 'warning');
        clearProblems();
        showProblem('Choose a board first: click Choose a board at the top of the window.', { note: true });
        return { ok: false, error: 'Choose a board first.', needsBoard: true };
    }

    if (!await saveAllFiles()) {
        clearProblems();
        showProblem('The sketch could not be saved, so the build would use old code. Fix the save error and try again.', { note: true });
        return { ok: false, error: 'The sketch could not be saved, so the build would use old code.' };
    }

    setButtonState('compileBtn', true, 'Verifying…');
    clearProblems();

    try {
        const result = await window.electronAPI.arduino.compile(state.currentSketch, pio ? PIO_FQBN : await fqbnFor(boardFQBN));

        if (result.success) {
            // Update context awareness
            state.context.lastCompileResult = {
                success: true,
                programSize: result.data?.programSize,
                usagePercent: result.data?.usagePercent,
                warnings: result.data?.warnings || []
            };
            updateAIContext();
            // Share with the AI agent (main process) so it can reference the build.
            window.electronAPI.ui.updateCompileResult({
                success: true,
                message: result.data?.message || 'Compilation successful',
                output: result.data?.output || ''
            });

            // It compiles; what the hardware linter found that fails on the board goes to Problems (without taking focus).
            const lint = result.data?.lint || [];
            if (lint.length) {
                const file = String(state.currentSketch || '').split(/[\\/]/).pop() || 'sketch.ino';
                showProblem(`Impulse found ${lint.length === 1 ? 'one thing that compiles' : `${lint.length} things that compile`} but will not work on this board.`, { note: true, focus: false });
                showProblem(lint.map((f) => `${file}:${f.line}:1: ${f.level}: ${f.message} Fix: ${f.fix}`).join('\n'), { focus: false });
                logToConsole(`Impulse found ${lint.length} problem${lint.length === 1 ? '' : 's'} the compiler cannot see: see Problems.`, 'warning');
            }
            return { ok: true, size: result.data?.programSize ?? null, percent: result.data?.usagePercent ?? null, summary: result.data?.summary || [] };
        } else {
            if (result.code === 'BUSY') {
                // Another build is running: its result arrives on its own.
                logToConsole(result.error, 'warning');
                return { ok: false, busy: true, code: 'BUSY', error: result.error };
            }
            // Update context awareness - compilation failed
            state.context.lastCompileResult = {
                success: false,
                error: result.error
            };
            updateAIContext();
            // Share the full failure with the AI agent so it can help debug.
            window.electronAPI.ui.updateCompileResult({
                success: false,
                message: result.error,
                errors: result.errors || (result.error ? [result.error] : []),
                output: result.output || result.error || ''
            });
            if (result.error) showBuildProblem(result);
            if (result.analyzedError) {
                displayErrorAnalysis(result.analyzedError);
            }
            return { ok: false, error: result.output || result.error || 'Compilation failed', code: result.code || null, title: result.title || null, hint: result.hint || '' };
        }
    } catch (error) {
        logToConsole(`Compilation error: ${error.message}`, 'error');
        showProblem(error.message, { note: true });
        return { ok: false, error: error.message };
    } finally {
        setButtonState('compileBtn', false, 'Verify');
    }
}

async function uploadSketch() {
    const boardFQBN = document.getElementById('boardSelectSidebar')?.value;
    const port = document.getElementById('portSelectSidebar')?.value;

    if (!state.currentSketch) {
        logToConsole('Open a sketch first.', 'warning');
        clearProblems();
        showProblem('Open a sketch first: use File › Open, or pick an .ino file in the sidebar.', { note: true });
        return { ok: false, error: 'Open a sketch first.' };
    }

    const pio = inPioProject(state.currentSketch);
    if (!boardFQBN && !pio) {
        logToConsole('Choose a board first.', 'warning');
        clearProblems();
        showProblem('Choose a board first: click Choose a board at the top of the window.', { note: true });
        return { ok: false, error: 'Choose a board first.', needsBoard: true };
    }

    if (!port) {
        logToConsole('Choose a port first.', 'warning');
        clearProblems();
        showProblem('Plug in the board, then choose its port at the top of the window.', { note: true });
        return { ok: false, error: 'Plug in the board and choose its port first.', needsBoard: true };
    }

    if (!await saveAllFiles()) {
        clearProblems();
        showProblem('The sketch could not be saved, so the build would use old code. Fix the save error and try again.', { note: true });
        return { ok: false, error: 'The sketch could not be saved, so the upload would use old code.' };
    }

    // The main process closes the port for the upload and reopens it afterwards
    // (serialMonitor.holdForUpload / resumeAfterUpload), like Arduino IDE.
    setButtonState('uploadBtn', true, 'Uploading…');
    clearProblems();

    try {
        const result = await window.electronAPI.arduino.upload(state.currentSketch, pio ? PIO_FQBN : await fqbnFor(boardFQBN), port);

        if (result.success) {
            return { ok: true, port, summary: result.data?.summary || [] };
        } else {
            if (result.code === 'BUSY') {
                // Another build is running: its result arrives on its own.
                logToConsole(result.error, 'warning');
                return { ok: false, busy: true, code: 'BUSY', error: result.error, port };
            }
            if (result.error) showBuildProblem(result);
            if (result.analyzedError) {
                displayErrorAnalysis(result.analyzedError);
            }
            return { ok: false, error: result.error || 'Upload failed', port, code: result.code || null, title: result.title || null, hint: result.hint || '' };
        }
    } catch (error) {
        logToConsole(`Upload error: ${error.message}`, 'error');
        showProblem(error.message, { note: true });
        return { ok: false, error: error.message, port };
    } finally {
        setButtonState('uploadBtn', false, 'Upload');
    }
}

// ============================================
// Serial Monitor Functions
// ============================================
async function toggleSerial() {
    if (state.serialConnected) {
        await disconnectSerial();
    } else {
        await connectSerial();
    }
}

async function connectSerial() {
    const port = document.getElementById('portSelectSidebar')?.value;
    const baudRate = parseInt(document.getElementById('baudRate')?.value || '115200');

    if (!port) {
        logToConsole('Please select a port first', 'warning');
        // Make the issue visible in the Serial panel too
        const statusText = document.getElementById('serialStatusText');
        if (statusText) statusText.textContent = 'Select a port first';
        appendSerialOutput('Choose a port first (the board manager, or the board button in the toolbar).', new Date().toISOString(), 'info');
        return;
    }

    try {
        // Make sure user sees serial output immediately
        document.querySelector('.output-tab[data-tab="serial"]')?.click();
        appendSerialOutput(`Connecting to ${port} @ ${baudRate}...`, new Date().toISOString(), 'info');
        const result = await window.electronAPI.serial.connect(port, baudRate);
        if (!result.success) {
            logToConsole(`Failed to connect: ${result.error}`, 'error');
            appendSerialOutput(`Failed to connect: ${result.error}`, new Date().toISOString(), 'error');
            const statusText = document.getElementById('serialStatusText');
            if (statusText) statusText.textContent = `Error: ${result.error}`;
        }
    } catch (error) {
        logToConsole(`Serial connection error: ${error.message}`, 'error');
        appendSerialOutput(`Serial connection error: ${error.message}`, new Date().toISOString(), 'error');
        const statusText = document.getElementById('serialStatusText');
        if (statusText) statusText.textContent = `Error: ${error.message}`;
    }
}


async function disconnectSerial() {
    try {
        await window.electronAPI.serial.disconnect();
    } catch (error) {
        logToConsole(`Disconnect error: ${error.message}`, 'error');
    }
}

async function sendSerialData() {
    const input = document.getElementById('serialInput');
    const data = input?.value;

    if (!data || !state.serialConnected) return;

    try {
        await window.electronAPI.serial.send(data + '\n');
        appendSerialOutput(`> ${data}`, new Date().toISOString(), 'sent');
        input.value = '';
    } catch (error) {
        logToConsole(`Failed to send: ${error.message}`, 'error');
    }
}

function updateSerialUI(connected) {
    window.dispatchEvent(new CustomEvent('impulse:serial-state'));
    const toggleBtn = document.getElementById('toggleSerial');
    const portSelectSidebar = document.getElementById('portSelectSidebar');
    const statusDot = document.getElementById('serialStatusDot');
    const statusText = document.getElementById('serialStatusText');

    if (toggleBtn) {
        toggleBtn.textContent = connected ? 'Close serial monitor' : 'Open serial monitor';
        toggleBtn.classList.toggle('active', connected);
    }

    if (statusDot) {
        statusDot.classList.toggle('connected', connected);
    }

    if (statusText) {
        const baudRate = document.getElementById('baudRate')?.value || '115200';
        statusText.textContent = connected ? `Connected @ ${baudRate}` : 'Disconnected';
    }

    // Disable port selection while connected (can't change port without disconnecting)
    if (portSelectSidebar) portSelectSidebar.disabled = connected;

    // Keep baud rate enabled - changing it will auto-reconnect
    // if (baudSelect) baudSelect.disabled = connected;
}

/**
 * A line the window itself has to say (connecting, an upload note). Lines from
 * the board are assembled in the main process and arrive through onLines.
 */
function appendSerialOutput(data, timestamp, type = 'received') {
    const kind = type === 'sent' ? 'tx' : type === 'error' ? 'error' : type === 'info' ? 'info' : 'rx';
    const lines = [{ at: timestamp || new Date().toISOString(), text: String(data), kind }];
    renderSerialLines(lines);
    publishSerialLines(lines);
}

// ============================================
// Context Awareness Setup
// ============================================
function setupContextAwareness() {
    // Context is now kept current by the debounced editor 'change' handler
    // (scheduleEditorSync) and by tab/board/port changes — no need for a
    // per-DOM-mutation observer on the editor, which fired on every keystroke
    // and scroll. Just seed the initial context once.
    updateAIContext();
}

function updateAIContext() {
    const context = {
        activeFile: state.currentFile || state.currentSketch,
        selectedBoard: state.context.selectedBoard,
        selectedPort: state.context.selectedPort,
        lastCompileResult: state.context.lastCompileResult,
        currentBaudRate: state.context.currentBaudRate,
        serialConnected: state.serialConnected,
        editorCode: state.editor ? state.editor.getValue() : null
    };

    // Store in state for AI agent access. (Context is read per-query in
    // sendAIMessage; there is no ai.updateContext IPC, so nothing to emit here.)
    state.context = { ...state.context, ...context };
}

// ============================================
// AI Panel Overlay (Top-Right) — Enhanced
// ============================================
function setupAIPanelOverlay() {
    const aiTab = document.getElementById('aiAgentTab');
    const aiCloseBtn = document.getElementById('aiCloseBtn');

    if (aiTab) {
        aiTab.addEventListener('click', () => toggleAIPanel());
    }

    // Close button: fully close the panel
    if (aiCloseBtn) {
        aiCloseBtn.addEventListener('click', () => {
            if (state.aiPanelOpen) toggleAIPanel();
        });
    }
}

// ============================================
// AI Panel Resize (drag left edge)
// ============================================
function setupAIPanelResize() {
    const handle = document.getElementById('aiResizeHandle');
    const panel = document.getElementById('aiPanel');
    if (!handle || !panel) return;

    let startX = 0;
    let startWidth = 0;
    let dragging = false;

    handle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        dragging = true;
        startX = e.clientX;
        startWidth = panel.getBoundingClientRect().width;
        handle.classList.add('dragging');
        document.body.style.cursor = 'ew-resize';
        document.body.style.userSelect = 'none';

        // PERF: Kill the CSS transition during drag so it's instantaneous —
        // the animation was fighting every mousemove update causing lag.
        panel.style.transition = 'none';

        const onMouseMove = (ev) => {
            if (!dragging) return;
            const delta = startX - ev.clientX;
            const newWidth = Math.max(260, Math.min(window.innerWidth * 0.6, startWidth + delta));
            state.aiPanelWidth = newWidth;
            // Set on documentElement so both the panel width and the workspace
            // reflow margin (which inherits the var) update together, live.
            applyAIPanelWidthVar(newWidth);
        };

        const onMouseUp = () => {
            dragging = false;
            handle.classList.remove('dragging');
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            // Restore the snappy open/close transition after drag ends
            panel.style.transition = 'width 0.2s ease';
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            if (state.editor) state.editor.refresh();
            saveAIPanelState();
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    });
}

// ============================================
// AI Panel Functions (side column — reflows the workspace)
// ============================================

// Width var lives on documentElement so the panel width AND the workspace
// reflow margin (which reads the same inherited var) stay in sync.
function applyAIPanelWidthVar(width) {
    document.documentElement.style.setProperty('--ai-panel-current-width', `${width}px`);
}

function toggleAIPanel() {
    const panel = document.getElementById('aiPanel');
    const tab = document.getElementById('aiAgentTab');
    const appContainer = document.querySelector('.app-container');

    if (panel) {
        state.aiPanelOpen = !state.aiPanelOpen;

        if (state.aiPanelOpen) {
            applyAIPanelWidthVar(state.aiPanelWidth || 380);
            panel.classList.add('open');
            appContainer?.classList.add('ai-open');
            if (tab) tab.classList.add('active');
        } else {
            panel.classList.remove('open');
            appContainer?.classList.remove('ai-open');
            if (tab) tab.classList.remove('active');
        }
        // Editor width changed — reflow CodeMirror after the transition.
        if (state.editor) setTimeout(() => state.editor.refresh(), 220);
        saveAIPanelState();
    }
}

// Persist AI panel state
const AI_PANEL_STATE_KEY = 'arduino-ide-ai-panel-state';

function saveAIPanelState() {
    try {
        localStorage.setItem(AI_PANEL_STATE_KEY, JSON.stringify({
            open: state.aiPanelOpen,
            width: state.aiPanelWidth
        }));
    } catch (e) { /* ignore */ }
}

function restoreAIPanelState() {
    try {
        const raw = localStorage.getItem(AI_PANEL_STATE_KEY);
        if (!raw) return;
        const s = JSON.parse(raw);
        if (s.width && typeof s.width === 'number') {
            state.aiPanelWidth = s.width;
        }
        // Restore panel open state (never restores a minimized/stuck state)
        if (s.open) {
            const panel = document.getElementById('aiPanel');
            const tab = document.getElementById('aiAgentTab');
            const appContainer = document.querySelector('.app-container');
            if (panel) {
                state.aiPanelOpen = true;
                applyAIPanelWidthVar(state.aiPanelWidth || 380);
                panel.classList.add('open');
                appContainer?.classList.add('ai-open');
                if (tab) tab.classList.add('active');
                if (state.editor) setTimeout(() => state.editor.refresh(), 50);
            }
        }
    } catch (e) { /* ignore */ }
}

// ============================================
// Serial Monitor & Plotter Buttons
// ============================================
function setupSerialButtons() {
    const serialMonitorBtn = document.getElementById('serialMonitorBtn');
    const serialPlotterBtn = document.getElementById('serialPlotterBtn');

    if (serialMonitorBtn) {
        serialMonitorBtn.addEventListener('click', () => {
            // Switch to Serial Monitor tab in output panel
            document.querySelector('.output-tab[data-tab="serial"]')?.click();
            // Also open serial panel in sidebar if needed
            if (state.sidebarCollapsed) toggleSidebar();
            switchPanel('serial');
            // Actually open the monitor: connect if not already connected.
            // (Disconnect stays on the sidebar toggle so this button never
            // accidentally closes an active session.)
            if (!state.serialConnected) connectSerial();
        });
    }

    if (serialPlotterBtn) {
        serialPlotterBtn.addEventListener('click', () => {
            // Switch to Serial Plotter tab in output panel
            document.querySelector('.output-tab[data-tab="plotter"]')?.click();
            // Also open serial panel in sidebar if needed
            if (state.sidebarCollapsed) toggleSidebar();
            switchPanel('serial');
        });
    }
}

// ============================================
// Serial Plotter Engine
// ============================================
const PLOTTER_COLORS = [
    '#00D4AA', // Teal (primary accent)
    '#FF5252', // Red
    '#FFB300', // Amber
    '#00B8D4', // Cyan
    '#B388FF', // Purple
    '#00E676', // Green
    '#FF6E40', // Deep Orange
    '#40C4FF'  // Light Blue
];

function feedPlotterData(rawData) {
    if (state.plotter.paused) return;

    // Parse numeric values from the serial line
    // Supports: single number, comma-separated, tab-separated, space-separated
    const line = String(rawData).trim();
    if (!line) return;

    // Split by common delimiters
    const parts = line.split(/[,\t ]+/);
    const values = [];

    for (const part of parts) {
        const num = parseFloat(part);
        if (!isNaN(num) && isFinite(num)) {
            values.push(num);
        }
    }

    if (values.length === 0) return;

    // Update channel count
    state.plotter.channelCount = Math.max(state.plotter.channelCount, values.length);

    // Add data point
    state.plotter.data.push({
        timestamp: Date.now(),
        values: values
    });

    // Trim old data
    while (state.plotter.data.length > state.plotter.maxPoints) {
        state.plotter.data.shift();
    }

    // Update UI counters
    const channelEl = document.getElementById('plotterChannelCount');
    const pointEl = document.getElementById('plotterPointCount');
    if (channelEl) channelEl.textContent = state.plotter.channelCount;
    if (pointEl) pointEl.textContent = state.plotter.data.length;
}

function setupSerialPlotter() {
    const pauseBtn = document.getElementById('plotterPauseBtn');
    const clearBtn = document.getElementById('plotterClearBtn');

    if (pauseBtn) {
        pauseBtn.addEventListener('click', () => {
            state.plotter.paused = !state.plotter.paused;
            pauseBtn.classList.toggle('active', state.plotter.paused);
            pauseBtn.innerHTML = state.plotter.paused ? PLOTTER_ICON.play : PLOTTER_ICON.pause;
            pauseBtn.title = state.plotter.paused ? 'Resume' : 'Pause';
            pauseBtn.setAttribute('aria-label', pauseBtn.title);
        });
    }

    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            state.plotter.data = [];
            state.plotter.channelCount = 0;
            const channelEl = document.getElementById('plotterChannelCount');
            const pointEl = document.getElementById('plotterPointCount');
            if (channelEl) channelEl.textContent = '0';
            if (pointEl) pointEl.textContent = '0';
        });
    }
}

function startPlotterRendering() {
    if (state.plotter.running) return;
    state.plotter.running = true;
    renderPlotterFrame();
}

function stopPlotterRendering() {
    state.plotter.running = false;
    if (state.plotter.animFrameId) {
        cancelAnimationFrame(state.plotter.animFrameId);
        state.plotter.animFrameId = null;
    }
}

/** The plotter's icons (the pause button swaps between them). */
const PLOTTER_ICON = {
    pause: '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
    play: '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>',
};

/** The plotter's colours and fonts, read from the design tokens (so both themes match the app). */
let plotterThemeCache = null;
function plotterTheme() {
    const key = document.documentElement.getAttribute('data-theme') || 'dark';
    if (plotterThemeCache?.key === key) return plotterThemeCache;
    const probe = document.createElement('span');
    probe.style.display = 'none';
    document.body.appendChild(probe);
    const resolve = (token) => { probe.style.color = `var(${token})`; return getComputedStyle(probe).color; };
    const css = getComputedStyle(document.documentElement);
    plotterThemeCache = {
        key,
        canvas: resolve('--ds-canvas'),
        grid: resolve('--ds-line'),
        muted: resolve('--ds-text-4'),
        text: resolve('--ds-text-2'),
        mono: css.getPropertyValue('--font-mono').trim() || 'monospace',
        ui: css.getPropertyValue('--font-ui').trim() || 'system-ui, sans-serif',
    };
    probe.remove();
    return plotterThemeCache;
}

function renderPlotterFrame() {
    if (!state.plotter.running) return;

    const canvas = document.getElementById('plotterCanvas');
    if (!canvas) {
        state.plotter.running = false;
        return;
    }

    const ctx = canvas.getContext('2d');
    const rect = canvas.parentElement.getBoundingClientRect();

    // Scale canvas to actual pixel size (HiDPI support)
    const dpr = window.devicePixelRatio || 1;
    const w = rect.width;
    const h = rect.height - 28; // subtract toolbar height

    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
        ctx.scale(dpr, dpr);
    }

    const theme = plotterTheme();

    // Clear canvas
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = theme.canvas;
    ctx.fillRect(0, 0, w, h);

    const data = state.plotter.data;
    const channels = state.plotter.channelCount;
    const empty = data.length < 2 || channels === 0;
    const emptyEl = document.getElementById('plotterEmpty');
    if (emptyEl) emptyEl.hidden = !empty;

    if (empty) {
        state.plotter.animFrameId = requestAnimationFrame(renderPlotterFrame);
        return;
    }

    // Calculate Y range
    let yMin = Infinity;
    let yMax = -Infinity;
    for (const point of data) {
        for (const v of point.values) {
            if (v < yMin) yMin = v;
            if (v > yMax) yMax = v;
        }
    }

    // Add padding to Y range
    const yRange = yMax - yMin || 1;
    yMin -= yRange * 0.1;
    yMax += yRange * 0.1;

    // Layout
    const pad = { left: 50, right: 16, top: 10, bottom: 20 };
    const plotW = w - pad.left - pad.right;
    const plotH = h - pad.top - pad.bottom;

    // Grid lines
    ctx.strokeStyle = theme.grid;
    ctx.lineWidth = 1;

    const ySteps = 5;
    for (let i = 0; i <= ySteps; i++) {
        const y = pad.top + (plotH * i) / ySteps;
        ctx.beginPath();
        ctx.moveTo(pad.left, y);
        ctx.lineTo(w - pad.right, y);
        ctx.stroke();

        // Y axis labels
        const val = yMax - ((yMax - yMin) * i) / ySteps;
        ctx.fillStyle = theme.muted;
        ctx.font = `10px ${theme.mono}`;
        ctx.textAlign = 'right';
        ctx.fillText(val.toFixed(val >= 100 || val <= -100 ? 0 : 1), pad.left - 6, y + 3);
    }

    // X axis labels (timestamps)
    const xSteps = Math.min(5, data.length - 1);
    for (let i = 0; i <= xSteps; i++) {
        const x = pad.left + (plotW * i) / xSteps;
        ctx.beginPath();
        ctx.moveTo(x, pad.top);
        ctx.lineTo(x, h - pad.bottom);
        ctx.stroke();
    }

    // Draw data lines for each channel
    for (let ch = 0; ch < channels; ch++) {
        ctx.strokeStyle = PLOTTER_COLORS[ch % PLOTTER_COLORS.length];
        ctx.lineWidth = 1.5;
        ctx.beginPath();

        let firstPoint = true;
        for (let i = 0; i < data.length; i++) {
            const val = data[i].values[ch];
            if (val === undefined) continue;

            const x = pad.left + (plotW * i) / (data.length - 1);
            const y = pad.top + plotH - ((val - yMin) / (yMax - yMin)) * plotH;

            if (firstPoint) {
                ctx.moveTo(x, y);
                firstPoint = false;
            } else {
                ctx.lineTo(x, y);
            }
        }
        ctx.stroke();
    }

    // Draw channel legend
    if (channels > 0) {
        const legendX = pad.left + 8;
        let legendY = pad.top + 14;
        ctx.font = `11px ${theme.ui}`;
        for (let ch = 0; ch < channels; ch++) {
            const color = PLOTTER_COLORS[ch % PLOTTER_COLORS.length];
            ctx.fillStyle = color;
            ctx.fillRect(legendX, legendY - 8, 10, 10);
            ctx.fillStyle = theme.text;
            const lastVal = data[data.length - 1]?.values[ch];
            const label = `Ch${ch + 1}: ${lastVal !== undefined ? lastVal.toFixed(2) : '--'}`;
            ctx.textAlign = 'left';
            ctx.fillText(label, legendX + 14, legendY);
            legendY += 14;
        }
    }

    state.plotter.animFrameId = requestAnimationFrame(renderPlotterFrame);
}

const AI_PREFS_KEY = 'arduino-ide-ai-prefs';
const SESSION_KEY = 'arduino-ide-session';

function saveSession() {
    try {
        const boardSelectSidebar = document.getElementById('boardSelectSidebar');
        const portSelectSidebar = document.getElementById('portSelectSidebar');
        const payload = {
            folderPath: state.folderRoot || null,
            boardFQBN: (boardSelectSidebar && boardSelectSidebar.value) || null,
            port: (portSelectSidebar && portSelectSidebar.value) || null,
            // Persist open tabs (paths only — content is re-read from disk on restore)
            openFiles: state.openFiles.map(f => ({ path: f.path, name: f.name })),
            activeTabIndex: state.activeTabIndex
        };
        localStorage.setItem(SESSION_KEY, JSON.stringify(payload));
    } catch (e) {
        console.warn('Could not save session', e);
    }
}

async function restoreSession() {
    try {
        const raw = localStorage.getItem(SESSION_KEY);
        if (!raw) return;
        const session = JSON.parse(raw);
        if (!session) return;

        // Restore board: only if option exists in loaded list
        let restoredBoardName = null;
        if (session.boardFQBN && state.boards && state.boards.some(b => b.fqbn === session.boardFQBN)) {
            const boardSelectSidebar = document.getElementById('boardSelectSidebar');
            if (boardSelectSidebar) {
                boardSelectSidebar.value = session.boardFQBN;
                state.selectedBoard = session.boardFQBN;
                state.context.selectedBoard = session.boardFQBN;
                announceBoard();
            }
            const board = state.boards.find(b => b.fqbn === session.boardFQBN);
            if (board) restoredBoardName = board.name;
            if (window.electronAPI?.ui?.updateBoard) {
                window.electronAPI.ui.updateBoard(session.boardFQBN);
            }
        }

        // Restore port: only if option exists in loaded list
        let restoredPort = null;
        if (session.port && state.ports && state.ports.some(p => p.port === session.port)) {
            const portSelectSidebar = document.getElementById('portSelectSidebar');
            if (portSelectSidebar) {
                portSelectSidebar.value = session.port;
                state.selectedPort = session.port;
                state.context.selectedPort = session.port;
            }
            restoredPort = session.port;
            if (window.electronAPI?.ui?.updatePort) {
                window.electronAPI.ui.updatePort(session.port);
            }
        }
        if (restoredBoardName || restoredPort) {
            updateBoardPortDisplay(restoredBoardName || null, restoredPort || null);
            loadSavedBoardPortOptions();
        }

        // Sessions saved before folder approvals were persisted need a one-time
        // approval (no-op on every later launch).
        const legacyFolders = [
            session.folderPath,
            ...(Array.isArray(session.openFiles) ? session.openFiles.map(f => f?.path?.replace(/[/\\][^/\\]*$/, '')) : [])
        ].filter(p => typeof p === 'string' && p);
        if (legacyFolders.length) await window.electronAPI.workspace?.migrateLegacySession(legacyFolders);

        // Restore folder: only if path still exists (list succeeds)
        if (session.folderPath && typeof session.folderPath === 'string') {
            const res = await window.electronAPI.folder.list(session.folderPath);
            if (res.success && res.entries) {
                state.folderRoot = session.folderPath;
                state.expandedDirs.clear();
                const label = document.getElementById('folderLabel');
                const name = session.folderPath.split(/[/\\]/).pop() || session.folderPath;
                if (label) {
                    label.innerHTML = `<span class="folder-icon">${ICONS.folder}</span><span>${escapeHtml(name)}</span>`;
                }
                await renderFileTree(session.folderPath);
            }
            // If folder not available: do nothing, boot as is (no folder open)
        }

        // Restore open tabs — re-read each file from disk, skip any that are gone.
        // Build the openFiles array directly (NOT via addOrFocusFile, whose
        // "save current tab before switching" would read the still-empty editor
        // and overwrite earlier tabs' content — the file-wipe bug).
        if (Array.isArray(session.openFiles) && session.openFiles.length > 0) {
            const restored = [];
            for (const f of session.openFiles) {
                if (!f || !f.path) continue;
                try {
                    const fr = await window.electronAPI.file.read(f.path);
                    if (fr && fr.success) {
                        restored.push({
                            path: f.path,
                            content: fr.content,
                            name: f.name || f.path.split(/[/\\]/).pop()
                        });
                    }
                } catch (_) { /* file unreadable — skip */ }
            }
            if (restored.length > 0) {
                showEditor();
                state.openFiles = restored;
                // activeTabIndex = -1 so switchToTab's "save current" is a no-op
                // (nothing to clobber), then it loads the chosen tab's content.
                state.activeTabIndex = -1;
                renderFileTabs();
                const savedIdx = session.activeTabIndex;
                const idx = (typeof savedIdx === 'number' && savedIdx >= 0 && savedIdx < restored.length)
                    ? savedIdx
                    : restored.length - 1;
                switchToTab(idx);
            }
        }
    } catch (e) {
        console.warn('Could not restore session', e);
    }
}

function saveAIPreferences() {
    try {
        localStorage.setItem(AI_PREFS_KEY, JSON.stringify({ mode: state.aiMode }));
    } catch (e) {
        console.warn('Could not save AI preferences', e);
    }
}

async function restoreAIPreferences() {
    try {
        const raw = localStorage.getItem(AI_PREFS_KEY);
        if (!raw) return;
        const prefs = JSON.parse(raw);
        if (prefs.mode && ['agent', 'plan', 'debug'].includes(prefs.mode)) {
            state.aiMode = prefs.mode;
            const modeSelect = document.getElementById('aiModeSelect');
            if (modeSelect) modeSelect.value = prefs.mode;
        }
    } catch (e) {
        console.warn('Could not restore AI preferences', e);
    }
}

/** The line under the IDE composer: whether Impulse AI can answer, or what to do first. */
function refreshAIStatus() {
    if (state.aiProviderConfigured) updateAIStatus('Ready · Impulse AI');
    else updateAIStatus('Sign in to Impulse (the person icon) to use the AI');
}

/**
 * Before sending: make sure Impulse AI can answer. There is one AI to the
 * person; the server picks the model behind it for each turn, so here only
 * the account matters.
 * @returns {Promise<{ ok: boolean, provider?: string, needsSignIn?: boolean, error?: string }>}
 */
async function readyAIModel() {
    const status = await window.electronAPI.cloud.status().catch(() => null);
    if (!status?.configured) return { ok: false, error: 'This build of Impulse has no cloud address, so its AI is off.' };
    if (!status.signedIn) {
        state.aiProviderConfigured = false;
        refreshAIStatus();
        return { ok: false, needsSignIn: true };
    }
    const res = await window.electronAPI.ai.ready().catch((e) => ({ success: false, error: e?.message }));
    state.aiProviderConfigured = !!res?.success;
    refreshAIStatus();
    if (res?.success) return { ok: true, provider: 'impulse' };
    if (res?.needsSignIn) return { ok: false, needsSignIn: true };
    return { ok: false, error: res?.error || 'Impulse AI isn\'t available right now.' };
}

/** IDE chat: like readyAIModel, but asks the person when something is missing. */
async function ensureAIModel({ quiet = false, pendingPrompt = null } = {}) {
    const ready = await readyAIModel();
    if (ready.ok || quiet) return ready.ok;
    if (ready.needsSignIn) window.impulse.account?.openSignIn({ pendingPrompt });
    else updateAIStatus(ready.error);
    return false;
}

/** Signing in makes Impulse AI ready; signing out takes it away. */
function followAccount(status) {
    if (status?.signedIn) {
        readyAIModel();
    } else if (state.aiProviderConfigured) {
        state.aiProviderConfigured = false;
        refreshAIStatus();
    }
}

// ============================================
// Code Snapshot & Revert System
// ============================================
const SNAPSHOTS_KEY = 'impulse-code-snapshots';
const MAX_SNAPSHOTS = 50;

function takeCodeSnapshot(prompt) {
    if (!state.editor) return null;
    const code = state.editor.getValue();
    const filePath = state.currentSketch || state.currentFile || null;

    const snapshot = {
        id: 'snap-' + Date.now(),
        timestamp: new Date().toISOString(),
        prompt,
        code,
        filePath
    };

    try {
        const existing = JSON.parse(localStorage.getItem(SNAPSHOTS_KEY) || '[]');
        existing.unshift(snapshot); // newest first
        if (existing.length > MAX_SNAPSHOTS) existing.splice(MAX_SNAPSHOTS);
        localStorage.setItem(SNAPSHOTS_KEY, JSON.stringify(existing));
    } catch (e) {
        console.warn('[Snapshots] Save failed:', e);
    }

    return snapshot.id;
}

function revertToSnapshot(id) {
    if (!id || !state.editor) return false;

    try {
        const existing = JSON.parse(localStorage.getItem(SNAPSHOTS_KEY) || '[]');
        const snap = existing.find(s => s.id === id);
        if (!snap) {
            logToConsole('Snapshot not found — it may have been cleared.', 'warning');
            window.notifications?.warning?.('That earlier version is no longer kept.');
            return false;
        }

        // The code goes back into the file it came from: show that file first
        // (never write it into whichever tab happens to be open).
        const index = snap.filePath ? state.openFiles.findIndex(f => f.path === snap.filePath) : state.activeTabIndex;
        if (index >= 0) {
            if (index !== state.activeTabIndex) switchToTab(index);
            state.editor.setValue(snap.code);
            window.electronAPI.ui.updateEditorCode(snap.code);
        }
        if (snap.filePath && window.electronAPI?.file?.save) {
            window.electronAPI.file.save(snap.filePath, snap.code)
                .then((res) => {
                    const file = state.openFiles.find(f => f.path === snap.filePath);
                    if (res?.success && file) { file.content = snap.code; file.dirty = false; }
                })
                .catch(e => console.warn('[Revert] File save failed:', e));
        }

        const timeStr = new Date(snap.timestamp).toLocaleTimeString();
        logToConsole(`✓ Reverted to snapshot from ${timeStr}`, 'info');
        addAIMessage('system', `Code reverted to state before: "${snap.prompt.slice(0, 60)}${snap.prompt.length > 60 ? '…' : ''}"`);
        return true;
    } catch (e) {
        console.warn('[Revert] Failed:', e);
        logToConsole('Revert failed — see console for details.', 'error');
        return false;
    }
}

// Wire up revert button clicks via event delegation (handles dynamically added buttons)
function setupRevertButtonHandler() {
    const container = document.getElementById('aiMessages');
    if (!container) return;

    container.addEventListener('click', (e) => {
        const btn = e.target.closest('.msg-revert-btn');
        if (!btn) return;
        const snapId = btn.dataset.snapshotId;
        if (snapId) revertToSnapshot(snapId);
    });
}

// Token threshold: trigger compaction at 70k input tokens (safely below most
// model context limits). Can be tweaked without touching other logic.
const AI_COMPACT_THRESHOLD = 70000;

// Normalise usage from any provider into a single { input, output } shape.
function extractTokens(usage) {
    if (!usage || typeof usage !== 'object') return { input: 0, output: 0 };
    return {
        input: usage.inputTokens ?? usage.prompt_tokens ?? usage.promptTokens ?? 0,
        output: usage.outputTokens ?? usage.completion_tokens ?? usage.completionTokens ?? usage.candidatesTokenCount ?? 0
    };
}

// Insert a visible summary divider card into the chat panel.
function addCompactDivider(summary) {
    const container = document.getElementById('aiMessages');
    if (!container) return;
    const div = document.createElement('div');
    div.className = 'ai-compact-divider';
    div.innerHTML =
        `<div class="ai-compact-header">` +
        `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>` +
        ` Conversation compacted` +
        `<button class="ai-compact-toggle" aria-expanded="false" title="Show / hide summary">▸ Show summary</button>` +
        `</div>` +
        `<div class="ai-compact-body" hidden>${formatAIContent(summary)}</div>`;
    div.querySelector('.ai-compact-toggle').addEventListener('click', (e) => {
        const body = div.querySelector('.ai-compact-body');
        const expanded = body.hidden;
        body.hidden = !expanded;
        e.target.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        e.target.textContent = expanded ? '▾ Hide summary' : '▸ Show summary';
    });
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

// Compact the conversation: summarise via AI, clear history on both sides,
// inject a divider card, reset token counter.
async function compactConversation() {
    if (state.aiCompacting) return;
    state.aiCompacting = true;
    const thinkingId = addAIMessage('assistant', '<span class="shimmer-text">Compacting conversation…</span>', true, true);
    try {
        const result = await window.electronAPI.ai.summarizeHistory();
        removeAIMessage(thinkingId);
        if (result.success) {
            addCompactDivider(result.summary || '');
            state.aiTokensUsed = 0;
            logToConsole('AI conversation compacted to save context.', 'info');
        } else {
            removeAIMessage(thinkingId);
            logToConsole(`Compact failed: ${result.error}`, 'warn');
        }
    } catch (e) {
        removeAIMessage(thinkingId);
        logToConsole(`Compact error: ${e.message}`, 'error');
    } finally {
        state.aiCompacting = false;
    }
}

const CODE_EDIT_TOOLS = new Set(['set_editor_code', 'edit_code', 'replace_in_code']);

// After the AI changes the sketch, run it in the simulator before the user
// trusts it. Boards the simulator can't run (ESP32, …) are skipped.
async function verifyAiEdit() {
    const container = document.getElementById('aiMessages');
    if (state.currentFile) await saveFile({ quiet: true });
    if (!container || !state.currentSketch || !isSimulatableBoard(state.selectedBoard)) return;
    const pending = document.createElement('div');
    pending.className = 'verify-card pending';
    pending.innerHTML = '<div class="verify-head"><span class="verify-dot"></span><span class="verify-title">Checking in simulator…</span></div>';
    container.appendChild(pending);
    container.scrollTop = container.scrollHeight;
    try {
        if (!await saveFile({ quiet: true })) {
            pending.remove();
            return;
        }
        const result = await runSimulatorCheck({ sketchPath: state.currentSketch, code: state.editor.getValue() });
        const card = renderVerifyCard(result, {
            onFix: (failures) => {
                const input = document.getElementById('aiInput');
                if (!input) return;
                input.value = `The simulator check failed:\n${failures.join('\n')}\nFix the sketch so it compiles and these checks pass.`;
                sendAIMessage();
            }
        });
        pending.replaceWith(card);
        container.scrollTop = container.scrollHeight;
        const report = document.getElementById('testsOutput');
        if (report) renderTestReport(report, result, { title: 'AI edit check' });
    } catch (err) {
        pending.remove();
        logToConsole(`Simulator check failed to run: ${err.message}`, 'error');
    }
}

// The composer pill, the thinking orb and the answer card (morph-orb.js).
let chatOrb = null;

function setupChatOrb() {
    const host = document.querySelector('#aiPanel .ai-panel-inner');
    const list = document.getElementById('aiMessages');
    const slot = host?.querySelector('.mo-slot');
    const input = document.getElementById('aiInput');
    const send = document.getElementById('aiSend');
    if (!host?.querySelector('.mo-root') || !list || !slot || !input || !send) return;
    host.querySelector('.mo-input')?.addEventListener('submit', (e) => e.preventDefault());
    const stopBtn = document.getElementById('aiStopBtn');
    chatOrb = createChatOrb({
        host, list, slot, input, send,
        onBusy: (busy) => { if (stopBtn) stopBtn.hidden = !busy; },
    });
}

/** The answer card that stays in the conversation. */
function buildAnswerMessage(result) {
    const el = document.createElement('div');
    el.className = 'ai-message assistant mo-msg';
    el.innerHTML = '<div class="mo-a-head"><i class="mo-a-dot" aria-hidden="true"></i><span></span></div><div class="mo-a-body"></div>';
    el.querySelector('.mo-a-head span').textContent = result.stopped ? 'Stopped' : result.ok ? ORB_COPY.answerTitle : ORB_COPY.errorTitle;
    el.querySelector('.mo-a-body').innerHTML = formatAIContent(result.content);
    if (!result.stopped && result.content) {
        const copy = document.createElement('button');
        copy.type = 'button';
        copy.className = 'ai-copy-btn';
        copy.title = 'Copy the answer';
        copy.setAttribute('aria-label', 'Copy the answer');
        copy.innerHTML = COPY_ICON;
        copy.addEventListener('click', () => copyText(String(result.content), copy));
        el.querySelector('.mo-a-head').appendChild(copy);
    }
    return el;
}

const COPY_ICON = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
const COPIED_ICON = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

/** Put text on the clipboard; the button shows a tick for a moment. */
async function copyText(text, button) {
    await window.electronAPI.clipboard.writeText(text);
    if (!button) return;
    const before = button.innerHTML;
    button.innerHTML = button.classList.contains('code-copy-btn') ? 'Copied' : COPIED_ICON;
    button.classList.add('copied');
    window.setTimeout(() => {
        button.innerHTML = before;
        button.classList.remove('copied');
    }, 1400);
}

/** Stop the agent (the Stop button and Esc): the turn ends where it is. */
function stopAIMessage() {
    if (!chatOrb?.busy()) return;
    window.electronAPI.ai.cancel?.().catch(() => {});
    if (chatOrb.stop({ ok: false, stopped: true, content: 'Stopped. Nothing after this point was done. Ask again whenever you like.' })) {
        logToConsole('AI stopped', 'info');
    }
}

/** What the agent is told about the editor, the sketch, the board and the port. */
function buildAIContext() {
    const hasFileOpen = !!(state.currentFile || state.currentSketch);
    return {
        code: hasFileOpen && state.editor ? state.editor.getValue() : '',
        sketchPath: state.currentSketch || null,
        board: document.getElementById('boardSelectSidebar')?.value,
        port: document.getElementById('portSelectSidebar')?.value,
        hasFileOpen
    };
}

/** Track token usage and compact the conversation when it nears the context limit. */
function recordAIUsage(data) {
    if (!data?.usage) return;
    const { input: used } = extractTokens(data.usage);
    state.aiTokensUsed += used;
    updateTokenCounter();
    if (state.aiTokensUsed >= AI_COMPACT_THRESHOLD && !state.aiCompacting) {
        compactConversation();
    }
}

/** A fresh conversation: the AI forgets this one, and the starters come back. */
async function newChat() {
    stopAIMessage();
    // Chat mode keeps the list of chats: the IDE's New chat starts a new one there too.
    if (window.impulse.chatLog) await window.impulse.chatLog.startNew();
    else await window.electronAPI.ai.clearHistory?.().catch(() => {});
    clearIdeChat();
    const input = document.getElementById('aiInput');
    if (input) input.focus({ preventScroll: true });
}

/** Empty the IDE's chat panel: the starters come back. */
function clearIdeChat() {
    const container = document.getElementById('aiMessages');
    // The welcome (starters) as it is before the first message.
    state.aiWelcomeHtml = state.aiWelcomeHtml || container?.querySelector('.ai-welcome')?.outerHTML || '';
    if (container && state.aiWelcomeHtml) {
        container.innerHTML = state.aiWelcomeHtml;
        container.scrollTop = 0;
    }
    state.aiTokensUsed = 0;
    updateTokenCounter();
}

async function sendAIMessage() {
    const input = document.getElementById('aiInput');
    const message = input?.value?.trim();

    if (chatOrb?.busy()) return;
    if (!message) {
        chatOrb?.shake();
        return;
    }
    if (window.impulse.chatLog?.busy) {
        updateAIStatus('Wait for the answer in chat mode, or stop it there first.');
        return;
    }

    if (!state.aiProviderConfigured && !await ensureAIModel({ pendingPrompt: message })) return;

    // --- Snapshot current code BEFORE AI edits it ---
    const snapId = takeCodeSnapshot(message);

    addAIMessage('user', message, false, false, snapId);

    const context = buildAIContext();
    const mode = state.aiMode || 'agent';
    window.impulse.chatLog?.user(message, { snapshot: snapId, mode });

    // Agent turns can legitimately take minutes; the orb shows each step
    // (the SDK enforces the real network timeout).
    const work = async (step) => {
        const stop = window.electronAPI.ai.onStep?.(step);
        try {
            const result = await window.electronAPI.ai.processQuery(message, context, mode);
            if (result.stopped) return { ok: false, stopped: true, content: 'Stopped.' };
            if (result.success && result.data) {
                return { ok: true, content: result.data.response || result.data.content || 'No response received', data: result.data };
            }
            return { ok: false, content: result.error || 'Unknown error occurred', code: result.code || null };
        } catch (error) {
            return { ok: false, content: error.message || 'An unexpected error occurred' };
        } finally {
            stop?.();
        }
    };

    const after = (result) => {
        window.impulse.chatLog?.assistant(result, { mode });
        if (!result.ok) {
            logToConsole(`AI Error: ${result.content}`, 'error');
            return;
        }
        const data = result.data || {};
        const editedCode = (data.toolResults || []).some(t => t && t.success && CODE_EDIT_TOOLS.has(t.tool));
        if (editedCode) {
            verifyAiEdit();
        } else if (mode === 'agent' || mode === 'debug') {
            // The answer carries the whole sketch instead of editing the file: write it in for the user.
            applyAnswerCode(result.content).then((applied) => {
                if (!applied) return;
                markAppliedCodeBlocks(document.getElementById('aiMessages'), applied.code);
                logToConsole(`Code written to ${applied.file}`, 'info');
                verifyAiEdit();
            });
        }

        if (data.toolResults && data.toolResults.length > 0) {
            const toolSummary = data.toolResults
                .map(t => `• ${t.tool || 'Action'}: ${t.success ? 'Success' : 'Failed'}`)
                .join('\n');
            addAIMessage('system', `Actions performed:\n${toolSummary}`);
        }

        recordAIUsage(data);
    };

    if (chatOrb) {
        chatOrb.run({ work, render: buildAnswerMessage, after });
        return;
    }
    // No orb (markup missing): answer in place.
    input.value = '';
    const result = await work(() => {});
    const container = document.getElementById('aiMessages');
    container?.appendChild(buildAnswerMessage(result));
    if (container) container.scrollTop = container.scrollHeight;
    after(result);
}

function addAIMessage(role, content, isTemporary = false, isRawHtml = false, snapshotId = null) {
    const container = document.getElementById('aiMessages');
    if (!container) return null;

    const welcome = container.querySelector('.ai-welcome');
    if (welcome) welcome.remove();

    const messageDiv = document.createElement('div');
    messageDiv.className = `ai-message ${role}`;
    if (isTemporary) {
        messageDiv.id = 'temp-message-' + Date.now();
        if (isRawHtml) messageDiv.classList.add('thinking-shimmer');
    }

    messageDiv.innerHTML = isRawHtml ? content : formatAIContent(content);

    // Add revert button to user messages that have a snapshot
    if (role === 'user' && snapshotId) {
        const revertBtn = document.createElement('button');
        revertBtn.className = 'msg-revert-btn';
        revertBtn.dataset.snapshotId = snapshotId;
        revertBtn.title = 'Revert code to state before this prompt';
        revertBtn.innerHTML = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg> Revert`;
        messageDiv.appendChild(revertBtn);
    }

    container.appendChild(messageDiv);
    container.scrollTop = container.scrollHeight;

    return messageDiv.id;
}

function removeAIMessage(id) {
    if (!id) return;
    const el = document.getElementById(id);
    if (el) el.remove();
}

/** AI answers are Markdown: headings, lists, tables, code blocks (markdown.js). */
function formatAIContent(content) {
    return renderMarkdown(content);
}

function setupCodeBlockActions() {
    const aiMessages = document.getElementById('aiMessages');
    if (!aiMessages) return;

    aiMessages.addEventListener('click', (e) => {
        if (e.target.classList.contains('code-copy-btn')) {
            const codeEl = e.target.closest('.code-block-wrapper')?.querySelector('code');
            if (codeEl) copyText(codeEl.textContent, e.target);
            return;
        }
        if (e.target.classList.contains('code-insert-btn')) {
            const wrapper = e.target.closest('.code-block-wrapper');
            if (wrapper) {
                const codeEl = wrapper.querySelector('code');
                if (codeEl) {
                    // textContent gives the real source (entities decoded, <pre>
                    // newlines preserved) — no <br> unescaping needed anymore.
                    insertCodeAtCursor(codeEl.textContent);
                }
            }
        }
    });
}

/**
 * A whole sketch in an answer goes into the open sketch, saved, so the user
 * never has to click Insert. Returns what was written, or null when the
 * answer has no single sketch-shaped block, nothing is open, or the sketch
 * already holds that code.
 */
async function applyAnswerCode(text) {
    const block = sketchBlockFrom(text);
    if (!block || !state.editor || !state.currentSketch) return null;
    // The code belongs in the sketch file, not whichever tab is in front.
    if (state.currentFile && state.currentFile !== state.currentSketch) {
        const i = state.openFiles.findIndex(f => f.path === state.currentSketch);
        if (i < 0) return null;
        if (i !== state.activeTabIndex) switchToTab(i);
    }
    if (state.editor.getValue().trim() === block.code.trim()) return null;
    state.editor.setValue(block.code);
    window.electronAPI.ui.updateEditorCode(block.code);
    if (state.currentFile) await saveFile({ quiet: true });
    return { code: block.code, file: (state.currentFile || state.currentSketch).split(/[\\/]/).pop() };
}

/** Code blocks that were written into the sketch lose their Insert button. */
function markAppliedCodeBlocks(root, code) {
    if (!root || !code) return;
    const want = String(code).trim();
    for (const wrapper of root.querySelectorAll('.code-block-wrapper')) {
        if (wrapper.querySelector('code')?.textContent.trim() !== want) continue;
        const btn = wrapper.querySelector('.code-insert-btn');
        if (!btn) continue;
        const mark = document.createElement('span');
        mark.className = 'code-applied';
        mark.textContent = 'In the sketch';
        btn.replaceWith(mark);
    }
}

function insertCodeAtCursor(code) {
    const ed = activeEditor();
    if (ed) {
        ed.replaceSelection(code);
        ed.focus();
    } else {
        // Fallback or show error
        console.warn('No active editor to insert code');
    }
}

function setupResizers() {
    // Sidebar Resize
    const sidebarResizer = document.getElementById('sidebarResizer');
    const sidebar = document.querySelector('.sidebar');

    if (sidebarResizer && sidebar) {
        let isResizing = false;

        sidebarResizer.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return; // Only left click
            e.preventDefault(); // Prevent text selection

            isResizing = true;
            document.body.classList.add('resizing-col');
            sidebarResizer.classList.add('active');

            const startX = e.clientX;
            const startWidth = sidebar.getBoundingClientRect().width;

            const COLLAPSE_THRESHOLD = 80;

            const onMouseMove = (ev) => {
                if (!isResizing) return;
                const newWidth = startWidth + (ev.clientX - startX);
                if (newWidth < COLLAPSE_THRESHOLD) {
                    // Auto-collapse when dragged past threshold
                    state.sidebarCollapsed = true;
                    sidebar.classList.add('collapsed');
                    sidebar.style.width = '';
                    sidebar.style.flexBasis = '';
                } else if (newWidth <= 600) {
                    // Min 150px when expanding, but allow dragging down to collapse
                    const width = Math.max(150, newWidth);
                    sidebar.classList.remove('collapsed');
                    state.sidebarCollapsed = false;
                    sidebar.style.width = `${width}px`;
                    sidebar.style.flexBasis = `${width}px`;
                }
            };

            const onMouseUp = () => {
                isResizing = false;
                document.body.classList.remove('resizing-col');
                sidebarResizer.classList.remove('active');
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);
                if (state.editor) state.editor.refresh();
            };

            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });
    }

    // Output Panel Resize
    const outputResizer = document.getElementById('outputResizer');
    const outputPanel = document.getElementById('outputPanel');

    if (outputResizer && outputPanel) {
        let isResizing = false;

        outputResizer.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            e.preventDefault();

            isResizing = true;
            document.body.classList.add('resizing-row');
            outputResizer.classList.add('active');

            const startY = e.clientY;
            // Get current COMPUTED height if style.height is not set
            const startHeight = outputPanel.getBoundingClientRect().height;

            const onMouseMove = (ev) => {
                if (!isResizing) return;
                // dragging up (smaller Y) increases height
                const delta = startY - ev.clientY;
                const newHeight = startHeight + delta;

                // Min 28px (header only), Max (window height - 200)
                if (newHeight >= 28 && newHeight <= (window.innerHeight - 200)) {
                    outputPanel.style.height = `${newHeight}px`;
                    outputPanel.style.flexBasis = `${newHeight}px`;
                }
            };

            const onMouseUp = () => {
                isResizing = false;
                document.body.classList.remove('resizing-row');
                outputResizer.classList.remove('active');
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);
                if (state.editor) state.editor.refresh();
            };

            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });
    }
}

function updateAIStatus(message) {
    const statusEl = document.getElementById('aiStatus');
    if (statusEl) statusEl.textContent = message;
}

function updateTokenCounter() {
    const el = document.getElementById('aiTokenCounter');
    if (!el) return;
    const k = Math.round(state.aiTokensUsed / 1000);
    if (k === 0) { el.textContent = ''; return; }
    const pct = Math.min(100, Math.round((state.aiTokensUsed / AI_COMPACT_THRESHOLD) * 100));
    el.textContent = `${k}k`;
    el.title = `~${k}k tokens used (${pct}% of compact threshold)`;
    el.className = 'ai-token-counter' + (pct >= 85 ? ' warn' : pct >= 60 ? ' mid' : '');
}

// Clear only the visual chat — does NOT reset the AI's LLM history.
// Use the compact button to also summarise and reset context.
// ============================================
// Console/Output Functions
// ============================================
// Surface a "not available yet" stub action visibly (toast + console),
// so users get feedback instead of a silent console-only line.

// arduino-cli colours its output; the codes are noise in a plain console.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

function logToConsole(message, type = 'info') {
    const consoleEl = document.getElementById('consoleOutput');
    if (!consoleEl) return;

    const time = new Date().toLocaleTimeString();
    const text = String(message).replace(ANSI, '');
    const line = document.createElement('div');
    line.className = `console-line ${type}`;
    line.textContent = type === 'build' ? text : `[${time}] ${text}`;
    consoleEl.appendChild(line);
    if (consoleEl.childElementCount > 3000) {
        while (consoleEl.childElementCount > 2500) consoleEl.removeChild(consoleEl.firstChild);
    }
    consoleEl.scrollTop = consoleEl.scrollHeight;
}

// note: the message is Impulse's own sentence (UI font), not compiler output.
// focus: bring the Problems tab to the front (not for findings on a build that worked).
function showProblem(message, { note = false, focus = true } = {}) {
    const problemsEl = document.getElementById('problemsOutput');
    if (!problemsEl) return;
    problemsEl.querySelector('.problems-empty')?.remove();
    if (note) {
        const noteEl = document.createElement('div');
        noteEl.className = 'problem-note';
        noteEl.textContent = message;
        problemsEl.appendChild(noteEl);
        if (focus) document.querySelector('.output-tab[data-tab="problems"]')?.click();
        return;
    }

    // Split message by newlines to handle multiple errors
    const lines = message.split('\n');

    lines.forEach(msgLine => {
        if (!msgLine.trim()) return;

        const problemDiv = document.createElement('div');
        problemDiv.className = 'problem-entry';

        // Parse GCC/Arduino error format: filename:line:col: type: message
        // Regex: (path):(line):(col): (type): (message)
        const match = msgLine.match(/^(.+?):(\d+):(\d+):\s*(\w+):\s*(.*)$/);

        if (match) {
            const [, file, line, col, type, text] = match;

            // Location Link
            const locSpan = document.createElement('span');
            locSpan.className = 'problem-location';
            locSpan.textContent = `${file.split(/[\\/]/).pop()}:${line}:${col}`;
            locSpan.title = `Jump to ${file}:${line}`;
            locSpan.onclick = () => {
                if (state.editor) {
                    // CodeMirror is 0-indexed for lines and cols
                    const lineNum = parseInt(line) - 1;
                    const colNum = parseInt(col) - 1;
                    state.editor.setCursor({ line: lineNum, ch: colNum });
                    state.editor.focus();

                    // Highlight line temporarily
                    state.editor.addLineClass(lineNum, 'background', 'line-error-flash');
                    setTimeout(() => {
                        state.editor.removeLineClass(lineNum, 'background', 'line-error-flash');
                    }, 1500);
                }
            };

            // Type Label (Error/Warning)
            const typeSpan = document.createElement('span');
            typeSpan.className = `problem-type ${type.toLowerCase()}`;
            typeSpan.textContent = type;

            // Message
            const msgSpan = document.createElement('span');
            msgSpan.className = 'problem-message';
            msgSpan.textContent = text;

            problemDiv.appendChild(locSpan);
            problemDiv.appendChild(typeSpan);
            problemDiv.appendChild(msgSpan);
        } else {
            // Unparsed line (e.g. "In function 'main':")
            problemDiv.className = 'problem-line';
            problemDiv.textContent = msgLine;
        }

        problemsEl.appendChild(problemDiv);
    });

    // Auto-switch to Problems tab if errors exist
    if (focus && lines.length > 0) {
        document.querySelector('.output-tab[data-tab="problems"]')?.click();
    }
}

function clearProblems() {
    const problemsEl = document.getElementById('problemsOutput');
    if (!problemsEl) return;
    const empty = document.createElement('div');
    empty.className = 'panel-empty problems-empty';
    const title = document.createElement('strong');
    title.textContent = 'No problems';
    const text = document.createElement('span');
    text.textContent = 'Errors and warnings from your last build show here.';
    empty.append(title, text);
    problemsEl.replaceChildren(empty);
}

function displayErrorAnalysis(analysis) {
    // Only fixes that worked before are worth showing: the error's type is internal.
    const fixes = (analysis?.suggestions || []).filter((fix) => fix && (fix.title || fix.solution));
    const problemsEl = document.getElementById('problemsOutput');
    if (!fixes.length || !problemsEl) return;
    problemsEl.querySelector('.problems-empty')?.remove();

    // Text nodes only: fix text can hold "#include <Wire.h>", which innerHTML would swallow.
    const box = document.createElement('div');
    box.className = 'error-analysis';
    const heading = document.createElement('h4');
    heading.textContent = fixes.length === 1 ? 'A fix that worked before' : 'Fixes that worked before';
    const list = document.createElement('ul');
    for (const fix of fixes) {
        const item = document.createElement('li');
        if (fix.title) {
            const title = document.createElement('strong');
            title.textContent = fix.title;
            item.append(title);
        }
        if (fix.solution) {
            const text = document.createElement('div');
            text.textContent = fix.solution;
            item.append(text);
        }
        list.append(item);
    }
    box.append(heading, list);
    problemsEl.append(box);

    document.querySelector('.output-tab[data-tab="problems"]')?.click();
}

// ============================================
// Board/Port Selector Functions
// ============================================
function setupBoardPortSelector() {
    const dropdownBtn = document.getElementById('boardPortDropdown');
    const dropdownMenu = document.getElementById('boardPortDropdownMenu');
    const selectOtherBtn = document.getElementById('selectOtherBoardPort');
    const modal = document.getElementById('boardPortModal');
    const modalClose = document.getElementById('boardPortModalClose');
    const modalCancel = document.getElementById('boardPortModalCancel');
    const modalOk = document.getElementById('boardPortModalOk');
    const boardSearchInput = document.getElementById('boardSearchInput');
    const showAllPorts = document.getElementById('showAllPorts');
    const selector = document.querySelector('.board-port-selector');

    // Toggle dropdown menu
    if (dropdownBtn && dropdownMenu) {
        dropdownBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            selector?.classList.toggle('open');
        });

        // Close dropdown when clicking outside
        document.addEventListener('click', (e) => {
            if (!selector?.contains(e.target)) {
                selector?.classList.remove('open');
            }
        });
    }

    document.getElementById('boardOptionsBtn')?.addEventListener('click', () => {
        selector?.classList.remove('open');
        openBoardOptions();
    });

    // Open modal when "Select other board and port" is clicked
    if (selectOtherBtn && modal) {
        selectOtherBtn.addEventListener('click', () => {
            selector?.classList.remove('open');
            openBoardPortModal();
        });
    }

    // Close modal
    if (modalClose) {
        modalClose.addEventListener('click', closeBoardPortModal);
    }
    if (modalCancel) {
        modalCancel.addEventListener('click', closeBoardPortModal);
    }

    // Modal OK button
    if (modalOk) {
        modalOk.addEventListener('click', async () => {
            const selectedBoard = modal.querySelector('.board-port-list-item.selected[data-board]');
            const selectedPort = modal.querySelector('.board-port-list-item.selected[data-port]');

            if (selectedBoard) {
                const boardFQBN = selectedBoard.dataset.board;
                const boardName = selectedBoard.dataset.name || selectedBoard.textContent.trim();
                // A popular board whose core is missing: one download first, then it is an ordinary board.
                if (selectedBoard.dataset.coreKey && !installedPlatforms().has(boardFQBN.split(':').slice(0, 2).join(':'))) {
                    modalOk.disabled = true;
                    const ready = await ensureCoreInstalled(selectedBoard.dataset.coreKey, boardName).finally(() => { modalOk.disabled = false; });
                    if (!ready) return;
                    await loadBoards();
                }
                // Catalog boards that need an option (an STM32 variant, the Nano's bootloader) remember it.
                if (selectedBoard.dataset.options) {
                    try { saveChoices(baseFqbn(boardFQBN), JSON.parse(selectedBoard.dataset.options)); } catch { /* no options */ }
                }
                document.getElementById('boardSelectSidebar').value = boardFQBN;
                state.selectedBoard = boardFQBN;
                state.context.selectedBoard = boardFQBN;
                announceBoard();
                updateBoardPortDisplay(boardName, null);
                if (window.electronAPI?.ui?.updateBoard) {
                    window.electronAPI.ui.updateBoard(boardFQBN);
                }
            }

            if (selectedPort) {
                const port = selectedPort.dataset.port;
                document.getElementById('portSelectSidebar').value = port;
                state.selectedPort = port;
                state.context.selectedPort = port;
                syncBoardFqbn();
                const display = document.getElementById('boardPortDisplay');
                const currentText = display.textContent;
                updateBoardPortDisplay(currentText.split(' on ')[0], port);
                if (window.electronAPI?.ui?.updatePort) {
                    window.electronAPI.ui.updatePort(port);
                }
            }

            updateAIContext();
            saveSession();
            loadSavedBoardPortOptions();
            closeBoardPortModal();
        });
    }

    // Board search
    if (boardSearchInput) {
        boardSearchInput.addEventListener('input', (e) => {
            filterBoardList(e.target.value);
        });
    }

    // Show all ports checkbox
    if (showAllPorts) {
        showAllPorts.addEventListener('change', (e) => {
            renderPortList(e.target.checked);
        });
    }

    // Load saved options
    loadSavedBoardPortOptions();
}

async function openBoardPortModal() {
    const modal = document.getElementById('boardPortModal');
    if (!modal) return;
    modal.classList.add('open');
    renderBoardList();
    renderPortList(false);
    if (!state.boardCatalog && !state.boardCatalogLoading) {
        state.boardCatalogLoading = true;
        try {
            const res = await window.electronAPI.arduino.boardCatalog?.();
            if (res?.success) state.boardCatalog = res.data;
        } catch (e) {
            console.warn('[boards] catalog unavailable:', e);
        } finally {
            state.boardCatalogLoading = false;
        }
        if (modal.classList.contains('open')) renderBoardList();
    }
}

/** The platforms (vendor:arch) whose cores arduino-cli lists as installed. */
function installedPlatforms() {
    return new Set((state.boards || []).map(b => String(b.fqbn || '').split(':').slice(0, 2).join(':')));
}

/**
 * Install the core a catalog board needs (one download, like Arduino IDE's
 * Boards Manager), with the footer showing progress. True when it is there.
 */
async function ensureCoreInstalled(key, boardName) {
    const info = await window.electronAPI.toolchain?.extraCore?.(key).catch(() => null);
    if (!info?.success) {
        logToConsole(`Could not check the core for ${boardName}: ${info?.error || 'the toolchain is not ready'}`, 'error');
        return false;
    }
    if (info.data.installed) return true;
    const { label, size } = info.data;
    const ok = await confirmDialog(`Install ${label}?`,
        `${boardName} needs ${label}: a one-time download of ${size}. Impulse installs it with arduino-cli, as Arduino IDE's Boards Manager does.`,
        { confirmLabel: 'Install' });
    if (!ok) return false;
    logToConsole(`Installing ${label} (${size})…`, 'info');
    setBuildStatus(`Installing ${label}…`, 'busy');
    const stop = window.electronAPI.toolchain.onProgress((p) => setBuildStatus(p.percent === null ? p.message : `${p.message} ${p.percent}%`, 'busy'));
    const res = await window.electronAPI.toolchain.installCore(key).catch(e => ({ success: false, error: e.message }));
    stop?.();
    if (!res?.success) {
        setBuildStatus(`Could not install ${label}`, 'error', { linger: true });
        logToConsole(`Could not install ${label}: ${res?.error || 'unknown error'}`, 'error');
        return false;
    }
    setBuildStatus(`${label} installed`, 'ok', { linger: true });
    logToConsole(`${label} installed.`, 'success');
    return true;
}

function closeBoardPortModal() {
    const modal = document.getElementById('boardPortModal');
    if (modal) {
        modal.classList.remove('open');
        // Clear search
        const searchInput = document.getElementById('boardSearchInput');
        if (searchInput) searchInput.value = '';
        filterBoardList('');
    }
}

function renderBoardList() {
    const boardList = document.getElementById('boardList');
    if (!boardList) return;
    boardList.innerHTML = '';
    const installed = installedPlatforms();
    const installedFqbns = new Set((state.boards || []).map(b => b.fqbn));
    const item = ({ fqbn, name, hint = '', badge = '', extra = {} }) => {
        const el = document.createElement('div');
        el.className = 'board-port-list-item';
        el.dataset.board = fqbn;
        el.dataset.name = name;
        for (const [k, v] of Object.entries(extra)) if (v) el.dataset[k] = v;
        if (state.selectedBoard === fqbn || baseFqbn(state.selectedBoard) === fqbn) el.classList.add('selected');
        el.innerHTML = `<span class="board-port-list-item-icon">${ICONS.chip}</span><span>${escapeHtml(name)}${hint ? ` <span class="board-port-list-item-hint">${escapeHtml(hint)}</span>` : ''}</span>${badge ? `<span class="board-port-badge">${escapeHtml(badge)}</span>` : ''}`;
        el.addEventListener('click', () => {
            boardList.querySelectorAll('.board-port-list-item').forEach(i => i.classList.remove('selected'));
            el.classList.add('selected');
        });
        return el;
    };
    const header = (text) => {
        const el = document.createElement('div');
        el.className = 'board-port-group';
        el.textContent = text;
        return el;
    };

    // Popular boards: the catalog, grouped by family, best-known first.
    const catalog = state.boardCatalog || [];
    if (catalog.length) {
        const groups = new Map();
        for (const b of catalog) {
            if (!groups.has(b.familyTitle)) groups.set(b.familyTitle, []);
            groups.get(b.familyTitle).push(b);
        }
        const popular = document.createElement('div');
        popular.className = 'board-port-section';
        popular.dataset.section = 'popular';
        popular.appendChild(header('Popular boards'));
        for (const [title, boards] of groups) {
            const group = document.createElement('div');
            group.className = 'board-port-family';
            group.appendChild(header(title));
            for (const b of boards) {
                const have = installed.has(b.platform);
                group.appendChild(item({
                    fqbn: b.fqbn, name: b.name,
                    badge: have ? (b.sim ? 'simulates' : '') : 'core download',
                    extra: { coreKey: have ? '' : b.coreKey || '', options: Object.keys(b.options || {}).length ? JSON.stringify(b.options) : '', catalogId: b.id },
                }));
            }
            popular.appendChild(group);
        }
        boardList.appendChild(popular);
    } else if (state.boardCatalogLoading) {
        boardList.appendChild(header('Loading popular boards…'));
    }

    // Every board of the installed cores, behind a toggle.
    const all = document.createElement('div');
    all.className = 'board-port-section';
    all.dataset.section = 'all';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'board-port-toggle';
    toggle.setAttribute('aria-expanded', state.boardListShowAll ? 'true' : 'false');
    toggle.textContent = `${state.boardListShowAll ? 'Hide' : 'Show'} all installed boards (${(state.boards || []).length})`;
    toggle.addEventListener('click', () => { state.boardListShowAll = !state.boardListShowAll; renderBoardList(); });
    all.appendChild(toggle);
    if (state.boardListShowAll || !catalog.length) {
        for (const board of state.boards || []) all.appendChild(item({ fqbn: board.fqbn, name: board.name, extra: { installedFqbn: installedFqbns.has(board.fqbn) ? '1' : '' } }));
    }
    boardList.appendChild(all);
    const search = document.getElementById('boardSearchInput');
    if (search?.value) filterBoardList(search.value);
}

function filterBoardList(searchTerm) {
    const term = searchTerm.toLowerCase().trim();
    const list = document.getElementById('boardList');
    if (!list) return;
    // Searching looks through every installed board too, not only the popular ones.
    if (term && !state.boardListShowAll && !list.querySelector('.board-port-section[data-section="all"] .board-port-list-item')) {
        state.boardListShowAll = true;
        renderBoardList();
        return;
    }
    list.querySelectorAll('.board-port-list-item').forEach(el => {
        const text = `${el.dataset.name || ''} ${el.dataset.board || ''} ${el.textContent}`.toLowerCase();
        el.style.display = !term || text.includes(term) ? 'flex' : 'none';
    });
    list.querySelectorAll('.board-port-family').forEach(group => {
        const visible = [...group.querySelectorAll('.board-port-list-item')].some(el => el.style.display !== 'none');
        group.style.display = visible ? '' : 'none';
    });
    list.querySelectorAll('.board-port-section').forEach(section => {
        const visible = [...section.querySelectorAll('.board-port-list-item')].some(el => el.style.display !== 'none');
        section.querySelectorAll(':scope > .board-port-group').forEach(h => { h.style.display = visible ? '' : 'none'; });
    });
}

function renderPortList(showAll) {
    const portList = document.getElementById('portList');
    if (!portList) return;

    portList.innerHTML = '';

    // USB ports by default; Bluetooth and system ports only with "Show all".
    const usb = state.ports.filter(p => p.vid);
    const portsToShow = sortPorts(showAll || !usb.length ? state.ports : usb);

    if (portsToShow.length === 0) {
        portList.innerHTML = '<div style="padding: 16px; color: var(--muted-foreground); text-align: center;">No ports available</div>';
        return;
    }

    portsToShow.forEach(port => {
        const item = document.createElement('div');
        item.className = 'board-port-list-item';
        item.dataset.port = port.port;
        if (state.selectedPort === port.port) {
            item.classList.add('selected');
        }

        item.innerHTML = `
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" class="board-port-list-item-icon">
                <path d="M21 16V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2h14a2 2 0 002-2zM7 10h10M7 14h10"/>
            </svg>
            <span>${escapeHtml(port.port)} <span class="board-port-list-item-hint">${escapeHtml(describePort(port))}</span></span>
        `;

        item.addEventListener('click', () => {
            // Toggle selection
            portList.querySelectorAll('.board-port-list-item').forEach(i => i.classList.remove('selected'));
            item.classList.add('selected');
        });

        portList.appendChild(item);
    });
}

function loadSavedBoardPortOptions() {
    const savedOptions = document.getElementById('boardPortSavedOptions');
    if (!savedOptions) return;

    // Always rebuild — this is re-run after each selection, so clear stale rows.
    savedOptions.innerHTML = '';

    // Get current selection
    const currentBoard = state.selectedBoard;
    const currentPort = state.selectedPort;

    if (currentBoard || currentPort) {
        const board = state.boards.find(b => b.fqbn === currentBoard);
        const port = state.ports.find(p => p.port === currentPort);

        if (board || port) {
            const option = document.createElement('div');
            option.className = 'board-port-saved-option selected';
            option.innerHTML = `
                <span>${escapeHtml(board ? board.name : 'No board')}${port ? ` on ${escapeHtml(port.port)}` : ''}</span>
            `;

            option.addEventListener('click', () => {
                if (board) {
                    document.getElementById('boardSelectSidebar').value = board.fqbn;
                    state.selectedBoard = board.fqbn;
                    state.context.selectedBoard = board.fqbn;
                    announceBoard();
                }
                if (port) {
                    document.getElementById('portSelectSidebar').value = port.port;
                    state.selectedPort = port.port;
                    state.context.selectedPort = port.port;
                }
                updateBoardPortDisplay(board?.name || 'No board', port?.port || null);
                updateAIContext();
                document.querySelector('.board-port-selector')?.classList.remove('open');
            });

            savedOptions.appendChild(option);
        }
    }
}

function updateBoardPortDisplay(boardName, port) {
    window.dispatchEvent(new CustomEvent('impulse:board-display'));
    window.dispatchEvent(new CustomEvent('impulse:serial-state'));
    const display = document.getElementById('boardPortDisplay');
    if (display) {
        if (boardName && port) {
            display.textContent = `${boardName} on ${port}`;
        } else if (boardName) {
            display.textContent = boardName;
        } else {
            display.textContent = 'Choose a board';
        }
    }
}

// ============================================
// Helper Functions
// ============================================

// The simulator keeps each sketch's circuit in diagram.json next to it, so it
// needs to know when the open sketch or the upload board changes.
let announcedSketch;
// ============================================
// PlatformIO projects
// ============================================
/** Stands in for a board FQBN in a PlatformIO project: platformio.ini names the board. */
const PIO_FQBN = 'platformio:project';
const normPath = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** Whether a file is inside the open PlatformIO project. */
function inPioProject(filePath) {
    if (!state.pio || !filePath) return false;
    const root = normPath(state.pio.root);
    const p = normPath(filePath);
    return p === root || p.startsWith(`${root}/`);
}

/** A file that is "the sketch": an .ino, or a C/C++ source of a PlatformIO project. */
function isSketchSource(filePath) {
    const ext = (String(filePath).split('.').pop() || '').toLowerCase();
    return ext === 'ino' || (inPioProject(filePath) && ['c', 'cc', 'cpp', 'cxx'].includes(ext));
}

/** Look up the PlatformIO project of a file (when it changes) and refresh what depends on it. */
async function syncPlatformio(filePath) {
    if (!filePath || !window.electronAPI?.platformio || inPioProject(filePath)) return;
    const info = await window.electronAPI.platformio.project(filePath).catch(() => null);
    const changed = (info?.root || null) !== (state.pio?.root || null);
    state.pio = info;
    if (changed) {
        if (info) logToConsole(info.error ? `PlatformIO project: ${info.error}` : `PlatformIO project · environment ${info.env}`, info.error ? 'warning' : 'info');
        const active = state.openFiles[state.activeTabIndex];
        if (active && isSketchSource(active.path)) state.currentSketch = active.path;
        else if (state.currentSketch && !isSketchSource(state.currentSketch)) state.currentSketch = null;
        announceSketch();
    }
    renderPioStatus();
}

function renderPioStatus() {
    const el = document.getElementById('statusPio');
    if (!el) return;
    el.hidden = !state.pio;
    if (!state.pio) return;
    el.dataset.state = state.pio.error ? 'error' : 'ok';
    el.textContent = state.pio.error ? 'PlatformIO: not available' : `PlatformIO · ${state.pio.env}`;
    el.title = state.pio.error || `PlatformIO environment for Verify and Upload (click to change). ${state.pio.envs.length} in platformio.ini.`;
}

/** Tools › PlatformIO Environment (or the status bar): choose the environment to build. */
async function choosePioEnv() {
    if (!state.pio) {
        logToConsole('Open a file of a PlatformIO project (a folder with platformio.ini) first.', 'warning');
        return;
    }
    if (state.pio.error) {
        await askDialog({ title: 'PlatformIO', message: state.pio.error, confirmLabel: 'OK', cancelLabel: 'Close' });
        return;
    }
    const choice = await askDialog({
        title: 'PlatformIO environment',
        message: 'Verify and Upload build this environment. The simulator picks the environment for its board (Uno, Nano or Mega 2560).',
        options: state.pio.envs.map(e => ({ value: e.name, label: e.name, hint: `${e.board}${e.simBoard ? ' · can be simulated' : ''}` })),
        confirmLabel: 'Use'
    });
    if (!choice || choice === state.pio.env) return;
    const info = await window.electronAPI.platformio.selectEnv(state.pio.root, choice);
    if (info) state.pio = info;
    renderPioStatus();
    logToConsole(`PlatformIO environment: ${state.pio.env}`, 'info');
}

/** The Source Control panel (set up once the UI is ready). */
let sourceControl = null;

/** Read a short message to screen readers. */
function announceStatus(text) {
    let el = document.getElementById('srStatus');
    if (!el) {
        el = document.createElement('div');
        el.id = 'srStatus';
        el.className = 'sr-only';
        el.setAttribute('role', 'status');
        el.setAttribute('aria-live', 'polite');
        document.body.appendChild(el);
    }
    el.textContent = text;
}

function announceSketch() {
    if (announcedSketch === state.currentSketch) return;
    announcedSketch = state.currentSketch;
    window.dispatchEvent(new CustomEvent('impulse:sketch-changed', { detail: { sketch: state.currentSketch } }));
}

function announceBoard() {
    window.dispatchEvent(new CustomEvent('impulse:board-changed', { detail: { fqbn: state.selectedBoard } }));
    syncBoardFqbn();
}

// ============================================
// Board options (Tools › Board Options)
// ============================================
const boardOptionCache = new Map();

async function getBoardOptions(base) {
    if (!base) return [];
    if (!boardOptionCache.has(base)) {
        const res = await window.electronAPI.arduino.boardOptions?.(base).catch(() => null);
        if (!res?.success) return [];
        boardOptionCache.set(base, res.data || []);
    }
    return boardOptionCache.get(base);
}

function selectedPortInfo() {
    const port = document.getElementById('portSelectSidebar')?.value || state.selectedPort;
    return (state.ports || []).find(p => p.port === port) || null;
}

const announcedSuggestions = new Set();

/** The FQBN compile and upload use: the board plus its chosen options. */
async function fqbnFor(board) {
    const base = baseFqbn(board);
    const options = await getBoardOptions(base);
    const port = selectedPortInfo();
    const suggested = suggestedChoices(options, port);
    const own = loadChoices()[base] || {};
    if (suggested.CDCOnBoot && !own.CDCOnBoot && !announcedSuggestions.has(base)) {
        announcedSuggestions.add(base);
        logToConsole('This ESP32 is on its built-in USB port, so "USB CDC On Boot" is on: Serial output appears in the serial monitor. Change it in Tools › Board Options.', 'info');
    }
    return composeFqbn(base, options, effectiveChoices(base, options, port));
}

/** Tell the main process (AI tools) the full FQBN, options included. */
async function syncBoardFqbn() {
    if (!state.selectedBoard) return;
    const fqbn = await fqbnFor(state.selectedBoard).catch(() => state.selectedBoard);
    state.context.selectedFqbn = fqbn;
    window.electronAPI?.ui?.updateBoard?.(fqbn);
}

async function openBoardOptions() {
    const base = baseFqbn(state.selectedBoard || document.getElementById('boardSelectSidebar')?.value);
    if (!base) {
        logToConsole('Select a board first.', 'warning');
        window.notifications?.warning?.('Choose a board first, then open its options.');
        document.getElementById('boardPortDropdown')?.click();
        return;
    }
    const options = await getBoardOptions(base);
    const boardName = state.boards.find(b => b.fqbn === base)?.name || base;
    if (!options.length) {
        await askDialog({ title: `${boardName} options`, message: 'This board has no options to choose.', confirmLabel: 'Done', cancelLabel: 'Close' });
        return;
    }
    const port = selectedPortInfo();
    const choices = await boardOptionsDialog({ boardName, options, choices: effectiveChoices(base, options, port), suggested: suggestedChoices(options, port) });
    if (!choices) return;
    saveChoices(base, choices);
    const fqbn = composeFqbn(base, options, choices);
    logToConsole(`Board options saved: ${fqbn}`, 'success');
    syncBoardFqbn();
}

// ============================================
// Build stream: every compile and upload as it runs
// ============================================
// The main process runs one build at a time and streams it (see
// main/services/buildJobs.js): the console shows each line as the tools print
// it, the Verify/Upload button shows the stage and the upload percentage, and
// the end brings Arduino IDE's memory summary or what went wrong.
const BUILD_BUTTON_LABEL = {
    starting: 'Starting', compiling: 'Compiling', detecting: 'Compiling', 'compiling-sketch': 'Compiling', 'compiling-libraries': 'Compiling',
    'compiling-core': 'Compiling core', linking: 'Linking', sizing: 'Compiling', uploading: 'Uploading', connecting: 'Connecting',
    erasing: 'Erasing', writing: 'Uploading', verifying: 'Verifying', resetting: 'Resetting',
};
let liveBuild = null;

function buildBoardName(fqbn) {
    if (!fqbn) return 'the board';
    if (fqbn === PIO_FQBN) return `the PlatformIO environment${state.pio?.env ? ` ${state.pio.env}` : ''}`;
    const base = baseFqbn(fqbn);
    return state.boards?.find(b => b.fqbn === base)?.name || base.split(':').pop();
}

let buildStatusTimer = null;

/** The footer's build item: the stage while a build runs, the outcome for a few seconds after. */
function setBuildStatus(text, state, { linger = false } = {}) {
    const el = document.getElementById('statusBuild');
    if (!el) return;
    clearTimeout(buildStatusTimer);
    el.hidden = !text;
    if (!text) return;
    el.dataset.state = state;
    el.querySelector('.status-text').textContent = text;
    if (linger) buildStatusTimer = setTimeout(() => { el.hidden = true; }, 12000);
}

function updateBuildButtons() {
    const b = liveBuild;
    if (!b) return;
    const label = BUILD_BUTTON_LABEL[b.stage] || (b.kind === 'upload' ? 'Uploading' : 'Compiling');
    const text = b.percent !== null ? `${label} ${b.percent}%` : `${label}…`;
    setButtonState(b.kind === 'upload' ? 'uploadBtn' : 'compileBtn', true, text);
    setBuildStatus(text, 'busy');
}

function setupBuildStream() {
    if (!window.electronAPI?.arduino?.onBuildEvent) return;
    window.electronAPI.arduino.onBuildEvent((ev) => {
        if (ev.phase === 'start') {
            liveBuild = { id: ev.jobId, kind: ev.kind, stage: 'starting', percent: null, port: ev.port };
            const name = buildBoardName(ev.fqbn);
            showOutputTab('console');
            logToConsole(ev.kind === 'upload' ? `Uploading to ${name} on ${ev.port}…` : `Compiling for ${name}…`, 'info');
            setButtonState('compileBtn', true, 'Verify');
            setButtonState('uploadBtn', true, 'Upload');
            updateBuildButtons();
            return;
        }
        if (!liveBuild || ev.jobId !== liveBuild.id) return;
        if (ev.phase === 'output') {
            for (const line of ev.lines) logToConsole(line, 'build');
        } else if (ev.phase === 'stage') {
            liveBuild.stage = ev.stage;
            liveBuild.percent = null;
            updateBuildButtons();
        } else if (ev.phase === 'progress') {
            liveBuild.percent = ev.percent;
            updateBuildButtons();
        } else if (ev.phase === 'done') {
            const b = liveBuild;
            liveBuild = null;
            setButtonState('compileBtn', false, 'Verify');
            setButtonState('uploadBtn', false, 'Upload');
            if (ev.ok) {
                for (const line of ev.summary || []) logToConsole(line, 'info');
                logToConsole(b.kind === 'upload' ? `Done uploading to ${ev.port || b.port}.` : 'Done compiling.', 'success');
                const flash = ev.result?.memory?.flash;
                const size = flash?.used ? ` · ${flash.used.toLocaleString()} bytes${flash.percent !== null && flash.percent !== undefined ? ` (${flash.percent}%)` : ''}` : '';
                setBuildStatus(b.kind === 'upload' ? `Uploaded to ${ev.port || b.port}` : `Compiled${size}`, 'ok', { linger: true });
            } else if (ev.error?.code === 'CANCELLED') {
                logToConsole('Stopped.', 'warning');
                setBuildStatus('Stopped', 'warning', { linger: true });
            } else {
                for (const line of ev.summary || []) logToConsole(line, 'info');
                logToConsole(`${ev.error?.title || (b.kind === 'upload' ? 'The upload failed' : 'The sketch did not compile')}${ev.error?.hint ? ` ${ev.error.hint}` : ''}`, 'error');
                setBuildStatus(ev.error?.title || (b.kind === 'upload' ? 'Upload failed' : 'Compile failed'), 'error', { linger: true });
            }
        }
    });
}

/**
 * What the Problems panel shows for a failed build: what went wrong and what
 * to do, then each diagnostic as "file:line:col: level: message" (the panel
 * makes those clickable). The whole log stays in the console.
 */
// A failed build: Impulse's explanation first (a sentence when the main process
// recognised the failure), then the compiler lines it rests on.
function showBuildProblem(result) {
    const head = result.title || result.error || '';
    const headLine = head && result.hint ? `${/[.!?:]$/.test(head) ? head : `${head}.`} ${result.hint}` : head;
    if (headLine) showProblem(headLine, { note: !!result.title });
    const lines = [];
    for (const d of result.diagnostics || []) lines.push(`${d.file}:${d.line}:${d.col ?? 1}: ${d.level}: ${d.message}`);
    if (!(result.diagnostics || []).length && result.excerpt && result.excerpt !== head) lines.push(result.excerpt);
    if (lines.length) showProblem(lines.join('\n'));
    if (!headLine && !lines.length) showProblem(result.output || 'The build failed.');
}

function setButtonState(buttonId, disabled, text) {
    const btn = document.getElementById(buttonId);
    if (!btn) return;
    btn.disabled = !!disabled;
    btn.classList.toggle('busy', !!disabled);
    btn.setAttribute('aria-busy', disabled ? 'true' : 'false');
    if (text) btn.setAttribute('aria-label', text);
}

// ============================================
// Simulation Panel
// ============================================

let simManager = null;
let simActive = false;

function setupSimulation() {
    const simView = document.getElementById('simView');
    const simEditorSlot = document.getElementById('simEditorSlot');
    if (!simView || !simEditorSlot) return;

    simManager = new SimulationManager();
    window.simManager = simManager;
    // The agent reads the circuit from the main process: publish it on every change.
    let circuitTimer = null;
    const publishCircuit = () => {
        clearTimeout(circuitTimer);
        circuitTimer = setTimeout(() => {
            try { window.electronAPI.ui.updateCircuit?.(simManager.circuitFacts()); } catch (e) { console.warn('[circuit] could not publish:', e); }
        }, 250);
    };
    window.addEventListener('impulse:circuit-changed', publishCircuit);
    publishCircuit();
    // The Serial Plotter also graphs what the simulated board prints.
    window.addEventListener('impulse:sim-serial-line', (e) => {
        if (state.plotter.running) feedPlotterData(e.detail);
    });
}

// Small API the simulator uses to open example sketches.
window.impulse = {
    /**
     * One chat exchange with a stand-in agent (tests and demos): `work(step)`
     * resolves to { ok, content }. The question goes in as the user typed it.
     */
    askWith(text, work) {
        if (!chatOrb || chatOrb.busy()) return false;
        addAIMessage('user', text);
        document.getElementById('aiInput').value = text;
        return chatOrb.run({ work, render: buildAnswerMessage });
    },
    get chatPhase() { return chatOrb?.phase ?? null; },
    async openSketch(folderPath, filePath) {
        if (folderPath) await loadFolder(folderPath);
        const res = await window.electronAPI.file.read(filePath);
        if (!res?.success) {
            logToConsole(res?.error || `Could not open ${filePath}`, 'error');
            return false;
        }
        showEditor();
        addOrFocusFile(filePath, res.content, filePath.split(/[/\\]/).pop());
        switchToTab(state.openFiles.findIndex(f => f.path === filePath));
        saveSession();
        return true;
    },
    /** Open a file (if it isn't already) and scroll to a line. */
    async revealLine(filePath, line) {
        const same = (a, b) => a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();
        let index = state.openFiles.findIndex(f => same(f.path, filePath));
        if (index < 0) {
            const res = await window.electronAPI.file.read(filePath);
            if (!res?.success) return false;
            showEditor();
            addOrFocusFile(filePath, res.content, filePath.split(/[/\\]/).pop());
            index = state.openFiles.findIndex(f => same(f.path, filePath));
        }
        if (index !== state.activeTabIndex) switchToTab(index);
        if (state.editor && line) state.editor.scrollIntoView({ line: line - 1, ch: 0 }, 80);
        return true;
    },
    showSimulator() {
        // Chat mode shows the simulator in its side panel.
        if (inChatMode() && window.impulse.shell) {
            window.impulse.shell.openBench('sim');
            return;
        }
        const view = document.getElementById('simView');
        if (simActive && view && view.style.display === 'flex') return;
        simActive = false;
        toggleSimView();
    }
};

document.addEventListener('DOMContentLoaded', () => {
    // Delay to let renderer.js initialize first
    setTimeout(() => {
        setupSimulation();
        patchActivityBarForSim();
    }, 500);
});

function patchActivityBarForSim() {
    const simIcon = document.querySelector('.activity-icon[data-panel="simulate"]');
    if (!simIcon) return;

    simIcon.addEventListener('click', (e) => {
        e.stopImmediatePropagation();
        toggleSimView();
    });
}

function toggleSimView() {
    const simView = document.getElementById('simView');
    const editorContainer = document.querySelector('.editor-container');
    const simEditorSlot = document.getElementById('simEditorSlot');
    const workspaceRow = document.getElementById('arduinoWorkspace');

    if (!simView || !editorContainer) return;

    simActive = !simActive;

    // Update activity icon active state
    document.querySelectorAll('.activity-icon[data-panel]').forEach(i => i.classList.remove('active'));
    if (simActive) {
        document.querySelector('.activity-icon[data-panel="simulate"]')?.classList.add('active');
    }

    const sidebar = document.getElementById('sidebar');
    const resizer = document.getElementById('sidebarResizer');

    if (simActive) {
        // Move editor into sim slot so it stays live
        if (simEditorSlot && editorContainer && !simEditorSlot.contains(editorContainer)) {
            simEditorSlot.appendChild(editorContainer);
        }
        simView.style.display = 'flex';
        simView.style.flex = '1';
        simView.style.minHeight = '0';

        if (sidebar) sidebar.style.display = 'none';
        if (resizer) resizer.style.display = 'none';
        // main-area is empty while the editor lives in the sim slot — collapse it
        if (workspaceRow) workspaceRow.style.display = 'none';

        // Refresh editor layout after the move
        setTimeout(() => window.state?.editor?.refresh?.(), 50);
        simManager?.onShow?.();
    } else {
        // Move editor back into the main workspace area
        if (workspaceRow) {
            workspaceRow.style.display = '';
            if (editorContainer && editorContainer.parentNode !== workspaceRow) {
                workspaceRow.appendChild(editorContainer);
            }
        }
        simView.style.display = 'none';
        if (sidebar) sidebar.style.display = '';
        if (resizer) resizer.style.display = '';
        document.querySelector('.activity-icon[data-panel="explorer"]')?.click();
        setTimeout(() => window.state?.editor?.refresh?.(), 50);
    }
}

// ============================================
// Chat mode bridge (window.impulse)
// ============================================
// Chat mode (src/renderer/vibe) is the default view. It drives the same
// editor, board, serial port, simulator and agent as the IDE through these
// calls, so both views always show the same state.

function inChatMode() {
    return document.documentElement.dataset.shell === 'vibe';
}

/** Chat mode's code panel: a second editor on the IDE editor's document. */
let linkedEditor = null;

/** The editor an edit goes to: the focused one; else the IDE's, or in chat mode the code panel's while it shows. */
function activeEditor() {
    const focused = document.activeElement?.closest?.('.CodeMirror')?.CodeMirror;
    if (focused) return focused;
    if (!inChatMode()) return state.editor;
    return linkedEditor && linkedEditor.getWrapperElement().offsetParent !== null ? linkedEditor : null;
}

const baseName = (p) => String(p || '').split(/[/\\]/).pop();
const parentDir = (p) => String(p || '').replace(/[/\\][^/\\]*$/, '');
const CODE_FILE = /\.(ino|h|hpp|hh|c|cc|cpp|cxx|s)$/i;

function currentBoard() {
    const fqbn = state.selectedBoard || null;
    const port = document.getElementById('portSelectSidebar')?.value || state.selectedPort || null;
    const board = fqbn ? state.boards.find(b => b.fqbn === fqbn) : null;
    return {
        fqbn,
        name: board?.name || (fqbn ? fqbn.split(':').pop() : null),
        port: port || null,
        portPresent: !!port && (state.ports || []).some(p => p.port === port),
    };
}

/** Select a board by FQBN (options ignored) when its core is installed; false when it is not. */
function chooseBoard(fqbn) {
    const base = baseFqbn(fqbn || '');
    const boardSel = document.getElementById('boardSelectSidebar');
    if (!base || !boardSel || !(state.boards || []).some(b => b.fqbn === base)) return false;
    if (state.selectedBoard !== base) {
        boardSel.value = base;
        boardSel.dispatchEvent(new Event('change'));
    }
    return true;
}

/** Use a plugged-in board's port, and the board arduino-cli recognises on it. */
function chooseBoardPort(port) {
    const p = (state.ports || []).find(x => x.port === port);
    const boardSel = document.getElementById('boardSelectSidebar');
    const portSel = document.getElementById('portSelectSidebar');
    if (!p || !portSel) return { ok: false };
    const candidates = (p.boards || []).filter(b => b.fqbn && state.boards.some(x => x.fqbn === b.fqbn));
    const keep = candidates.find(b => b.fqbn === baseFqbn(state.selectedBoard || ''));
    const pick = keep || (candidates.length === 1 ? candidates[0] : null);
    if (pick && !keep && boardSel) {
        boardSel.value = pick.fqbn;
        boardSel.dispatchEvent(new Event('change'));
    }
    portSel.value = port;
    portSel.dispatchEvent(new Event('change'));
    return { ok: true, board: pick?.name || null, needsBoard: !pick && !state.selectedBoard };
}

function currentProject() {
    const file = state.currentSketch;
    if (!file) return null;
    const folder = parentDir(file);
    return { name: baseName(folder), folder, file };
}

/** The sketch in a folder: <folder>/<folder>.ino, else its first .ino. */
async function sketchIn(folder) {
    const res = await window.electronAPI.folder.list(folder).catch(() => null);
    const inos = (res?.entries || []).filter(e => !e.isDirectory && /\.ino$/i.test(e.name));
    return (inos.find(e => e.name.toLowerCase() === `${baseName(folder).toLowerCase()}.ino`) || inos[0])?.path || null;
}

async function openProjectFolder(folder) {
    const file = await sketchIn(folder);
    if (file) {
        if (!await window.impulse.openSketch(folder, file)) return null;
    } else if (!await loadFolder(folder)) {
        return null;
    }
    return { name: baseName(folder), folder, file };
}

/** Save everything and close the open sketch: the next chat starts clean. */
async function closeProject() {
    await saveAllFiles().catch(() => false);
    state.folderRoot = null;
    state.expandedDirs.clear();
    const tree = document.getElementById('fileTree');
    if (tree) tree.innerHTML = '';
    const label = document.getElementById('folderLabel');
    if (label) label.innerHTML = `<span class="folder-icon">${ICONS.folder}</span><span>No folder open</span>`;
    showWelcomeState();
    state.editor?.setValue('');
    window.electronAPI.ui.updateSketchPath(null);
    updateAIContext();
    saveSession();
}

function serialState() {
    return {
        connected: !!state.serialConnected,
        port: document.getElementById('portSelectSidebar')?.value || null,
        baud: parseInt(document.getElementById('baudRate')?.value || '115200', 10) || 115200,
    };
}

/** Run the sketch in the simulator after the AI changed it (null: nothing to check). */
async function verifyInSimulator() {
    if (state.currentFile && !await saveFile({ quiet: true })) return null;
    if (!state.currentSketch || !isSimulatableBoard(state.selectedBoard) || !state.editor) return null;
    try {
        const result = await runSimulatorCheck({ sketchPath: state.currentSketch, code: state.editor.getValue() });
        const report = document.getElementById('testsOutput');
        if (report) renderTestReport(report, result, { title: 'AI edit check' });
        return result;
    } catch (err) {
        logToConsole(`Simulator check failed to run: ${err.message}`, 'error');
        return null;
    }
}

/** Show chat mode's conversation in the IDE's chat panel. */
function renderIdeChat(messages) {
    const container = document.getElementById('aiMessages');
    if (!container || chatOrb?.busy()) return;
    if (!messages?.length) {
        if (!container.querySelector('.ai-welcome')) clearIdeChat();
        return;
    }
    container.innerHTML = '';
    for (const m of messages) {
        if (m.role === 'user') {
            addAIMessage('user', m.text, false, false, m.snapshot || null);
        } else if (m.role === 'assistant') {
            container.appendChild(buildAnswerMessage({ ok: m.ok, stopped: m.stopped, content: m.text }));
        } else if (m.role === 'card' && m.kind === 'verify' && m.result) {
            container.appendChild(renderVerifyCard(m.result, {
                onFix: (failures) => {
                    const input = document.getElementById('aiInput');
                    if (!input) return;
                    input.value = `The simulator check failed:\n${failures.join('\n')}\nFix the sketch so it compiles and these checks pass.`;
                    sendAIMessage();
                }
            }));
        }
    }
    container.scrollTop = container.scrollHeight;
    chatOrb?.refresh();
}

Object.assign(window.impulse, {
    ai: {
        info: () => ({
            mode: state.aiMode,
            ready: state.aiProviderConfigured,
        }),
        busy: () => !!chatOrb?.busy(),
        ensureModel: readyAIModel,
        setMode(mode) {
            state.aiMode = ['agent', 'plan', 'debug'].includes(mode) ? mode : 'agent';
            const select = document.getElementById('aiModeSelect');
            if (select) select.value = state.aiMode;
            saveAIPreferences();
        },
        context: buildAIContext,
        snapshot: takeCodeSnapshot,
        revert: revertToSnapshot,
        editedCode: (data) => (data?.toolResults || []).some(t => t && t.success && CODE_EDIT_TOOLS.has(t.tool)),
        verify: verifyInSimulator,
        recordUsage: recordAIUsage,
        format: formatAIContent,
        copy: copyText,
        insert: insertCodeAtCursor,
        applyAnswerCode,
        markApplied: markAppliedCodeBlocks,
    },
    board: {
        current: currentBoard,
        /** A board's menu name from its FQBN (options stripped), or null. */
        nameOf: (fqbn) => (fqbn ? (state.boards || []).find(b => b.fqbn === baseFqbn(fqbn))?.name || null : null),
        ports: () => sortPorts((state.ports || []).filter(p => p.vid)).map(p => ({
            port: p.port,
            label: describePort(p),
            boardName: p.boards?.length === 1 ? p.boards[0].name : null,
        })),
        choosePort: chooseBoardPort,
        choose: chooseBoard,
        openPicker: openBoardPortModal,
        openOptions: openBoardOptions,
        verify: compileSketch,
        upload: uploadSketch,
        simulatable: () => isSimulatableBoard(state.selectedBoard),
    },
    project: {
        current: currentProject,
        async create(name) {
            const res = await window.electronAPI.sketch.createProject({ name }).catch((e) => ({ success: false, error: e?.message }));
            if (!res?.success) {
                logToConsole(res?.error || 'Could not create the project', 'error');
                return null;
            }
            if (!await window.impulse.openSketch(res.folderPath, res.filePath)) return null;
            return { name: res.name, folder: res.folderPath, file: res.filePath };
        },
        async pick() {
            const res = await window.electronAPI.dialog.openFolder().catch(() => null);
            if (!res?.success || !res.folderPath) return null;
            return openProjectFolder(res.folderPath);
        },
        openFolder: openProjectFolder,
        async open(project) {
            if (!project?.folder) return false;
            if (project.file && state.currentSketch === project.file) return true;
            return project.file ? window.impulse.openSketch(project.folder, project.file) : loadFolder(project.folder);
        },
        async files(folder) {
            const res = await window.electronAPI.folder.list(folder).catch(() => null);
            const files = (res?.entries || []).filter(e => !e.isDirectory && CODE_FILE.test(e.name));
            return files
                .sort((a, b) => (b.name.endsWith('.ino') - a.name.endsWith('.ino')) || a.name.localeCompare(b.name))
                .map(e => ({ name: e.name, path: e.path }));
        },
        openFile: openFileFromTree,
        close: closeProject,
    },
    editor: {
        currentFile: () => state.currentFile,
        /** What the editor holds right now (chat mode reads it for library checks). */
        value: () => (state.editor ? state.editor.getValue() : ''),
        /** A second editor on the same document (edits and undo show in both). */
        createLinked(host) {
            const CodeMirror = getCodeMirror();
            if (!CodeMirror || !state.editor) return null;
            linkedEditor = CodeMirror(host, {
                value: state.editor.getDoc().linkedDoc({ sharedHist: true }),
                mode: 'text/x-arduino',
                lineNumbers: true,
                indentUnit: state.editor.getOption('indentUnit'),
                tabSize: state.editor.getOption('tabSize'),
                indentWithTabs: false,
                autoCloseBrackets: true,
                matchBrackets: true,
                lineWrapping: true,
                styleActiveLine: true,
                extraKeys: { 'Ctrl-Space': 'autocomplete' },
                hintOptions: { hint: CodeMirror.hint.arduino },
            });
            linkedEditor.getInputField().setAttribute('aria-label', 'Code editor');
            linkedEditor.getWrapperElement().style.fontSize = `${editorFontSize}px`;
            return linkedEditor;
        },
    },
    serial: {
        state: serialState,
        async connect() {
            await connectSerial();
            return serialState();
        },
        disconnect: disconnectSerial,
        async send(text) {
            if (!state.serialConnected || !text) return false;
            try {
                await window.electronAPI.serial.send(`${text}\n`);
                appendSerialOutput(`> ${text}`, new Date().toISOString(), 'sent');
                return true;
            } catch (error) {
                logToConsole(`Failed to send: ${error.message}`, 'error');
                return false;
            }
        },
        setBaud(baud) {
            const select = document.getElementById('baudRate');
            if (!select) return;
            select.value = String(baud);
            select.dispatchEvent(new Event('change'));
        },
        /** Batches of lines from the board, and single lines from the simulator. */
        onLines(fn) {
            const port = (e) => fn(e.detail);
            const sim = (e) => fn([{ text: String(e.detail), kind: 'rx', source: 'SIM', at: new Date().toISOString() }]);
            window.addEventListener('impulse:serial-lines', port);
            window.addEventListener('impulse:sim-serial-line', sim);
            return () => {
                window.removeEventListener('impulse:serial-lines', port);
                window.removeEventListener('impulse:sim-serial-line', sim);
            };
        },
        onCleared(fn) {
            window.addEventListener('impulse:serial-cleared', fn);
            return () => window.removeEventListener('impulse:serial-cleared', fn);
        },
        /** What the board printed before this pane existed. */
        async history(lines = 500) {
            const res = await window.electronAPI.serial.history(lines).catch(() => null);
            return res?.success ? res.data : [];
        },
        clear: () => window.electronAPI.serial.clear().catch(() => {}),
        onState(fn) {
            const handler = () => fn(serialState());
            window.addEventListener('impulse:serial-state', handler);
            return () => window.removeEventListener('impulse:serial-state', handler);
        },
    },
    sim: {
        /** Show the simulator inside chat mode's side panel. */
        mountInto(host) {
            const panel = document.getElementById('simPanel');
            if (!panel || !host) return;
            if (panel.parentElement !== host) {
                host.append(panel);
                requestAnimationFrame(() => simManager?.fit());
            }
            simManager?.onShow?.();
        },
        /** Put it back in the IDE. */
        restore() {
            const panel = document.getElementById('simPanel');
            const view = document.getElementById('simView');
            if (!panel || !view || panel.parentElement === view) return;
            view.append(panel);
            if (simActive) requestAnimationFrame(() => simManager?.fit());
        },
        fit: () => simManager?.fit(),
        /** What is wired on the canvas (the same facts the agent is given). */
        facts: () => simManager?.circuitFacts?.() || null,
        /** The gallery of ready-made sketches with their circuits. */
        examples: () => simManager?.gallery?.open?.(),
        /** The examples, for a menu or a test: id, title, board, category. */
        listExamples: () => EXAMPLES.map((e) => ({ id: e.id, title: e.title, board: e.board, category: e.category, libraries: e.libraries || [] })),
        /** Open one example (its sketch and circuit) by id. */
        async openExample(id) {
            const example = EXAMPLES.find((e) => e.id === id);
            if (!example || !simManager) return false;
            await simManager.openExample(example);
            return true;
        },
        /** Start the simulation (compiles first); no-op while it runs. */
        run() {
            if (simManager && !simManager.running) simManager.run();
        },
        stop() {
            simManager?.stop?.();
        },
        get running() { return !!simManager?.running; },
        /** 'idle' | 'compiling' | 'running' | … as the simulator's toolbar shows it. */
        get state() { return simManager?.state || (simManager?.running ? 'running' : 'idle'); },
    },
    tools: {
        open(name) {
            const ide = () => window.impulse.shell?.setMode('ide');
            const panel = (id) => {
                ide();
                if (state.sidebarCollapsed) toggleSidebar();
                switchPanel(id);
            };
            if (name === 'libraries') panel('libraries');
            else if (name === 'boards') panel('boards');
            else if (name === 'examples') { ide(); setTimeout(showExamplesDropdown, 30); }
            else if (name === 'plotter') { ide(); handleMenuAction('tools-serial-plotter'); }
            else if (name === 'output') { ide(); showOutputTab('console'); }
            else if (name === 'preferences') showPreferences();
            else if (name === 'report') reportProblem();
        },
    },
    theme: {
        toggle: () => setTheme(document.documentElement.dataset.theme === 'light'),
    },
    ideChat: {
        render: renderIdeChat,
    },
});
