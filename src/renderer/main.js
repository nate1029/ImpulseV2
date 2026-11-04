/**
 * Vite entry point for the renderer process.
 * Bundles CodeMirror locally (no CDN), imports all CSS and scripts.
 */

// Must run first so errors thrown while later modules load are captured.
import './error-capture.js';
// Theme and view before the first paint.
import './shell-boot.js';

// --- CodeMirror CSS (bundled locally, no CDN) ---
import 'codemirror/lib/codemirror.css';
import 'codemirror/addon/hint/show-hint.css';
import 'codemirror/addon/dialog/dialog.css';

// --- Fonts (bundled; the app must look right offline) ---
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';

// --- App CSS ---
import './styles.css';
import './simulation/simulation.css';
import './design-system.css';
import './morph-orb/morph-orb.css';

// --- CodeMirror JS (bundled locally, no CDN) ---
import CodeMirror from 'codemirror';
import 'codemirror/mode/clike/clike';
import 'codemirror/addon/hint/show-hint';
import 'codemirror/addon/hint/anyword-hint';
import 'codemirror/addon/dialog/dialog';
import 'codemirror/addon/search/searchcursor';
import 'codemirror/addon/search/search';
import 'codemirror/addon/search/jump-to-line';
import 'codemirror/addon/edit/matchbrackets';
import 'codemirror/addon/edit/closebrackets';
import 'codemirror/addon/selection/active-line';
import { setCodeMirror } from './codemirror-ref.js';
import { defineArduinoMode } from './arduino-mode.js';

defineArduinoMode(CodeMirror);
setCodeMirror(CodeMirror);
window.CodeMirror = CodeMirror;

// --- Application scripts (side-effect imports) ---
import './notifications.js';
import './tooltips.js';
import './validation.js';
import './onboarding.js';
import './accessibility.js';
import './renderer.js';
import './ui-shell.js';
import { startChatMode } from './vibe/index.js';

/**
 * Chat mode consumes the IDE façade (`window.impulse.board/project/editor/…`).
 * The façade is a side-effect of importing `./renderer.js`, which runs an
 * `Object.assign(window.impulse, { board, project, editor, … })` at module top
 * level. Load order today puts that import before this one, so the façade is
 * ready by the time `startChatMode()` runs. This guard is an explicit tripwire:
 * if a future change moves the Object.assign inside a lazy loader or an async
 * callback, chat mode fails loudly instead of silently reading `undefined`.
 * The real fix (a shared appContext module with explicit init()) is deferred
 * to the renderer refactor; this guards the race until then.
 */
function assertImpulseReady() {
    // Only the pieces the IDE renderer is responsible for seeding. `shell`,
    // `chatLog`, `account` and others are installed by vibe itself after it
    // mounts, so they must not be in this list.
    const required = ['board', 'project', 'editor'];
    const missing = required.filter((k) => !window.impulse || typeof window.impulse[k] !== 'object');
    if (missing.length) {
        throw new Error(`Chat mode cannot start: window.impulse.{${missing.join(', ')}} not initialised. The IDE façade must be assembled before vibe/startChatMode(). See src/renderer/main.js.`);
    }
}

// Chat mode: the default view (the IDE is behind its Chat | IDE switch).
document.addEventListener('DOMContentLoaded', () => {
    if (typeof window.electronAPI === 'undefined' || !document.querySelector('.app-container')) return;
    try {
        assertImpulseReady();
    } catch (err) {
        console.error(err);
        document.documentElement.dataset.shell = 'ide';
        return;
    }
    startChatMode().catch((err) => {
        console.error('Chat mode failed to start', err);
        document.documentElement.dataset.shell = 'ide';
    });
});
