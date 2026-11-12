import { inject, injectable, named, postConstruct } from '@theia/core/shared/inversify';
import { ContributionProvider, PreferenceService } from '@theia/core';
import { AIVariableContext, LanguageModel, LanguageModelMessage, LanguageModelRequirement, PromptVariantSet, ToolProvider } from '@theia/ai-core';
import { AbstractStreamParsingChatAgent, ChatModel, MutableChatRequestModel, SystemMessageDescription } from '@theia/ai-chat';
import { EditorManager } from '@theia/editor/lib/browser';
import { SkillLibrary, TOOL_PROVIDER } from './tools.js';
import { TourService } from './tour-service.js';
import { WorkspaceDocuments } from './workspace-documents.js';

export const CICERONE_AGENT_ID = 'Cicerone';
export const CICERONE_PROMPT_ID = 'cicerone-system';
export const CiceroneToolProvider = Symbol('CiceroneToolProvider');

/** Selections up to this size travel with the request; larger ones are referred to by line range. */
const INLINE_SELECTION_CHARS = 2000;
const EDITOR_NOTE_KEY = 'cicerone.editorNote';
export const MODEL_PREF = 'cicerone.model';

/*
 * The system prompt. It is the fixed cost of every request, so it says only what the model would
 * not do unprompted: that its work is reviewed as a tour, and what that asks of it.
 * No role play, no tool catalogue (the tool schemas carry that), no formatting rules.
 */
export const CICERONE_PROMPT = `You are Cicerone, an agent working inside the user's editor on the text files of their workspace: code, manuscripts, contracts, notes.

The user reviews your work as a tour: each \`edit\` and \`show\` becomes a numbered stop they step through, with your \`why\` beside it.
- Read before you edit. One stop is one change a reviewer can judge on its own; its \`why\` gives the reason, not a description of the diff.
- An edit is either written at once or held as a proposal until the user accepts it; the result of \`edit\` says which. \`read\` shows held proposals as if applied, \`run\` only sees what is written.
- Use \`show\` for places that matter but need no change.
- If a request is ambiguous in a way that changes the work, ask before editing.
- A \`[review of your stops: …]\` line tells you what the user accepted or rejected. It is information, not a request: do not extend the work because of it.
- End with two or three sentences: what you did and where to look first. Do not list the stops; the tour does that.`;

/**
 * The one agent. There are no modes: it reads, proposes and explains, and the human decides.
 */
@injectable()
export class CiceroneAgent extends AbstractStreamParsingChatAgent {

    @inject(ContributionProvider) @named(CiceroneToolProvider)
    protected readonly toolProviders: ContributionProvider<ToolProvider>;
    @inject(SkillLibrary) protected readonly skills: SkillLibrary;
    @inject(EditorManager) protected readonly editorManager: EditorManager;
    @inject(WorkspaceDocuments) protected readonly documents: WorkspaceDocuments;
    @inject(TourService) protected readonly tours: TourService;
    @inject(PreferenceService) protected readonly preferences: PreferenceService;

    readonly id = CICERONE_AGENT_ID;
    readonly name = CICERONE_AGENT_ID;
    override description = 'Works on the files of your workspace and shows its work: every proposed change and every place worth noticing ' +
        'becomes a stop on a tour you step through and accept or reject. Reads and searches files on its own; runs shell commands only with your consent.';
    override iconClass = 'codicon codicon-compass';
    override tags = ['Chat'];

    readonly languageModelRequirements: LanguageModelRequirement[] = [{ purpose: 'chat', identifier: 'default/universal' }];
    protected readonly defaultLanguageModelPurpose = 'chat';

    override prompts: PromptVariantSet[] = [{ id: CICERONE_PROMPT_ID, defaultVariant: { id: CICERONE_PROMPT_ID, template: CICERONE_PROMPT } }];
    protected override systemPromptId: string | undefined = CICERONE_PROMPT_ID;

    @postConstruct()
    protected initTools(): void {
        this.additionalToolRequests = this.toolProviders.getContributions().map(provider => provider.getTool());
        this.functions = this.additionalToolRequests.map(tool => tool.id);
    }

    override async invoke(request: MutableChatRequestModel): Promise<void> {
        // Where the human is looking when they ask is what "this" and "here" refer to.
        const note = [this.tours.reviewNote(request.session.id), this.describeEditor()].filter(Boolean).join('\n');
        request.addData(EDITOR_NOTE_KEY, note || undefined);
        return super.invoke(request);
    }

    protected override async getSystemMessageDescription(context: AIVariableContext): Promise<SystemMessageDescription | undefined> {
        const description = await super.getSystemMessageDescription(context);
        if (!description) {
            return undefined;
        }
        // Skills cost one line each until loaded. The list only changes when skills do, so the prompt stays cacheable.
        const skills = await this.skills.list();
        if (skills.length === 0) {
            return description;
        }
        const list = skills.map(skill => `- ${skill.name}: ${skill.description}`).join('\n');
        return { ...description, text: `${description.text}\n\nSkills (load with \`skill\` before doing what one covers):\n${list}` };
    }

    /**
     * Appends each request's editor note to its own user message. The note is stored with the request
     * rather than recomputed, so earlier messages are byte-identical from one request to the next and
     * the provider's prompt cache keeps hitting.
     */
    protected override async getMessages(model: ChatModel, includeResponseInProgress = false): Promise<LanguageModelMessage[]> {
        const messages = await super.getMessages(model, includeResponseInProgress);
        const notes = model.getRequests()
            .filter(request => request.message.parts.some(part => part.promptText.length > 0))
            .map(request => request.data?.[EDITOR_NOTE_KEY] as string | undefined);
        let index = 0;
        for (const message of messages) {
            if (message.actor === 'user' && message.type === 'text') {
                const note = notes[index++];
                if (note) {
                    message.text = `${message.text}\n\n${note}`;
                }
            }
        }
        return messages;
    }

    protected describeEditor(): string | undefined {
        const editor = this.editorManager.currentEditor?.editor;
        if (!editor || editor.uri.scheme !== 'file') {
            return undefined;
        }
        const path = this.documents.relative(editor.uri);
        const selection = editor.selection;
        const empty = selection.start.line === selection.end.line && selection.start.character === selection.end.character;
        if (empty) {
            return `[editor: ${path}, cursor at line ${selection.start.line + 1}]`;
        }
        const lines = `lines ${selection.start.line + 1}-${selection.end.line + 1}`;
        const text = editor.document.getText(selection);
        return text.length <= INLINE_SELECTION_CHARS
            ? `[editor: ${path}, selected ${lines}]\n${text}`
            : `[editor: ${path}, selected ${lines} (${text.length} characters; read the file to see them)]`;
    }

    /**
     * Uses the `cicerone.model` preference, then the model configured for the agent in the AI settings;
     * if neither yields a ready model, any model that is ready, gateway models first. Setting a
     * gateway URL is then all it takes to get going.
     */
    protected override async getLanguageModel(languageModelPurpose: string): Promise<LanguageModel> {
        const preferred = this.preferences.get<string>(MODEL_PREF, '');
        if (preferred) {
            const model = await this.resolveModelById(preferred);
            if (model) {
                return model;
            }
        }
        try {
            return await super.getLanguageModel(languageModelPurpose);
        } catch (error) {
            const ready = (await this.languageModelRegistry.getLanguageModels()).filter(model => model.status.status === 'ready');
            const fallback = ready.find(model => model.id.startsWith('litellm/')) ?? ready[0];
            if (!fallback) {
                throw new Error('No language model is connected. Run "Cicerone: Connect a LiteLLM Gateway…" from the command palette (F1), or set up another provider in the AI Configuration view.');
            }
            return fallback;
        }
    }
}

export { TOOL_PROVIDER };
