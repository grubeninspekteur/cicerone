import { inject, injectable, named } from '@theia/core/shared/inversify';
import { ContributionProvider, URI } from '@theia/core';
import { createToolCallError, ToolCallResult, ToolProvider, ToolRequest, ToolRequestParametersProperties } from '@theia/ai-core';
import { parseSkillFile } from '@theia/ai-core/lib/common/skill';
import { SkillService } from '@theia/ai-core/lib/browser';
import { assertChatContext, ChatToolContext } from '@theia/ai-chat';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { locate } from '../common/tour.js';
import { WorkspaceTools } from '../common/workspace-tools.js';
import { ActivityService } from './activity-service.js';
import { BuiltinSkill, BuiltinSkillContribution } from './builtin-skills.js';
import { EditValidator } from './edit-validator.js';
import { FleetService } from './fleet-service.js';
import { StopPresenter } from './stop-presenter.js';
import { ProposalError, TourOrigin, TourService } from './tour-service.js';
import { WorkspaceDocuments } from './workspace-documents.js';

/*
 * The whole tool set. Seven tools, short descriptions, short results.
 *
 * Every definition below is sent with every request, and every result stays in the conversation
 * for the rest of it, so both are written to be as small as they can be while still being
 * unambiguous: results say what happened in a line, cap what they return, and say what was cut.
 */

export const TOOL_PROVIDER = 'cicerone';
/** Where workspace skills live: the Agent Skills convention, which Theia's skill service scans too. */
const WORKSPACE_SKILLS = '.agents/skills';
export const READ_LINES = 400;
const READ_CHARS = 32_000;
const FIND_MAX = 60;
const RUN_TAIL_LINES = 60;
const RUN_HEAD_LINES = 12;
const RUN_TIMEOUT_MS = 120_000;
const MAX_WORKERS = 6;

@injectable()
abstract class CiceroneTool implements ToolProvider {

    @inject(WorkspaceDocuments) protected readonly documents: WorkspaceDocuments;
    @inject(TourService) protected readonly tours: TourService;
    @inject(ActivityService) protected readonly activity: ActivityService;
    @inject(StopPresenter) protected readonly presenter: StopPresenter;
    @inject(FleetService) protected readonly fleet: FleetService;

    abstract getTool(): ToolRequest;

    protected define<A>(
        name: string,
        description: string,
        properties: ToolRequestParametersProperties,
        required: string[],
        run: (args: A, ctx: ChatToolContext) => Promise<ToolCallResult>,
        label: (args: A) => string | undefined,
        extra?: Partial<ToolRequest>
    ): ToolRequest {
        return {
            id: name,
            name,
            description,
            providerName: TOOL_PROVIDER,
            parameters: { type: 'object', properties, required },
            getArgumentsShortLabel: (raw: string) => {
                try {
                    const text = label(JSON.parse(raw) as A);
                    return text ? { label: text, hasMore: false } : undefined;
                } catch {
                    return undefined;
                }
            },
            handler: async (raw: string, ctx?: unknown) => {
                try {
                    assertChatContext(ctx);
                    if (ctx.cancellationToken?.isCancellationRequested) {
                        return createToolCallError('Cancelled by the user.');
                    }
                    const args = JSON.parse(raw || '{}') as A;
                    this.activity.annotate(ctx.toolCallId, { target: label(args) });
                    return this.steered(await run(args, ctx), ctx);
                } catch (error) {
                    // What the model reads when it got something wrong: one sentence it can act on.
                    const failure = createToolCallError(error instanceof Error ? error.message : String(error));
                    return ChatToolContext.is(ctx) ? this.steered(failure, ctx) : failure;
                }
            },
            ...extra
        };
    }

    /**
     * A tool result is the one moment a working model reads something new, so whatever the human
     * said in the meantime travels with it. That is what makes an agent steerable without stopping it.
     */
    protected steered(result: ToolCallResult, ctx: ChatToolContext): ToolCallResult {
        const steering = this.fleet.takeSteering(ctx.request.session.id);
        if (!steering) {
            return result;
        }
        if (typeof result === 'string') {
            return `${result}\n\n${steering}`;
        }
        const failure = errorText(result);
        return failure === undefined ? result : createToolCallError(`${failure}\n\n${steering}`);
    }

    protected origin(ctx: ChatToolContext): TourOrigin {
        return { sessionId: ctx.request.session.id, requestId: ctx.request.id, prompt: ctx.request.request.displayText ?? ctx.request.request.text };
    }
}

@injectable()
export class ReadTool extends CiceroneTool {

    getTool(): ToolRequest {
        return this.define<{ path: string, from?: number, lines?: number }>(
            'read',
            `Read a text file, with your held proposals applied. Returns at most ${READ_LINES} lines; page with from/lines.`,
            {
                path: { type: 'string', description: 'Workspace-relative path.' },
                from: { type: 'integer', description: 'First line, 1-based. Default 1.' },
                lines: { type: 'integer', description: `Number of lines. Default ${READ_LINES}.` }
            },
            ['path'],
            async (args, ctx) => {
                const uri = this.documents.resolve(args.path);
                const text = await this.tours.proposedText(uri);
                if (text === undefined) {
                    throw new Error(`${args.path} does not exist.`);
                }
                if (text.includes('\u0000')) {
                    throw new Error(`${args.path} is a binary file.`);
                }
                const all = text.split('\n');
                const from = Math.max(1, Math.floor(args.from ?? 1));
                const wanted = Math.max(1, Math.min(Math.floor(args.lines ?? READ_LINES), READ_LINES));
                let slice = all.slice(from - 1, from - 1 + wanted);
                let body = slice.join('\n');
                if (body.length > READ_CHARS) {
                    // Very long lines: cut on a line boundary rather than mid-sentence.
                    let size = 0;
                    const kept = slice.findIndex(line => (size += line.length + 1) > READ_CHARS);
                    slice = slice.slice(0, Math.max(1, kept));
                    body = slice.join('\n').slice(0, READ_CHARS);
                }
                const to = from + slice.length - 1;
                const partial = from > 1 || to < all.length;
                this.activity.annotate(ctx.toolCallId, {
                    uri: uri.toString(),
                    span: { startLine: from, endLine: Math.max(from, to) },
                    outcome: partial ? `lines ${from}–${to} of ${all.length}` : `${all.length} lines`
                });
                this.presenter.follow(uri, partial ? { startLine: from, endLine: Math.min(to, from + 30) } : undefined, ctx.request.session.id);
                // The header is only spent when the model needs it to know there is more.
                return partial ? `[lines ${from}-${to} of ${all.length}]\n${body}` : body;
            },
            args => args.path
        );
    }
}

@injectable()
export class FindTool extends CiceroneTool {

    @inject(WorkspaceTools) protected readonly workspaceTools: WorkspaceTools;

    getTool(): ToolRequest {
        return this.define<{ text?: string, glob?: string, regex?: boolean }>(
            'find',
            'Search the workspace. With `text`: lines containing it, as path:line: text. Without `text`: the files matching `glob`. Respects .gitignore.',
            {
                text: { type: 'string', description: 'Text to search for (case-insensitive unless it contains capitals).' },
                glob: { type: 'string', description: 'Limit to matching paths, e.g. src/**/*.ts or *.md.' },
                regex: { type: 'boolean', description: 'Treat `text` as a regular expression.' }
            },
            [],
            async (args, ctx) => {
                if (!args.text && !args.glob) {
                    throw new Error('Pass `text`, `glob`, or both.');
                }
                const root = this.documents.requireRoot();
                const result = await this.workspaceTools.find(root.path.fsPath(), { text: args.text || undefined, regex: args.regex, glob: args.glob, max: FIND_MAX });
                const unit = args.text ? 'match' : 'file';
                this.activity.annotate(ctx.toolCallId, { outcome: `${result.total} ${unit}${result.total === 1 ? '' : unit === 'match' ? 'es' : 's'}` });
                if (result.total === 0) {
                    return args.text ? 'No matches.' : 'No files.';
                }
                const cut = result.total > result.lines.length ? `\n[${result.total - result.lines.length} more not shown; narrow the search]` : '';
                return result.lines.join('\n') + cut;
            },
            args => [args.text && `"${args.text}"`, args.glob].filter(Boolean).join(' in ')
        );
    }
}

@injectable()
export class EditTool extends CiceroneTool {

    @inject(ContributionProvider) @named(EditValidator)
    protected readonly validators: ContributionProvider<EditValidator>;

    protected async problems(uri: URI, path: string): Promise<string> {
        const proposed = await this.tours.proposedText(uri);
        if (proposed === undefined) {
            return '';
        }
        const found: string[] = [];
        for (const validator of this.validators.getContributions()) {
            found.push(...await validator.validate(uri, path, proposed) ?? []);
        }
        return found.length ? `\nProblems to fix with another edit:\n- ${found.join('\n- ')}` : '';
    }

    getTool(): ToolRequest {
        return this.define<{ path: string, old: string, new: string, why: string }>(
            'edit',
            'Change a file: replace the exact text `old` (must occur once) with `new`. Empty `old` creates the file. ' +
            'Becomes a tour stop with your `why`; the result says whether it was written or is held for the user to accept.',
            {
                path: { type: 'string', description: 'Workspace-relative path.' },
                old: { type: 'string', description: 'Exact text to replace, with enough context to be unique. Empty to create the file.' },
                new: { type: 'string', description: 'Replacement text.' },
                why: { type: 'string', description: 'One sentence for the reviewer: what this change does and why.' }
            },
            ['path', 'old', 'new', 'why'],
            async (args, ctx) => {
                const uri = this.documents.resolve(args.path);
                if (typeof args.old !== 'string' || typeof args.new !== 'string') {
                    throw new Error('`old` and `new` must be strings.');
                }
                try {
                    const stop = await this.tours.proposeEdit(this.origin(ctx), uri, args.old, args.new, args.why?.trim() || 'No reason given.', ctx.toolCallId);
                    this.activity.annotate(ctx.toolCallId, { uri: uri.toString(), stopId: stop.id, outcome: `stop ${stop.n}` });
                    const problems = await this.problems(uri, args.path);
                    if (this.presenter.writesAtOnce(args.path)) {
                        const problem = await this.tours.accept(stop);
                        if (problem) {
                            await this.tours.reject(stop);
                            return createToolCallError(`Could not write the change: ${problem}`);
                        }
                        return `Written; stop ${stop.n}.${problems}`;
                    }
                    return `Held as proposal; stop ${stop.n}.${problems}`;
                } catch (error) {
                    if (error instanceof ProposalError) {
                        return createToolCallError(error.message);
                    }
                    throw error;
                }
            },
            args => args.path
        );
    }
}

@injectable()
export class ShowTool extends CiceroneTool {

    getTool(): ToolRequest {
        return this.define<{ path: string, quote: string, why: string }>(
            'show',
            'Point the user at a place that matters but needs no change (the cause, the precedent, the conflict). Shown as a tour stop.',
            {
                path: { type: 'string', description: 'Workspace-relative path.' },
                quote: { type: 'string', description: 'Exact text from the file marking the place; a line or a few.' },
                why: { type: 'string', description: 'One sentence: what the user should notice here.' }
            },
            ['path', 'quote', 'why'],
            async (args, ctx) => {
                const uri = this.documents.resolve(args.path);
                const text = await this.tours.proposedText(uri);
                if (text === undefined) {
                    throw new Error(`${args.path} does not exist.`);
                }
                const span = locate(text, args.quote) ?? locate(text, args.quote.trim());
                if (!span) {
                    throw new Error(`\`quote\` was not found in ${args.path}. Quote the file exactly.`);
                }
                const stop = this.tours.addContext(this.origin(ctx), uri, args.quote, args.why?.trim() || '', ctx.toolCallId);
                this.activity.annotate(ctx.toolCallId, { uri: uri.toString(), span, stopId: stop.id, outcome: `stop ${stop.n}` });
                return `Shown as stop ${stop.n}.`;
            },
            args => args.path
        );
    }
}

@injectable()
export class RunTool extends CiceroneTool {

    @inject(WorkspaceTools) protected readonly workspaceTools: WorkspaceTools;

    getTool(): ToolRequest {
        return this.define<{ command: string, why?: string }>(
            'run',
            'Run a shell command in the workspace root (tests, builds, linters, word counts). It runs on the files as written: ' +
            'if proposals of yours are still held, it first waits for the user to review them and tells you what they decided. ' +
            'Returns exit code and the end of the output.',
            {
                command: { type: 'string', description: 'The command line.' },
                why: { type: 'string', description: 'One sentence: what this shows the user.' }
            },
            ['command'],
            async (args, ctx) => {
                const root = this.documents.requireRoot();
                const sessionId = ctx.request.session.id;
                let review = '';
                if (this.tours.pendingIn(sessionId).length > 0) {
                    // Running now would test the files without the agent's own changes and report a failure that means nothing.
                    this.activity.annotate(ctx.toolCallId, { outcome: 'waiting for your review' });
                    const outcome = await this.tours.awaitReview(sessionId, args.command, ctx.cancellationToken);
                    if (outcome === 'cancelled') {
                        return createToolCallError('Cancelled by the user.');
                    }
                    review = outcome === 'skipped'
                        ? '[the user had this run without reviewing: your held proposals are NOT in the files]\n'
                        : `${this.tours.reviewNote(sessionId) ?? '[review of your stops: nothing accepted]'}\n`;
                }
                const result = await this.workspaceTools.run(root.path.fsPath(), args.command, RUN_TIMEOUT_MS);
                const seconds = (result.durationMs / 1000).toFixed(1);
                const status = result.timedOut ? `timed out after ${seconds}s` : `exit ${result.exitCode} · ${seconds}s`;
                const stop = this.tours.addResult(this.origin(ctx), args.command, result.exitCode, result.output.trimEnd(), args.why?.trim() || '', ctx.toolCallId);
                this.activity.annotate(ctx.toolCallId, { outcome: status, stopId: stop.id });
                const text = `${review}[${status}]\n${elide(result.output.trimEnd())}`;
                return result.exitCode === 0 && !result.timedOut ? text : createToolCallError(text);
            },
            args => args.command,
            {
                // Shell access is the one capability here that can do damage, so it always asks first.
                confirmAlwaysAllow: 'This lets the agent run any shell command in your workspace without asking.'
            }
        );
    }
}

/**
 * Fan-out. The agent splits off parts of the work that do not depend on each other; each goes to a
 * worker with a conversation, a tour and a place on the fleet board of its own, and they run at the
 * same time. What comes back is each worker's closing words, not its transcript: the parent pays
 * for a paragraph per worker, and the human reviews the workers' stops like anyone else's.
 */
@injectable()
export class DelegateTool extends CiceroneTool {

    getTool(): ToolRequest {
        return this.define<{ tasks: string[] }>(
            'delegate',
            `Hand independent parts of the work to up to ${MAX_WORKERS} workers that run in parallel. Each worker is a fresh agent that knows only its task text, ` +
            'so make each one self-contained (files, goal, what to report). Returns every worker\'s closing summary. Not for steps that depend on each other.',
            { tasks: { type: 'array', items: { type: 'string' }, description: 'One self-contained instruction per worker.' } },
            ['tasks'],
            async (args, ctx) => {
                const sessionId = ctx.request.session.id;
                const tasks = (Array.isArray(args.tasks) ? args.tasks : []).filter(task => typeof task === 'string' && task.trim()).map(task => task.trim());
                if (tasks.length === 0) {
                    throw new Error('Pass `tasks`: a list of instructions, one per worker.');
                }
                if (tasks.length > MAX_WORKERS) {
                    throw new Error(`At most ${MAX_WORKERS} workers at a time; you passed ${tasks.length}. Group the tasks.`);
                }
                if (this.tours.parentOf(sessionId)) {
                    throw new Error('You are a worker; workers do the task themselves and cannot delegate.');
                }
                this.activity.annotate(ctx.toolCallId, { outcome: `${tasks.length} ${tasks.length === 1 ? 'worker' : 'workers'} at work` });
                const workers = await Promise.all(tasks.map(task => this.fleet.dispatch(task, { parentId: sessionId })));
                const cancelling = ctx.cancellationToken?.onCancellationRequested(() => workers.forEach(worker => this.fleet.stop(worker.sessionId)));
                try {
                    const turns = await Promise.all(workers.map(worker => worker.finished));
                    const reports = workers.map((worker, index) => {
                        const agent = this.fleet.getAgent(worker.sessionId);
                        const turn = turns[index];
                        const outcome = !turn ? 'did not start'
                            : turn.status === 'error' ? `failed: ${turn.error ?? 'unknown error'}`
                                : turn.status === 'canceled' ? 'was stopped by the user'
                                    : agent?.summary ?? 'finished without a summary';
                        const held = agent && agent.changes > 0 ? ` [${agent.changes} ${agent.changes === 1 ? 'change' : 'changes'}: ${agent.applied} written, ${agent.pending} held for the user's review]` : '';
                        return `Worker ${index + 1} (${tasks[index].split('\n')[0].slice(0, 60)}): ${outcome}${held}`;
                    });
                    const failed = turns.filter(turn => !turn || turn.status !== 'done').length;
                    this.activity.annotate(ctx.toolCallId, { outcome: failed ? `${tasks.length - failed} of ${tasks.length} workers finished` : `${tasks.length} ${tasks.length === 1 ? 'worker' : 'workers'} finished` });
                    return reports.join('\n\n');
                } finally {
                    cancelling?.dispose();
                }
            },
            args => Array.isArray(args.tasks) ? `${args.tasks.length} ${args.tasks.length === 1 ? 'task' : 'tasks'}` : undefined
        );
    }
}

/** The message of a tool error, or undefined for any other result. */
function errorText(result: ToolCallResult): string | undefined {
    const content = (result as { content?: { type?: string, data?: unknown }[] } | undefined)?.content;
    const first = Array.isArray(content) && content.length === 1 ? content[0] : undefined;
    return first?.type === 'error' && typeof first.data === 'string' ? first.data : undefined;
}

/** Keeps the start (what ran) and the end (how it went) of long output. */
function elide(output: string): string {
    const lines = output.split('\n');
    if (lines.length <= RUN_HEAD_LINES + RUN_TAIL_LINES) {
        return output;
    }
    const dropped = lines.length - RUN_HEAD_LINES - RUN_TAIL_LINES;
    return [...lines.slice(0, RUN_HEAD_LINES), `[… ${dropped} lines …]`, ...lines.slice(-RUN_TAIL_LINES)].join('\n');
}

/** What the model is told about a skill before it loads it. */
export interface SkillSummary { name: string, description: string }

@injectable()
export class SkillLibrary {

    @inject(SkillService) protected readonly skillService: SkillService;
    @inject(FileService) protected readonly fileService: FileService;
    @inject(WorkspaceDocuments) protected readonly documents: WorkspaceDocuments;
    @inject(ContributionProvider) @named(BuiltinSkillContribution)
    protected readonly builtins: ContributionProvider<BuiltinSkillContribution>;

    protected builtinSkills(): BuiltinSkill[] {
        return this.builtins.getContributions().flatMap(contribution => contribution.getSkills());
    }

    /**
     * Skills in the workspace that the skill service has not noticed yet. Its file watching lags by
     * a few seconds, which is exactly the window in which a skill that was just created (by the
     * agent, or by setting up a profile) gets used for the first time.
     */
    protected async unseenWorkspaceSkills(known: Set<string>): Promise<{ name: string, description: string, content: string }[]> {
        const root = this.documents.root;
        if (!root) {
            return [];
        }
        const result: { name: string, description: string, content: string }[] = [];
        try {
            const directory = await this.fileService.resolve(root.resolve(WORKSPACE_SKILLS));
            for (const child of directory.children ?? []) {
                if (!child.isDirectory || known.has(child.name)) {
                    continue;
                }
                try {
                    const parsed = parseSkillFile((await this.fileService.read(child.resource.resolve('SKILL.md'))).value);
                    if (parsed.metadata?.name === child.name && parsed.metadata.description) {
                        result.push({ name: child.name, description: parsed.metadata.description, content: parsed.content.trim() });
                    }
                } catch {
                    // a folder without a readable SKILL.md is not a skill
                }
            }
        } catch {
            // no skills folder in this workspace
        }
        return result;
    }

    /** Workspace and user skills first, built-in ones after; a workspace skill shadows a built-in of the same name. */
    async list(): Promise<SkillSummary[]> {
        await this.skillService.ready;
        const found = this.skillService.getSkills().map(skill => ({ name: skill.qualifiedName, description: skill.description }));
        const names = new Set(found.map(skill => skill.name));
        for (const skill of await this.unseenWorkspaceSkills(names)) {
            found.push({ name: skill.name, description: skill.description });
            names.add(skill.name);
        }
        return [...found, ...this.builtinSkills().filter(skill => !names.has(skill.name)).map(({ name, description }) => ({ name, description }))];
    }

    async load(name: string): Promise<string | undefined> {
        await this.skillService.ready;
        const skill = this.skillService.getSkill(name);
        if (skill) {
            const location = skill.location.includes('://') ? new URI(skill.location) : URI.fromFilePath(skill.location);
            const raw = (await this.fileService.read(location)).value;
            return parseSkillFile(raw).content.trim();
        }
        const unseen = (await this.unseenWorkspaceSkills(new Set())).find(candidate => candidate.name === name);
        if (unseen) {
            return unseen.content;
        }
        const builtin = this.builtinSkills().find(candidate => candidate.name === name);
        if (builtin) {
            return (typeof builtin.content === 'string' ? builtin.content : await builtin.content()).trim();
        }
        return undefined;
    }
}

@injectable()
export class SkillTool extends CiceroneTool {

    @inject(SkillLibrary) protected readonly skills: SkillLibrary;

    getTool(): ToolRequest {
        return this.define<{ name: string }>(
            'skill',
            'Load the instructions of a skill listed in the system prompt. Do this before starting work the skill covers.',
            { name: { type: 'string', description: 'Skill name.' } },
            ['name'],
            async (args, ctx) => {
                const content = await this.skills.load(args.name);
                if (content === undefined) {
                    const known = (await this.skills.list()).map(skill => skill.name).join(', ');
                    throw new Error(`No skill named '${args.name}'. Available: ${known || 'none'}.`);
                }
                this.activity.annotate(ctx.toolCallId, { outcome: 'loaded' });
                return content;
            },
            args => args.name
        );
    }
}
