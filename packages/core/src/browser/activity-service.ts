import { inject, injectable } from '@theia/core/shared/inversify';
import { Emitter, Event } from '@theia/core';
import { hasToolCallError } from '@theia/ai-core';
import { ChatModel, ChatRequestModel, ChatService, ToolCallChatResponseContent } from '@theia/ai-chat';
import { LineSpan } from '../common/tour.js';
import { summarizePrompt, TourService } from './tour-service.js';

export type EntryStatus = 'running' | 'awaiting-approval' | 'done' | 'failed' | 'denied';

/** One thing the agent did: a tool call, described the way a colleague would mention it. */
export interface ActivityEntry {
    readonly id: string;
    readonly tool: string;
    /** What it was applied to: a path, a query, a command. */
    target: string;
    /** What came of it: "120 lines", "7 matches", "exit 0 · 4.2s". */
    outcome?: string;
    status: EntryStatus;
    readonly startedAt: number;
    endedAt?: number;
    /** Where to go when the entry is clicked. */
    uri?: string;
    span?: LineSpan;
    stopId?: string;
}

export interface ActivityTurn {
    readonly requestId: string;
    readonly sessionId: string;
    readonly prompt: string;
    readonly startedAt: number;
    status: 'running' | 'waiting' | 'done' | 'error' | 'canceled';
    model?: string;
    entries: ActivityEntry[];
    usage?: { input: number, output: number, cacheRead: number };
    /** Number of model round-trips (each tool result goes back to the model once). */
    roundTrips: number;
}

export interface Annotation {
    target?: string;
    outcome?: string;
    uri?: string;
    span?: LineSpan;
    stopId?: string;
}

/**
 * The ledger of what the agent is doing, kept as data rather than as scroll-back.
 *
 * It is derived from the chat model, so every tool call shows up here, including tools from MCP
 * servers that know nothing about this service. Cicerone's own tools add what only they know
 * (which file, which lines, which stop) through {@link annotate}.
 */
@injectable()
export class ActivityService {

    @inject(TourService) protected readonly tours: TourService;

    protected readonly turns: ActivityTurn[] = [];
    protected readonly annotations = new Map<string, Annotation>();
    protected readonly watchedSessions = new Set<string>();
    protected readonly onDidChangeEmitter = new Emitter<void>();
    readonly onDidChange: Event<void> = this.onDidChangeEmitter.event;

    /**
     * Starts observing the chat sessions. Called once at startup rather than injected: the chat
     * service creates the agents, whose tools need this service, so injecting it here would be a cycle.
     */
    connect(chatService: ChatService): void {
        chatService.getSessions().forEach(session => this.watch(session.model));
        chatService.onSessionEvent(event => {
            if (event.type === 'created' || event.type === 'activeChange') {
                const session = event.sessionId ? chatService.getSession(event.sessionId) : undefined;
                if (session) {
                    this.watch(session.model);
                }
            }
        });
    }

    getTurns(): readonly ActivityTurn[] { return this.turns; }

    get runningTurn(): ActivityTurn | undefined {
        return this.turns.findLast(turn => turn.status === 'running' || turn.status === 'waiting');
    }

    /** The entry the agent is busy with right now, if any. */
    get currentEntry(): ActivityEntry | undefined {
        return this.runningTurn?.entries.findLast(entry => entry.status === 'running' || entry.status === 'awaiting-approval');
    }

    totals(): { input: number, output: number, cacheRead: number } {
        return this.turns.reduce((sum, turn) => ({
            input: sum.input + (turn.usage?.input ?? 0),
            output: sum.output + (turn.usage?.output ?? 0),
            cacheRead: sum.cacheRead + (turn.usage?.cacheRead ?? 0)
        }), { input: 0, output: 0, cacheRead: 0 });
    }

    annotate(toolCallId: string | undefined, annotation: Annotation): void {
        if (!toolCallId) {
            return;
        }
        this.annotations.set(toolCallId, { ...this.annotations.get(toolCallId), ...annotation });
        for (const turn of this.turns) {
            const entry = turn.entries.find(candidate => candidate.id === toolCallId);
            if (entry) {
                Object.assign(entry, this.annotations.get(toolCallId));
                this.onDidChangeEmitter.fire();
                return;
            }
        }
    }

    clear(): void {
        this.turns.splice(0, this.turns.length, ...this.turns.filter(turn => turn.status === 'running' || turn.status === 'waiting'));
        this.onDidChangeEmitter.fire();
    }

    protected watch(model: ChatModel): void {
        if (this.watchedSessions.has(model.id)) {
            return;
        }
        this.watchedSessions.add(model.id);
        model.onDidChange(event => {
            if (event.kind === 'addRequest') {
                this.track(model, event.request);
            }
        });
    }

    protected track(model: ChatModel, request: ChatRequestModel): void {
        const turn: ActivityTurn = {
            requestId: request.id,
            sessionId: model.id,
            prompt: summarizePrompt(request.request.displayText ?? request.request.text),
            startedAt: Date.now(),
            status: 'running',
            entries: [],
            roundTrips: 0
        };
        this.turns.push(turn);
        this.onDidChangeEmitter.fire();
        const response = request.response;
        const listener = response.onDidChange(() => {
            this.sync(turn, request);
            if (response.isComplete || response.isCanceled || response.isError) {
                listener.dispose();
                this.tours.finish(request.id, response.isError ? undefined : lastWords(request));
            }
        });
    }

    protected sync(turn: ActivityTurn, request: ChatRequestModel): void {
        const response = request.response;
        turn.model = response.languageModel ?? turn.model;
        turn.status = response.isError ? 'error' : response.isCanceled ? 'canceled' : response.isComplete ? 'done' : response.isWaitingForInput ? 'waiting' : 'running';
        // Each round-trip resends the conversation so far, so what a turn costs is the sum over its round-trips.
        type Usage = { inputTokens: number, outputTokens: number, cacheReadInputTokens?: number };
        const trips = (response as { tokenUsageEntries?: readonly Usage[] }).tokenUsageEntries;
        const usages: readonly Usage[] = trips?.length ? trips : response.tokenUsage ? [response.tokenUsage] : [];
        if (usages.length > 0) {
            turn.usage = {
                input: usages.reduce((sum: number, usage) => sum + usage.inputTokens, 0),
                output: usages.reduce((sum: number, usage) => sum + usage.outputTokens, 0),
                cacheRead: usages.reduce((sum: number, usage) => sum + (usage.cacheReadInputTokens ?? 0), 0)
            };
            turn.roundTrips = usages.length;
        }
        const finished = turn.status !== 'running' && turn.status !== 'waiting';
        for (const content of response.response.content) {
            if (!ToolCallChatResponseContent.is(content) || !content.id) {
                continue;
            }
            let entry = turn.entries.find(candidate => candidate.id === content.id);
            if (!entry) {
                entry = { id: content.id, tool: content.name ?? 'tool', target: '', status: 'running', startedAt: Date.now() };
                turn.entries.push(entry);
            }
            Object.assign(entry, this.annotations.get(content.id));
            if (!entry.target) {
                entry.target = describeArguments(content.arguments);
            }
            const status: EntryStatus = content.finished
                ? (hasToolCallError(content.result) ? 'failed' : isDenied(content.result) ? 'denied' : 'done')
                : content.isAwaitingUserConfirmation ? 'awaiting-approval'
                    : finished ? 'failed' : 'running';
            if (status !== entry.status) {
                entry.status = status;
                if (status !== 'running' && status !== 'awaiting-approval') {
                    entry.endedAt = Date.now();
                }
            }
        }
        this.onDidChangeEmitter.fire();
    }
}

/** The agent's closing text: whatever it said after its last tool call. */
function lastWords(request: ChatRequestModel): string | undefined {
    const content = request.response.response.content;
    const parts: string[] = [];
    for (let i = content.length - 1; i >= 0; i--) {
        const part = content[i];
        if (ToolCallChatResponseContent.is(part)) {
            break;
        }
        if (part.kind === 'markdownContent' || part.kind === 'text') {
            const text = part.asString?.();
            if (text) {
                parts.unshift(text);
            }
        }
    }
    return parts.join('').trim() || undefined;
}

function isDenied(result: unknown): boolean {
    return typeof result === 'string' && /denied|not allowed by the user/i.test(result) && result.length < 200;
}

/** A tool we know nothing about: show its most telling argument. */
function describeArguments(args: string | undefined): string {
    if (!args) {
        return '';
    }
    try {
        const parsed = JSON.parse(args) as Record<string, unknown>;
        const value = Object.values(parsed).find(candidate => typeof candidate === 'string' && candidate.length > 0) as string | undefined;
        return value ? (value.length > 80 ? value.slice(0, 77) + '…' : value).replace(/\s+/g, ' ') : '';
    } catch {
        return '';
    }
}
