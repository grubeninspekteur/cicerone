import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { Emitter, Event } from '@theia/core';
import { ChatAgentLocation, ChatService, ChatSession, ToolCallChatResponseContent } from '@theia/ai-chat';
import { Tour } from '../common/tour.js';
import { ActivityEntry, ActivityService, ActivityTurn } from './activity-service.js';
import { summarizePrompt, TourService } from './tour-service.js';

/**
 * What an agent is up to, in the one word a person juggling several of them needs:
 * `approval` and `review` mean it is blocked on the human, `decide` that it has finished and left proposals.
 */
export type AgentState = 'working' | 'approval' | 'review' | 'decide' | 'done' | 'error' | 'canceled' | 'idle';

export interface FleetFile {
    path: string;
    /** Names of other agents that read-write the same file: the place where parallel work collides. */
    sharedWith: string[];
}

/** One conversation with the agent, seen from above. */
export interface FleetAgent {
    readonly sessionId: string;
    readonly name: string;
    /** Index into the agent colours; stable for the life of the agent. */
    readonly colour: number;
    /** The agent that delegated to this one, if it is a worker. */
    readonly parentId?: string;
    readonly state: AgentState;
    /** The step it is on right now. */
    readonly step?: ActivityEntry;
    readonly turns: ActivityTurn[];
    readonly startedAt: number;
    readonly endedAt?: number;
    readonly pending: number;
    readonly changes: number;
    readonly applied: number;
    readonly files: FleetFile[];
    readonly usage: { input: number, output: number };
    /** Its closing words. */
    readonly summary?: string;
    readonly error?: string;
    /** Messages waiting to reach it at its next step. */
    readonly steering: readonly string[];
    /** Messages it gets once it has finished what it is doing. */
    readonly queued: readonly string[];
    /** It finished and the human has not looked yet. */
    readonly unread: boolean;
    /** Decisions were made about its stops that it has not heard of. */
    readonly canWrapUp: boolean;
}

export type AttentionKind = 'approval' | 'gate' | 'error' | 'review' | 'report';

/** One thing, anywhere in the fleet, that waits for the human. */
export interface AttentionItem {
    readonly id: string;
    readonly kind: AttentionKind;
    readonly agent: FleetAgent;
    /** What is asked of the human, in a line. */
    readonly text: string;
    /** Detail worth reading before deciding: the command line, the error. */
    readonly detail?: string;
    readonly since: number;
    readonly toolCallId?: string;
}

export interface DispatchOptions {
    /** Shown instead of the prompt in the chat. */
    displayText?: string;
    name?: string;
    /** Makes the new agent a worker of this conversation. */
    parentId?: string;
    /** Leaves the chat view on the conversation it is showing. Default true. */
    background?: boolean;
}

export interface Dispatched {
    sessionId: string;
    /** Resolves with the agent's closing words when its first turn has ended. */
    finished: Promise<ActivityTurn | undefined>;
}

const ATTENTION_ORDER: AttentionKind[] = ['approval', 'gate', 'error', 'review', 'report'];
export const AGENT_COLOURS = 8;
/** What a tool result carries when the human steered while the agent worked. Named in the system prompt. */
/** Stands in for a conversation id when the human is watching none of the agents. */
const NOBODY = 'nobody';
export const STEER_PREFIX = '[the user, while you work: ';

/**
 * The fleet: every conversation with the agent, running or finished, and the one queue of things
 * that wait for the human across all of them.
 *
 * A chat shows one agent as scroll-back and makes you find the moment it needs you. With several
 * agents at work that does not scale, so the questions "who is doing what" and "what is waiting
 * for me" are answered here, from the ledger and the tours, and every agent can be dispatched,
 * steered, approved, stopped and reviewed without opening its conversation.
 */
@injectable()
export class FleetService {

    @inject(ActivityService) protected readonly activity: ActivityService;
    @inject(TourService) protected readonly tours: TourService;

    protected chat: ChatService | undefined;
    protected readonly names = new Map<string, string>();
    protected readonly colours = new Map<string, number>();
    protected readonly background = new Set<string>();
    protected readonly dismissed = new Set<string>();
    protected readonly steering = new Map<string, string[]>();
    protected readonly queued = new Map<string, string[]>();
    /** Requests whose outcome the human has seen. */
    protected readonly seen = new Set<string>();
    protected readonly finishWaiters = new Map<string, ((turn: ActivityTurn | undefined) => void)[]>();
    protected known = new Set<string>();
    protected lastVisited: string | undefined;
    protected firing = false;

    protected readonly onDidChangeEmitter = new Emitter<void>();
    readonly onDidChange: Event<void> = this.onDidChangeEmitter.event;
    protected readonly onDidNeedAttentionEmitter = new Emitter<AttentionItem>();
    /** Fires when something new starts waiting for the human. */
    readonly onDidNeedAttention: Event<AttentionItem> = this.onDidNeedAttentionEmitter.event;

    /** Whether the human can be assumed to be looking at the conversation they have open. Set by the UI. */
    isWatching: () => boolean = () => true;

    @postConstruct()
    protected init(): void {
        this.activity.onDidChange(() => this.changed());
        this.tours.onDidChange(() => this.changed());
        this.activity.onDidFinishTurn(turn => this.turnFinished(turn));
    }

    /** Called once at startup rather than injected, for the same reason as {@link ActivityService.connect}. */
    connect(chat: ChatService): void {
        this.chat = chat;
        this.watch(chat.getActiveSession()?.id);
        chat.onSessionEvent(event => {
            if (event.type === 'activeChange') {
                this.watch(event.sessionId);
                this.markSeen(event.sessionId);
            } else if (event.type === 'deleted') {
                this.dismissed.add(event.sessionId);
            }
            this.changed();
        });
    }

    /**
     * The conversation in the chat view is the one the tour and the editor follow, unless it is an
     * agent that was sent to the background and never opened: that one stays out of the way.
     */
    protected watch(sessionId: string | undefined): void {
        this.tours.watchedSessionId = sessionId && !this.background.has(sessionId) ? sessionId : NOBODY;
    }

    protected changed(): void {
        if (this.firing) {
            return;
        }
        this.firing = true;
        queueMicrotask(() => {
            this.firing = false;
            const now = this.attention();
            const before = this.known;
            this.known = new Set(now.map(item => item.id));
            this.onDidChangeEmitter.fire();
            now.filter(item => !before.has(item.id)).forEach(item => this.onDidNeedAttentionEmitter.fire(item));
        });
    }

    // ------------------------------------------------------------------ reading the fleet

    protected sessionIds(): string[] {
        const ids = new Set<string>();
        for (const turn of this.activity.getTurns()) {
            ids.add(turn.sessionId);
        }
        return [...ids].filter(id => !this.dismissed.has(id));
    }

    nameOf(sessionId: string): string {
        return this.names.get(sessionId) ?? this.activity.turnsOf(sessionId)[0]?.prompt ?? 'Agent';
    }

    colourOf(sessionId: string): number {
        let colour = this.colours.get(sessionId);
        if (colour === undefined) {
            colour = this.colours.size % AGENT_COLOURS;
            this.colours.set(sessionId, colour);
        }
        return colour;
    }

    /** Whether the agent was started away from the chat, so "this" and "here" in the editor mean nothing to it. */
    isBackground(sessionId: string): boolean {
        return this.background.has(sessionId);
    }

    getAgents(): FleetAgent[] {
        const ids = this.sessionIds();
        const touched = new Map<string, Set<string>>();
        for (const id of ids) {
            touched.set(id, this.changedFiles(id));
        }
        const agents = ids.map(id => this.describe(id, touched));
        // Workers follow the agent they work for.
        const roots = agents.filter(agent => !agent.parentId || !ids.includes(agent.parentId));
        const ordered: FleetAgent[] = [];
        const place = (agent: FleetAgent) => {
            ordered.push(agent);
            agents.filter(child => child.parentId === agent.sessionId).forEach(place);
        };
        roots.forEach(place);
        return ordered;
    }

    getAgent(sessionId: string): FleetAgent | undefined {
        return this.getAgents().find(agent => agent.sessionId === sessionId);
    }

    protected changedFiles(sessionId: string): Set<string> {
        const paths = new Set<string>();
        for (const tour of this.tours.getTours()) {
            if (tour.sessionId === sessionId) {
                Tour.changes(tour).filter(stop => stop.path && stop.state !== 'rejected').forEach(stop => paths.add(stop.path!));
            }
        }
        return paths;
    }

    protected describe(sessionId: string, touched: Map<string, Set<string>>): FleetAgent {
        const turns = this.activity.turnsOf(sessionId);
        const last = turns[turns.length - 1];
        const running = this.activity.runningTurnOf(sessionId);
        const step = running?.entries.findLast(entry => entry.status === 'running' || entry.status === 'awaiting-approval');
        const tours = this.tours.getTours().filter(tour => tour.sessionId === sessionId);
        const changes = tours.flatMap(tour => Tour.changes(tour));
        const pending = changes.filter(stop => stop.state === 'pending').length;
        const gate = this.tours.getGates().find(candidate => candidate.sessionId === sessionId);
        let state: AgentState = 'idle';
        if (running) {
            state = running.entries.some(entry => entry.status === 'awaiting-approval') ? 'approval' : gate ? 'review' : 'working';
        } else if (last) {
            state = last.status === 'error' ? 'error' : pending > 0 ? 'decide' : last.status === 'canceled' ? 'canceled' : 'done';
        }
        const mine = touched.get(sessionId) ?? new Set<string>();
        const files = [...mine].map(path => ({
            path,
            sharedWith: [...touched].filter(([other, paths]) => other !== sessionId && paths.has(path)).map(([other]) => this.nameOf(other))
        }));
        return {
            sessionId,
            name: this.nameOf(sessionId),
            colour: this.colourOf(sessionId),
            parentId: this.tours.parentOf(sessionId),
            state,
            step,
            turns,
            startedAt: turns[0]?.startedAt ?? Date.now(),
            endedAt: running ? undefined : last?.endedAt,
            pending,
            changes: changes.length,
            applied: changes.filter(stop => stop.state === 'accepted').length,
            files,
            usage: turns.reduce((sum, turn) => ({ input: sum.input + (turn.usage?.input ?? 0), output: sum.output + (turn.usage?.output ?? 0) }), { input: 0, output: 0 }),
            summary: turns.findLast(turn => turn.summary)?.summary ?? tours.findLast(tour => tour.summary)?.summary,
            error: last?.status === 'error' ? last.error : undefined,
            steering: this.steering.get(sessionId) ?? [],
            queued: this.queued.get(sessionId) ?? [],
            unread: !running && !!last && !this.seen.has(last.requestId),
            canWrapUp: !running && pending === 0 && this.tours.hasUnreportedReview(sessionId)
        };
    }

    /** Everything that waits for the human, most blocking first: an agent held up by you comes before one that is merely done. */
    attention(): AttentionItem[] {
        const items: AttentionItem[] = [];
        for (const agent of this.getAgents()) {
            const running = this.activity.runningTurnOf(agent.sessionId);
            for (const entry of running?.entries ?? []) {
                if (entry.status === 'awaiting-approval') {
                    items.push({
                        id: `approval:${entry.id}`, kind: 'approval', agent, since: entry.startedAt, toolCallId: entry.id,
                        text: `wants to ${entry.tool === 'run' ? 'run a command' : `use ${entry.tool}`}`, detail: entry.target
                    });
                }
            }
            const gate = this.tours.getGates().find(candidate => candidate.sessionId === agent.sessionId);
            if (gate) {
                const waiting = this.tours.pendingIn(agent.sessionId).length;
                items.push({
                    id: `gate:${agent.sessionId}:${gate.since}`, kind: 'gate', agent, since: gate.since,
                    text: `waits for your review of ${count(waiting, 'stop')} before it runs`, detail: gate.reason
                });
            }
            const last = agent.turns[agent.turns.length - 1];
            if (running || !last) {
                continue;
            }
            const since = last.endedAt ?? last.startedAt;
            if (agent.state === 'error' && agent.unread) {
                items.push({ id: `error:${last.requestId}`, kind: 'error', agent, since, text: 'failed', detail: agent.error });
            } else if (agent.pending > 0 && !this.tours.gateFor(agent.sessionId)) {
                items.push({ id: `review:${agent.sessionId}`, kind: 'review', agent, since, text: `finished with ${count(agent.pending, 'stop')} to review` });
            } else if (agent.unread && agent.state === 'done' && !agent.parentId) {
                items.push({ id: `report:${last.requestId}`, kind: 'report', agent, since, text: 'finished', detail: agent.summary });
            }
        }
        return items.sort((a, b) => ATTENTION_ORDER.indexOf(a.kind) - ATTENTION_ORDER.indexOf(b.kind) || a.since - b.since);
    }

    /** The next thing to look at: a different one each time while there are several, so repeating the key walks the queue. */
    nextAttention(): AttentionItem | undefined {
        const items = this.attention();
        const index = items.findIndex(item => item.id === this.lastVisited);
        const next = items[(index + 1) % Math.max(1, items.length)];
        this.lastVisited = next?.id;
        return next;
    }

    // ------------------------------------------------------------------ acting on the fleet

    protected requireChat(): ChatService {
        if (!this.chat) {
            throw new Error('The chat is not ready yet.');
        }
        return this.chat;
    }

    /**
     * Starts an agent on a task in a conversation of its own. By default it works in the background:
     * the chat stays where it is, the tour and the editor are not taken over.
     */
    async dispatch(text: string, options: DispatchOptions = {}): Promise<Dispatched> {
        const chat = this.requireChat();
        const background = options.background !== false;
        const previous = chat.getActiveSession();
        const session = chat.createSession(ChatAgentLocation.Panel, { focus: false });
        const sessionId = session.id;
        if (options.parentId) {
            // Theia's own delegation uses these fields, so its session list shows the hierarchy and deleting the parent takes the workers along.
            const root = chat.getSession(options.parentId)?.rootSessionId ?? options.parentId;
            session.parentSessionId = options.parentId;
            session.rootSessionId = root;
            Object.assign(session.model, { parentSessionId: options.parentId, rootSessionId: root });
            this.tours.adopt(sessionId, options.parentId);
        }
        const name = options.name?.trim() || summarizePrompt(options.displayText ?? text);
        this.names.set(sessionId, name);
        // A session that has a title is not sent to the model to be given one: the task is its name, and naming costs a request.
        session.title = name;
        this.colourOf(sessionId);
        if (background) {
            this.background.add(sessionId);
            if (previous) {
                chat.setActiveSession(previous.id, { focus: false });
            }
            this.watch(chat.getActiveSession()?.id);
        }
        const finished = new Promise<ActivityTurn | undefined>(resolve => {
            this.finishWaiters.set(sessionId, [...this.finishWaiters.get(sessionId) ?? [], resolve]);
        });
        const invocation = await chat.sendRequest(sessionId, { text, displayText: options.displayText });
        if (!invocation) {
            this.settle(sessionId, undefined);
        } else {
            // A request that never reaches an agent produces no turn to wait for.
            invocation.requestCompleted.catch(() => this.settle(sessionId, undefined));
        }
        this.changed();
        return { sessionId, finished };
    }

    protected settle(sessionId: string, turn: ActivityTurn | undefined): void {
        const waiters = this.finishWaiters.get(sessionId);
        this.finishWaiters.delete(sessionId);
        waiters?.forEach(resolve => resolve(turn));
    }

    /**
     * Says something to an agent without waiting for it to stop. `now`: it reads the message with the
     * result of the step it is on and changes course from there. `after`: it gets the message as its
     * next request once it has finished. An agent that is not working gets it at once either way.
     */
    async tell(sessionId: string, text: string, when: 'now' | 'after' = 'now'): Promise<void> {
        const message = text.trim();
        if (!message) {
            return;
        }
        if (!this.activity.runningTurnOf(sessionId)) {
            await this.requireChat().sendRequest(sessionId, { text: message });
            return;
        }
        const list = when === 'now' ? this.steering : this.queued;
        list.set(sessionId, [...list.get(sessionId) ?? [], message]);
        this.activity.note(sessionId, when === 'now' ? 'steer' : 'queue', message, when === 'now' ? 'at its next step' : 'when it has finished');
        this.changed();
    }

    /** What the human said while the agent worked, as the line its current tool result should end with. Each message is delivered once. */
    takeSteering(sessionId: string): string | undefined {
        const messages = this.steering.get(sessionId);
        if (!messages?.length) {
            return undefined;
        }
        this.steering.delete(sessionId);
        this.activity.resolveNotes(sessionId, 'steer', 'delivered');
        this.changed();
        return messages.map(message => `${STEER_PREFIX}${message}]`).join('\n');
    }

    protected turnFinished(turn: ActivityTurn): void {
        const sessionId = turn.sessionId;
        // Steering that found no step to travel with (the agent was already writing its answer) is not lost: it becomes the next request.
        const leftover = [...this.steering.get(sessionId) ?? [], ...this.queued.get(sessionId) ?? []];
        this.steering.delete(sessionId);
        if (turn.status === 'done') {
            this.queued.delete(sessionId);
        }
        // The human saw it happen if it happened in the conversation they have open, with the window in front of them.
        if (this.tours.watchedSessionId === sessionId && !this.background.has(sessionId) && this.isWatching()) {
            this.seen.add(turn.requestId);
        }
        if (turn.status === 'done' && leftover.length > 0 && this.chat?.getSession(sessionId)) {
            this.chat.sendRequest(sessionId, { text: leftover.join('\n\n') }).catch(error => console.error('Cicerone: could not pass a queued message on', error));
        } else {
            this.settle(sessionId, turn);
        }
        this.changed();
    }

    protected markSeen(sessionId: string | undefined): void {
        const turns = sessionId ? this.activity.turnsOf(sessionId) : [];
        turns.filter(turn => turn.status !== 'running' && turn.status !== 'waiting').forEach(turn => this.seen.add(turn.requestId));
    }

    /** Brings an agent's conversation to the chat view. From then on it is the one the tour and the editor follow. */
    focus(sessionId: string): ChatSession | undefined {
        const session = this.chat?.getSession(sessionId);
        if (session) {
            // Once opened it is a conversation like any other: followed in the editor, and "this" means the selection.
            this.background.delete(sessionId);
            this.markSeen(sessionId);
            this.chat!.setActiveSession(sessionId, { focus: true });
            this.watch(sessionId);
            this.changed();
        }
        return session;
    }

    /** Marks an agent's outcome as seen without opening its conversation. */
    acknowledge(sessionId: string): void {
        this.markSeen(sessionId);
        this.changed();
    }

    protected findToolCall(toolCallId: string): ToolCallChatResponseContent | undefined {
        for (const session of this.chat?.getSessions() ?? []) {
            for (const request of session.model.getRequests()) {
                for (const content of request.response.response.content) {
                    if (ToolCallChatResponseContent.is(content) && content.id === toolCallId) {
                        return content;
                    }
                }
            }
        }
        return undefined;
    }

    /** Answers a step that waits for approval, from wherever the human happens to be. */
    decide(toolCallId: string, allow: boolean): boolean {
        const call = this.findToolCall(toolCallId);
        if (!call?.isAwaitingUserConfirmation) {
            return false;
        }
        if (allow) {
            call.confirm();
        } else {
            call.deny('Denied by the user.');
        }
        this.changed();
        return true;
    }

    async stop(sessionId: string): Promise<void> {
        this.steering.delete(sessionId);
        this.queued.delete(sessionId);
        for (const member of this.tours.family(sessionId)) {
            const turn = this.activity.runningTurnOf(member);
            if (turn) {
                await this.chat?.cancelRequest(member, turn.requestId);
            }
        }
        this.changed();
    }

    /** Takes a finished agent off the board. Its conversation and its tours stay where they are. */
    async dismiss(sessionId: string): Promise<void> {
        await this.stop(sessionId);
        this.tours.family(sessionId).forEach(member => this.dismissed.add(member));
        this.changed();
    }

    /** Takes every agent off the board that is finished and has nothing left to review. */
    dismissFinished(): void {
        for (const agent of this.getAgents()) {
            if ((agent.state === 'done' || agent.state === 'canceled') && !agent.canWrapUp) {
                this.dismissed.add(agent.sessionId);
            }
        }
        this.changed();
    }
}

function count(n: number, noun: string): string {
    return `${n} ${noun}${n === 1 ? '' : 's'}`;
}
