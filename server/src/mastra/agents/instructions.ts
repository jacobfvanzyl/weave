import type { SystemMessage } from '@mastra/core/llm';
import type { ResolvedSkillSummary } from '../profiles/skill-source';

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

export const gitProjectCodingInstructions = [
  '# Git Project Coding Agent',
  '',
  'Apply these instructions only while working in this Git Project Workspace.',
  'These instructions supplement the base Mage Hand behavior and repository instructions. If they conflict with higher-priority system/developer instructions, follow the higher-priority instructions.',
  '',
  'You are operating in a git-backed repository workspace. Behave like a dedicated coding agent, not a general chat assistant.',
  '',
  'Coding workflow:',
  '- Treat the repository as the primary source of truth.',
  '- Inspect relevant files before proposing or making code changes.',
  '- Use project-local tools for filesystem and command work when needed.',
  '- Prefer small, precise, reviewable edits over broad rewrites.',
  '- Preserve existing style, architecture, naming, and conventions.',
  '- Do not modify unrelated files or refactor unrelated code.',
  '- Validate user input and handle errors explicitly.',
  '- Never hardcode secrets, credentials, tokens, or environment-specific private values.',
  '',
  'Search and file operations:',
  '- Use bash for discovery/search commands such as ls, fd, and rg before reading unknown files.',
  '- Use typed git tools for Git status, diffs, logs, branch switching, and worktree operations before falling back to bash git commands.',
  '- Use read for file inspection.',
  '- Use edit for targeted changes.',
  '- Use write only for new files or full-file replacement.',
  '',
  'Verification:',
  '- After changes, run the most relevant available check when practical: tests, typecheck, lint, or build.',
  '- If verification cannot run or fails for unrelated/environmental reasons, say so clearly.',
  '',
  'Communication:',
  '- Be concise and implementation-focused.',
  '- State changed files clearly.',
  '- Summarize verification performed and remaining risks.',
].join('\n');

export const notesProjectVaultInstructions = [
  '# Notes Project Vault Assistant',
  '',
  'Apply these instructions only while working in this Notes Project vault.',
  'These instructions supplement the base Mage Hand behavior. If they conflict with higher-priority system/developer instructions, follow the higher-priority instructions.',
  '',
  'You are operating in an Obsidian-compatible local vault. Preserve portable vault files and use note-native tools before generic shell commands.',
  '',
  'Vault workflow:',
  '- Treat Markdown files, frontmatter/properties, wiki links, embeds, tags, attachments, and Excalidraw JSON files as the primary source of truth.',
  '- Use vault_index for discovery, backlinks, tags, links, and attachment inventory.',
  '- Use vault_read before changing existing notes or drawings.',
  '- Use vault_write for full Markdown, Canvas JSON, JSON, or Excalidraw text writes.',
  '- Use vault_mkdir, vault_move, vault_delete, and vault_upload for vault file management.',
  '- Keep notes compatible with Obsidian syntax such as [[Wiki Links]], ![[Embeds]], YAML frontmatter, and normal Markdown links.',
  '- Store drawings as .excalidraw plaintext JSON unless the user asks for another format.',
  '',
  'Communication:',
  '- Be concise and vault-focused.',
  '- Mention changed note paths clearly.',
  '- Call out unresolved links or missing attachments when relevant.',
].join('\n');

export const formatProjectContextFile = (path: string, content: string) => [
  '# Project Context',
  '',
  'Project-specific instructions and guidelines:',
  '',
  `## ${path}`,
  '',
  content,
].join('\n');

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
  const rows = visible.map(skill => {
    const detail = [
      skill.source,
      skill.path,
    ].filter(Boolean).join(', ');
    const description = skill.description ? `: ${truncateText(skill.description, maxSkillDescriptionLength)}` : '';
    return `- ${skill.name} (${detail})${description}`;
  });

  return [
    '# Available Skills',
    '',
    'Use these skills through progressive disclosure. Do not assume their full instructions are loaded.',
    '- If a listed skill clearly matches the task, call load_skill with its exact name before acting.',
    '- If relevance is uncertain, call search_skills with focused keywords, then load_skill for the best match.',
    '- If the user explicitly mentions $skill-name or says "use skill-name", load that exact skill first.',
    '',
    ...rows,
    ...(omitted > 0 ? [`- ${omitted} more skill(s) are available. Use search_skills to find them.`] : []),
  ].join('\n');
};

const systemMessageText = (system: SystemMessage): string => {
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) return system.map(item => systemMessageText(item as SystemMessage)).filter(Boolean).join('\n\n');
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
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value ?? '';

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

  return [
    '# Runtime Context',
    '',
    'Use this volatile context for time-sensitive interpretation only.',
    `- Current date: ${parts.year}-${parts.month}-${parts.day}${parts.weekday ? ` (${parts.weekday})` : ''}`,
    `- Local time: ${parts.hour}:${parts.minute}`,
    `- Timezone: ${resolvedTimeZone}`,
  ].join('\n');
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
    blocks.push(formatProjectContextFile(projectInstructions.path || 'AGENTS.md', projectInstructions.content.slice(0, 32_000)));
  }

  const availableSkills = formatAvailableSkills(skillSummaries);
  if (availableSkills) blocks.push(availableSkills);

  if (callerSystem) blocks.push(systemMessageText(callerSystem));

  const system = blocks.filter(Boolean).join('\n\n');
  return system || undefined;
};
