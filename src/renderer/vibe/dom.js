// Small DOM helpers for chat mode. Text always goes in as text nodes.

/**
 * h('div', { class: 'x', onclick, html }, child, 'text', …)
 * `html` sets trusted markup (icons only); everything else is text.
 */
export function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const present = (children) => children.flat().filter((c) => c !== null && c !== undefined && c !== false);

/** Append children, skipping empty ones (the DOM would print "null"). */
export function add(el, ...children) {
  el.append(...present(children));
  return el;
}

/** Replace the children, skipping empty ones. */
export function fill(el, ...children) {
  el.replaceChildren(...present(children));
  return el;
}

/** An element from a trusted icon string. */
export function icon(svgString) {
  const t = document.createElement('template');
  t.innerHTML = svgString.trim();
  const el = t.content.firstElementChild;
  el.classList.add('v-ico');
  return el;
}

export function led(state, { pulse = false } = {}) {
  return h('span', { class: 'v-led', dataset: state ? { state } : {}, 'data-pulse': pulse || null, 'aria-hidden': 'true' });
}

export const initials = (name, email) => (name || email || '?').trim().split(/\s+/).map((p) => p[0]).join('').slice(0, 2).toUpperCase();

export function avatar(user) {
  const box = h('span', { class: 'v-avatar', 'aria-hidden': 'true' });
  if (user?.image && /^https:\/\//.test(user.image)) {
    const img = h('img', { src: user.image, alt: '', referrerpolicy: 'no-referrer' });
    img.addEventListener('error', () => { box.textContent = initials(user.name, user.email); });
    box.append(img);
  } else {
    box.textContent = initials(user?.name, user?.email);
  }
  return box;
}

export function timeAgo(ms) {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Credits as people read them: 297.6, 1,450 (tenths below a thousand). */
export const fmtCredits = (v) => {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  if (Math.abs(v) >= 1000) return new Intl.NumberFormat('en', { maximumFractionDigits: 0 }).format(v);
  return String(Math.round(v * 10) / 10);
};

let toastTimer = null;
/** A short message at the bottom; `action` adds one button (e.g. Undo). */
export function toast(message, { action = null, duration = 3200 } = {}) {
  document.querySelector('.v-toast')?.remove();
  clearTimeout(toastTimer);
  const el = h('div', { class: 'v-toast', role: 'status', 'aria-live': 'polite' }, h('span', { text: message }));
  if (action) {
    el.append(h('button', {
      type: 'button', class: 'v-btn ghost', text: action.label,
      onclick: () => { el.remove(); action.run(); },
    }));
  }
  document.body.append(el);
  toastTimer = setTimeout(() => {
    el.remove();
    action?.expire?.();
  }, duration);
  return el;
}
