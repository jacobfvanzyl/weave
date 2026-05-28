import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2Content,
  LanguageModelV2FinishReason,
  LanguageModelV2FunctionTool,
  LanguageModelV2Message,
  LanguageModelV2StreamPart,
  LanguageModelV2Usage,
} from '@ai-sdk/provider-v5';
import { attachmentIdFromReference, attachmentStorage } from '../attachments';
import { getCodexCredentials } from './chatgpt-codex-auth';

const CODEX_URL = 'https://chatgpt.com/backend-api/codex/responses';

const isFunctionTool = (tool: unknown): tool is LanguageModelV2FunctionTool => {
  return Boolean(tool && typeof tool === 'object' && 'type' in tool && tool.type === 'function');
};

const stringifyToolOutput = (output: unknown): string => {
  if (typeof output === 'string') return output;
  return JSON.stringify(output);
};

type FilePartData = Exclude<LanguageModelV2Message, { role: 'system' }>['content'][number] extends infer Part
  ? Part extends { type: 'file'; data: infer Data } ? Data : never
  : never;

const toBase64 = async (data: FilePartData | URL | string | Uint8Array | ArrayBuffer) => {
  if (data instanceof URL) {
    const attachmentId = attachmentIdFromReference(data.toString());
    if (attachmentId) {
      const attachment = await attachmentStorage.get(attachmentId);
      return attachment ? Buffer.from(attachment.bytes).toString('base64') : '';
    }

    return data.toString();
  }

  if (typeof data === 'string') {
    const attachmentId = attachmentIdFromReference(data);
    if (attachmentId) {
      const attachment = await attachmentStorage.get(attachmentId);
      return attachment ? Buffer.from(attachment.bytes).toString('base64') : '';
    }

    return data.startsWith('data:') || data.startsWith('http') ? data : data;
  }
  return Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data).toString('base64');
};

const filePartImageUrl = async (part: Extract<Exclude<LanguageModelV2Message, { role: 'system' }>['content'][number], { type: 'file' }>) => {
  const mediaType = part.mediaType === 'image/*' ? 'image/jpeg' : part.mediaType;
  const data = await toBase64(part.data);
  if (!data) return undefined;
  return data.startsWith('data:') || data.startsWith('http') ? data : `data:${mediaType};base64,${data}`;
};

const imagePartImageUrl = async (part: { image?: unknown }) => {
  const image = part.image;
  if (!(typeof image === 'string' || image instanceof URL || image instanceof Uint8Array || image instanceof ArrayBuffer)) return undefined;
  const data = await toBase64(image);
  if (!data) return undefined;
  return data.startsWith('data:') || data.startsWith('http') ? data : `data:image/jpeg;base64,${data}`;
};

const toResponsesContent = async (message: Exclude<LanguageModelV2Message, { role: 'system' | 'tool' }>) => {
  const content: Array<Record<string, unknown>> = [];

  for (const part of message.content) {
    const rawPart = part as { type?: string; image?: unknown };
    if (part.type === 'text') {
      content.push({ type: message.role === 'assistant' ? 'output_text' : 'input_text', text: part.text });
      continue;
    }

    if (message.role === 'user' && part.type === 'file' && part.mediaType.startsWith('image/')) {
      const imageUrl = await filePartImageUrl(part);
      if (imageUrl) content.push({ type: 'input_image', image_url: imageUrl });
      continue;
    }

    if (message.role === 'user' && rawPart.type === 'image') {
      const imageUrl = await imagePartImageUrl(rawPart);
      if (imageUrl) content.push({ type: 'input_image', image_url: imageUrl });
    }
  }

  return content;
};

const toResponsesInput = async (prompt: LanguageModelV2CallOptions['prompt']) => {
  const input: Array<Record<string, unknown>> = [];

  for (const message of prompt) {
    if (message.role === 'system') continue;

    if (message.role === 'tool') {
      for (const part of message.content) {
        input.push({
          type: 'function_call_output',
          call_id: part.toolCallId,
          output: stringifyToolOutput(part.output),
        });
      }
      continue;
    }

    if (message.role === 'assistant') {
      for (const part of message.content) {
        if (part.type === 'tool-call') {
          input.push({
            type: 'function_call',
            call_id: part.toolCallId,
            name: part.toolName,
            arguments: JSON.stringify(part.input ?? {}),
          });
        }
      }
    }

    const content = await toResponsesContent(message);
    if (!content.length) continue;

    input.push({
      role: message.role,
      content,
    });
  }

  return input;
};

const getInstructions = (prompt: LanguageModelV2CallOptions['prompt']): string | undefined => {
  return prompt.filter(message => message.role === 'system').map(message => message.content).join('\n\n') || undefined;
};

const toResponsesTools = (tools: LanguageModelV2CallOptions['tools']) => {
  return tools?.filter(isFunctionTool).map(tool => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    strict: false,
  }));
};

const getReasoningEffort = (options: LanguageModelV2CallOptions): string | undefined => {
  const openai = options.providerOptions?.openai;
  const effort = openai?.reasoningEffort;
  return typeof effort === 'string' ? effort : undefined;
};

const buildBody = async (modelId: string, options: LanguageModelV2CallOptions) => {
  const body: Record<string, unknown> = {
    model: modelId,
    store: false,
    stream: true,
    input: await toResponsesInput(options.prompt),
    text: { verbosity: 'low' },
    include: ['reasoning.encrypted_content'],
    tool_choice: options.toolChoice?.type === 'none' ? 'none' : 'auto',
    parallel_tool_calls: true,
  };

  const instructions = getInstructions(options.prompt);
  if (instructions) body.instructions = instructions;
  if (options.temperature !== undefined) body.temperature = options.temperature;
  if (options.maxOutputTokens !== undefined) body.max_output_tokens = options.maxOutputTokens;

  const tools = toResponsesTools(options.tools);
  if (tools?.length) body.tools = tools;

  const effort = getReasoningEffort(options);
  if (effort && effort !== 'off') body.reasoning = { effort: effort === 'minimal' ? 'low' : effort, summary: 'auto' };

  return body;
};

const countInputImages = (input: unknown) => {
  if (!Array.isArray(input)) return 0;
  return input.reduce((total, item) => {
    const content = item && typeof item === 'object' && 'content' in item ? (item as { content?: unknown }).content : undefined;
    if (!Array.isArray(content)) return total;
    return total + content.filter(part => part && typeof part === 'object' && (part as { type?: unknown }).type === 'input_image').length;
  }, 0);
};

async function* parseSse(response: Response): AsyncGenerator<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let index = buffer.indexOf('\n\n');
      while (index !== -1) {
        const chunk = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const data = chunk
          .split('\n')
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trim())
          .join('\n');

        if (data && data !== '[DONE]') yield JSON.parse(data) as Record<string, unknown>;
        index = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
}

const finishReason = (status?: unknown): LanguageModelV2FinishReason => {
  if (status === 'incomplete') return 'length';
  if (status === 'failed') return 'error';
  return 'stop';
};

const usageFrom = (response: Record<string, unknown> | undefined): LanguageModelV2Usage => {
  const usage = response?.usage as Record<string, unknown> | undefined;
  const inputTokens = typeof usage?.input_tokens === 'number' ? usage.input_tokens : undefined;
  const outputTokens = typeof usage?.output_tokens === 'number' ? usage.output_tokens : undefined;
  const totalTokens = typeof usage?.total_tokens === 'number' ? usage.total_tokens : undefined;
  const inputDetails = usage?.input_tokens_details as Record<string, unknown> | undefined;
  const cachedInputTokens = typeof inputDetails?.cached_tokens === 'number' ? inputDetails.cached_tokens : undefined;

  return { inputTokens, outputTokens, totalTokens, cachedInputTokens };
};

export class ChatGPTCodexLanguageModel implements LanguageModelV2 {
  readonly specificationVersion = 'v2' as const;
  readonly provider = 'chatgpt-codex';
  readonly supportedUrls = {
    'image/*': [/^data:image\/[a-z0-9.+-]+;base64,/i, /^https:\/\/weave\.local\/attachments\/[^/?#]+$/i],
  };

  constructor(readonly modelId: string) {}

  async doGenerate(options: LanguageModelV2CallOptions) {
    const chunks: LanguageModelV2Content[] = [];
    let text = '';
    let finish: LanguageModelV2FinishReason = 'stop';
    let usage: LanguageModelV2Usage = { inputTokens: undefined, outputTokens: undefined, totalTokens: undefined };
    const { stream } = await this.doStream(options);
    const reader = stream.getReader();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.type === 'text-delta') text += value.delta;
      if (value.type === 'finish') {
        finish = value.finishReason;
        usage = value.usage;
      }
    }

    if (text) chunks.push({ type: 'text', text });
    return { content: chunks, finishReason: finish, usage, warnings: [] };
  }

  async doStream(options: LanguageModelV2CallOptions) {
    const body = await buildBody(this.modelId, options);
    const credentials = await getCodexCredentials();
    console.info('[chatgpt-codex] request', {
      model: this.modelId,
      accountId: credentials.accountId,
      reasoningEffort: getReasoningEffort(options) ?? 'default',
      tools: options.tools?.length ?? 0,
      inputImages: countInputImages(body.input),
    });
    const headers = new Headers(options.headers as Record<string, string> | undefined);

    headers.set('Authorization', `Bearer ${credentials.access}`);
    headers.set('ChatGPT-Account-Id', credentials.accountId ?? '');
    headers.set('originator', 'mage-hand');
    headers.set('User-Agent', 'mage-hand');
    headers.set('OpenAI-Beta', 'responses=experimental');
    headers.set('accept', 'text/event-stream');
    headers.set('content-type', 'application/json');

    const response = await fetch(CODEX_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: options.abortSignal,
    });
    const modelId = this.modelId;

    if (!response.ok) {
      const text = await response.text().catch(() => response.statusText);
      console.error('[chatgpt-codex] response error', { model: this.modelId, status: response.status, body: text });
      throw new Error(`ChatGPT Codex request failed (${response.status}): ${text}`);
    }

    console.info('[chatgpt-codex] response stream opened', { model: this.modelId, status: response.status });

    const stream = new ReadableStream<LanguageModelV2StreamPart>({
      async start(controller) {
        controller.enqueue({ type: 'stream-start', warnings: [] });
        const textId = 'text-0';
        let textStarted = false;
        const toolNames = new Map<string, string>();
        const toolCallIdsByItemId = new Map<string, string>();

        try {
          for await (const event of parseSse(response)) {
            if (options.includeRawChunks) controller.enqueue({ type: 'raw', rawValue: event });

            const type = event.type;
            if (type === 'response.created' || type === 'response.in_progress') {
              const res = event.response as Record<string, unknown> | undefined;
              if (typeof res?.id === 'string') controller.enqueue({ type: 'response-metadata', id: res.id, modelId });
            }

            if (type === 'response.output_text.delta' && typeof event.delta === 'string') {
              if (!textStarted) {
                controller.enqueue({ type: 'text-start', id: textId });
                textStarted = true;
              }
              controller.enqueue({ type: 'text-delta', id: textId, delta: event.delta });
            }

            if (type === 'response.output_item.added') {
              const item = event.item as Record<string, unknown> | undefined;
              if (item?.type === 'function_call' && typeof item.call_id === 'string' && typeof item.name === 'string') {
                toolNames.set(item.call_id, item.name);
                if (typeof item.id === 'string') toolCallIdsByItemId.set(item.id, item.call_id);
                controller.enqueue({ type: 'tool-input-start', id: item.call_id, toolName: item.name });
              }
            }

            if (type === 'response.function_call_arguments.delta' && typeof event.delta === 'string' && typeof event.item_id === 'string') {
              controller.enqueue({ type: 'tool-input-delta', id: toolCallIdsByItemId.get(event.item_id) ?? event.item_id, delta: event.delta });
            }

            if (type === 'response.output_item.done') {
              const item = event.item as Record<string, unknown> | undefined;
              if (item?.type === 'function_call' && typeof item.call_id === 'string') {
                const toolName = typeof item.name === 'string' ? item.name : toolNames.get(item.call_id) ?? 'unknown';
                const input = typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {});
                controller.enqueue({ type: 'tool-input-end', id: item.call_id });
                controller.enqueue({ type: 'tool-call', toolCallId: item.call_id, toolName, input });
              }
            }

            if (type === 'response.completed' || type === 'response.done' || type === 'response.incomplete' || type === 'response.failed') {
              const res = event.response as Record<string, unknown> | undefined;
              const usage = usageFrom(res);
              console.info('[chatgpt-codex] response completed', {
                model: modelId,
                inputTokens: usage.inputTokens,
                cachedInputTokens: usage.cachedInputTokens,
                outputTokens: usage.outputTokens,
              });
              if (textStarted) controller.enqueue({ type: 'text-end', id: textId });
              controller.enqueue({ type: 'finish', finishReason: finishReason(res?.status), usage });
              controller.close();
              return;
            }
          }

          if (textStarted) controller.enqueue({ type: 'text-end', id: textId });
          controller.enqueue({ type: 'finish', finishReason: 'unknown', usage: usageFrom(undefined) });
          controller.close();
        } catch (error) {
          controller.enqueue({ type: 'error', error });
          controller.close();
        }
      },
    });

    return { stream, request: { body } };
  }
}
