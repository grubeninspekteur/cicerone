import { inject, injectable } from '@theia/core/shared/inversify';
import { Command, CommandContribution, CommandRegistry, MessageService, PreferenceScope, PreferenceService, QuickInputService } from '@theia/core';
import { API_KEY_PREF, BASE_URL_PREF, LiteLlmGateway, normalizeBaseUrl } from '../common/litellm-protocol.js';

export const ConnectGatewayCommand: Command = {
    id: 'cicerone.gateway.connect',
    category: 'Cicerone',
    label: 'Connect a LiteLLM Gateway…'
};

/**
 * The way in for someone who has just started the application: asks for the gateway's URL and key,
 * tries them, and only then saves them. A wrong URL or key is reported in the gateway's own words
 * while the dialog is still open, rather than as a silent absence of models later.
 */
@injectable()
export class LiteLlmConnectCommandContribution implements CommandContribution {

    @inject(QuickInputService) protected readonly quickInput: QuickInputService;
    @inject(PreferenceService) protected readonly preferences: PreferenceService;
    @inject(MessageService) protected readonly messages: MessageService;
    @inject(LiteLlmGateway) protected readonly gateway: LiteLlmGateway;

    registerCommands(registry: CommandRegistry): void {
        registry.registerCommand(ConnectGatewayCommand, { execute: () => this.connect() });
    }

    protected async connect(): Promise<void> {
        let url = this.preferences.get<string>(BASE_URL_PREF, '') || 'http://localhost:4000';
        let key = this.preferences.get<string>(API_KEY_PREF, '');
        for (; ;) {
            const enteredUrl = await this.quickInput.input({
                title: 'Connect a LiteLLM Gateway (1/2)',
                prompt: 'URL of the gateway, e.g. http://localhost:4000. Any OpenAI-compatible endpoint works.',
                value: url,
                validateInput: async value => /^https?:\/\/\S+$/.test(value.trim()) ? undefined : 'Enter a URL starting with http:// or https://'
            });
            if (enteredUrl === undefined) {
                return;
            }
            url = normalizeBaseUrl(enteredUrl);
            const enteredKey = await this.quickInput.input({
                title: 'Connect a LiteLLM Gateway (2/2)',
                prompt: 'Key for the gateway (a virtual key or the master key). Leave empty if it needs none. Stored in your user settings in clear text.',
                value: key,
                password: true
            });
            if (enteredKey === undefined) {
                return;
            }
            key = enteredKey.trim();
            try {
                const found = await this.gateway.listModels(url, key || undefined, undefined, false);
                if (found.models.length === 0) {
                    throw new Error('The gateway answered but serves no chat models.');
                }
                // Saving is what makes the provider discover and register the models.
                await this.preferences.set(BASE_URL_PREF, url, PreferenceScope.User);
                await this.preferences.set(API_KEY_PREF, key, PreferenceScope.User);
                const names = found.models.slice(0, 4).map(model => model.id).join(', ');
                const more = found.models.length > 4 ? ` and ${found.models.length - 4} more` : '';
                this.messages.info(`Connected to ${url}. ${found.models.length === 1 ? 'Model' : `${found.models.length} models`}: ${names}${more}.`, { timeout: 8000 });
                return;
            } catch (error) {
                const again = await this.messages.error(`Could not connect to ${url}. ${error instanceof Error ? error.message : String(error)}`, 'Try Again');
                if (again !== 'Try Again') {
                    return;
                }
            }
        }
    }
}
