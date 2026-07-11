import { readFileSync } from 'node:fs';
import type { SystemMessage } from '@mastra/core/llm';
import type { ResolvedSkillSummary } from '../context/skill-source';

export type ProjectAgentInstructions = {
  path: string;
  content: string;
  size?: number;
  updatedAt?: string;
  checkedAt?: string;
};

export type ChatRuntimeContext = {
  now?: Date;
  timeZone?: string;
};

const readInstruction = (name: string) =>
  readFileSync(new URL(`./instructions/${name}.md`, import.meta.url), 'utf8').trim();

const renderTemplate = (template: string, values: Record<string, string>) =>
  Object.entries(values).reduce(
    (result, [key, value]) => result.replaceAll(`{{${key}}}`, value),
    template,
  ).replace(/\n{3,}/g, '\n\n').trim();

export const gitProjectCodingInstructions = readInstruction('git-project-coding');

export const notesProjectVaultInstructions = readInstruction('notes-project-vault');

const projectContextTemplate = readInstruction('project-context');
const availableSkillsTemplate = readInstruction('available-skills');
const runtimeContextTemplate = readInstruction('runtime-context');

export const formatProjectContextFile = (path: string, content: string) =>
  renderTemplate(projectContextTemplate, { path, content });

const maxAvailableSkills = 30;
const maxSkillDescriptionLength = 220;

const compactText = (value: string) => value.replace(/\s+/g, ' ').trim();

const truncateText = (value: string, maxLength: number) => {
  const compact = compactText(value);
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1).trimEnd()}...`;
};

export const formatAvailableSkills = (skills: ResolvedSkillSummary[] = []) => {
  if (skills.length === 0) return undefined;

  const visible = skills.slice(0, maxAvailableSkills);
  const omitted = skills.length - visible.length;
  const rows = visible.map((skill) => {
    const detail = [
      skill.source,
      skill.path,
    ].filter(Boolean).join(', ');
    const description = skill.description ? `: ${truncateText(skill.description, maxSkillDescriptionLength)}` : '';
    return `- ${skill.name} (${detail})${description}`;
  });

  return renderTemplate(availableSkillsTemplate, {
    skills: rows.join('\n'),
    omitted: omitted > 0 ? `- ${omitted} more skill(s) are available. Use search_skills to find them.` : '',
  });
};

const systemMessageText = (system: SystemMessage): string => {
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system.map((item) => systemMessageText(item as SystemMessage)).filter(Boolean).join('\n\n');
  }
  return system.content;
};

const resolveTimeZone = (timeZone?: string) => {
  const candidate = timeZone?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format(new Date(0));
    return candidate;
  } catch {
    return 'UTC';
  }
};

const dateTimeParts = (now: Date, timeZone: string) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';

  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    weekday: value('weekday'),
    hour: value('hour'),
    minute: value('minute'),
  };
};

export const formatRuntimeContext = ({ now = new Date(), timeZone }: ChatRuntimeContext = {}) => {
  const resolvedTimeZone = resolveTimeZone(timeZone);
  const parts = dateTimeParts(now, resolvedTimeZone);

  return renderTemplate(runtimeContextTemplate, {
    date: `${parts.year}-${parts.month}-${parts.day}${parts.weekday ? ` (${parts.weekday})` : ''}`,
    time: `${parts.hour}:${parts.minute}`,
    timezone: resolvedTimeZone,
  });
};

export const buildChatSystemMessages = ({
  includeGitInstructions,
  includeNotesInstructions,
  agentFiles,
  skillSummaries,
  projectInstructions,
  callerSystem,
}: {
  includeGitInstructions: boolean;
  includeNotesInstructions?: boolean;
  agentFiles?: ProjectAgentInstructions[];
  skillSummaries?: ResolvedSkillSummary[];
  projectInstructions?: ProjectAgentInstructions;
  callerSystem?: SystemMessage;
}): SystemMessage | undefined => {
  const blocks: string[] = [];

  if (includeGitInstructions) blocks.push(gitProjectCodingInstructions);
  if (includeNotesInstructions) blocks.push(notesProjectVaultInstructions);

  for (const file of agentFiles ?? []) {
    if (file.content.trim()) {
      blocks.push(formatProjectContextFile(file.path || 'AGENTS.md', file.content.slice(0, 32_000)));
    }
  }

  if (projectInstructions?.content.trim()) {
    blocks.push(
      formatProjectContextFile(projectInstructions.path || 'AGENTS.md', projectInstructions.content.slice(0, 32_000)),
    );
  }

  const availableSkills = formatAvailableSkills(skillSummaries);
  if (availableSkills) blocks.push(availableSkills);

  if (callerSystem) blocks.push(systemMessageText(callerSystem));

  const system = blocks.filter(Boolean).join('\n\n');
  return system || undefined;
};
