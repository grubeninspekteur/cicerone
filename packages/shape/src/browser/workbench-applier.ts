import { inject, injectable } from '@theia/core/shared/inversify';
import {
    Command, CommandContribution, CommandRegistry, DisposableCollection, MenuModelRegistry, MessageService, QuickInputService, SelectionService, URI
} from '@theia/core';
import {
    ApplicationShell, FrontendApplication, FrontendApplicationContribution, KeybindingRegistry, open, OpenerService, StatusBar, StatusBarAlignment, WidgetManager
} from '@theia/core/lib/browser';
import { FrontendApplicationStateService } from '@theia/core/lib/browser/frontend-application-state';
import { UriSelection } from '@theia/core/lib/common/selection';
import { ChatAgentLocation, ChatService } from '@theia/ai-chat';
import { EDITOR_CONTEXT_MENU, EditorManager } from '@theia/editor/lib/browser';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { NAVIGATOR_CONTEXT_MENU } from '@theia/navigator/lib/browser/navigator-contribution';
import { globToRegExp } from '@cicerone/core/lib/common';
import { CHAT_VIEW_ID } from '@cicerone/core/lib/browser';
import { PROFILES, WorkbenchProfile } from '../common/profiles.js';
import { ActionSpec, AREAS, BUILTIN_VIEWS, LayoutSpec, WORKBENCH_FILE } from '../common/workbench.js';
import { WORKBENCH_SKILL_NAME } from '../common/workbench-skill.js';
import { actionCommandId, SHAPED_VIEW_FACTORY, ShapedViewWidget, shapedViewWidgetId } from './shaped-view-widget.js';
import { WorkbenchService } from './workbench-service.js';

export namespace WorkbenchCommands {
    const category = 'Cicerone';
    export const OPEN: Command = { id: 'cicerone.workbench.open', label: 'Open Workbench Description', category };
    export const APPLY_LAYOUT: Command = { id: 'cicerone.workbench.applyLayout', label: 'Apply Workbench Layout', category };
    export const SET_UP: Command = { id: 'cicerone.workbench.setUp', label: 'Set Up This Workspace For…', category };
}

const STATUS_ID = 'cicerone.workbench';
const MENU_GROUP = '0_cicerone';

/** Makes the running editor match the workbench description, and keeps it matching as the file changes. */
@injectable()
export class WorkbenchApplier implements FrontendApplicationContribution, CommandContribution {

    @inject(WorkbenchService) protected readonly workbench: WorkbenchService;
    @inject(WidgetManager) protected readonly widgetManager: WidgetManager;
    @inject(ApplicationShell) protected readonly shell: ApplicationShell;
    @inject(CommandRegistry) protected readonly commands: CommandRegistry;
    @inject(MenuModelRegistry) protected readonly menus: MenuModelRegistry;
    @inject(KeybindingRegistry) protected readonly keybindings: KeybindingRegistry;
    @inject(StatusBar) protected readonly statusBar: StatusBar;
    @inject(MessageService) protected readonly messages: MessageService;
    @inject(QuickInputService) protected readonly quickInput: QuickInputService;
    @inject(ChatService) protected readonly chatService: ChatService;
    @inject(EditorManager) protected readonly editorManager: EditorManager;
    @inject(SelectionService) protected readonly selectionService: SelectionService;
    @inject(OpenerService) protected readonly openerService: OpenerService;
    @inject(FileService) protected readonly fileService: FileService;
    @inject(FrontendApplicationStateService) protected readonly stateService: FrontendApplicationStateService;

    protected readonly actionRegistrations = new DisposableCollection();
    protected knownViews: Set<string> | undefined;
    protected appliedLayout: string | undefined;
    protected reportedProblems = '';
    protected syncing: Promise<void> = Promise.resolve();

    onStart(): void {
        this.workbench.ready.then(() => {
            this.sync(true);
            this.workbench.onDidChange(() => this.sync(false));
        });
    }

    /**
     * Runs only when the workspace has no saved layout: a workbench that describes one starts out arranged.
     * The arranging waits until the application is up. Closing a built-in view while it is still
     * assembling itself (the debug view does so asynchronously) makes it fail on its own disposed parts.
     */
    async initializeLayout(_app: FrontendApplication): Promise<void> {
        this.stateService.reachedState('ready')
            .then(() => this.workbench.ready)
            .then(() => this.sync(true))
            .then(() => new Promise(resolve => setTimeout(resolve, 250)))
            .then(() => this.applyLayout());
    }

    protected sync(initial: boolean): Promise<void> {
        this.syncing = this.syncing.then(() => this.doSync(initial)).catch(error => console.error('Cicerone: could not apply the workbench', error));
        return this.syncing;
    }

    protected async doSync(initial: boolean): Promise<void> {
        const config = this.workbench.config;

        // Views: one widget per described view; widgets of views that are gone are closed.
        const wanted = new Set(config.views.map(view => view.id));
        const added: string[] = [];
        for (const [index, view] of config.views.entries()) {
            const widget = await this.widgetManager.getOrCreateWidget<ShapedViewWidget>(SHAPED_VIEW_FACTORY, { viewId: view.id });
            if (!widget.isAttached) {
                await this.shell.addWidget(widget, { area: view.area ?? 'left', rank: 200 + index });
                added.push(view.id);
            }
        }
        for (const widget of this.widgetManager.getWidgets(SHAPED_VIEW_FACTORY)) {
            const viewId = widget.id.slice(SHAPED_VIEW_FACTORY.length + 1);
            if (!wanted.has(viewId)) {
                widget.close();
            }
        }

        this.registerActions(config.actions);

        const layout = JSON.stringify(config.layout ?? {});
        if (!initial && this.appliedLayout !== undefined && layout !== this.appliedLayout && config.layout) {
            await this.applyLayout();
        } else if (!initial && added.length > 0) {
            // A view the agent just made should be seen, not hunted for.
            await this.shell.revealWidget(shapedViewWidgetId(added[0]));
        }
        this.appliedLayout = layout;
        this.knownViews = wanted;
        this.updateStatus();
    }

    protected updateStatus(): void {
        const problems = this.workbench.problems;
        if (!this.workbench.exists) {
            this.statusBar.removeElement(STATUS_ID);
        } else {
            this.statusBar.setElement(STATUS_ID, {
                text: problems.length ? `$(warning) Workbench: ${problems.length} ${problems.length === 1 ? 'problem' : 'problems'}` : `$(layout) ${this.workbench.config.title ?? 'Workbench'}`,
                tooltip: problems.length ? problems.join('\n') : `This workspace shapes the editor through ${WORKBENCH_FILE}. Click to open it.`,
                alignment: StatusBarAlignment.RIGHT, priority: 5, command: WorkbenchCommands.OPEN.id
            });
        }
        const signature = problems.join('\n');
        if (signature && signature !== this.reportedProblems) {
            this.messages.warn(`${WORKBENCH_FILE}: ${problems[0]}${problems.length > 1 ? ` (and ${problems.length - 1} more)` : ''}`, 'Open').then(choice => {
                if (choice === 'Open') {
                    this.commands.executeCommand(WorkbenchCommands.OPEN.id);
                }
            });
        }
        this.reportedProblems = signature;
    }

    // ------------------------------------------------------------- layout

    protected async resolveWidget(id: string): Promise<{ id: string } & Parameters<ApplicationShell['addWidget']>[0] | undefined> {
        try {
            if (this.workbench.config.views.some(view => view.id === id)) {
                return await this.widgetManager.getOrCreateWidget(SHAPED_VIEW_FACTORY, { viewId: id });
            }
            const builtin = BUILTIN_VIEWS[id];
            if (builtin && id !== 'terminal') {
                return await this.widgetManager.getOrCreateWidget(builtin.widgetId);
            }
        } catch {
            // an extension that is not part of this product build
        }
        return undefined;
    }

    async applyLayout(layout: LayoutSpec | undefined = this.workbench.config.layout): Promise<void> {
        if (!layout) {
            return;
        }
        for (const id of layout.hide ?? []) {
            if (id === 'terminal') {
                this.shell.widgets.filter(widget => widget.id.startsWith('terminal')).forEach(widget => widget.close());
            } else {
                const widgetId = BUILTIN_VIEWS[id]?.widgetId ?? shapedViewWidgetId(id);
                await this.shell.closeWidget(widgetId);
            }
        }
        for (const area of AREAS) {
            const ids = layout[area] ?? [];
            let first: string | undefined;
            for (const [index, id] of ids.entries()) {
                const widget = await this.resolveWidget(id);
                if (widget) {
                    await this.shell.addWidget(widget, { area, rank: 10 + index * 10 });
                    first ??= widget.id;
                }
            }
            if (first) {
                await this.shell.revealWidget(first);
            }
        }
        this.appliedLayout = JSON.stringify(layout);
    }

    // ------------------------------------------------------------ actions

    protected registerActions(actions: ActionSpec[]): void {
        this.actionRegistrations.dispose();
        actions.forEach((action, index) => {
            const command: Command = { id: actionCommandId(action.id), label: action.label, category: 'Cicerone' };
            const applies = () => this.target(action) !== undefined;
            this.actionRegistrations.push(this.commands.registerCommand(command, { execute: () => this.run(action), isEnabled: applies, isVisible: applies }));
            const item = { commandId: command.id, label: action.label, order: String(index).padStart(3, '0') };
            if (action.on !== 'workspace') {
                this.actionRegistrations.push(this.menus.registerMenuAction([...EDITOR_CONTEXT_MENU, MENU_GROUP], item));
            }
            if (action.on === 'file') {
                this.actionRegistrations.push(this.menus.registerMenuAction([...NAVIGATOR_CONTEXT_MENU, MENU_GROUP], item));
            }
            if (action.key) {
                try {
                    this.actionRegistrations.push(this.keybindings.registerKeybinding({ command: command.id, keybinding: action.key }));
                } catch {
                    this.messages.warn(`${WORKBENCH_FILE}: "${action.key}" is not a valid keybinding (action ${action.id}).`);
                }
            }
        });
    }

    /** What the action would work on right now, or undefined when it does not apply. An empty string stands for the workspace. */
    protected target(action: ActionSpec): { path: string, note: string } | undefined {
        if (action.on === 'workspace') {
            return { path: '', note: '' };
        }
        const root = this.workbench.root;
        const editor = this.editorManager.currentEditor?.editor;
        let uri: URI | undefined;
        if (action.on === 'selection') {
            const selection = editor?.selection;
            if (!editor || !selection || (selection.start.line === selection.end.line && selection.start.character === selection.end.character)) {
                return undefined;
            }
            uri = editor.uri;
        } else {
            // From the file tree the selection is a file; from an editor it is text, and the editor's file is meant.
            uri = UriSelection.getUri(this.selectionService.selection) ?? editor?.uri;
        }
        const path = uri && uri.scheme === 'file' ? root?.relative(uri)?.toString() : undefined;
        if (!path || (action.files && !globToRegExp(action.files).test(path))) {
            return undefined;
        }
        // The selected text itself travels with the agent's note about the editor; only a file needs naming here.
        return { path, note: action.on === 'file' ? `File: ${path}` : '' };
    }

    protected async run(action: ActionSpec): Promise<void> {
        const target = this.target(action);
        if (!target) {
            return;
        }
        const text = [action.skill && `Use the skill \`${action.skill}\`.`, action.prompt, target.note].filter(Boolean).join('\n');
        const displayText = target.path && action.on === 'file' ? `${action.label} · ${target.path}` : action.label;
        await this.ask(text, displayText);
    }

    /**
     * Sends a request to the agent. A conversation that already has history is not continued: an
     * action is self-contained, and starting clean keeps what the model has to read to the minimum.
     */
    protected async ask(text: string, displayText?: string): Promise<void> {
        let session = this.chatService.getActiveSession();
        if (!session || !session.model.isEmpty()) {
            session = this.chatService.createSession(ChatAgentLocation.Panel, { focus: false });
        }
        await this.shell.revealWidget(CHAT_VIEW_ID);
        await this.chatService.sendRequest(session.id, { text, displayText });
    }

    // ----------------------------------------------------------- commands

    registerCommands(registry: CommandRegistry): void {
        registry.registerCommand(WorkbenchCommands.OPEN, {
            execute: () => this.workbench.uri && open(this.openerService, this.workbench.uri),
            isEnabled: () => this.workbench.exists
        });
        registry.registerCommand(WorkbenchCommands.APPLY_LAYOUT, {
            execute: () => this.applyLayout(),
            isEnabled: () => !!this.workbench.config.layout
        });
        registry.registerCommand(WorkbenchCommands.SET_UP, { execute: () => this.setUp(), isEnabled: () => !!this.workbench.root });
    }

    protected async setUp(): Promise<void> {
        const custom = { label: '$(sparkle) Something else…', description: 'Tell the agent what you do and let it build the workbench', profile: undefined as WorkbenchProfile | undefined };
        const picked = await this.quickInput.pick([
            ...PROFILES.map(profile => ({ label: profile.label, description: profile.description, profile })),
            custom
        ], { placeHolder: 'What kind of work happens in this folder?' });
        if (!picked) {
            return;
        }
        if (!picked.profile) {
            const work = await this.quickInput.input({ prompt: 'Describe your work in a sentence', placeHolder: 'e.g. I copy-edit magazine articles against a house style sheet' });
            if (work?.trim()) {
                await this.ask(`Use the skill \`${WORKBENCH_SKILL_NAME}\`.\nSet this workspace up for me. ${work.trim()}`, `Set up the workbench: ${work.trim()}`);
            }
            return;
        }
        const root = this.workbench.root!;
        const skipped: string[] = [];
        for (const [path, content] of Object.entries(picked.profile.files)) {
            const uri = root.resolve(path);
            if (await this.fileService.exists(uri)) {
                skipped.push(path);
            } else {
                await this.fileService.create(uri, content);
            }
        }
        await this.workbench.reload();
        await this.sync(false);
        await this.applyLayout();
        // Short-lived: the notification sits on top of the chat input, which is where the user goes next.
        this.messages.info(skipped.length
            ? `Set up for ${picked.profile.label.toLowerCase()}. Kept your existing ${skipped.join(', ')}.`
            : `Set up for ${picked.profile.label.toLowerCase()}. Everything it added is in ${WORKBENCH_FILE} and .agents/skills, yours to change, or ask the agent to.`,
            { timeout: 7000 });
    }
}
