// Runs before anything renders: the saved theme and view (chat mode is the
// default), so a light-theme or IDE start never flashes the other one first.
try {
    document.documentElement.dataset.theme = localStorage.getItem('arduino-ide-theme') === 'light' ? 'light' : 'dark';
    document.documentElement.dataset.shell = localStorage.getItem('impulse-shell') === 'ide' ? 'ide' : 'vibe';
} catch {
    document.documentElement.dataset.shell = 'vibe';
}
