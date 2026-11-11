import { PreferenceSchema } from '@theia/core';

export const LITELLM_GATEWAY_PATH = '/services/cicerone/litellm-gateway';
export const LITELLM_PROVIDER_ID = 'liteLlm';
/** Prefix of the ids under which gateway models are registered, e.g. `litellm/claude-sonnet`. */
export const LITELLM_MODEL_PREFIX = 'litellm';

export const BASE_URL_PREF = 'ai-features.liteLlm.baseUrl';
export const API_KEY_PREF = 'ai-features.liteLlm.apiKey';
export const HEADERS_PREF = 'ai-features.liteLlm.headers';
export const MODEL_OVERRIDES_PREF = 'ai-features.liteLlm.modelOverrides';
export const ALLOW_ENV_PREF = 'ai-features.liteLlm.allowEnvironmentApiKey';
export const DEFAULT_MODEL_PREF = 'ai-features.liteLlm.defaultModel';

export const LiteLlmPreferencesSchema: PreferenceSchema = {
    properties: {
        [BASE_URL_PREF]: {
            type: 'string',
            default: '',
            markdownDescription: 'Base URL of a [LiteLLM](https://docs.litellm.ai/docs/simple_proxy) gateway, e.g. `http://localhost:4000`. ' +
                'Every chat model the gateway serves is discovered and offered to all agents. ' +
                'Any OpenAI-compatible gateway works; LiteLLM additionally reports which models are chat models.',
            title: 'LiteLLM gateway URL'
        },
        [API_KEY_PREF]: {
            type: 'string',
            default: '',
            markdownDescription: 'Virtual key or master key for the gateway. Leave empty for a gateway without authentication. ' +
                '**Stored in clear text** in your settings; alternatively set `LITELLM_API_KEY` in the environment.',
            title: 'LiteLLM key'
        },
        [HEADERS_PREF]: {
            type: 'object',
            additionalProperties: { type: 'string' },
            default: {},
            markdownDescription: 'Additional HTTP headers sent with every gateway request, e.g. for a reverse proxy in front of it.',
            title: 'LiteLLM headers'
        },
        [MODEL_OVERRIDES_PREF]: {
            type: 'array',
            items: { type: 'string' },
            default: [],
            markdownDescription: 'If set, exactly these model names are registered and the gateway is not asked what it offers.',
            title: 'LiteLLM models'
        },
        [DEFAULT_MODEL_PREF]: {
            type: 'string',
            default: '',
            markdownDescription: 'Gateway model that stands in wherever no other model is configured or available (the `default/…` model aliases all agents use). ' +
                'Empty: the first chat model the gateway lists.',
            title: 'LiteLLM default model'
        },
        [ALLOW_ENV_PREF]: {
            type: 'boolean',
            default: false,
            markdownDescription: 'Allow using `LITELLM_BASE_URL` / `LITELLM_API_KEY` from the environment.',
            title: 'Use LiteLLM settings from the environment'
        }
    }
};

export interface GatewayModel {
    /** Model name as the gateway routes it (`model` in a chat completion request). */
    id: string;
    /** `chat`, `embedding`, … as LiteLLM reports it; undefined for plain OpenAI-compatible gateways. */
    mode?: string;
    maxInputTokens?: number;
    supportsTools?: boolean;
    /** The upstream model the gateway routes to, e.g. `anthropic/claude-sonnet-4-5`. */
    upstream?: string;
}

export interface GatewayModels {
    /** `litellm` when the gateway answered LiteLLM's `/model/info`; otherwise a generic OpenAI-compatible endpoint. */
    flavor: 'litellm' | 'openai-compatible';
    models: GatewayModel[];
}

export interface GatewayEnvironment {
    baseUrl?: string;
    hasApiKey: boolean;
}

export const LiteLlmGateway = Symbol('LiteLlmGateway');
export interface LiteLlmGateway {
    /** What the environment of the backend process offers, without revealing the key itself. */
    getEnvironment(): Promise<GatewayEnvironment>;
    /**
     * Lists the chat models of the gateway. Rejects with a readable message when the gateway cannot be
     * reached or refuses the key. `useEnvironment` fills a missing URL or key from the environment.
     */
    listModels(baseUrl: string | undefined, apiKey: string | undefined, headers: Record<string, string> | undefined, useEnvironment: boolean): Promise<GatewayModels>;
    /** The key the registered models should use: the given one, or the environment's when allowed. */
    resolveCredentials(baseUrl: string | undefined, apiKey: string | undefined, useEnvironment: boolean): Promise<{ baseUrl?: string, apiKey?: string }>;
}

/** `http://host:4000/` → `http://host:4000`; a trailing `/v1` is dropped so both spellings work. */
export function normalizeBaseUrl(url: string): string {
    return url.trim().replace(/\/+$/, '').replace(/\/v1$/, '');
}
