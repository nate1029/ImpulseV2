// Status bar + AI starter prompts. Mirrors state that renderer.js already renders elsewhere.

function setupAiStarters() {
    const messages = document.getElementById('aiMessages');
    const input = document.getElementById('aiInput');
    if (!messages || !input) return;

    messages.addEventListener('click', (e) => {
        const chip = e.target.closest('.ai-starter');
        if (!chip) return;
        input.value = chip.dataset.prompt || chip.textContent.trim();
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
    });
}

function setupStatusBar() {
    const left = document.querySelector('.app-footer .footer-left');
    const right = document.querySelector('.app-footer .footer-right');
    if (!left || !right) return;

    left.innerHTML = `
        <span class="status-item status-cli" id="statusCli"><span class="status-dot"></span><span class="status-text">Checking CLI…</span></span>
        <span class="status-item status-board" id="statusBoard">
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3"/></svg>
            <span class="status-text">No board selected</span>
        </span>
        <button type="button" class="status-item status-pio" id="statusPio" hidden></button>
        <span class="status-item status-build" id="statusBuild" hidden><span class="status-dot"></span><span class="status-text"></span></span>`;
    right.innerHTML = `
        <button type="button" class="status-item status-pins" id="statusPins" hidden></button>
        <span class="status-item status-cursor" id="statusCursor"></span>`;

    const pinsEl = document.getElementById('statusPins');
    let firstIssueLine = null;
    window.addEventListener('impulse:pin-issues', (e) => {
        const issues = e.detail || [];
        const warnings = issues.filter(i => i.severity === 'warning').length;
        firstIssueLine = issues.length ? issues[0].line : null;
        pinsEl.hidden = issues.length === 0;
        pinsEl.dataset.state = warnings ? 'warning' : 'info';
        pinsEl.textContent = warnings
            ? `${warnings} pin warning${warnings === 1 ? '' : 's'}`
            : `${issues.length} pin note${issues.length === 1 ? '' : 's'}`;
        pinsEl.title = issues.map(i => `Line ${i.line + 1}: ${i.message}`).join('\n');
    });
    pinsEl.addEventListener('click', () => {
        const cmEditor = document.querySelector('.CodeMirror')?.CodeMirror;
        if (!cmEditor || firstIssueLine === null) return;
        cmEditor.focus();
        cmEditor.setCursor({ line: firstIssueLine, ch: 0 });
        cmEditor.scrollIntoView({ line: firstIssueLine, ch: 0 }, 80);
    });

    const cliSrc = document.getElementById('cliStatus');
    const cliEl = document.getElementById('statusCli');
    const syncCli = () => {
        if (!cliSrc || !cliEl) return;
        const ok = cliSrc.classList.contains('success');
        const bad = cliSrc.classList.contains('error');
        cliEl.dataset.state = ok ? 'ok' : bad ? 'error' : 'pending';
        cliEl.querySelector('.status-text').textContent =
            ok ? 'Arduino CLI' : bad ? cliSrc.textContent.replace('●', '').trim() : 'Checking CLI…';
    };

    const boardSrc = document.getElementById('boardPortDisplay');
    const boardEl = document.getElementById('statusBoard');
    const syncBoard = () => {
        if (!boardSrc || !boardEl) return;
        const t = boardSrc.textContent.trim();
        const none = !t || t === 'Choose a board';
        boardEl.dataset.state = none ? 'empty' : 'set';
        boardEl.querySelector('.status-text').textContent = none ? 'No board selected' : t;
    };

    const watch = (el, fn) => {
        if (!el) return;
        new MutationObserver(fn).observe(el, { childList: true, characterData: true, subtree: true, attributes: true });
        fn();
    };
    watch(cliSrc, syncCli);
    watch(boardSrc, syncBoard);
    boardEl?.addEventListener('click', () => document.getElementById('boardPortDropdown')?.click());

    // renderer.js creates the CodeMirror instance synchronously in its own DOMContentLoaded handler.
    const cm = document.querySelector('.CodeMirror')?.CodeMirror;
    const cursorEl = document.getElementById('statusCursor');
    const editorWrapper = document.getElementById('editorWrapper');
    if (cm && cursorEl && editorWrapper) {
        const update = () => {
            if (editorWrapper.style.display === 'none') { cursorEl.textContent = ''; return; }
            const { line, ch } = cm.getCursor();
            cursorEl.textContent = `Ln ${line + 1}, Col ${ch + 1}`;
        };
        cm.on('cursorActivity', update);
        cm.on('swapDoc', update);
        new MutationObserver(update).observe(editorWrapper, { attributes: true, attributeFilter: ['style'] });
        update();
    }
}

const IS_MAC = /Mac/i.test(navigator.platform || navigator.userAgent);

// Shortcuts are native menu accelerators (CmdOrCtrl), so label them as the OS does.
function localizeShortcutLabels() {
    if (!IS_MAC) return;
    document.querySelectorAll('kbd').forEach((k) => {
        if (k.textContent === 'Ctrl') k.textContent = '⌘';
        else if (k.textContent === 'Shift') k.textContent = '⇧';
        else k.textContent = k.textContent.replace(/Ctrl\+Shift\+/g, '⇧⌘').replace(/Ctrl\+/g, '⌘');
    });
    document.querySelectorAll('[title*="Ctrl+"]').forEach((el) => {
        el.title = el.title.replace(/Ctrl\+Shift\+/g, '⇧⌘').replace(/Ctrl\+/g, '⌘');
    });
}

document.addEventListener('DOMContentLoaded', () => {
    localizeShortcutLabels();
    setupAiStarters();
    setupStatusBar();
});
