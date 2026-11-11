#!/usr/bin/env node
/*
 * A stand-in for a LiteLLM gateway that needs no model and no key.
 *
 * It answers the endpoints Cicerone uses (/v1/models, /model/info, /v1/chat/completions with
 * streaming and tool calls) and plays scripted conversations from scenarios.mjs, so the whole
 * loop of the IDE can be tried, demonstrated and tested offline and deterministically.
 *
 *   node tools/mock-gateway/server.mjs [--port 4000]
 *   MOCK_GATEWAY_KEY=sk-demo node tools/mock-gateway/server.mjs    # require a key, like a real gateway
 */
import { createServer } from 'node:http';
import { scenarios } from './scenarios.mjs';

const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1]) || Number(process.env.PORT) || 4000;
const requiredKey = process.env.MOCK_GATEWAY_KEY;
const delay = Number(process.env.MOCK_GATEWAY_DELAY_MS ?? 25);

const MODELS = [
    { name: 'claude-sonnet', upstream: 'anthropic/claude-sonnet-4-5', mode: 'chat', context: 200000 },
    { name: 'gpt-large', upstream: 'openai/gpt-5', mode: 'chat', context: 400000 },
    { name: 'local-qwen', upstream: 'ollama/qwen3-coder', mode: 'chat', context: 32768 },
    { name: 'embed-small', upstream: 'openai/text-embedding-3-small', mode: 'embedding', context: 8191 }
];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
/** Rough but stable: the point is to make cost visible, not to bill anyone. */
const estimateTokens = value => Math.ceil(JSON.stringify(value ?? '').length / 4);

function textOf(message) {
    if (typeof message?.content === 'string') {
        return message.content;
    }
    return Array.isArray(message?.content) ? message.content.map(part => part.text ?? '').join('') : '';
}

/** Which scripted step comes next: the scenario is chosen by the last user message, the step by how far the model has got since. */
function nextStep(body) {
    const messages = body.messages ?? [];
    const lastUser = messages.findLastIndex(message => message.role === 'user');
    const prompt = lastUser === -1 ? '' : textOf(messages[lastUser]);
    if (!body.tools?.length) {
        // Housekeeping requests of the host (naming a chat session, summarising): answer briefly.
        return { say: prompt.split('\n').find(line => line.trim())?.replace(/[^\w\s-]/g, '').trim().split(/\s+/).slice(0, 5).join(' ') || 'Conversation' };
    }
    const stepIndex = messages.slice(lastUser + 1).filter(message => message.role === 'assistant').length;
    const scenario = scenarios.find(candidate => candidate.match.test(prompt)) ?? scenarios.at(-1);
    const steps = typeof scenario.steps === 'function' ? scenario.steps(prompt, messages) : scenario.steps;
    return steps[Math.min(stepIndex, steps.length - 1)];
}

function completionId() {
    return 'chatcmpl-mock-' + Math.random().toString(36).slice(2, 10);
}

async function streamCompletion(response, body, step) {
    const id = completionId();
    const created = Math.floor(Date.now() / 1000);
    const send = (delta, finishReason = null, extra = {}) => response.write(`data: ${JSON.stringify({
        id, object: 'chat.completion.chunk', created, model: body.model,
        choices: [{ index: 0, delta, finish_reason: finishReason }], ...extra
    })}\n\n`);
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    send({ role: 'assistant', content: '' });
    let output = '';
    if (step.say) {
        for (const piece of step.say.match(/\S+\s*/g) ?? []) {
            send({ content: piece });
            output += piece;
            await sleep(delay);
        }
    }
    const calls = step.call ?? [];
    for (let index = 0; index < calls.length; index++) {
        const call = calls[index];
        const argumentsText = JSON.stringify(call.args);
        output += call.name + argumentsText;
        send({ tool_calls: [{ index, id: `call_${id.slice(-6)}_${index}`, type: 'function', function: { name: call.name, arguments: '' } }] });
        for (let offset = 0; offset < argumentsText.length; offset += 48) {
            send({ tool_calls: [{ index, function: { arguments: argumentsText.slice(offset, offset + 48) } }] });
            await sleep(delay / 2);
        }
    }
    send({}, calls.length ? 'tool_calls' : 'stop');
    const usage = usageOf(body, output);
    response.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: body.model, choices: [], usage })}\n\n`);
    response.end('data: [DONE]\n\n');
    return usage;
}

function usageOf(body, output) {
    const prompt = estimateTokens(body.messages) + estimateTokens(body.tools);
    const completion = estimateTokens(output);
    return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

function plainCompletion(response, body, step) {
    const calls = (step.call ?? []).map((call, index) => ({
        id: `call_mock_${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) }
    }));
    const usage = usageOf(body, (step.say ?? '') + JSON.stringify(calls));
    json(response, 200, {
        id: completionId(), object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: body.model,
        choices: [{ index: 0, finish_reason: calls.length ? 'tool_calls' : 'stop', message: { role: 'assistant', content: step.say ?? null, tool_calls: calls.length ? calls : undefined } }],
        usage
    });
    return usage;
}

function json(response, status, payload) {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(payload));
}

function readBody(request) {
    return new Promise((resolve, reject) => {
        let data = '';
        request.setEncoding('utf8').on('data', chunk => data += chunk).on('end', () => resolve(data)).on('error', reject);
    });
}

const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '');
    try {
        if (path === '/health/liveliness' || path === '') {
            return json(response, 200, "I'm alive!");
        }
        if (requiredKey && request.headers.authorization !== `Bearer ${requiredKey}`) {
            return json(response, 401, { error: { message: 'Authentication Error, invalid key', type: 'auth_error', code: '401' } });
        }
        if (request.method === 'GET' && (path === '/v1/models' || path === '/models')) {
            return json(response, 200, { object: 'list', data: MODELS.map(model => ({ id: model.name, object: 'model', created: 1700000000, owned_by: 'mock' })) });
        }
        if (request.method === 'GET' && (path === '/model/info' || path === '/v1/model/info')) {
            return json(response, 200, {
                data: MODELS.map(model => ({
                    model_name: model.name,
                    litellm_params: { model: model.upstream },
                    model_info: { mode: model.mode, max_input_tokens: model.context, supports_function_calling: model.mode === 'chat' }
                }))
            });
        }
        if (request.method === 'POST' && (path === '/v1/chat/completions' || path === '/chat/completions')) {
            const body = JSON.parse(await readBody(request));
            const step = nextStep(body);
            const usage = body.stream ? await streamCompletion(response, body, step) : plainCompletion(response, body, step);
            const system = (body.messages ?? []).filter(message => message.role === 'system' || message.role === 'developer').map(textOf).join('\n');
            // One line per request: what the harness actually put on the wire.
            console.log(JSON.stringify({
                model: body.model, messages: body.messages?.length ?? 0, tools: body.tools?.length ?? 0,
                systemTokens: estimateTokens(system), toolTokens: estimateTokens(body.tools), promptTokens: usage.prompt_tokens,
                reply: step.call ? step.call.map(call => call.name).join('+') : 'text'
            }));
            if (process.env.MOCK_GATEWAY_DUMP) {
                (await import('node:fs')).writeFileSync(process.env.MOCK_GATEWAY_DUMP, JSON.stringify(body, undefined, 2));
            }
            return;
        }
        json(response, 404, { error: { message: `Mock gateway: no route for ${request.method} ${path}` } });
    } catch (error) {
        console.error(error);
        if (!response.headersSent) {
            json(response, 500, { error: { message: String(error) } });
        } else {
            response.end();
        }
    }
});

server.listen(port, '127.0.0.1', () => console.error(`Mock LiteLLM gateway on http://127.0.0.1:${port} (${scenarios.length} scenarios${requiredKey ? ', key required' : ''})`));
