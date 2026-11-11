import { injectable } from '@theia/core/shared/inversify';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import { rgPath } from '@vscode/ripgrep';
import { globToRegExp } from '../common/glob.js';
import { FindOptions, FindResult, RunResult, WorkspaceTools } from '../common/workspace-tools.js';

/** Characters of context kept on each side of a match. */
const EXCERPT = 90;
const MAX_CAPTURE = 256 * 1024;
const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules', 'lib', 'dist', 'build', 'target', '.venv']);

@injectable()
export class WorkspaceToolsImpl implements WorkspaceTools {

    async find(rootFsPath: string, options: FindOptions): Promise<FindResult> {
        try {
            return await this.findWithRipgrep(rootFsPath, options);
        } catch (error) {
            if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
                // No ripgrep binary for this platform: slower, but the tool keeps working.
                return this.findWithNode(rootFsPath, options);
            }
            throw error;
        }
    }

    protected findWithRipgrep(root: string, options: FindOptions): Promise<FindResult> {
        const args = ['--color', 'never', '--hidden', '--glob', '!.git', '--sort', 'path'];
        if (options.glob) {
            args.push('--glob', options.glob);
        }
        if (options.text !== undefined) {
            args.push('--line-number', '--no-heading', '--smart-case');
            if (options.wholeLines) {
                if (!options.regex) {
                    args.push('--fixed-strings');
                }
                args.push('--regexp', options.text, '.');
            } else {
                // Ask for the match with some text on either side instead of the line it is on.
                const pattern = options.regex ? options.text : escapeRegExp(options.text);
                args.push('--only-matching', '--regexp', `.{0,${EXCERPT}}(?:${pattern}).{0,${EXCERPT}}`, '.');
            }
        } else {
            args.push('--files');
        }
        return new Promise((resolve, reject) => {
            const child = spawn(rgPath, args, { cwd: root });
            const lines: string[] = [];
            let total = 0;
            let rest = '';
            let stderr = '';
            child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
                const parts = (rest + chunk).split('\n');
                rest = parts.pop() ?? '';
                for (const part of parts) {
                    total++;
                    if (lines.length < options.max) {
                        lines.push(this.tidy(part, options.text !== undefined));
                    }
                }
            });
            child.stderr.setEncoding('utf8').on('data', (chunk: string) => stderr += chunk);
            child.on('error', reject);
            child.on('close', code => {
                // ripgrep: 0 = matches, 1 = none, 2 = error.
                if (code !== null && code > 1) {
                    reject(new Error(stderr.trim().split('\n')[0] || `search failed (${code})`));
                } else {
                    resolve({ lines, total });
                }
            });
        });
    }

    /** `./src/a.ts:12:  text` → `src/a.ts:12: text` */
    protected tidy(line: string, isMatch: boolean): string {
        const relative = line.startsWith('./') ? line.slice(2) : line;
        if (!isMatch) {
            return relative;
        }
        const match = /^(.*?):(\d+):(.*)$/.exec(relative);
        return match ? `${match[1]}:${match[2]}: ${match[3].trim()}` : relative;
    }

    protected async findWithNode(root: string, options: FindOptions): Promise<FindResult> {
        const globPattern = options.glob ? globToRegExp(options.glob) : undefined;
        const matcher = options.text === undefined ? undefined
            : new RegExp(options.regex ? options.text : escapeRegExp(options.text), /[A-Z]/.test(options.text) ? '' : 'i');
        const lines: string[] = [];
        let total = 0;
        const add = (line: string) => {
            total++;
            if (lines.length < options.max) {
                lines.push(line);
            }
        };
        const walk = async (dir: string): Promise<void> => {
            const entries = (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
            for (const entry of entries) {
                const absolute = path.join(dir, entry.name);
                const relative = path.relative(root, absolute).split(path.sep).join('/');
                if (entry.isDirectory()) {
                    if (!SKIPPED_DIRECTORIES.has(entry.name)) {
                        await walk(absolute);
                    }
                    continue;
                }
                if (globPattern && !globPattern.test(relative)) {
                    continue;
                }
                if (options.text === undefined) {
                    add(relative);
                    continue;
                }
                const stat = await fs.stat(absolute);
                if (stat.size > 1024 * 1024) {
                    continue;
                }
                const content = await fs.readFile(absolute, 'utf8');
                if (content.includes('\u0000')) {
                    continue;
                }
                content.split('\n').forEach((text, index) => {
                    const hit = matcher!.exec(text);
                    if (hit) {
                        const excerpt = options.wholeLines ? text : text.slice(Math.max(0, hit.index - EXCERPT), hit.index + hit[0].length + EXCERPT);
                        add(`${relative}:${index + 1}: ${excerpt.trim()}`);
                    }
                });
            }
        };
        await walk(root);
        return { lines, total };
    }

    run(cwdFsPath: string, command: string, timeoutMs: number): Promise<RunResult> {
        const started = Date.now();
        return new Promise(resolve => {
            const child = spawn(command, { cwd: cwdFsPath, shell: true, env: { ...process.env, CI: '1', NO_COLOR: '1', TERM: 'dumb' } });
            let output = '';
            let dropped = 0;
            let timedOut = false;
            const capture = (chunk: string) => {
                output += chunk;
                if (output.length > MAX_CAPTURE) {
                    // Keep the tail: that is where a failing command says why.
                    dropped += output.length - MAX_CAPTURE;
                    output = output.slice(-MAX_CAPTURE);
                }
            };
            child.stdout.setEncoding('utf8').on('data', capture);
            child.stderr.setEncoding('utf8').on('data', capture);
            const timer = setTimeout(() => {
                timedOut = true;
                child.kill('SIGTERM');
                setTimeout(() => child.kill('SIGKILL'), 2000).unref();
            }, timeoutMs);
            const finish = (exitCode: number | null) => {
                clearTimeout(timer);
                resolve({ exitCode, output: (dropped > 0 ? `[… ${dropped} characters dropped …]\n` : '') + output, durationMs: Date.now() - started, timedOut });
            };
            child.on('error', error => { capture(String(error)); finish(null); });
            child.on('close', finish);
        });
    }
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
