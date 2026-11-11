import { injectable } from '@theia/core/shared/inversify';
import { GatewayEnvironment, GatewayModel, GatewayModels, LiteLlmGateway, normalizeBaseUrl } from '../common/litellm-protocol.js';

const TIMEOUT_MS = 10_000;
/** LiteLLM modes that cannot hold a conversation; anything else (or no mode at all) is offered. */
const NON_CHAT_MODES = new Set(['embedding', 'image_generation', 'audio_transcription', 'audio_speech', 'rerank', 'moderation', 'ocr', 'video_generation']);

@injectable()
export class LiteLlmGatewayImpl implements LiteLlmGateway {

    async getEnvironment(): Promise<GatewayEnvironment> {
        return { baseUrl: process.env.LITELLM_BASE_URL || undefined, hasApiKey: !!process.env.LITELLM_API_KEY };
    }

    async resolveCredentials(baseUrl: string | undefined, apiKey: string | undefined, useEnvironment: boolean): Promise<{ baseUrl?: string, apiKey?: string }> {
        const url = baseUrl || (useEnvironment ? process.env.LITELLM_BASE_URL : undefined);
        const key = apiKey || (useEnvironment ? process.env.LITELLM_API_KEY : undefined);
        return { baseUrl: url ? normalizeBaseUrl(url) : undefined, apiKey: key || undefined };
    }

    async listModels(baseUrl: string | undefined, apiKey: string | undefined, headers: Record<string, string> | undefined, useEnvironment: boolean): Promise<GatewayModels> {
        const credentials = await this.resolveCredentials(baseUrl, apiKey, useEnvironment);
        if (!credentials.baseUrl) {
            throw new Error('No gateway URL configured.');
        }
        const requestHeaders: Record<string, string> = { ...headers, accept: 'application/json' };
        if (credentials.apiKey) {
            requestHeaders.authorization = `Bearer ${credentials.apiKey}`;
        }
        const listed = await this.getJson(`${credentials.baseUrl}/v1/models`, requestHeaders) as { data?: { id?: unknown }[] };
        if (!Array.isArray(listed?.data)) {
            throw new Error(`${credentials.baseUrl}/v1/models did not answer with a model list.`);
        }
        const ids = listed.data.map(entry => entry.id).filter((id): id is string => typeof id === 'string');

        // LiteLLM knows what each model is; a plain OpenAI-compatible endpoint answers 404 here and we simply offer every id.
        const info = await this.getModelInfo(credentials.baseUrl, requestHeaders);
        const models: GatewayModel[] = [];
        for (const id of new Set(ids)) {
            const details = info?.get(id);
            if (details?.mode && NON_CHAT_MODES.has(details.mode)) {
                continue;
            }
            models.push({ id, ...details });
        }
        models.sort((a, b) => a.id.localeCompare(b.id));
        return { flavor: info ? 'litellm' : 'openai-compatible', models };
    }

    protected async getModelInfo(baseUrl: string, headers: Record<string, string>): Promise<Map<string, Omit<GatewayModel, 'id'>> | undefined> {
        try {
            const body = await this.getJson(`${baseUrl}/model/info`, headers) as { data?: unknown[] };
            if (!Array.isArray(body?.data)) {
                return undefined;
            }
            const result = new Map<string, Omit<GatewayModel, 'id'>>();
            for (const raw of body.data) {
                const entry = raw as { model_name?: string, litellm_params?: { model?: string }, model_info?: Record<string, unknown> };
                if (typeof entry?.model_name !== 'string') {
                    continue;
                }
                const modelInfo = entry.model_info ?? {};
                result.set(entry.model_name, {
                    mode: typeof modelInfo.mode === 'string' ? modelInfo.mode : undefined,
                    maxInputTokens: typeof modelInfo.max_input_tokens === 'number' ? modelInfo.max_input_tokens : undefined,
                    supportsTools: typeof modelInfo.supports_function_calling === 'boolean' ? modelInfo.supports_function_calling : undefined,
                    upstream: typeof entry.litellm_params?.model === 'string' ? entry.litellm_params.model : undefined
                });
            }
            return result;
        } catch {
            return undefined;
        }
    }

    protected async getJson(url: string, headers: Record<string, string>): Promise<unknown> {
        let response: Response;
        try {
            response = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
        } catch (error) {
            const cause = (error as { cause?: { code?: string, message?: string } })?.cause;
            throw new Error(`Cannot reach ${url}: ${cause?.code ?? cause?.message ?? (error as Error).message}`);
        }
        if (response.status === 401 || response.status === 403) {
            throw new Error(`The gateway refused the key (HTTP ${response.status}).`);
        }
        if (!response.ok) {
            throw new Error(`${url} answered HTTP ${response.status}.`);
        }
        return response.json();
    }
}
