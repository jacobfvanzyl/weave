import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandArguments } from './arguments';
import { parseFrontmatter } from './frontmatter';
import type { PromptSummary, PromptTemplate } from './types';
import { resolveProfileContext, type ResolvedProfileContext, type WeaveContextFile } from '../profiles/resolver';

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
  profileId?: unknown;
  resolvedProfile?: ResolvedProfileContext;
};

const builtinPrompts: PromptTemplate[] = [
  {
    name: 'plan',
    command: '/plan',
    description: 'Make a concise implementation plan',
    argumentHint: '<goal>',
    tags: ['planning'],
    content: 'Make a concise implementation plan for:\n\n$ARGUMENTS\n\nInclude:\n- affected files or systems\n- implementation steps\n- verification steps\n- open questions',
    source: 'app',
  },
  {
    name: 'review',
    command: '/review',
    description: 'Review text for risks, gaps, and next actions',
    argumentHint: '[context]',
    tags: ['review'],
    content: 'Review this:\n\n$ARGUMENTS\n\nFocus on:\n- missing assumptions\n- edge cases\n- risks\n- next concrete action',
    source: 'app',
  },
  {
    name: 'summarize',
    command: '/summarize',
    description: 'Summarize content into key points and action items',
    argumentHint: '[content]',
    tags: ['summary'],
    content: 'Summarize this:\n\n$ARGUMENTS\n\nReturn:\n- key points\n- decisions\n- action items',
    source: 'app',
  },
];

const firstContentLine = (content: string) =>
  content
    .split('\n')
    .map(line => line.trim())
    .find(Boolean) ?? '';

const toStringArray = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

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

const promptFromContextFile = (file: WeaveContextFile, source: 'global' | 'project'): PromptTemplate | undefined => {
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

const getResolvedProfile = async (context?: PromptResolutionContext) => {
  if (context?.resolvedProfile) return context.resolvedProfile;
  if (!context?.mastra || !context.resourceId) return undefined;
  return resolveProfileContext({
    mastra: context.mastra,
    resourceId: context.resourceId,
    threadId: context.threadId,
    projectId: context.projectId,
    workspaceId: context.workspaceId,
    profileId: context.profileId,
  });
};

const listAppPromptTemplates = async (): Promise<PromptTemplate[]> => {
  if (promptCache) return promptCache;

  const promptsByName = new Map<string, PromptTemplate>(builtinPrompts.map(prompt => [prompt.name, prompt]));

  for (const dir of promptDirs) {
    const files = await readdir(dir).catch(() => []);
    const prompts = await Promise.all(files.map(fileName => loadPrompt(dir, fileName)));
    for (const prompt of prompts) {
      if (prompt) promptsByName.set(prompt.name, prompt);
    }
  }

  promptCache = [...promptsByName.values()].sort((a, b) => a.name.localeCompare(b.name));
  return promptCache;
};

export const listPromptTemplates = async (context?: PromptResolutionContext): Promise<PromptTemplate[]> => {
  const appPrompts = await listAppPromptTemplates();
  const resolved = await getResolvedProfile(context);
  if (!resolved) return appPrompts;

  const promptsByName = new Map<string, PromptTemplate>(appPrompts.map(prompt => [prompt.name, prompt]));

  for (const file of resolved.globalSnapshot?.files.filter(file => file.kind === 'prompt') ?? []) {
    const prompt = promptFromContextFile(file, 'global');
    if (prompt) promptsByName.set(prompt.name, prompt);
  }

  for (const file of resolved.projectSnapshot?.files.filter(file => file.kind === 'prompt') ?? []) {
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
  return prompts.find(prompt => prompt.name === name);
};

export const expandPromptTemplate = async (name: string, argsText: string, context?: PromptResolutionContext) => {
  const prompt = await getPromptTemplate(name, context);
  if (!prompt) return undefined;
  return expandArguments(prompt.content, argsText);
};
