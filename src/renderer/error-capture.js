// Every uncaught error is shown in the Console panel and written to the log
// file, so nothing fails silently.
function setupErrorCapture() {
    const report = (message, source, stack) => {
        const text = String(message || 'Unknown error');
        const consoleEl = document.getElementById('consoleOutput');
        if (consoleEl) {
            const line = document.createElement('div');
            line.className = 'console-line error';
            line.textContent = `[${new Date().toLocaleTimeString()}] Internal error: ${text}`;
            consoleEl.appendChild(line);
            consoleEl.scrollTop = consoleEl.scrollHeight;
        }
        window.electronAPI?.app?.logError?.({ message: text, source, stack });
    };
    window.addEventListener('error', (e) => {
        // Resource load errors (img/script) have no message; ignore them here.
        if (!e.message) return;
        // Chromium reports this when a ResizeObserver callback causes another
        // resize; it is informational and the next frame catches up.
        if (/ResizeObserver loop/.test(e.message)) return;
        report(e.message, `${e.filename || ''}:${e.lineno || 0}`, e.error?.stack);
    });
    window.addEventListener('unhandledrejection', (e) => {
        const reason = e.reason;
        report(reason?.message || reason, 'promise', reason?.stack);
    });
}

setupErrorCapture();
