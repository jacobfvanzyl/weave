import { createHash } from 'node:crypto';

const defaultMaxChars = 1_600;
const defaultCodeToolMaxChars = 12_000;

export const hashText = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 12);

const positiveInteger = (value: unknown) => {
  const number = typeof value === 'string' ? Number(value) : value;
  return typeof number === 'number' && Number.isInteger(number) && number > 0 ? number : undefined;
};

export const getCodeToolModelOutputMaxChars = (env: NodeJS.ProcessEnv = process.env) =>
  positiveInteger(env.WEAVE_CODE_TOOL_MODEL_OUTPUT_MAX_CHARS) ?? defaultCodeToolMaxChars;

export const compactText = (value: unknown, maxChars = defaultMaxChars) => {
  const text = typeof value === 'string' ? value : value === undefined || value === null ? '' : JSON.stringify(value);
  if (text.length <= maxChars) {
    return {
      text,
      chars: text.length,
      hash: hashText(text),
      truncated: false,
    };
  }

  return {
    text: text.slice(0, maxChars),
    chars: text.length,
    hash: hashText(text),
    truncated: true,
  };
};

const lines = (items: Array<[string, unknown]>) =>
  items
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);

export const formatToolModelOutput = (heading: string, fields: Array<[string, unknown]>, body?: unknown, maxChars = defaultMaxChars) => {
  const compact = compactText(body, maxChars);
  const header = [heading, ...lines(fields), ...(compact.chars ? [
    `contentChars: ${compact.chars}`,
    `contentHash: ${compact.hash}`,
    ...(compact.truncated ? ['truncated: true'] : []),
  ] : [])];

  return compact.text ? `${header.join('\n')}\n\n${compact.text}` : header.join('\n');
};
