import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import {
    Command, CommandContribution, CommandRegistry, MenuContribution, MenuModelRegistry, MessageService, PreferenceSchema, PreferenceScope, PreferenceService,
    QuickInputService, QuickPickItem
} from '@theia/core';
import {
    AbstractViewContribution, ApplicationShell, FrontendApplication, FrontendApplicationContribution, KeybindingContribution, KeybindingRegistry,
    StatusBar, StatusBarAlignment, WidgetManager
} from '@theia/core/lib/browser';
import { LanguageModelRegistry } from '@theia/ai-core';
import { ChatService } from '@theia/ai-chat';
import { EditorManager, EDITOR_CONTEXT_MENU } from '@theia/editor/lib/browser';
import { Tour } from '../common/tour.js';
import { ActivityService } from './activity-service.js';
import { ACTIVITY_WIDGET_ID, ActivityWidget } from './activity-widget.js';
import { MODEL_PREF } from './cicerone-agent.js';
import { AttentionItem, FleetAgent, FleetService } from './fleet-service.js';
import { FLEET_WIDGET_ID, FleetCommandIds, FleetWidget } from './fleet-widget.js';
import { WorkspaceDocuments } from './workspace-documents.js';
import { FOLLOW_PREF, REVIEW_PREF, StopPresenter, WRITE_AT_ONCE_PREF } from './stop-presenter.js';
import { TourService } from './tour-service.js';
import { TOUR_WIDGET_ID, TourCommandIds, TourWidget } from './tour-widget.js';

export const CHAT_VIEW_ID = 'chat-view-widget';
export const NOTIFY_PREF = 'cicerone.notify';
/** Selections up to this size travel with a dispatched task; larger ones are referred to by line range. */
const INLINE_SELECTION_CHARS = 2000;

export const CiceronePreferenceSchema: PreferenceSchema = {
    properties: {
        [FOLLOW_PREF]: {
            type: 'boolean',
            default: true,
            description: 'Show each file in the editor as the agent reads or changes it, and bring up the tour when it starts proposing.'
        },
        [REVIEW_PREF]: {
            type: 'string',
            enum: ['before', 'after'],
            enumDescriptions: [
                'Changes are held as proposals. Nothing is written to a file until you accept the stop.',
                'Changes are written as the agent makes them, so it can test its own work. You review the tour afterwards and can undo any stop.'
            ],
            default: 'before',
            scope: PreferenceScope.User,
            description: 'When you review the agent\'s changes: before they are written, or after.'
        },
        [WRITE_AT_ONCE_PREF]: {
            type: 'array',
            items: { type: 'string' },
            default: [],
            scope: PreferenceScope.User,
            markdownDescription: 'Files whose changes are written at once even when changes otherwise wait for you, as globs: e.g. `notes/**` or `test/**`. ' +
                'They still appear as stops and can be undone. Only your user settings count; a workspace cannot set this.'
        },
        [NOTIFY_PREF]: {
            type: 'boolean',
            default: false,
            scope: PreferenceScope.User,
            description: 'Show a desktop notification when an agent starts waiting for you (an approval, a review, a failure, a finished task) while this window is in the background.'
        },
        [MODEL_PREF]: {
            type: 'string',
            default: '',
            markdownDescription: 'Model the agent uses, e.g. `litellm/claude-sonnet`. Empty: the model chosen for the agent in the AI configuration, ' +
                'otherwise the first model your gateway offers.'
        }
    }
};

export namespace CiceroneCommands {
    const category = 'Cicerone';
    export const NEXT: Command = { id: 'cicerone.tour.next', label: 'Tour: Next Stop', category };
    export const PREVIOUS: Command = { id: 'cicerone.tour.previous', label: 'Tour: Previous Stop', category };
    export const ACCEPT: Command = { id: 'cicerone.tour.accept', label: 'Tour: Accept Current Stop', category };
    export const REJECT: Command = { id: 'cicerone.tour.reject', label: 'Tour: Reject Current Stop', category };
    export const ACCEPT_ALL: Command = { id: 'cicerone.tour.acceptAll', label: 'Tour: Accept All Pending Stops', category };
    export const DISCUSS: Command = { id: TourCommandIds.DISCUSS, label: 'Tour: Discuss Current Stop with the Agent…', category };
    export const CONTINUE: Command = { id: TourCommandIds.CONTINUE, label: 'Tour: Tell the Agent What You Decided and Let It Wrap Up', category };
    export const TOGGLE_FOLLOW: Command = { id: 'cicerone.follow.toggle', label: 'Toggle Following the Agent in the Editor', category };
    export const DISPATCH: Command = { id: FleetCommandIds.DISPATCH, label: 'Dispatch an Agent…', category };
    export const DISPATCH_SELECTION: Command = { id: FleetCommandIds.DISPATCH_SELECTION, label: 'Dispatch an Agent on This Selection…', category };
    export const NEXT_ATTENTION: Command = { id: FleetCommandIds.NEXT, label: 'Go to the Next Thing That Needs You', category };
    export const TELL: Command = { id: FleetCommandIds.TELL, label: 'Steer a Working Agent…', category };
    export const JUMP: Command = { id: FleetCommandIds.JUMP, label: 'Go to Agent…', category };
    export const STOP_ALL: Command = { id: FleetCommandIds.STOP_ALL, label: 'Stop All Agents', category };
    export const TOGGLE_NOTIFY: Command = { id: 'cicerone.notify.toggle', label: 'Toggle Desktop Notifications When an Agent Needs You', category };
    export const TOGGLE_REVIEW: Command = { id: 'cicerone.review.toggle', label: 'Toggle Reviewing Changes Before or After They Are Written', category };
}

@injectable()
export class TourViewContribution extends AbstractViewContribution<TourWidget> {
    constructor() {
        super({
            widgetId: TOUR_WIDGET_ID,
            widgetName: TourWidget.LABEL,
            defaultWidgetOptions: { area: 'left', rank: 150 },
            toggleCommandId: 'cicerone.tour.toggle',
            toggleKeybinding: 'ctrlcmd+alt+t'
        });
    }
}

@injectable()
export class ActivityViewContribution extends AbstractViewContribution<ActivityWidget> {
    constructor() {
        super({
            widgetId: ACTIVITY_WIDGET_ID,
            widgetName: ActivityWidget.LABEL,
            defaultWidgetOptions: { area: 'bottom', rank: 50 },
            toggleCommandId: 'cicerone.activity.toggle'
        });
    }
}

@injectable()
export class FleetViewContribution extends AbstractViewContribution<FleetWidget> {
    constructor() {
        super({
            widgetId: FLEET_WIDGET_ID,
            widgetName: FleetWidget.LABEL,
            defaultWidgetOptions: { area: 'main' },
            toggleCommandId: 'cicerone.fleet.toggle',
            toggleKeybinding: 'alt+o'
        });
    }
}

const STATUS_ID = 'cicerone.status';
const NO_MODEL_STATUS_ID = 'cicerone.status.noModel';
/** Contributed by @cicerone/litellm; named here so the core does not depend on that package. */
export const CONNECT_GATEWAY_COMMAND_ID = 'cicerone.gateway.connect';

/** Commands, keys, the status bar entry, and the layout a fresh workspace starts with. */
@injectable()
export class CiceroneContribution implements FrontendApplicationContribution, CommandContribution, KeybindingContribution, MenuContribution {

    @inject(FleetService) protected readonly fleet: FleetService;
    @inject(FleetViewContribution) protected readonly fleetView: FleetViewContribution;
    @inject(EditorManager) protected readonly editorManager: EditorManager;
    @inject(WorkspaceDocuments) protected readonly documents: WorkspaceDocuments;

    @inject(TourService) protected readonly tours: TourService;
    @inject(ActivityService) protected readonly activity: ActivityService;
    @inject(StopPresenter) protected readonly presenter: StopPresenter;
    @inject(TourViewContribution) protected readonly tourView: TourViewContribution;
    @inject(ActivityViewContribution) protected readonly activityView: ActivityViewContribution;
    @inject(StatusBar) protected readonly statusBar: StatusBar;
    @inject(ApplicationShell) protected readonly shell: ApplicationShell;
    @inject(WidgetManager) protected readonly widgetManager: WidgetManager;
    @inject(ChatService) protected readonly chatService: ChatService;
    @inject(QuickInputService) protected readonly quickInput: QuickInputService;
    @inject(MessageService) protected readonly messages: MessageService;
    @inject(PreferenceService) protected readonly preferences: PreferenceService;
    @inject(LanguageModelRegistry) protected readonly languageModels: LanguageModelRegistry;

    @postConstruct()
    protected init(): void {
        this.languageModels.onChange(() => this.updateModelStatus());
        this.tours.onDidChange(() => this.updateStatus());
        this.activity.onDidChange(() => this.updateStatus());
        this.fleet.onDidChange(() => { this.updateStatus(); this.updateTitle(); });
        this.fleet.onDidNeedAttention(item => this.notify(item));
        this.fleet.isWatching = () => !document.hidden;
        this.tours.onDidAddStop(stop => {
            // The first stop of a tour is the moment the tour becomes the thing to look at, if it is the agent being watched.
            const sessionId = this.tours.getTour(stop.tourId)?.sessionId;
            if (stop.n === 1 && this.presenter.following && this.tours.isWatched(sessionId)) {
                this.tourView.openView({ reveal: true });
            }
        });
    }

    onStart(): void {
        this.activity.connect(this.chatService);
        this.fleet.connect(this.chatService);
        // The workbench rewrites the window title whenever the active editor changes; the count has to survive that.
        const title = document.querySelector('title');
        if (title) {
            new MutationObserver(() => this.updateTitle()).observe(title, { childList: true, characterData: true, subtree: true });
        }
        this.updateStatus();
        // Providers register their models shortly after start; do not cry wolf before they had the chance.
        setTimeout(() => this.updateModelStatus(), 4000);
    }

    /**
     * Without a model nothing works, and the first place that said so used to be an error in the chat.
     * A status bar entry says it up front and leads to the way out.
     */
    protected async updateModelStatus(): Promise<void> {
        const models = await this.languageModels.getLanguageModels();
        if (models.some(model => model.status.status === 'ready')) {
            this.statusBar.removeElement(NO_MODEL_STATUS_ID);
            return;
        }
        this.statusBar.setElement(NO_MODEL_STATUS_ID, {
            text: '$(plug) No model connected',
            tooltip: 'The agent has no language model to talk to. Click to connect a LiteLLM gateway, or set up another provider in the AI Configuration view.',
            alignment: StatusBarAlignment.LEFT,
            priority: 1001,
            backgroundColor: 'var(--theia-statusBarItem-warningBackground)',
            color: 'var(--theia-statusBarItem-warningForeground)',
            command: CONNECT_GATEWAY_COMMAND_ID
        });
    }

    /** Only runs when there is no saved layout: what was asked | the board and the work | the conversation, activity underneath. */
    async initializeLayout(_app: FrontendApplication): Promise<void> {
        await this.fleetView.openView({ activate: false, reveal: true });
        await this.tourView.openView({ activate: false });
        await this.activityView.openView({ activate: false, reveal: true });
        // The tour carries prose, so the side panels start wider than a file tree needs.
        this.shell.leftPanelHandler.resize(340);
        this.shell.rightPanelHandler.resize(400);
        try {
            const chat = await this.widgetManager.getOrCreateWidget(CHAT_VIEW_ID);
            if (!chat.isAttached) {
                await this.shell.addWidget(chat, { area: 'right', rank: 100 });
            }
            await this.shell.revealWidget(CHAT_VIEW_ID);
        } catch {
            // Without the chat extension there is nothing to place.
        }
    }

    /**
     * One line for the whole fleet. With a single agent it says what that agent is doing; with
     * several, how many are at work and how many wait for you, and a click goes to the first of those.
     */
    protected updateStatus(): void {
        const attention = this.fleet.attention();
        const agents = this.fleet.getAgents();
        const busy = agents.filter(agent => agent.state === 'working' || agent.state === 'approval' || agent.state === 'review');
        const stray = attention.length === 1 && busy.length === 1 && attention[0].agent.sessionId !== busy[0].sessionId;
        let text: string | undefined;
        let tooltip = 'Open the tour';
        let command = 'cicerone.tour.toggle';
        if (busy.length > 1 || attention.length > 1 || stray) {
            const parts = [
                busy.length ? `${busy.length} ${busy.length === 1 ? 'agent' : 'agents'} at work` : '',
                attention.length ? `${attention.length} ${attention.length === 1 ? 'needs' : 'need'} you` : ''
            ].filter(Boolean);
            text = `${attention.length ? '$(bell-dot)' : '$(loading~spin)'} Cicerone: ${parts.join(' · ')}`;
            tooltip = attention.length
                ? `Next: ${attention[0].agent.name} ${attention[0].text}. Click (or Alt+I) to go there.`
                : 'Open Mission Control';
            command = attention.length ? FleetCommandIds.NEXT : 'cicerone.fleet.toggle';
        } else {
            const agent: FleetAgent | undefined = busy[0];
            const gate = agent && this.tours.getGates().find(candidate => candidate.sessionId === agent.sessionId);
            const entry = agent?.step;
            const pending = this.tours.pendingCount();
            if (gate) {
                const waiting = this.tours.pendingIn(gate.sessionId).length;
                text = `$(compass) Cicerone waits for your review: ${waiting} ${waiting === 1 ? 'stop' : 'stops'}, then ${shorten(gate.reason)}`;
                tooltip = 'The agent wants to run a command that needs its proposed changes in the files. Review them in the tour.';
                command = FleetCommandIds.NEXT;
            } else if (entry) {
                text = entry.status === 'awaiting-approval'
                    ? `$(shield) Cicerone needs your approval: ${entry.tool} ${shorten(entry.target)}`
                    : `$(loading~spin) Cicerone: ${entry.tool} ${shorten(entry.target)}`;
                tooltip = entry.status === 'awaiting-approval' ? 'Click (or Alt+I) to decide' : 'What the agent is doing right now';
                command = entry.status === 'awaiting-approval' ? FleetCommandIds.NEXT : 'cicerone.activity.toggle';
            } else if (agent) {
                text = '$(loading~spin) Cicerone: thinking';
                command = 'cicerone.activity.toggle';
            } else if (attention[0] && attention[0].kind !== 'review') {
                text = `$(bell-dot) ${shorten(attention[0].agent.name)} ${attention[0].text}`;
                tooltip = 'Click (or Alt+I) to go there';
                command = FleetCommandIds.NEXT;
            } else if (pending > 0) {
                text = `$(compass) ${pending} ${pending === 1 ? 'stop' : 'stops'} to review`;
            }
        }
        if (text) {
            this.statusBar.setElement(STATUS_ID, { text, tooltip, alignment: StatusBarAlignment.LEFT, priority: 1000, command });
        } else {
            this.statusBar.removeElement(STATUS_ID);
        }
    }

    /** The number of things waiting, in the window title: visible in the tab bar and the task switcher when the window is not. */
    protected updateTitle(): void {
        const waiting = this.fleet.attention().length;
        const bare = document.title.replace(/^\(\d+\) /, '');
        const wanted = waiting > 0 ? `(${waiting}) ${bare}` : bare;
        if (document.title !== wanted) {
            document.title = wanted;
        }
    }

    protected notify(item: AttentionItem): void {
        if (!document.hidden || !this.preferences.get<boolean>(NOTIFY_PREF, false) || typeof Notification === 'undefined' || Notification.permission !== 'granted') {
            return;
        }
        const notification = new Notification(`${item.agent.name} ${item.text}`, { body: item.detail, tag: item.id });
        notification.onclick = () => {
            window.focus();
            this.goTo(item);
        };
    }

    protected async toggleNotifications(): Promise<void> {
        const on = !this.preferences.get<boolean>(NOTIFY_PREF, false);
        if (on) {
            if (typeof Notification === 'undefined') {
                this.messages.warn('This browser has no desktop notifications.');
                return;
            }
            if (Notification.permission !== 'granted' && await Notification.requestPermission() !== 'granted') {
                this.messages.warn('The browser did not allow notifications for this page.');
                return;
            }
        }
        await this.preferences.set(NOTIFY_PREF, on, PreferenceScope.User);
        this.messages.info(on ? 'You will be notified when an agent needs you while this window is in the background.' : 'Desktop notifications are off.');
    }

    // ------------------------------------------------------------------ the fleet

    /** Takes the human to what an attention item is about. */
    protected async goTo(item: AttentionItem): Promise<void> {
        if (item.kind === 'approval') {
            await this.decideApproval(item);
        } else if (item.kind === 'gate' || item.kind === 'review') {
            await this.review(item.agent.sessionId);
        } else {
            await this.openChat(item.agent.sessionId);
        }
    }

    protected async nextAttention(): Promise<void> {
        const item = this.fleet.nextAttention();
        if (!item) {
            this.messages.info('Nothing is waiting for you.', { timeout: 2500 });
            return;
        }
        await this.goTo(item);
    }

    /** An approval can be given from anywhere, but never blind: the question shows what would run. */
    protected async decideApproval(item: AttentionItem): Promise<void> {
        type Choice = QuickPickItem & { choice: 'allow' | 'deny' | 'open' };
        const items: Choice[] = [
            { label: '$(check) Approve', description: 'run it, this once', choice: 'allow' },
            { label: '$(circle-slash) Deny', description: 'the agent is told you said no', choice: 'deny' },
            { label: '$(comment-discussion) Open the conversation', choice: 'open' }
        ];
        const picked = await this.quickInput.showQuickPick(items, {
            title: `${item.agent.name} ${item.text}`,
            placeholder: item.detail
        });
        if (picked?.choice === 'open') {
            await this.openChat(item.agent.sessionId);
        } else if (picked && item.toolCallId && !this.fleet.decide(item.toolCallId, picked.choice === 'allow')) {
            this.messages.warn('That step is no longer waiting.');
        }
    }

    /** Opens the tour of an agent (or of one of its workers) at the first stop that still waits for a decision. */
    protected async review(sessionId: string): Promise<void> {
        const family = this.tours.family(sessionId);
        const tours = this.tours.getTours().filter(tour => family.includes(tour.sessionId));
        const tour = tours.find(candidate => Tour.pending(candidate).length > 0) ?? tours[tours.length - 1];
        if (!tour) {
            this.messages.info('This agent has not proposed anything.', { timeout: 2500 });
            return;
        }
        // Whoever reviews an agent's stops has seen that it finished.
        family.forEach(member => this.fleet.acknowledge(member));
        await this.tourView.openView({ reveal: true });
        const stop = Tour.pending(tour)[0] ?? tour.stops[0];
        if (stop) {
            await this.presenter.present(stop);
        } else {
            this.tours.setCurrent(tour.id);
        }
    }

    protected async openChat(sessionId: string): Promise<void> {
        if (!this.fleet.focus(sessionId)) {
            this.messages.warn('That conversation is no longer open.');
            return;
        }
        await this.shell.revealWidget(CHAT_VIEW_ID);
    }

    protected async dispatch(withSelection: boolean): Promise<void> {
        const editor = withSelection ? this.editorManager.currentEditor?.editor : undefined;
        let about = '';
        let prompt = 'What should an agent do? It works in the background and reports to Mission Control.';
        if (editor && editor.uri.scheme === 'file') {
            const path = this.documents.relative(editor.uri);
            const selection = editor.selection;
            const lines = `lines ${selection.start.line + 1}-${selection.end.line + 1}`;
            const text = editor.document.getText(selection);
            about = !text ? `\n\n[about ${path}, line ${selection.start.line + 1}]`
                : text.length <= INLINE_SELECTION_CHARS ? `\n\n[about ${path}, ${lines}]\n${text}` : `\n\n[about ${path}, ${lines}; read the file to see them]`;
            prompt = `What should an agent do with ${text ? lines : `line ${selection.start.line + 1}`} of ${path}?`;
        }
        const task = await this.quickInput.input({ prompt, placeHolder: 'e.g. Find out why the slug tests fail and fix it' });
        if (!task?.trim()) {
            return;
        }
        try {
            await this.fleet.dispatch(task.trim() + about, { displayText: about ? task.trim() : undefined });
        } catch (error) {
            this.messages.error(`Could not start an agent: ${error instanceof Error ? error.message : error}`);
        }
    }

    protected async pickAgent(placeholder: string, filter: (agent: FleetAgent) => boolean = () => true): Promise<FleetAgent | undefined> {
        const agents = this.fleet.getAgents().filter(filter);
        if (agents.length <= 1) {
            return agents[0];
        }
        type Choice = QuickPickItem & { agent: FleetAgent };
        const items: Choice[] = agents.map(agent => ({
            label: `${agent.parentId ? '$(type-hierarchy-sub) ' : ''}${agent.name}`,
            description: agent.state === 'working' && agent.step ? `${agent.step.tool} ${shorten(agent.step.target)}` : agent.state,
            agent
        }));
        return (await this.quickInput.showQuickPick(items, { placeholder }))?.agent;
    }

    protected async steer(): Promise<void> {
        const working = (agent: FleetAgent) => agent.state === 'working' || agent.state === 'approval' || agent.state === 'review';
        const agent = await this.pickAgent('Which agent?', this.fleet.getAgents().some(working) ? working : undefined);
        if (!agent) {
            this.messages.info('There is no agent to talk to yet.', { timeout: 2500 });
            return;
        }
        const live = working(agent);
        const message = await this.quickInput.input({
            prompt: live ? `Steer "${agent.name}". It keeps working and reads this with the result of the step it is on.` : `Follow up with "${agent.name}"`,
            placeHolder: live ? 'e.g. Leave the tests alone, only fix the library' : 'What next?'
        });
        if (message?.trim()) {
            await this.fleet.tell(agent.sessionId, message, 'now');
        }
    }

    registerMenus(menus: MenuModelRegistry): void {
        menus.registerMenuAction([...EDITOR_CONTEXT_MENU, '0_cicerone'], { commandId: FleetCommandIds.DISPATCH_SELECTION, label: 'Dispatch an Agent on This…', order: 'z' });
    }

    registerCommands(registry: CommandRegistry): void {
        const withStop = (action: (widget: TourWidget) => unknown) => ({
            execute: async () => action(await this.tourView.widget),
            isEnabled: () => this.tours.getTours().length > 0
        });
        registry.registerCommand(CiceroneCommands.NEXT, withStop(widget => widget.step(1)));
        registry.registerCommand(CiceroneCommands.PREVIOUS, withStop(widget => widget.step(-1)));
        registry.registerCommand(CiceroneCommands.ACCEPT, withStop(widget => {
            const stop = this.tours.currentStop;
            return stop && widget.accept(stop);
        }));
        registry.registerCommand(CiceroneCommands.REJECT, withStop(() => {
            const stop = this.tours.currentStop;
            return stop && this.tours.reject(stop);
        }));
        registry.registerCommand(CiceroneCommands.ACCEPT_ALL, withStop(widget => {
            const tour = this.tours.currentTour;
            return tour && widget.acceptAll(tour);
        }));
        registry.registerCommand(CiceroneCommands.DISCUSS, { execute: (stopId?: string) => this.discuss(stopId) });
        registry.registerCommand(CiceroneCommands.CONTINUE, { execute: (tourId?: string) => this.continueAfterReview(tourId) });
        registry.registerCommand(CiceroneCommands.DISPATCH, { execute: () => this.dispatch(false) });
        registry.registerCommand(CiceroneCommands.DISPATCH_SELECTION, {
            execute: () => this.dispatch(true),
            isEnabled: () => this.editorManager.currentEditor?.editor.uri.scheme === 'file'
        });
        registry.registerCommand(CiceroneCommands.NEXT_ATTENTION, { execute: () => this.nextAttention() });
        registry.registerCommand(CiceroneCommands.TELL, { execute: () => this.steer() });
        registry.registerCommand(CiceroneCommands.JUMP, {
            execute: async () => {
                const agent = await this.pickAgent('Go to which agent?');
                if (agent) {
                    await this.openChat(agent.sessionId);
                }
            },
            isEnabled: () => this.fleet.getAgents().length > 0
        });
        registry.registerCommand(CiceroneCommands.STOP_ALL, { execute: () => Promise.all(this.fleet.getAgents().map(agent => this.fleet.stop(agent.sessionId))) });
        registry.registerCommand(CiceroneCommands.TOGGLE_NOTIFY, { execute: () => this.toggleNotifications() });
        registry.registerCommand({ id: FleetCommandIds.GO_TO }, {
            execute: (id: string) => {
                const item = this.fleet.attention().find(candidate => candidate.id === id);
                return item && this.goTo(item);
            }
        });
        registry.registerCommand({ id: FleetCommandIds.REVIEW }, { execute: (sessionId: string) => this.review(sessionId) });
        registry.registerCommand({ id: FleetCommandIds.OPEN_CHAT }, { execute: (sessionId: string) => this.openChat(sessionId) });
        registry.registerCommand(CiceroneCommands.TOGGLE_REVIEW, {
            execute: () => this.preferences.set(REVIEW_PREF, this.presenter.reviewMode === 'before' ? 'after' : 'before', PreferenceScope.User)
        });
        registry.registerCommand(CiceroneCommands.TOGGLE_FOLLOW, {
            execute: () => this.preferences.set(FOLLOW_PREF, !this.presenter.following, PreferenceScope.User)
        });
    }

    registerKeybindings(registry: KeybindingRegistry): void {
        registry.registerKeybinding({ command: CiceroneCommands.NEXT.id, keybinding: 'alt+j' });
        registry.registerKeybinding({ command: CiceroneCommands.PREVIOUS.id, keybinding: 'alt+k' });
        registry.registerKeybinding({ command: CiceroneCommands.ACCEPT.id, keybinding: 'alt+enter' });
        registry.registerKeybinding({ command: CiceroneCommands.REJECT.id, keybinding: 'alt+backspace' });
        registry.registerKeybinding({ command: CiceroneCommands.DISPATCH.id, keybinding: 'alt+d' });
        registry.registerKeybinding({ command: CiceroneCommands.NEXT_ATTENTION.id, keybinding: 'alt+i' });
        registry.registerKeybinding({ command: CiceroneCommands.TELL.id, keybinding: 'alt+s' });
        registry.registerKeybinding({ command: CiceroneCommands.JUMP.id, keybinding: 'alt+g' });
    }

    /**
     * For a turn that ended with proposals on the table: once they are decided, one click hands the
     * decisions back to the agent so it can finish that request (typically: verify what was accepted) and nothing more.
     */
    protected async continueAfterReview(tourId?: string): Promise<void> {
        const tour = this.tours.getTour(tourId) ?? this.tours.currentTour;
        const session = tour && this.chatService.getSession(tour.sessionId);
        if (!tour || !session) {
            this.messages.warn('The conversation this tour belongs to is no longer open.');
            return;
        }
        this.chatService.setActiveSession(session.id, { focus: false });
        // What was accepted and rejected travels with the message; the agent adds it to every request.
        // The wording fences the turn in: an open "continue" reads as an invitation to find more to do,
        // and a model asked to tighten one paragraph went on to the next ones.
        await this.chatService.sendRequest(session.id, {
            text: 'I have reviewed your stops. Finish only what my last request still needs, such as checking the accepted changes. ' +
                'Do not start anything new; if nothing is left to do, say so in one sentence.'
        });
    }

    /** Sends the human's remark about a stop back to the agent, in the conversation the stop came from. */
    protected async discuss(stopId?: string): Promise<void> {
        const stop = (stopId && this.tours.findStop(stopId)) || this.tours.currentStop;
        const tour = stop && this.tours.getTour(stop.tourId);
        if (!stop || !tour) {
            return;
        }
        const remark = await this.quickInput.input({
            prompt: `About stop ${stop.n}${stop.path ? ` (${stop.path})` : ''}`,
            placeHolder: 'What should the agent reconsider or explain?'
        });
        if (!remark?.trim()) {
            return;
        }
        const session = this.chatService.getSession(tour.sessionId);
        if (!session) {
            this.messages.warn('The conversation this tour belongs to is no longer open.');
            return;
        }
        this.chatService.setActiveSession(session.id, { focus: true });
        await this.chatService.sendRequest(session.id, { text: `About stop ${stop.n}${stop.path ? ` (${stop.path})` : ''}: ${remark.trim()}` });
    }
}

function shorten(text: string): string {
    return text.length > 48 ? '…' + text.slice(text.length - 47) : text;
}
