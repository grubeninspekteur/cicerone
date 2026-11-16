import * as React from '@theia/core/shared/react';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { CommandService, MessageService } from '@theia/core';
import { codicon, Message, ReactWidget } from '@theia/core/lib/browser';
import { parseTasks } from '../common/tasks.js';
import { ActivityEntry } from './activity-service.js';
import { AgentState, AttentionItem, FleetAgent, FleetService } from './fleet-service.js';
import { Markdown } from './markdown.js';

export const FLEET_WIDGET_ID = 'cicerone.fleet';

export namespace FleetCommandIds {
    export const DISPATCH = 'cicerone.fleet.dispatch';
    export const DISPATCH_SELECTION = 'cicerone.fleet.dispatchSelection';
    export const NEXT = 'cicerone.fleet.next';
    export const TELL = 'cicerone.fleet.tell';
    export const JUMP = 'cicerone.fleet.jump';
    export const STOP_ALL = 'cicerone.fleet.stopAll';
    /** Arguments: the attention item's id. Takes the human to what the item is about. */
    export const GO_TO = 'cicerone.fleet.goTo';
    /** Arguments: session id. Opens the agent's tour at its first undecided stop. */
    export const REVIEW = 'cicerone.fleet.review';
    /** Arguments: session id. Opens the agent's conversation. */
    export const OPEN_CHAT = 'cicerone.fleet.openChat';
}

const STATE_LABEL: Record<AgentState, string> = {
    working: 'working', approval: 'needs approval', review: 'waits for review', decide: 'to review',
    done: 'done', error: 'failed', canceled: 'stopped', idle: 'idle'
};
const STATE_ICON: Record<AgentState, string> = {
    working: 'loading codicon-modifier-spin', approval: 'shield', review: 'debug-pause', decide: 'checklist',
    done: 'check', error: 'error', canceled: 'circle-slash', idle: 'circle-outline'
};
const ATTENTION_ICON: Record<string, string> = { approval: 'shield', gate: 'debug-pause', error: 'error', review: 'checklist', report: 'check' };
const TOOL_ICON: Record<string, string> = {
    read: 'file', find: 'search', edit: 'edit', show: 'eye', run: 'terminal', skill: 'book', delegate: 'type-hierarchy-sub', steer: 'megaphone', queue: 'watch'
};

/**
 * Mission control: every agent on one board, the things that wait for you in one queue above it,
 * and a box to start more. It is the answer to "what are they all doing, and which one needs me",
 * which a stack of chat tabs cannot give.
 */
@injectable()
export class FleetWidget extends ReactWidget {

    static readonly ID = FLEET_WIDGET_ID;
    static readonly LABEL = 'Mission Control';

    @inject(FleetService) protected readonly fleet: FleetService;
    @inject(CommandService) protected readonly commands: CommandService;
    @inject(MessageService) protected readonly messages: MessageService;

    protected ticker: ReturnType<typeof setInterval> | undefined;
    protected draft = '';
    protected input: HTMLTextAreaElement | undefined;

    @postConstruct()
    protected init(): void {
        this.id = FLEET_WIDGET_ID;
        this.title.label = FleetWidget.LABEL;
        this.title.caption = 'Mission Control: every agent, and everything that waits for you';
        this.title.iconClass = codicon('layout');
        this.title.closable = true;
        this.addClass('cicerone-fleet');
        this.node.tabIndex = 0;
        this.toDispose.push(this.fleet.onDidChange(() => { this.update(); this.tick(); }));
        this.update();
    }

    protected override onActivateRequest(message: Message): void {
        super.onActivateRequest(message);
        (this.input ?? this.node).focus();
    }

    /** Puts the cursor in the dispatch box; what the dispatch key does when the board is in view. */
    focusDispatch(): void {
        this.input?.focus();
    }

    /** Elapsed times only need repainting while something is running. */
    protected tick(): void {
        const running = this.fleet.getAgents().some(agent => !agent.endedAt && agent.state !== 'idle');
        if (running && !this.ticker) {
            this.ticker = setInterval(() => this.update(), 1000);
        } else if (!running && this.ticker) {
            clearInterval(this.ticker);
            this.ticker = undefined;
        }
    }

    protected async dispatch(): Promise<void> {
        const tasks = parseTasks(this.draft);
        if (tasks.length === 0) {
            return;
        }
        this.draft = '';
        this.update();
        for (const task of tasks) {
            try {
                await this.fleet.dispatch(task);
            } catch (error) {
                this.messages.error(`Could not start an agent: ${error instanceof Error ? error.message : error}`);
            }
        }
    }

    protected render(): React.ReactNode {
        const agents = this.fleet.getAgents();
        const attention = this.fleet.attention();
        const tasks = parseTasks(this.draft);
        const busy = agents.filter(agent => agent.state === 'working' || agent.state === 'approval' || agent.state === 'review').length;
        const tokens = agents.reduce((sum, agent) => sum + agent.usage.input + agent.usage.output, 0);
        const finished = agents.filter(agent => (agent.state === 'done' || agent.state === 'canceled') && !agent.canWrapUp).length;
        return <div className='cicerone-fleet-body'>
            <section className='cicerone-dispatch'>
                <textarea className='theia-input cicerone-dispatch-input' rows={Math.min(8, Math.max(2, this.draft.split('\n').length))}
                    ref={element => { this.input = element ?? undefined; }}
                    placeholder={'What should an agent do? It starts in the background and reports back here.\nA list ("- fix the slug tests", "- document reading-time") starts one agent per item.'}
                    value={this.draft}
                    onChange={event => { this.draft = event.target.value; this.update(); }}
                    onKeyDown={event => {
                        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                            event.preventDefault();
                            this.dispatch();
                        }
                    }} />
                <div className='cicerone-dispatch-bar'>
                    <span className='cicerone-dim'>
                        {tasks.length > 1 ? <><b>{tasks.length} agents</b> will start, one per list item.</> : <>Enter dispatches · Shift+Enter for a new line · from anywhere: Alt+D</>}
                    </span>
                    <button className='theia-button' disabled={tasks.length === 0} onClick={() => this.dispatch()}>
                        <span className={codicon('rocket')} /> {tasks.length > 1 ? `Dispatch ${tasks.length} agents` : 'Dispatch'}
                    </button>
                </div>
            </section>

            {attention.length > 0 && <section className='cicerone-attention' aria-label='Needs you'>
                <h3 className='cicerone-fleet-heading'>
                    <span className='cicerone-attention-count'>{attention.length}</span> Needs you
                    <span className='cicerone-spacer' />
                    <span className='cicerone-dim cicerone-fleet-hint'>Alt+I takes you to the next one</span>
                </h3>
                {attention.map(item => <AttentionRow key={item.id} item={item} fleet={this.fleet} commands={this.commands} />)}
            </section>}

            <section className='cicerone-agents'>
                <h3 className='cicerone-fleet-heading'>
                    Agents
                    {agents.length > 0 && <span className='cicerone-dim cicerone-fleet-facts'>
                        {busy > 0 ? `${busy} at work` : 'none at work'} · {agents.length} in all{tokens > 0 && <> · {compact(tokens)} tokens</>}
                    </span>}
                    <span className='cicerone-spacer' />
                    {busy > 1 && <button className='cicerone-toggle' title='Stop every agent that is working' onClick={() => this.commands.executeCommand(FleetCommandIds.STOP_ALL)}>
                        <span className={codicon('debug-stop')} /> Stop all
                    </button>}
                    {finished > 0 && <button className='cicerone-toggle' title='Take finished agents off the board. Their conversations and tours are kept.'
                        onClick={() => this.fleet.dismissFinished()}>
                        <span className={codicon('clear-all')} /> Clear finished
                    </button>}
                </h3>
                {agents.length === 0
                    ? <div className='cicerone-fleet-empty'>
                        <div className={`cicerone-empty-icon ${codicon('layout')}`} />
                        <p><b>No agents yet.</b> Describe a task above, or ask in the chat: every conversation shows up here as an agent.</p>
                        <p className='cicerone-dim'>Start several and keep working. Whatever needs you (a command to approve, changes to review, a failure) lines up in one queue on this board,
                            and <kbd>Alt</kbd>+<kbd>I</kbd> takes you to the next one from anywhere. You can talk to an agent while it works; it reads your message at its next step.</p>
                    </div>
                    : <div className='cicerone-agent-grid'>
                        {agents.map(agent => <AgentCard key={agent.sessionId} agent={agent} fleet={this.fleet} commands={this.commands}
                            parent={agent.parentId ? agents.find(candidate => candidate.sessionId === agent.parentId) : undefined} />)}
                    </div>}
            </section>
        </div>;
    }
}

interface RowProps { fleet: FleetService, commands: CommandService }

function AttentionRow({ item, fleet, commands }: RowProps & { item: AttentionItem }): React.ReactElement {
    const { agent } = item;
    return <div className={`cicerone-attention-row ${item.kind}`} data-agent={agent.name}>
        <span className={`cicerone-attention-icon ${codicon(ATTENTION_ICON[item.kind])}`} />
        <div className='cicerone-attention-main'>
            <div className='cicerone-attention-line'>
                <AgentDot agent={agent} /> <b className='cicerone-attention-agent' title={agent.name}>{agent.name}</b> <span>{item.text}</span>
            </div>
            {item.detail && (item.kind === 'report'
                ? <Markdown className='cicerone-attention-detail clamped' text={item.detail} />
                : <code className='cicerone-attention-detail'>{item.detail}</code>)}
        </div>
        <div className='cicerone-attention-actions'>
            {item.kind === 'approval' && <>
                <button className='theia-button' title='Let this step run, this once' onClick={() => fleet.decide(item.toolCallId!, true)}>
                    <span className={codicon('check')} /> Approve
                </button>
                <button className='theia-button secondary' onClick={() => fleet.decide(item.toolCallId!, false)}>Deny</button>
            </>}
            {(item.kind === 'gate' || item.kind === 'review') && <button className='theia-button'
                title='Open the tour at the first stop that waits for you' onClick={() => commands.executeCommand(FleetCommandIds.REVIEW, agent.sessionId)}>
                <span className={codicon('compass')} /> Review
            </button>}
            {(item.kind === 'error' || item.kind === 'report') && <>
                <button className='theia-button' onClick={() => commands.executeCommand(FleetCommandIds.OPEN_CHAT, agent.sessionId)}>
                    <span className={codicon('comment-discussion')} /> Open
                </button>
                <button className='theia-button secondary' title='Seen it' onClick={() => fleet.acknowledge(agent.sessionId)}>Got it</button>
            </>}
        </div>
    </div>;
}

function AgentDot({ agent }: { agent: FleetAgent }): React.ReactElement {
    return <span className={`cicerone-agent-dot colour-${agent.colour}`} />;
}

function AgentCard({ agent, parent, fleet, commands }: RowProps & { agent: FleetAgent, parent?: FleetAgent }): React.ReactElement {
    const [message, setMessage] = React.useState('');
    const live = agent.state === 'working' || agent.state === 'approval' || agent.state === 'review';
    const lastTurn = agent.turns[agent.turns.length - 1];
    const trail = (lastTurn?.entries ?? []).slice(-28);
    const waitingMessages = agent.steering.length + agent.queued.length;
    const send = (when: 'now' | 'after') => {
        if (message.trim()) {
            fleet.tell(agent.sessionId, message, when).catch(error => console.error(error));
            setMessage('');
        }
    };
    return <article className={`cicerone-agent colour-${agent.colour} ${agent.state} ${agent.parentId ? 'worker' : ''} ${agent.unread ? 'unread' : ''}`} data-agent={agent.name}>
        <header className='cicerone-agent-head'>
            <AgentDot agent={agent} />
            <span className='cicerone-agent-name' title={agent.name}>{agent.name}</span>
            <span className={`cicerone-agent-state ${agent.state}`}><span className={codicon(STATE_ICON[agent.state])} /> {STATE_LABEL[agent.state]}</span>
        </header>
        {parent && <div className='cicerone-agent-parent cicerone-dim'><span className={codicon('type-hierarchy-sub')} /> worker for <AgentDot agent={parent} /> {parent.name}</div>}
        <div className='cicerone-agent-now'>
            {live
                ? agent.step ? <StepLine entry={agent.step} waiting={agent.state} />
                    : <span className='cicerone-dim'>thinking…{trail.length > 0 && <> after <span className='cicerone-agent-after'>{trail[trail.length - 1].tool} {trail[trail.length - 1].target}</span></>}</span>
                : agent.error ? <span className='cicerone-agent-error'>{agent.error}</span>
                    : agent.summary ? <Markdown className='cicerone-agent-summary' text={agent.summary} />
                        : <span className='cicerone-dim'>{agent.state === 'canceled' ? 'Stopped before it finished.' : 'No report.'}</span>}
        </div>
        {trail.length > 0 && <div className='cicerone-trail' aria-label='Steps of the current turn'>
            {trail.map(entry => <span key={entry.id} className={`cicerone-trail-step ${entry.status} ${codicon(TOOL_ICON[entry.tool] ?? 'tools')}`}
                title={`${entry.tool} ${entry.target}${entry.outcome ? ` · ${entry.outcome}` : ''}`} />)}
        </div>}
        {agent.files.length > 0 && <div className='cicerone-agent-files'>
            {agent.files.map(file => <span key={file.path} className={`cicerone-file ${file.sharedWith.length ? 'shared' : ''}`}
                title={file.sharedWith.length ? `Also changed by: ${file.sharedWith.join(', ')}. Their proposals build on each other in the order they were made; review them together.` : file.path}>
                {file.sharedWith.length > 0 && <span className={codicon('warning')} />}{file.path.slice(file.path.lastIndexOf('/') + 1)}
            </span>)}
        </div>}
        <footer className='cicerone-agent-foot'>
            <span className='cicerone-dim cicerone-agent-facts'>
                {agent.changes > 0 && <span title='Changes written to the files, of all it proposed'>{agent.applied}/{agent.changes} applied</span>}
                {agent.usage.input + agent.usage.output > 0 && <span title='Tokens sent to and received from the model'>{compact(agent.usage.input + agent.usage.output)} tok</span>}
                <span>{elapsed((agent.endedAt ?? Date.now()) - agent.startedAt)}</span>
                {waitingMessages > 0 && <span className='cicerone-agent-waiting' title={[...agent.steering, ...agent.queued].join('\n')}>
                    <span className={codicon('mail')} /> {waitingMessages} to deliver
                </span>}
            </span>
            <span className='cicerone-agent-actions'>
                {agent.pending > 0 && <button className='cicerone-icon-button accent' title={`Review its ${agent.pending} pending ${agent.pending === 1 ? 'stop' : 'stops'}`}
                    onClick={() => commands.executeCommand(FleetCommandIds.REVIEW, agent.sessionId)}><span className={codicon('compass')} /></button>}
                {agent.canWrapUp && <button className='cicerone-icon-button accent' title='Tell it what you accepted and rejected, and let it wrap up'
                    onClick={() => fleet.tell(agent.sessionId, 'I have reviewed your stops. Finish only what my last request still needs, such as checking the accepted changes. ' +
                        'Do not start anything new; if nothing is left to do, say so in one sentence.')}><span className={codicon('check-all')} /></button>}
                <button className='cicerone-icon-button' title='Open its conversation' onClick={() => commands.executeCommand(FleetCommandIds.OPEN_CHAT, agent.sessionId)}>
                    <span className={codicon('comment-discussion')} />
                </button>
                {live
                    ? <button className='cicerone-icon-button' title='Stop this agent' onClick={() => fleet.stop(agent.sessionId)}><span className={codicon('debug-stop')} /></button>
                    : <button className='cicerone-icon-button' title='Take it off the board (its conversation and tour are kept)' onClick={() => fleet.dismiss(agent.sessionId)}>
                        <span className={codicon('close')} />
                    </button>}
            </span>
        </footer>
        <input className='theia-input cicerone-agent-tell' value={message} onChange={event => setMessage(event.target.value)}
            placeholder={live ? 'Say something while it works…' : 'Follow up…'}
            title={live ? 'It keeps working. Enter: your message travels with the result of the step it is on. Alt+Enter: it gets the message as its next request when it is done.' : 'Send it another request'}
            onKeyDown={event => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    send(event.altKey ? 'after' : 'now');
                }
            }} />
        {live && message && <div className='cicerone-dim cicerone-agent-tell-hint'>Enter: it reads this at its next step · Alt+Enter: once it has finished</div>}
    </article>;
}

function StepLine({ entry, waiting }: { entry: ActivityEntry, waiting: AgentState }): React.ReactElement {
    return <span className='cicerone-agent-step'>
        <span className={codicon(TOOL_ICON[entry.tool] ?? 'tools')} /> <b>{entry.tool}</b> <span title={entry.target}>{entry.target}</span>
        {waiting === 'approval' && <em> · waiting for your approval</em>}
        {waiting === 'review' && <em> · held until you have reviewed its changes</em>}
    </span>;
}

function compact(tokens: number): string {
    return tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}M` : tokens >= 10_000 ? `${Math.round(tokens / 1000)}k`
        : tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

function elapsed(ms: number): string {
    const seconds = Math.max(0, Math.round(ms / 1000));
    return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
}
