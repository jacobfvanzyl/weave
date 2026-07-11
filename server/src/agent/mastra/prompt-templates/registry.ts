import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandArguments } from './arguments';
import { parseFrontmatter } from './frontmatter';
import type { PromptSummary, PromptTemplate } from './types';
import { resolveAgentContext, type ResolvedAgentContext, type WeaveContextFile } from '../context/resolver';

const promptNamePattern = /^[a-zA-Z0-9_-]+$/;
const promptDirs = [
  path.resolve(process.cwd(), 'src/mastra/prompts'),
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../prompts'),
];

let promptCache: PromptTemplate[] | undefined;

export type PromptResolutionContext = {
  mastra?: any;
  resourceId?: string;
  threadId?: unknown;
  projectId?: unknown;
  workspaceId?: unknown;
  resolvedContext?: ResolvedAgentContext;
};

const firstContentLine = (content: string) =>
  content
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean) ?? '';

const toStringArray = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

const loadPrompt = async (dir: string, fileName: string): Promise<PromptTemplate | null> => {
  if (!fileName.endsWith('.md')) return null;

  const name = fileName.slice(0, -'.md'.length);
  if (!promptNamePattern.test(name)) return null;

  const raw = await readFile(path.join(dir, fileName), 'utf8');
  const { data, content } = parseFrontmatter(raw);
  const description = typeof data.description === 'string' && data.description.trim()
    ? data.description.trim()
    : firstContentLine(content).slice(0, 120);
  const argumentHint = typeof data['argument-hint'] === 'string' ? data['argument-hint'].trim() : undefined;

  return {
    name,
    command: `/${name}`,
    description,
    argumentHint,
    tags: toStringArray(data.tags),
    content: content.trim(),
    source: 'app',
  };
};

const promptNameFromPath = (filePath: string) => {
  const name = filePath.split('/').pop() ?? '';
  return name.endsWith('.md') ? name.slice(0, -'.md'.length) : name;
};

const promptFromContextFile = (file: WeaveContextFile, source: 'user' | 'project'): PromptTemplate | undefined => {
  const name = promptNameFromPath(file.path);
  if (!promptNamePattern.test(name)) return undefined;

  const { data, content } = parseFrontmatter(file.content);
  const description = typeof data.description === 'string' && data.description.trim()
    ? data.description.trim()
    : firstContentLine(content).slice(0, 120);
  const argumentHint = typeof data['argument-hint'] === 'string' ? data['argument-hint'].trim() : undefined;

  return {
    name,
    command: `/${name}`,
    description,
    argumentHint,
    tags: toStringArray(data.tags),
    content: content.trim(),
    source,
    path: file.path,
  };
};

const getResolvedContext = async (context?: PromptResolutionContext) => {
  if (context?.resolvedContext) return context.resolvedContext;
  if (!context?.mastra || !context.resourceId) return undefined;
  return resolveAgentContext({
    mastra: context.mastra,
    resourceId: context.resourceId,
    threadId: context.threadId,
    projectId: context.projectId,
    workspaceId: context.workspaceId,
  });
};

const listAppPromptTemplates = async (): Promise<PromptTemplate[]> => {
  if (promptCache) return promptCache;

  const promptsByName = new Map<string, PromptTemplate>();

  for (const dir of promptDirs) {
    const files = await readdir(dir).catch(() => []);
    const prompts = await Promise.all(files.map((fileName) => loadPrompt(dir, fileName)));
    for (const prompt of prompts) {
      if (prompt) promptsByName.set(prompt.name, prompt);
    }
  }

  promptCache = [...promptsByName.values()].sort((a, b) => a.name.localeCompare(b.name));
  return promptCache;
};

export const listPromptTemplates = async (context?: PromptResolutionContext): Promise<PromptTemplate[]> => {
  const appPrompts = await listAppPromptTemplates();
  const resolved = await getResolvedContext(context);
  if (!resolved) return appPrompts;

  const promptsByName = new Map<string, PromptTemplate>(appPrompts.map((prompt) => [prompt.name, prompt]));

  for (const file of resolved.userSnapshot?.files.filter((file) => file.kind === 'prompt') ?? []) {
    const prompt = promptFromContextFile(file, 'user');
    if (prompt) promptsByName.set(prompt.name, prompt);
  }

  for (const file of resolved.projectSnapshot?.files.filter((file) => file.kind === 'prompt') ?? []) {
    const prompt = promptFromContextFile(file, 'project');
    if (prompt) promptsByName.set(prompt.name, prompt);
  }

  return [...promptsByName.values()].sort((a, b) => a.name.localeCompare(b.name));
};

export const listPromptSummaries = async (context?: PromptResolutionContext): Promise<PromptSummary[]> => {
  const prompts = await listPromptTemplates(context);
  return prompts.map(({ content: _content, ...summary }) => summary);
};

export const getPromptTemplate = async (name: string, context?: PromptResolutionContext) => {
  if (!promptNamePattern.test(name)) return undefined;
  const prompts = await listPromptTemplates(context);
  return prompts.find((prompt) => prompt.name === name);
};

export const expandPromptTemplate = async (name: string, argsText: string, context?: PromptResolutionContext) => {
  const prompt = await getPromptTemplate(name, context);
  if (!prompt) return undefined;
  return expandArguments(prompt.content, argsText);
};
