import { inject, injectable } from '@theia/core/shared/inversify';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { WorkspaceTools } from '@cicerone/core/lib/common';
import { countWords, splitFrontMatter, ViewSpec } from '../common/workbench.js';
import { WorkbenchService } from './workbench-service.js';

export interface ViewItem {
    label: string;
    path: string;
    line: number;
    /** Indentation level, for outlines. */
    level?: number;
    detail?: string;
}

export interface ViewGroup {
    label: string;
    /** Set when the group is a file, so its header opens it. */
    path?: string;
    items: ViewItem[];
}

export type ViewData =
    | { kind: 'groups', groups: ViewGroup[], total: number, truncated: boolean, flat: boolean }
    | { kind: 'cards', cards: { path: string, title: string, fields: [string, string][] }[] }
    | { kind: 'counts', rows: { path: string, label: string, count: number }[], total: number, unit: string, target?: number }
    | { kind: 'document', path: string, text: string }
    | { kind: 'message', text: string };

const MAX_MATCHES = 600;
const MAX_FILES = 300;
const MAX_FILE_CHARS = 400_000;

/** Turns a view description into what the view shows, by searching and reading the workspace. */
@injectable()
export class ViewDataService {

    @inject(WorkspaceTools) protected readonly tools: WorkspaceTools;
    @inject(FileService) protected readonly fileService: FileService;
    @inject(WorkbenchService) protected readonly workbench: WorkbenchService;

    async load(spec: ViewSpec): Promise<ViewData> {
        const root = this.workbench.root;
        if (!root) {
            return { kind: 'message', text: 'Open a folder to fill this view.' };
        }
        const rootPath = root.path.fsPath();
        try {
            switch (spec.kind) {
                case 'outline': {
                    const depth = Math.min(Math.max(spec.depth ?? 2, 1), 6);
                    const found = await this.tools.find(rootPath, { text: `^#{1,${depth}}\\s+\\S`, regex: true, glob: spec.files, max: MAX_MATCHES });
                    const groups = this.byFile(found.lines.map(parseMatch).filter(isDefined).map(match => {
                        const heading = /^(#+)\s+(.*?)\s*#*$/.exec(match.text);
                        return { label: heading ? heading[2] : match.text, path: match.path, line: match.line, level: heading ? heading[1].length : 1 };
                    }));
                    for (const group of groups) {
                        // A file that opens with its only top-level heading is named by it.
                        const tops = group.items.filter(item => item.level === 1);
                        if (tops.length === 1 && group.items[0] === tops[0]) {
                            group.label = tops[0].label;
                            group.items.shift();
                        }
                        const base = Math.min(...group.items.map(item => item.level ?? 1), 6);
                        group.items.forEach(item => item.level = (item.level ?? 1) - base);
                    }
                    return { kind: 'groups', groups, total: found.total, truncated: found.total > found.lines.length, flat: false };
                }
                case 'matches': {
                    const found = await this.tools.find(rootPath, { text: spec.pattern, regex: true, glob: spec.files, max: MAX_MATCHES });
                    const expression = new RegExp(spec.pattern!);
                    const items: ViewItem[] = found.lines.map(parseMatch).filter(isDefined).map(match => {
                        const hit = expression.exec(match.text);
                        const label = (hit?.[1] ?? hit?.[0] ?? match.text).trim();
                        return { label, path: match.path, line: match.line, detail: label === match.text ? undefined : match.text };
                    });
                    let groups: ViewGroup[];
                    if (spec.group === 'match') {
                        const byLabel = new Map<string, ViewItem[]>();
                        for (const item of items) {
                            const list = byLabel.get(item.label) ?? [];
                            list.push({ ...item, label: `${item.path}:${item.line}`, detail: item.detail ?? item.label });
                            byLabel.set(item.label, list);
                        }
                        groups = [...byLabel].sort(([a], [b]) => a.localeCompare(b)).map(([label, list]) => ({ label, items: list }));
                    } else if (spec.group === 'none') {
                        groups = [{ label: '', items: items.map(item => ({ ...item, detail: `${item.path}:${item.line}` })) }];
                    } else {
                        groups = this.byFile(items);
                    }
                    return { kind: 'groups', groups, total: found.total, truncated: found.total > found.lines.length, flat: spec.group === 'none' };
                }
                case 'files': {
                    const files = await this.read(rootPath, spec.files!);
                    return {
                        kind: 'cards',
                        cards: files.map(({ path, text }) => {
                            const { fields, body } = splitFrontMatter(text);
                            const heading = /^#\s+(.+)$/m.exec(body);
                            return {
                                path,
                                title: fields.title ?? fields.name ?? heading?.[1] ?? baseName(path),
                                fields: (spec.fields ?? []).filter(field => fields[field]).map(field => [field, fields[field]] as [string, string])
                            };
                        })
                    };
                }
                case 'counts': {
                    const files = await this.read(rootPath, spec.files!);
                    const lines = spec.unit === 'lines';
                    const rows = files.map(({ path, text }) => {
                        const { fields, body } = splitFrontMatter(text);
                        const heading = /^#\s+(.+)$/m.exec(body);
                        return { path, label: fields.title ?? heading?.[1] ?? baseName(path), count: lines ? body.split('\n').length : countWords(body.replace(/^#+\s.*$/gm, '')) };
                    });
                    return { kind: 'counts', rows, total: rows.reduce((sum, row) => sum + row.count, 0), unit: lines ? 'lines' : 'words', target: spec.target };
                }
                case 'document': {
                    try {
                        const text = (await this.fileService.read(root.resolve(spec.file!))).value;
                        return { kind: 'document', path: spec.file!, text };
                    } catch {
                        return { kind: 'message', text: `${spec.file} does not exist yet.` };
                    }
                }
            }
        } catch (error) {
            return { kind: 'message', text: error instanceof Error ? error.message : String(error) };
        }
    }

    protected byFile(items: ViewItem[]): ViewGroup[] {
        const groups = new Map<string, ViewGroup>();
        for (const item of items) {
            let group = groups.get(item.path);
            if (!group) {
                group = { label: baseName(item.path), path: item.path, items: [] };
                groups.set(item.path, group);
            }
            group.items.push(item);
        }
        return [...groups.values()];
    }

    protected async read(rootPath: string, glob: string): Promise<{ path: string, text: string }[]> {
        const root = this.workbench.root!;
        const listed = await this.tools.find(rootPath, { glob, max: MAX_FILES });
        const result: { path: string, text: string }[] = [];
        for (const path of listed.lines) {
            try {
                const text = (await this.fileService.read(root.resolve(path))).value;
                if (text.length <= MAX_FILE_CHARS && !text.includes('\u0000')) {
                    result.push({ path, text });
                }
            } catch {
                // deleted between listing and reading
            }
        }
        return result;
    }
}

function parseMatch(line: string): { path: string, line: number, text: string } | undefined {
    const match = /^(.*?):(\d+): ?(.*)$/.exec(line);
    return match ? { path: match[1], line: Number(match[2]), text: match[3] } : undefined;
}

function isDefined<T>(value: T | undefined): value is T {
    return value !== undefined;
}

function baseName(path: string): string {
    return path.slice(path.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
}
