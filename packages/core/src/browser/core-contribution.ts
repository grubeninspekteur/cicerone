import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { Command, CommandContribution, CommandRegistry, MessageService, PreferenceSchema, PreferenceScope, PreferenceService, QuickInputService } from '@theia/core';
import {
    AbstractViewContribution, ApplicationShell, FrontendApplication, FrontendApplicationContribution, KeybindingContribution, KeybindingRegistry,
    StatusBar, StatusBarAlignment, WidgetManager
} from '@theia/core/lib/browser';
import { ChatService } from '@theia/ai-chat';
import { ActivityService } from './activity-service.js';
import { ACTIVITY_WIDGET_ID, ActivityWidget } from './activity-widget.js';
import { MODEL_PREF } from './cicerone-agent.js';
import { FOLLOW_PREF, REVIEW_PREF, StopPresenter } from './stop-presenter.js';
import { TourService } from './tour-service.js';
import { TOUR_WIDGET_ID, TourCommandIds, TourWidget } from './tour-widget.js';

export const CHAT_VIEW_ID = 'chat-view-widget';

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
            description: 'When you review the agent\'s changes: before they are written, or after.'
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
    export const TOGGLE_FOLLOW: Command = { id: 'cicerone.follow.toggle', label: 'Toggle Following the Agent in the Editor', category };
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

const STATUS_ID = 'cicerone.status';

/** Commands, keys, the status bar entry, and the layout a fresh workspace starts with. */
@injectable()
export class CiceroneContribution implements FrontendApplicationContribution, CommandContribution, KeybindingContribution {

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

    @postConstruct()
    protected init(): void {
        this.tours.onDidChange(() => this.updateStatus());
        this.activity.onDidChange(() => this.updateStatus());
        this.tours.onDidAddStop(stop => {
            // The first stop of a tour is the moment the tour becomes the thing to look at.
            if (stop.n === 1 && this.presenter.following) {
                this.tourView.openView({ reveal: true });
            }
        });
    }

    onStart(): void {
        this.activity.connect(this.chatService);
        this.updateStatus();
    }

    /** Only runs when there is no saved layout: what was asked | the work | the conversation, activity underneath. */
    async initializeLayout(_app: FrontendApplication): Promise<void> {
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

    protected updateStatus(): void {
        const entry = this.activity.currentEntry;
        const pending = this.tours.pendingCount();
        let text: string | undefined;
        let tooltip = 'Open the tour';
        if (entry) {
            text = entry.status === 'awaiting-approval'
                ? `$(shield) Cicerone needs your approval: ${entry.tool} ${shorten(entry.target)}`
                : `$(loading~spin) Cicerone: ${entry.tool} ${shorten(entry.target)}`;
            tooltip = 'What the agent is doing right now';
        } else if (this.activity.runningTurn) {
            text = '$(loading~spin) Cicerone: thinking';
        } else if (pending > 0) {
            text = `$(compass) ${pending} ${pending === 1 ? 'stop' : 'stops'} to review`;
        }
        if (text) {
            this.statusBar.setElement(STATUS_ID, {
                text, tooltip, alignment: StatusBarAlignment.LEFT, priority: 1000,
                command: this.activity.runningTurn ? 'cicerone.activity.toggle' : 'cicerone.tour.toggle'
            });
        } else {
            this.statusBar.removeElement(STATUS_ID);
        }
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
