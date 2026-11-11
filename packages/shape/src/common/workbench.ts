/*
 * The workbench description: one JSON file in the workspace that says which views exist, how the
 * panels are arranged, and which actions sit in the context menus.
 *
 * It is a file on purpose. The agent shapes the editor with the same `edit` tool it uses for
 * everything else, the human reviews the reshaping as ordinary tour stops, it is versioned with the
 * work it serves, and a colleague who opens the folder gets the same workbench.
 */

export const WORKBENCH_FILE = '.cicerone/workbench.json';
/** Where skills live; the location the Agent Skills convention and Theia's skill service already use. */
export const SKILLS_DIRECTORY = '.agents/skills';

export const VIEW_KINDS = ['outline', 'matches', 'files', 'counts', 'document'] as const;
export type ViewKind = typeof VIEW_KINDS[number];
export const AREAS = ['left', 'right', 'bottom'] as const;
export type Area = typeof AREAS[number];
export const ACTION_SCOPES = ['selection', 'file', 'workspace'] as const;
export type ActionScope = typeof ACTION_SCOPES[number];

export interface ViewSpec {
    id: string;
    title: string;
    kind: ViewKind;
    /** Codicon name without prefix, e.g. `book`. */
    icon?: string;
    area?: Area;
    /** Glob of the files the view draws on (all kinds except `document`). */
    files?: string;
    /** `document`: the markdown file to render. */
    file?: string;
    /** `matches`: regular expression; the first capture group, if any, is what gets listed. */
    pattern?: string;
    /** `matches`: list under each file (default), under each distinct match, or flat. */
    group?: 'file' | 'match' | 'none';
    /** `outline`: deepest heading level to include (default 2). */
    depth?: number;
    /** `files`: front-matter fields to show under each file's title. */
    fields?: string[];
    /** `counts`: what to count (default words) and an optional target for the total. */
    unit?: 'words' | 'lines';
    target?: number;
    /** Id of an action offered as a button in the view, e.g. to have the agent rebuild a `document`. */
    action?: string;
}

export interface ActionSpec {
    id: string;
    label: string;
    /** Skill the agent loads to carry the action out. */
    skill?: string;
    /** Instruction sent along; at least one of `skill` and `prompt` is needed. */
    prompt?: string;
    /** What the action works on, and therefore where it is offered: editor selection, a file, or the whole workspace. */
    on: ActionScope;
    /** Glob limiting the files the action is offered for. */
    files?: string;
    /** Keybinding in Theia notation, e.g. `ctrlcmd+alt+t`. */
    key?: string;
}

export interface LayoutSpec {
    left?: string[];
    right?: string[];
    bottom?: string[];
    /** Views to close. */
    hide?: string[];
}

export interface WorkbenchConfig {
    /** What this workbench is for, in a word or two; shown in the status bar. */
    title?: string;
    views: ViewSpec[];
    actions: ActionSpec[];
    layout?: LayoutSpec;
}

export const EMPTY_WORKBENCH: WorkbenchConfig = { views: [], actions: [] };

/** Names for the views that come with the product, usable in `layout`. */
export const BUILTIN_VIEWS: Record<string, { widgetId: string, description: string }> = {
    explorer: { widgetId: 'explorer-view-container', description: 'file tree' },
    search: { widgetId: 'search-view-container', description: 'search across files' },
    tour: { widgetId: 'cicerone.tour', description: 'the agent\'s stops' },
    chat: { widgetId: 'chat-view-widget', description: 'conversation with the agent' },
    activity: { widgetId: 'cicerone.activity', description: 'what the agent is doing' },
    outline: { widgetId: 'outline-view', description: 'symbols of the open file' },
    problems: { widgetId: 'problems', description: 'errors and warnings' },
    terminal: { widgetId: 'terminal', description: 'shell' },
    scm: { widgetId: 'scm-view-container', description: 'source control' },
    debug: { widgetId: 'debug', description: 'debugger' },
    test: { widgetId: 'test-view-container', description: 'test runner' }
};

const ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export interface ParsedWorkbench {
    config: WorkbenchConfig;
    /** Worded so that whoever wrote the file, human or model, can fix it from the message alone. */
    problems: string[];
}

/** Parses and checks a workbench description. Whatever is valid is kept, so one bad view does not take the others down. */
export function parseWorkbench(text: string): ParsedWorkbench {
    const problems: string[] = [];
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch (error) {
        return { config: EMPTY_WORKBENCH, problems: [`${WORKBENCH_FILE} is not valid JSON: ${(error as Error).message}`] };
    }
    if (!isObject(raw)) {
        return { config: EMPTY_WORKBENCH, problems: [`${WORKBENCH_FILE} must contain a JSON object.`] };
    }
    for (const key of Object.keys(raw)) {
        if (!['title', 'views', 'actions', 'layout', '$schema'].includes(key)) {
            problems.push(`Unknown top-level key "${key}". Allowed: title, views, actions, layout.`);
        }
    }
    const views: ViewSpec[] = [];
    const seenViews = new Set<string>();
    asArray(raw.views, 'views', problems).forEach((entry, index) => {
        const at = `views[${index}]`;
        if (!isObject(entry)) {
            problems.push(`${at} must be an object.`);
            return;
        }
        const before = problems.length;
        const id = requireId(entry.id, `${at}.id`, problems);
        if (id && (seenViews.has(id) || id in BUILTIN_VIEWS)) {
            problems.push(`${at}.id "${id}" is already taken${id in BUILTIN_VIEWS ? ' by a built-in view' : ''}.`);
        }
        requireString(entry.title, `${at}.title`, problems);
        if (!VIEW_KINDS.includes(entry.kind as ViewKind)) {
            problems.push(`${at}.kind must be one of: ${VIEW_KINDS.join(', ')}.`);
        } else if (entry.kind === 'document') {
            requireString(entry.file, `${at}.file (the markdown file to render)`, problems);
        } else {
            requireString(entry.files, `${at}.files (a glob such as "chapters/*.md")`, problems);
            if (entry.kind === 'matches') {
                if (requireString(entry.pattern, `${at}.pattern`, problems)) {
                    try {
                        new RegExp(entry.pattern as string);
                    } catch (error) {
                        problems.push(`${at}.pattern is not a valid regular expression: ${(error as Error).message}`);
                    }
                }
                if (entry.group !== undefined && !['file', 'match', 'none'].includes(entry.group as string)) {
                    problems.push(`${at}.group must be "file", "match" or "none".`);
                }
            }
        }
        if (entry.area !== undefined && !AREAS.includes(entry.area as Area)) {
            problems.push(`${at}.area must be one of: ${AREAS.join(', ')}.`);
        }
        if (entry.fields !== undefined && !(Array.isArray(entry.fields) && entry.fields.every(field => typeof field === 'string'))) {
            problems.push(`${at}.fields must be an array of strings.`);
        }
        if (entry.target !== undefined && typeof entry.target !== 'number') {
            problems.push(`${at}.target must be a number.`);
        }
        if (problems.length === before && id) {
            seenViews.add(id);
            views.push(entry as unknown as ViewSpec);
        }
    });

    const actions: ActionSpec[] = [];
    const seenActions = new Set<string>();
    asArray(raw.actions, 'actions', problems).forEach((entry, index) => {
        const at = `actions[${index}]`;
        if (!isObject(entry)) {
            problems.push(`${at} must be an object.`);
            return;
        }
        const before = problems.length;
        const id = requireId(entry.id, `${at}.id`, problems);
        if (id && seenActions.has(id)) {
            problems.push(`${at}.id "${id}" is used twice.`);
        }
        requireString(entry.label, `${at}.label`, problems);
        if (!ACTION_SCOPES.includes(entry.on as ActionScope)) {
            problems.push(`${at}.on must be one of: ${ACTION_SCOPES.join(', ')}.`);
        }
        if (typeof entry.skill !== 'string' && typeof entry.prompt !== 'string') {
            problems.push(`${at} needs a "skill", a "prompt", or both.`);
        }
        if (entry.skill !== undefined && !(typeof entry.skill === 'string' && ID.test(entry.skill))) {
            problems.push(`${at}.skill must be a skill name in kebab-case.`);
        }
        if (problems.length === before && id) {
            seenActions.add(id);
            actions.push(entry as unknown as ActionSpec);
        }
    });
    for (const view of views) {
        if (view.action && !seenActions.has(view.action)) {
            problems.push(`View "${view.id}" refers to action "${view.action}", which is not defined under actions.`);
        }
    }

    let layout: LayoutSpec | undefined;
    if (raw.layout !== undefined) {
        if (!isObject(raw.layout)) {
            problems.push('layout must be an object.');
        } else {
            layout = {};
            for (const key of Object.keys(raw.layout)) {
                const value = raw.layout[key];
                if (!['left', 'right', 'bottom', 'hide'].includes(key)) {
                    problems.push(`Unknown key layout.${key}. Allowed: left, right, bottom, hide.`);
                } else if (!(Array.isArray(value) && value.every(item => typeof item === 'string'))) {
                    problems.push(`layout.${key} must be an array of view ids.`);
                } else {
                    const unknown = value.filter(item => !seenViews.has(item) && !(item in BUILTIN_VIEWS));
                    if (unknown.length) {
                        problems.push(`layout.${key} names unknown views: ${unknown.join(', ')}. Use ids from views or built-ins: ${Object.keys(BUILTIN_VIEWS).join(', ')}.`);
                    }
                    layout[key as keyof LayoutSpec] = value.filter(item => !unknown.includes(item));
                }
            }
        }
    }
    return { config: { title: typeof raw.title === 'string' ? raw.title : undefined, views, actions, layout }, problems };
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray(value: unknown, name: string, problems: string[]): unknown[] {
    if (value === undefined) {
        return [];
    }
    if (!Array.isArray(value)) {
        problems.push(`${name} must be an array.`);
        return [];
    }
    return value;
}

function requireString(value: unknown, name: string, problems: string[]): boolean {
    if (typeof value !== 'string' || value.trim() === '') {
        problems.push(`${name} is required.`);
        return false;
    }
    return true;
}

function requireId(value: unknown, name: string, problems: string[]): string | undefined {
    if (typeof value !== 'string' || !ID.test(value)) {
        problems.push(`${name} is required and must be kebab-case (lower-case letters, digits, hyphens).`);
        return undefined;
    }
    return value;
}

/** Minimal front matter: `key: value` lines between two `---` lines at the top of a file. */
export function splitFrontMatter(text: string): { fields: Record<string, string>, body: string } {
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
    if (!match) {
        return { fields: {}, body: text };
    }
    const fields: Record<string, string> = {};
    for (const line of match[1].split(/\r?\n/)) {
        const pair = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
        if (pair) {
            fields[pair[1]] = pair[2].replace(/^["']|["']$/g, '');
        }
    }
    return { fields, body: text.slice(match[0].length) };
}

export function countWords(text: string): number {
    return text.split(/\s+/).filter(word => /[\p{L}\p{N}]/u.test(word)).length;
}
