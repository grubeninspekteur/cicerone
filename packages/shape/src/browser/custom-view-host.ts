import { inject, injectable } from '@theia/core/shared/inversify';
import { CommandRegistry, Emitter, Event, URI } from '@theia/core';
import { StorageService } from '@theia/core/lib/browser';
import { ThemeService } from '@theia/core/lib/browser/theming';
import { EditorManager } from '@theia/editor/lib/browser';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { globToRegExp, WorkspaceTools } from '@cicerone/core/lib/common';
import { ViewRequest } from '../common/custom-view.js';
import { actionCommandId, ViewSpec } from '../common/workbench.js';
import { WorkbenchService } from './workbench-service.js';

const MAX_LIST = 2000;
const MAX_READ_CHARS = 2_000_000;
const APPROVED_KEY = 'cicerone.customViews.approved';
const MAX_APPROVED = 200;

/**
 * The workbench side of a custom view: answers its requests, and remembers which view code the
 * human has allowed to run.
 *
 * Every request is checked here, not in the frame: a path must lie in the workspace, must not be in a
 * dot-folder or be a dot-file (that is where `.env`, `.git` and the workbench's own machinery live),
 * and must match the view's `files` glob when it declares one. That glob is the view's whole
 * reach, and the human sees it before allowing the view to run.
 */
@injectable()
export class CustomViewHost {

    @inject(WorkbenchService) protected readonly workbench: WorkbenchService;
    @inject(WorkspaceTools) protected readonly tools: WorkspaceTools;
    @inject(FileService) protected readonly fileService: FileService;
    @inject(EditorManager) protected readonly editorManager: EditorManager;
    @inject(CommandRegistry) protected readonly commands: CommandRegistry;
    @inject(StorageService) protected readonly storage: StorageService;
    @inject(ThemeService) protected readonly themes: ThemeService;

    protected approved: Promise<string[]> | undefined;
    protected readonly onDidChangeApprovalEmitter = new Emitter<void>();
    readonly onDidChangeApproval: Event<void> = this.onDidChangeApprovalEmitter.event;

    get onDidChangeTheme(): Event<unknown> {
        return this.themes.onDidColorThemeChange;
    }

    // --------------------------------------------------------------- consent

    /**
     * Whether this exact code may run. Consent is kept in the browser, per content: the agent can
     * write the file but cannot write this, and any change to the file asks again.
     */
    async isApproved(hash: string): Promise<boolean> {
        return (await this.approvedHashes()).includes(hash);
    }

    async approve(hash: string): Promise<void> {
        const list = (await this.approvedHashes()).filter(candidate => candidate !== hash);
        list.push(hash);
        const kept = list.slice(-MAX_APPROVED);
        this.approved = Promise.resolve(kept);
        await this.storage.setData(APPROVED_KEY, kept);
        this.onDidChangeApprovalEmitter.fire();
    }

    protected approvedHashes(): Promise<string[]> {
        this.approved ??= this.storage.getData<string[]>(APPROVED_KEY, []).then(list => Array.isArray(list) ? list : []);
        return this.approved;
    }

    // ----------------------------------------------------------------- theme

    /** The editor's colours and fonts, as CSS variables: short names for the common ones, and every `--theia-*` for the rest. */
    theme(): { vars: Record<string, string>, dark: boolean } {
        const style = getComputedStyle(document.documentElement);
        const vars: Record<string, string> = {};
        for (const sheet of Array.from(document.styleSheets)) {
            let rules: CSSRuleList;
            try {
                rules = sheet.cssRules;
            } catch {
                continue; // a stylesheet from another origin
            }
            for (const rule of Array.from(rules)) {
                if (rule instanceof CSSStyleRule && /:root|^body$/.test(rule.selectorText)) {
                    for (const name of Array.from(rule.style)) {
                        if (name.startsWith('--theia-')) {
                            vars[name] = style.getPropertyValue(name).trim();
                        }
                    }
                }
            }
        }
        const pick = (...names: string[]) => names.map(name => style.getPropertyValue(name).trim()).find(Boolean) ?? '';
        Object.assign(vars, {
            '--fg': pick('--theia-foreground'),
            '--bg': pick('--theia-sideBar-background', '--theia-editor-background'),
            '--dim': pick('--theia-descriptionForeground'),
            '--border': pick('--theia-editorWidget-border', '--theia-panel-border'),
            '--hover': pick('--theia-list-hoverBackground'),
            '--selection': pick('--theia-list-activeSelectionBackground', '--theia-editor-selectionBackground'),
            '--focus': pick('--theia-focusBorder'),
            '--accent': pick('--cicerone-accent') || '#c8872a',
            '--ok': pick('--theia-charts-green'),
            '--bad': pick('--theia-charts-red'),
            '--warn': pick('--theia-editorWarning-foreground'),
            '--chart-1': pick('--theia-charts-blue'),
            '--chart-2': pick('--theia-charts-purple'),
            '--chart-3': pick('--theia-charts-green'),
            '--chart-4': pick('--theia-charts-orange'),
            '--chart-5': pick('--theia-charts-red'),
            '--chart-6': pick('--theia-charts-yellow'),
            '--font': pick('--theia-ui-font-family'),
            '--font-size': pick('--theia-ui-font-size1') || '13px',
            '--mono': pick('--theia-code-font-family')
        });
        const type = this.themes.getCurrentTheme().type;
        return { vars, dark: type === 'dark' || type === 'hc' };
    }

    // -------------------------------------------------------------- requests

    async handle(spec: ViewSpec, request: ViewRequest): Promise<unknown> {
        const root = this.workbench.root;
        if (!root) {
            throw new Error('No folder is open.');
        }
        const rootPath = root.path.fsPath();
        const scope = spec.files ? globToRegExp(spec.files) : undefined;
        const allowed = (path: string) => !/(^|\/)\./.test(path) && (!scope || scope.test(path));
        const wanted = (glob: string | undefined) => {
            const extra = glob ? globToRegExp(glob) : undefined;
            return (path: string) => allowed(path) && (!extra || extra.test(path));
        };
        switch (request.op) {
            case 'files': {
                const found = await this.tools.find(rootPath, { glob: request.glob || spec.files, max: MAX_LIST });
                return found.lines.filter(wanted(request.glob));
            }
            case 'read': {
                const path = this.checkPath(root, request.path, allowed, spec);
                const text = (await this.fileService.read(root.resolve(path))).value;
                if (text.length > MAX_READ_CHARS || text.includes('\u0000')) {
                    throw new Error(`${path} is too large or not a text file.`);
                }
                return text;
            }
            case 'find': {
                if (typeof request.text !== 'string' || !request.text) {
                    throw new Error('find needs text to look for.');
                }
                const found = await this.tools.find(rootPath, {
                    text: request.text, regex: !!request.regex, glob: request.glob || spec.files, wholeLines: true, max: MAX_LIST
                });
                const keep = wanted(request.glob);
                return found.lines.map(line => /^(.*?):(\d+): ?(.*)$/.exec(line))
                    .filter((match): match is RegExpExecArray => !!match && keep(match[1]))
                    .map(match => ({ path: match[1], line: Number(match[2]), text: match[3] }));
            }
            case 'open': {
                const path = this.checkPath(root, request.path, allowed, spec);
                const line = typeof request.line === 'number' && request.line > 0 ? Math.floor(request.line) : undefined;
                const start = { line: (line ?? 1) - 1, character: 0 };
                await this.editorManager.open(root.resolve(path), { mode: 'activate', selection: line ? { start, end: start } : undefined });
                return true;
            }
            case 'action': {
                // Only what the workbench already declares, so a view cannot make up requests to the agent.
                const action = this.workbench.config.actions.find(candidate => candidate.id === request.action);
                if (!action) {
                    throw new Error(`No action "${request.action}" in the workbench. Declared: ${this.workbench.config.actions.map(candidate => candidate.id).join(', ') || 'none'}.`);
                }
                if (!this.commands.isEnabled(actionCommandId(action.id))) {
                    throw new Error(`The action "${action.id}" does not apply right now (it works on "${action.on}").`);
                }
                await this.commands.executeCommand(actionCommandId(action.id));
                return true;
            }
            default:
                throw new Error(`Unknown request "${(request as { op?: string }).op}".`);
        }
    }

    protected checkPath(root: URI, path: unknown, allowed: (path: string) => boolean, spec: ViewSpec): string {
        if (typeof path !== 'string' || !path.trim()) {
            throw new Error('A workspace-relative path is needed.');
        }
        const target = root.resolve(path.trim().replace(/^\.\//, '').replace(/^\/+/, '')).normalizePath();
        const relative = root.relative(target)?.toString();
        if (!relative || !root.isEqualOrParent(target)) {
            throw new Error(`'${path}' is outside the workspace.`);
        }
        if (!allowed(relative)) {
            throw new Error(spec.files ? `'${relative}' is outside what this view may read (${spec.files}).` : `'${relative}' is in a hidden folder or is a hidden file; views cannot read those.`);
        }
        return relative;
    }
}

/** A short fingerprint of a view's code, for consent. */
export async function fingerprint(text: string): Promise<string> {
    if (globalThis.crypto?.subtle) {
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
        return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    }
    // Not a secure context: a weaker hash still tells one version of the file from another.
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
    }
    return `fnv-${text.length}-${hash.toString(16)}`;
}
