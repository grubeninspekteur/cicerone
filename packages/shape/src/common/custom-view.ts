/*
 * The `custom` view kind: a view the agent writes as code, for questions the five declarative kinds
 * cannot answer (who is in which scene, which clause cites which, what the dependency graph looks like).
 *
 * The code is an HTML file in the workspace. It runs in two nested sandboxed frames:
 *
 *   workbench ── frame 1: the warden ── frame 2: the view
 *
 * The warden carries a Content Security Policy that allows nothing to be fetched, and that policy also
 * governs where the view's frame may navigate, so the view cannot reach the network by any route:
 * not fetch, not images, not sockets, not child frames, not by navigating itself somewhere. Both
 * frames are sandboxed without same-origin, so neither can touch the workbench, its storage or its
 * cookies. The only way out is a handful of messages the warden relays and the workbench answers:
 * list, read and search files, open a file, run an action the workbench already declares.
 */

/** Requests a view can make. Every one is answered with a {@link ViewResponse} of the same id. */
export type ViewRequest =
    | { id: number, op: 'files', glob?: string }
    | { id: number, op: 'read', path: string }
    | { id: number, op: 'find', text: string, glob?: string, regex?: boolean }
    | { id: number, op: 'open', path: string, line?: number }
    | { id: number, op: 'action', action: string };

export interface ViewResponse {
    id: number;
    result?: unknown;
    error?: string;
}

/** What the workbench tells a view without being asked. */
export type ViewEvent =
    | { event: 'changed' }
    | { event: 'theme', vars: Record<string, string>, dark: boolean };

/** What a view reports without being asked. */
export type ViewReport = { report: 'error', message: string } | { report: 'ready' };

/** Marks every message of this protocol, so stray messages from elsewhere are ignored. */
export const CHANNEL = 'cicerone-view';

export const CUSTOM_VIEW_DIRECTORY = '.cicerone/views';

/** Nothing may be loaded from anywhere; inline scripts and styles, and images built in the page, are fine. */
export const VIEW_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; " +
    "frame-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'";

/**
 * The `cicerone` object a view sees. Kept small and promise-based; it is documented in the workbench
 * skill, which is all the agent knows about it.
 */
const PRELUDE = `
(() => {
    const CHANNEL = '${CHANNEL}';
    const pending = new Map();
    const listeners = [];
    let next = 1;
    const call = (op, args) => new Promise((resolve, reject) => {
        const id = next++;
        pending.set(id, { resolve, reject });
        parent.postMessage({ channel: CHANNEL, request: { id, op, ...args } }, '*');
    });
    const report = value => parent.postMessage({ channel: CHANNEL, report: value }, '*');
    const applyTheme = (vars, dark) => {
        const root = document.documentElement;
        for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
        root.classList.toggle('dark', dark);
        root.classList.toggle('light', !dark);
    };
    addEventListener('message', event => {
        const data = event.data;
        if (event.source !== parent || !data || data.channel !== CHANNEL) return;
        if (data.response) {
            const waiting = pending.get(data.response.id);
            pending.delete(data.response.id);
            if (waiting) data.response.error ? waiting.reject(new Error(data.response.error)) : waiting.resolve(data.response.result);
        } else if (data.event && data.event.event === 'changed') {
            listeners.forEach(listener => { try { listener(); } catch (error) { report({ report: 'error', message: String(error && error.stack || error) }); } });
        } else if (data.event && data.event.event === 'theme') {
            applyTheme(data.event.vars, data.event.dark);
        }
    });
    addEventListener('error', event => report({ report: 'error', message: (event.error && event.error.stack) || event.message }));
    addEventListener('unhandledrejection', event => report({ report: 'error', message: String(event.reason && event.reason.stack || event.reason) }));
    window.cicerone = Object.freeze({
        files: glob => call('files', { glob }),
        read: path => call('read', { path }),
        find: (text, options) => call('find', { text, glob: options && options.glob, regex: options && options.regex }),
        open: (path, line) => call('open', { path, line }),
        action: action => call('action', { action }),
        onChange: listener => { listeners.push(listener); },
        frontMatter: text => {
            const match = /^---\\r?\\n([\\s\\S]*?)\\r?\\n---\\r?\\n?/.exec(text);
            const fields = {};
            if (match) for (const line of match[1].split(/\\r?\\n/)) {
                const pair = /^([A-Za-z0-9_-]+):\\s*(.*)$/.exec(line);
                if (pair) fields[pair[1]] = pair[2].replace(/^["']|["']$/g, '');
            }
            return { fields, body: match ? text.slice(match[0].length) : text };
        }
    });
    addEventListener('DOMContentLoaded', () => report({ report: 'ready' }));
})();
`;

/** Styles every view starts from, so a view that does nothing about looks still matches the editor. */
const BASE_STYLE = `
html { color-scheme: light dark; }
body { margin: 0; padding: 10px 12px; background: transparent; color: var(--fg); font: var(--font-size) var(--font); line-height: 1.45; }
a, button { color: inherit; font: inherit; }
code, pre { font-family: var(--mono); }
`;

/** The view's own HTML with the policy, the base style and the `cicerone` object put in front of everything it brings. */
export function viewDocument(html: string, theme: { vars: Record<string, string>, dark: boolean }): string {
    const vars = Object.entries(theme.vars).map(([name, value]) => `${name}: ${value};`).join(' ');
    const head = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${VIEW_CSP}">` +
        `<style>:root { ${vars} }${BASE_STYLE}</style><script>${PRELUDE}</script>`;
    const theme0 = theme.dark ? 'dark' : 'light';
    // The policy must come before anything the view brings, so the head is opened by us whatever the file looks like.
    const body = html.replace(/<!doctype[^>]*>/i, '').replace(/<\/?html[^>]*>/gi, '').replace(/<head[^>]*>|<\/head>/gi, '');
    return `<!doctype html><html class="${theme0}"><head>${head}</head>${body}</html>`;
}

/**
 * The warden: frame 1. It holds the policy that also governs where frame 2 may navigate, and relays
 * messages between the view and the workbench, checking which side each one comes from.
 */
export function wardenDocument(view: string): string {
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${VIEW_CSP}">
<style>html, body, iframe { margin: 0; width: 100%; height: 100%; border: 0; display: block; background: transparent; overflow: hidden; }</style></head>
<body><iframe id="view" sandbox="allow-scripts" srcdoc="${escapeAttribute(view)}"></iframe><script>
const view = document.getElementById('view');
let loads = 0;
// A second load means the view navigated away from its page; the policy blocked it, and the frame now shows nothing.
view.addEventListener('load', () => {
    if (++loads > 1) parent.postMessage({ channel: '${CHANNEL}', report: { report: 'error', message: 'The view tried to navigate away from its page, which is blocked, so it went blank. Draw everything in the page itself and use cicerone.open(path) to show a file.' } }, '*');
});
addEventListener('message', event => {
    const data = event.data;
    if (!data || data.channel !== '${CHANNEL}') return;
    if (event.source === view.contentWindow && (data.request || data.report)) parent.postMessage(data, '*');
    else if (event.source === parent && (data.response || data.event)) view.contentWindow.postMessage(data, '*');
});
</script></body></html>`;
}

export function escapeAttribute(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * What the agent should hear about a view it is writing: things that cannot work in the sandbox.
 * Worded so it can fix them from the message alone.
 */
export function checkViewSource(html: string): string[] {
    const problems: string[] = [];
    if (/<(script|link|img|iframe)\b[^>]*\b(src|href)\s*=\s*["']?(https?:)?\/\//i.test(html)) {
        problems.push('The view loads something from the network (a script, stylesheet, image or frame URL). Views have no network: inline it, or draw it with SVG.');
    }
    if (/\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b/.test(html)) {
        problems.push('The view uses fetch, XMLHttpRequest or WebSocket, which are blocked. Read workspace files with `cicerone.read(path)` and search with `cicerone.find(text)`.');
    }
    if (/\b(localStorage|sessionStorage|indexedDB|document\.cookie)\b/.test(html)) {
        problems.push('The view uses browser storage, which is not available in its sandbox. Keep state in variables, or in a workspace file the user can see.');
    }
    if (!/cicerone\.(files|read|find)\b/.test(html)) {
        problems.push('The view never reads the workspace (cicerone.files, cicerone.read or cicerone.find), so it can only show what is written into it. If that is intended, a `document` view is simpler.');
    }
    return problems;
}
