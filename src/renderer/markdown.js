// Markdown for AI answers, in both chat mode and the IDE's chat panel.
//
// Everything is escaped first; only the tags made here reach the page:
// headings, paragraphs (line breaks kept), lists (one level of nesting),
// quotes, tables, rules, code blocks (with Copy and Insert), inline code,
// bold, italic, strikethrough and http(s) links that open in the browser.

const esc = (s) => String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function codeBlock(lang, code) {
    const language = esc(lang || 'text');
    return '<div class="code-block-wrapper">' +
        '<div class="code-block-header">' +
        `<span class="code-lang">${language}</span>` +
        '<span class="code-block-actions">' +
        '<button class="code-copy-btn" type="button" title="Copy the code">Copy</button>' +
        '<button class="code-insert-btn" type="button" title="Insert at cursor">Insert</button>' +
        '</span>' +
        '</div>' +
        `<pre><code class="language-${language}">${esc(code)}</code></pre>` +
        '</div>';
}

const URL_TRAIL = /[.,;:!?)\]]+$/;

function link(href, text) {
    return `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
}

/** Inline markdown on one block of raw text. */
export function inline(raw) {
    const slots = [];
    const keep = (html) => `\u0000${slots.push(html) - 1}\u0000`;
    let s = String(raw);
    // Code spans first: nothing inside them is formatted.
    s = s.replace(/`([^`\n]+)`/g, (m, code) => keep(`<code>${esc(code)}</code>`));
    // [text](https://…)
    s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, text, href) => keep(link(href, esc(text))));
    // Bare https:// links (trailing punctuation stays outside).
    s = s.replace(/\bhttps?:\/\/[^\s<>"'`]+/g, (m) => {
        const trail = (m.match(URL_TRAIL) || [''])[0];
        const href = m.slice(0, m.length - trail.length);
        return keep(link(href, esc(href))) + trail;
    });
    s = esc(s);
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
        .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
        .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
        .replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?!\w)/g, '$1<em>$2</em>')
        .replace(/(^|[^_\w])_([^_\s][^_\n]*?)_(?!\w)/g, '$1<em>$2</em>');
    // eslint-disable-next-line no-control-regex
    return s.replace(/\u0000(\d+)\u0000/g, (m, i) => slots[Number(i)] ?? '');
}

const FENCE = /^\s*(```+|~~~+)\s*([\w+#.-]*)\s*$/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(\S.*)$/;
// A rule: three or more of the same -, * or _ (spaces between allowed).
const isRule = (line) => /^(-{3,}|\*{3,}|_{3,})$/.test(line.replace(/[ \t]/g, ''));
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const NUMBERED = /^(\s*)(\d{1,3})[.)]\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
// A table's header separator: | --- | :--: | ---: |
const isTableSep = (line) => line.includes('-') && line.trim().replace(/^\||\|$/g, '').split('|').every((c) => /^:?-{2,}:?$/.test(c.trim()));

const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

function table(head, rows) {
    const th = head.map((c) => `<th>${inline(c)}</th>`).join('');
    const body = rows.map((r) => `<tr>${head.map((_, i) => `<td>${inline(r[i] ?? '')}</td>`).join('')}</tr>`).join('');
    return `<div class="md-table"><table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function list(lines) {
    // lines: [{ indent, ordered, start, text }]
    let html = '';
    const stack = [];
    const open = (item) => {
        const tag = item.ordered ? 'ol' : 'ul';
        html += item.ordered && item.start !== 1 ? `<ol start="${item.start}">` : `<${tag}>`;
        stack.push({ tag, indent: item.indent });
    };
    for (const item of lines) {
        if (!stack.length) {
            open(item);
        } else if (item.indent > stack[stack.length - 1].indent + 1 && stack.length < 2) {
            html = html.replace(/<\/li>$/, '');
            open(item);
        } else {
            while (stack.length > 1 && item.indent < stack[stack.length - 1].indent) {
                html += `</${stack.pop().tag}></li>`;
            }
        }
        html += `<li>${inline(item.text)}</li>`;
    }
    while (stack.length) {
        html += `</${stack.pop().tag}>`;
        if (stack.length) html += '</li>';
    }
    return html;
}

/** Markdown text to safe HTML. */
export function renderMarkdown(text) {
    const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let para = [];
    const flush = () => {
        if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
        para = [];
    };
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const fence = line.match(FENCE);
        if (fence) {
            flush();
            const code = [];
            let j = i + 1;
            while (j < lines.length && !(lines[j].trim().startsWith(fence[1][0].repeat(3)) && /^\s*(```+|~~~+)\s*$/.test(lines[j]))) {
                code.push(lines[j]);
                j++;
            }
            out.push(codeBlock(fence[2], code.join('\n')));
            i = j;
            continue;
        }
        if (!line.trim()) {
            flush();
            continue;
        }
        const heading = line.match(HEADING);
        if (heading) {
            flush();
            const level = Math.min(6, heading[1].length + 2);
            const title = heading[2].replace(/[ \t]+#+[ \t]*$/, '').trim();
            out.push(`<h${level}>${inline(title)}</h${level}>`);
            continue;
        }
        if (isRule(line)) {
            flush();
            out.push('<hr>');
            continue;
        }
        if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
            flush();
            const head = cells(line);
            const rows = [];
            let j = i + 2;
            while (j < lines.length && lines[j].includes('|') && lines[j].trim()) {
                rows.push(cells(lines[j]));
                j++;
            }
            out.push(table(head, rows));
            i = j - 1;
            continue;
        }
        if (BULLET.test(line) || NUMBERED.test(line)) {
            flush();
            const items = [];
            let j = i;
            while (j < lines.length) {
                const b = lines[j].match(BULLET);
                const n = !b && lines[j].match(NUMBERED);
                if (b) items.push({ indent: b[1].replace(/\t/g, '  ').length, ordered: false, start: 1, text: b[2] });
                else if (n) items.push({ indent: n[1].replace(/\t/g, '  ').length, ordered: true, start: Number(n[2]), text: n[3] });
                else if (lines[j].trim() && /^\s{2,}\S/.test(lines[j]) && items.length) items[items.length - 1].text += `\n${lines[j].trim()}`;
                else break;
                j++;
            }
            out.push(list(items).replace(/\n/g, '<br>'));
            i = j - 1;
            continue;
        }
        const quote = line.match(QUOTE);
        if (quote) {
            flush();
            const body = [];
            let j = i;
            while (j < lines.length) {
                const q = lines[j].match(QUOTE);
                if (!q) break;
                body.push(q[1]);
                j++;
            }
            out.push(`<blockquote>${body.map(inline).join('<br>')}</blockquote>`);
            i = j - 1;
            continue;
        }
        para.push(line);
    }
    flush();
    return out.join('');
}
