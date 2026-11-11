import { inject, injectable } from '@theia/core/shared/inversify';
import { PreferenceChange } from '@theia/core';
import { ApiKeySource, DiscoveredModel, LanguageModelAliasRegistry, ModelDiscoveryResult, resolveCustomModelHeaders } from '@theia/ai-core';
import { DiscoveringLanguageModelsManager, DiscoveringProviderContribution, ModelDiscoveryMessages } from '@theia/ai-core/lib/browser';
import { AICorePreferences, PREFERENCE_NAME_MAX_RETRIES } from '@theia/ai-core/lib/common/ai-core-preferences';
import { OpenAiLanguageModelsManager, OpenAiModelDescription } from '@theia/ai-openai/lib/common';
import {
    ALLOW_ENV_PREF, API_KEY_PREF, BASE_URL_PREF, DEFAULT_MODEL_PREF, HEADERS_PREF, LITELLM_MODEL_PREFIX, LITELLM_PROVIDER_ID, LiteLlmGateway, MODEL_OVERRIDES_PREF
} from '../common/litellm-protocol.js';

/**
 * Offers every chat model of a LiteLLM gateway to all agents.
 *
 * The gateway speaks the OpenAI chat-completions protocol for whatever it routes to, so the models
 * are registered through Theia's OpenAI provider with the gateway as their endpoint: streaming, tool
 * calling, retries and token accounting are the well-trodden path rather than a second implementation.
 * What this contribution adds is the part a gateway makes possible: one URL, and the model list
 * follows the gateway's configuration instead of being typed into the settings model by model.
 */
@injectable()
export class LiteLlmFrontendContribution extends DiscoveringProviderContribution<OpenAiModelDescription> {

    @inject(OpenAiLanguageModelsManager)
    protected readonly openAiManager: OpenAiLanguageModelsManager;

    @inject(LiteLlmGateway)
    protected readonly gateway: LiteLlmGateway;

    @inject(AICorePreferences)
    protected readonly aiCorePreferences: AICorePreferences;

    @inject(LanguageModelAliasRegistry)
    protected readonly aliases: LanguageModelAliasRegistry;

    /** The gateway model currently appended to the built-in aliases. */
    protected aliasFallback: string | undefined;

    protected readonly providerId = LITELLM_PROVIDER_ID;
    protected readonly providerLabel = 'LiteLLM Gateway';
    protected readonly modelOverridesPreference = MODEL_OVERRIDES_PREF;
    protected readonly allowEnvironmentApiKeyPreference = ALLOW_ENV_PREF;

    /** Endpoint and key the registered models use; resolved by the backend so the environment can supply them. */
    protected credentials: { baseUrl?: string, apiKey?: string } = {};

    protected override get modelIdPrefix(): string {
        return LITELLM_MODEL_PREFIX;
    }

    protected readonly manager: DiscoveringLanguageModelsManager<OpenAiModelDescription> = {
        fetchAvailableModels: () => this.fetchAvailableModels(),
        getApiKeySource: () => this.getGatewaySource(),
        setAllowEnvironmentApiKey: () => { /* read from the preference on every run */ },
        createOrUpdateLanguageModels: (...descriptions) => this.openAiManager.createOrUpdateLanguageModels(...descriptions),
        removeLanguageModels: (...ids) => this.openAiManager.removeLanguageModels(...ids)
    };

    protected get discoveryMessages(): ModelDiscoveryMessages {
        return {
            noCredentials: 'No gateway URL set. Enter the URL of your LiteLLM gateway to discover its models.',
            consentRequired: 'LiteLLM settings were found in the environment. Confirm their use to discover models.',
            consentPrompt: 'LiteLLM settings were found in the environment (LITELLM_BASE_URL / LITELLM_API_KEY). Use them to discover and call models?',
            useEnvironmentKey: 'Use them',
            overridden: 'The model list is configured manually. Clear the model list to ask the gateway again.',
            cached: error => `Showing the last known models; the gateway could not be reached: ${error}`
        };
    }

    protected override initializeProvider(): void {
        this.aiCorePreferences.onPreferenceChanged(event => {
            if (event.preferenceName === PREFERENCE_NAME_MAX_RETRIES) {
                this.updateDiscoveredModels();
            }
        });
    }

    protected override handlePreferenceChange(event: PreferenceChange): void {
        if (event.preferenceName === BASE_URL_PREF || event.preferenceName === API_KEY_PREF || event.preferenceName === HEADERS_PREF) {
            this.discoverAndRegisterModels();
        } else if (event.preferenceName === DEFAULT_MODEL_PREF) {
            this.updateAliasFallback();
        }
    }

    protected get baseUrl(): string | undefined {
        return this.preferenceService.get<string>(BASE_URL_PREF, '') || undefined;
    }

    protected get apiKey(): string | undefined {
        return this.preferenceService.get<string>(API_KEY_PREF, '') || undefined;
    }

    protected get headers(): Record<string, string> | undefined {
        return resolveCustomModelHeaders(this.preferenceService.get<Record<string, string>>(HEADERS_PREF));
    }

    /** What discovery calls the "API key source" is, for a gateway, where its URL comes from: the key is optional. */
    protected async getGatewaySource(): Promise<ApiKeySource> {
        if (this.baseUrl) {
            return 'preference';
        }
        const environment = await this.gateway.getEnvironment();
        return environment.baseUrl ? 'environment' : 'none';
    }

    protected override async runDiscovery(): Promise<void> {
        // Model overrides skip `fetchAvailableModels`, but the models still need an endpoint.
        this.credentials = await this.gateway.resolveCredentials(this.baseUrl, this.apiKey, this.isEnvironmentApiKeyAllowed());
        if (!this.credentials.baseUrl && this.getModelOverrides().length > 0) {
            this.removeAllDiscoveredModels();
            this.discoveryStatus.updateStatus(this.providerId, { state: 'no-credentials', message: this.discoveryMessages.noCredentials });
            return;
        }
        return super.runDiscovery();
    }

    protected override async applyDiscoveredModels(models: DiscoveredModel[]): Promise<void> {
        await super.applyDiscoveredModels(models);
        await this.updateAliasFallback();
    }

    protected override removeAllDiscoveredModels(): void {
        super.removeAllDiscoveredModels();
        this.updateAliasFallback();
    }

    /**
     * Makes one gateway model the last resort of the built-in `default/…` aliases, which every agent
     * (including the host's own helpers, such as the one that names chat sessions) resolves its model
     * through. A gateway URL alone is then a complete setup. The aliases are amended in memory only:
     * a model the user selected, or a provider key they add later, still takes precedence.
     */
    protected async updateAliasFallback(): Promise<void> {
        await this.aliases.ready;
        const configured = this.preferenceService.get<string>(DEFAULT_MODEL_PREF, '');
        const chosen = this.discoveredModels.find(model => model.id === configured) ?? this.discoveredModels[0];
        const fallback = chosen ? this.qualifiedModelId(chosen.id) : undefined;
        for (const alias of this.aliases.getAliases()) {
            if (!alias.id.startsWith('default/')) {
                continue;
            }
            const previous = this.aliasFallback ? alias.defaultModelIds.indexOf(this.aliasFallback) : -1;
            if (previous !== -1) {
                alias.defaultModelIds.splice(previous, 1);
            }
            if (fallback && !alias.defaultModelIds.includes(fallback)) {
                alias.defaultModelIds.push(fallback);
            }
        }
        this.aliasFallback = fallback;
    }

    protected async fetchAvailableModels(): Promise<ModelDiscoveryResult> {
        const { models } = await this.gateway.listModels(this.baseUrl, this.apiKey, this.headers, this.isEnvironmentApiKeyAllowed());
        const discovered: DiscoveredModel[] = models.map(model => ({
            id: model.id,
            description: model.upstream && model.upstream !== model.id ? `Routed to ${model.upstream}` : undefined
        }));
        return { models: discovered, fromCache: false };
    }

    protected createModelDescription(model: DiscoveredModel): OpenAiModelDescription {
        return {
            id: this.qualifiedModelId(model.id),
            model: model.id,
            url: `${this.credentials.baseUrl}/v1`,
            // The OpenAI client insists on a key; a gateway without authentication ignores it.
            apiKey: this.credentials.apiKey ?? 'not-needed',
            apiVersion: undefined,
            maxRetries: this.aiCorePreferences.get(PREFERENCE_NAME_MAX_RETRIES) ?? 3,
            headers: this.headers,
            // LiteLLM translates a plain `system` message for every upstream; `developer` is OpenAI-only.
            developerMessageSettings: 'system',
            enableStreaming: true,
            useResponseApi: false
        };
    }
}
