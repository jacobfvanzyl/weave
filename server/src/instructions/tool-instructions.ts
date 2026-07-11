import { readFileSync } from 'node:fs';

export type ToolInstruction = {
  description: string;
  inputs: Record<string, string>;
};

const cache = new Map<string, ToolInstruction>();

const sectionBody = (content: string, heading: string) => {
  const pattern = new RegExp(`^## ${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm');
  const match = pattern.exec(content);
  if (!match) return '';
  const start = match.index + match[0].length;
  const next = /^##\s+/m.exec(content.slice(start));
  return content.slice(start, next ? start + next.index : undefined).trim();
};

const parseInputDescriptions = (content: string) => {
  const inputs = sectionBody(content, 'Inputs');
  const result: Record<string, string> = {};
  const matches = [...inputs.matchAll(/^###\s+(.+?)\s*$/gm)];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const next = matches[index + 1];
    const key = match[1].trim();
    const start = match.index! + match[0].length;
    const end = next?.index ?? inputs.length;
    const value = inputs.slice(start, end).trim();
    if (key && value) result[key] = value;
  }
  return result;
};

export const getToolInstruction = (toolId: string): ToolInstruction => {
  const cached = cache.get(toolId);
  if (cached) return cached;

  const content = readFileSync(new URL(`../agent/mastra/tools/${toolId}/INSTRUCTION.md`, import.meta.url), 'utf8');
  const instruction = {
    description: sectionBody(content, 'Description'),
    inputs: parseInputDescriptions(content),
  };
  if (!instruction.description) throw new Error(`Tool instruction missing Description section: ${toolId}`);
  cache.set(toolId, instruction);
  return instruction;
};

export const toolDescription = (toolId: string) => getToolInstruction(toolId).description;

export const toolInputDescription = (toolId: string, inputPath: string) => {
  const description = getToolInstruction(toolId).inputs[inputPath];
  if (!description) throw new Error(`Tool instruction missing input description: ${toolId}.${inputPath}`);
  return description;
};

export const __toolInstructionsTest = {
  parseInputDescriptions,
  sectionBody,
};
