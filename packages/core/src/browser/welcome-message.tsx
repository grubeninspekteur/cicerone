import * as React from '@theia/core/shared/react';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { CommandService, Emitter, Event } from '@theia/core';
import { codicon } from '@theia/core/lib/browser';
import { LanguageModelRegistry } from '@theia/ai-core';
import { ChatWelcomeMessageProvider } from '@theia/ai-chat-ui/lib/browser/chat-tree-view';
import { CONNECT_GATEWAY_COMMAND_ID } from './core-contribution.js';

const OPEN_AI_CONFIGURATION = 'aiConfiguration:open';

/**
 * What an empty chat says. It replaces the Theia IDE's text, which introduces agents this product
 * ships switched off and, with no model configured, claims that no provider packages are installed.
 * Here the empty chat says the one thing a newcomer needs: how the work will come back to them, or,
 * if no model is connected yet, how to connect one.
 */
@injectable()
export class CiceroneWelcomeMessageProvider implements ChatWelcomeMessageProvider {

    @inject(LanguageModelRegistry) protected readonly languageModels: LanguageModelRegistry;
    @inject(CommandService) protected readonly commands: CommandService;

    /** Above the Theia IDE's own (100), so this one decides whether the input is enabled. */
    readonly priority = 200;
    readonly modelRequirementBypassed = false;

    protected ready = false;
    protected checked = false;
    protected readonly onStateChangedEmitter = new Emitter<void>();
    readonly onStateChanged: Event<void> = this.onStateChangedEmitter.event;

    @postConstruct()
    protected init(): void {
        this.languageModels.onChange(() => this.refresh());
        this.refresh();
    }

    get hasReadyModels(): boolean {
        return this.ready;
    }

    protected async refresh(): Promise<void> {
        const ready = (await this.languageModels.getLanguageModels()).some(model => model.status.status === 'ready');
        if (ready !== this.ready || !this.checked) {
            this.ready = ready;
            this.checked = true;
            this.onStateChangedEmitter.fire();
        }
    }

    renderWelcomeMessage(): React.ReactNode {
        if (!this.checked) {
            return undefined;
        }
        if (!this.ready) {
            return <div className='theia-WelcomeMessage cicerone-welcome' key='cicerone-no-model'>
                <div className={`cicerone-welcome-icon ${codicon('plug')}`} />
                <h3>No model connected</h3>
                <p>The agent needs a language model to talk to: a LiteLLM gateway, or a provider such as Ollama, Anthropic, OpenAI or Google.</p>
                <div className='theia-WelcomeMessage-Actions cicerone-welcome-actions'>
                    <button className='theia-button main' onClick={() => this.commands.executeCommand(CONNECT_GATEWAY_COMMAND_ID)}>Connect a LiteLLM Gateway…</button>
                    <button className='theia-button secondary' onClick={() => this.commands.executeCommand(OPEN_AI_CONFIGURATION)}>Open AI Configuration</button>
                </div>
            </div>;
        }
        return <div className='theia-WelcomeMessage theia-WelcomeMessage-Compact cicerone-welcome' key='cicerone-welcome'>
            <div className={`cicerone-welcome-icon ${codicon('compass')}`} />
            <h3>Ask for something</h3>
            <p>Whatever the agent proposes comes back as a <b>tour</b>: one stop per change, each with its reason, for you to accept or reject.
                Nothing is written to your files before that.</p>
            <p className='cicerone-dim'>It reads and searches on its own, and asks before it runs a command.</p>
        </div>;
    }

    renderDisabledMessage(): React.ReactNode {
        return <div className='theia-WelcomeMessage cicerone-welcome' key='cicerone-disabled'>
            <div className={`cicerone-welcome-icon ${codicon('circle-slash')}`} />
            <h3>AI features are switched off</h3>
            <div className='theia-WelcomeMessage-Actions cicerone-welcome-actions'>
                <button className='theia-button main' onClick={() => this.commands.executeCommand(OPEN_AI_CONFIGURATION)}>Open AI Configuration</button>
            </div>
        </div>;
    }
}
