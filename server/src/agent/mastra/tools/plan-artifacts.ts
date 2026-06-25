import { parseDocument, stringify } from 'yaml';
import { z } from 'zod';
import { hashText } from './model-output';

export const planArtifactVersion = 1;
export const planDirectory = '.agents/plans';

export const planStatusSchema = z.enum(['pending', 'in_progress', 'completed', 'blocked']);
export const overallPlanStatusSchema = z.enum(['pending', 'in_progress', 'completed', 'blocked']);

export const planChecklistItemSchema = z.object({
  id: z.string().min(1).max(80),
  text: z.string().min(1).max(240),
  status: planStatusSchema,
}).strict();

export const planFrontmatterSchema = z.object({
  weave_plan_version: z.literal(planArtifactVersion),
  id: z.string().min(1).max(80),
  title: z.string().min(1).max(160),
  status: overallPlanStatusSchema,
  scope: z.literal('git'),
  shared: z.boolean(),
  thread_ids: z.array(z.string().min(1)).default([]),
  path: z.string().min(1),
  updated_at: z.string().min(1),
  checklist: z.array(planChecklistItemSchema).min(1).max(80),
}).strict().refine(
  value => value.checklist.filter(item => item.status === 'in_progress').length <= 1,
  { message: 'At most one checklist item can be in_progress', path: ['checklist'] },
);

export type PlanStatus = z.infer<typeof planStatusSchema>;
export type PlanFrontmatter = z.infer<typeof planFrontmatterSchema>;
export type PlanChecklistItem = z.infer<typeof planChecklistItemSchema>;

export type PlanSectionKey =
  | 'purpose'
  | 'progress'
  | 'surprises'
  | 'decisions'
  | 'outcomes'
  | 'context'
  | 'requirements'
  | 'nonGoals'
  | 'assumptions'
  | 'planOfWork'
  | 'concreteSteps'
  | 'validation'
  | 'idempotence'
  | 'artifacts'
  | 'interfaces';

export type PlanSections = Partial<Record<PlanSectionKey, string>>;

export const planSectionTitles: Array<[PlanSectionKey, string]> = [
  ['purpose', 'Purpose / Big Picture'],
  ['progress', 'Progress'],
  ['surprises', 'Surprises & Discoveries'],
  ['decisions', 'Decision Log'],
  ['outcomes', 'Outcomes & Retrospective'],
  ['context', 'Context and Orientation'],
  ['requirements', 'Requirements'],
  ['nonGoals', 'Non-goals'],
  ['assumptions', 'Assumptions'],
  ['planOfWork', 'Plan of Work'],
  ['concreteSteps', 'Concrete Steps'],
  ['validation', 'Validation and Acceptance'],
  ['idempotence', 'Idempotence and Recovery'],
  ['artifacts', 'Artifacts and Notes'],
  ['interfaces', 'Interfaces and Dependencies'],
];

const titleToSectionKey = new Map(planSectionTitles.map(([key, title]) => [title.toLowerCase(), key]));

const dockerAdjectives = [
  'bright',
  'calm',
  'clever',
  'crisp',
  'direct',
  'eager',
  'fair',
  'fresh',
  'kind',
  'lucid',
  'nimble',
  'quiet',
  'rapid',
  'steady',
  'tidy',
  'vivid',
];

const dockerNouns = [
  'anchor',
  'bridge',
  'compass',
  'delta',
  'harbor',
  'lantern',
  'maple',
  'matrix',
  'orbit',
  'river',
  'signal',
  'summit',
  'vector',
  'vista',
  'wave',
  'workshop',
];

export const slugifyPlanId = (value: string, fallback = 'plan') => {
  const slug = value
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .toLowerCase()
    .replace(/_/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return slug || fallback;
};

export const dockerStylePlanName = (random: () => number = Math.random) => {
  const adjective = dockerAdjectives[Math.floor(random() * dockerAdjectives.length)] ?? dockerAdjectives[0];
  const noun = dockerNouns[Math.floor(random() * dockerNouns.length)] ?? dockerNouns[0];
  return `${adjective}-${noun}`;
};

export const resolveUniquePlanPath = async (
  exists: (path: string) => boolean | Promise<boolean>,
  random: () => number = Math.random,
) => {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const path = planPathForName(dockerStylePlanName(random));
    if (!await exists(path)) return path;
  }

  for (let suffix = 1; suffix < 10_000; suffix += 1) {
    const path = planPathForName(`${dockerStylePlanName(random)}-${suffix.toString(36)}`);
    if (!await exists(path)) return path;
  }

  throw new Error('Unable to allocate a unique plan artifact path');
};

export const validatePlanPath = (value: string) => {
  const path = value.trim();
  if (!/^\.agents\/plans\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.md$/.test(path)) {
    throw new Error('planPath must match .agents/plans/<lowercase-docker-style-name>.md');
  }
  if (path.includes('..') || path.includes('\\') || path.includes('//')) {
    throw new Error('planPath cannot contain traversal or path separator escapes');
  }
  return path;
};

export const planPathForName = (name: string) => validatePlanPath(`${planDirectory}/${slugifyPlanId(name)}.md`);

export const normalizeChecklist = (items: Array<{ id?: string; text: string; status?: PlanStatus }>) => {
  const seen = new Map<string, number>();
  return items.map((item, index) => {
    const baseId = slugifyPlanId(item.id ?? item.text, `step-${index + 1}`).slice(0, 72);
    const count = seen.get(baseId) ?? 0;
    seen.set(baseId, count + 1);
    return {
      id: count === 0 ? baseId : `${baseId}-${count + 1}`,
      text: item.text.trim(),
      status: item.status ?? 'pending',
    };
  });
};

const checkboxForStatus = (status: PlanStatus) => status === 'completed' ? 'x' : ' ';

const progressLine = (item: PlanChecklistItem) => {
  const suffix = item.status === 'blocked' ? ' (blocked)' : item.status === 'in_progress' ? ' (in progress)' : '';
  return `- [${checkboxForStatus(item.status)}] ${item.text}${suffix}`;
};

const stripRenderedProgress = (value: string | undefined) => {
  if (!value) return '';
  const lines = value.split('\n');
  let index = 0;
  while (index < lines.length && (/^\s*$/.test(lines[index]) || /^- \[[ xX]\] /.test(lines[index]))) {
    index += 1;
  }
  return lines.slice(index).join('\n').trim();
};

const emptySection = (key: PlanSectionKey) => {
  if (key === 'progress') return '';
  if (key === 'surprises' || key === 'decisions' || key === 'outcomes' || key === 'artifacts') return '- None yet.';
  return 'TBD.';
};

const renderSectionBody = (key: PlanSectionKey, frontmatter: PlanFrontmatter, sections: PlanSections) => {
  const body = sections[key]?.trim();
  if (key !== 'progress') return body || emptySection(key);

  const generated = frontmatter.checklist.map(progressLine).join('\n');
  const notes = stripRenderedProgress(body);
  return notes ? `${generated}\n\n${notes}` : generated;
};

export const renderPlanArtifact = (frontmatter: PlanFrontmatter, sections: PlanSections = {}) => {
  const normalized = planFrontmatterSchema.parse(frontmatter);
  const yaml = stringify(normalized, { lineWidth: 0 }).trim();
  const body = [
    `# ${normalized.title}`,
    '',
    ...planSectionTitles.flatMap(([key, title]) => [
      `## ${title}`,
      '',
      renderSectionBody(key, normalized, sections),
      '',
    ]),
  ].join('\n').replace(/\n{3,}/g, '\n\n').trim();

  return `---\n${yaml}\n---\n\n${body}\n`;
};

const splitFrontmatter = (raw: string) => {
  if (!raw.startsWith('---\n')) throw new Error('Plan artifact must start with YAML frontmatter');
  const end = raw.indexOf('\n---', 4);
  if (end === -1) throw new Error('Plan artifact frontmatter is not closed');
  const contentStart = raw.indexOf('\n', end + 4);
  return {
    yaml: raw.slice(4, end),
    body: contentStart === -1 ? '' : raw.slice(contentStart + 1),
  };
};

export const parsePlanSections = (body: string): PlanSections => {
  const sections: PlanSections = {};
  const lines = body.split('\n');
  let current: PlanSectionKey | undefined;
  let buffer: string[] = [];

  const flush = () => {
    if (current) sections[current] = buffer.join('\n').trim();
    buffer = [];
  };

  for (const line of lines) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flush();
      current = titleToSectionKey.get(heading[1].toLowerCase());
      continue;
    }
    if (current) buffer.push(line);
  }
  flush();

  return sections;
};

export const parsePlanArtifact = (raw: string) => {
  const { yaml, body } = splitFrontmatter(raw);
  const document = parseDocument(yaml);
  if (document.errors.length) {
    throw new Error(`Plan artifact frontmatter is invalid YAML: ${document.errors[0].message}`);
  }
  const frontmatter = planFrontmatterSchema.parse(document.toJS());
  return { frontmatter, sections: parsePlanSections(body), body };
};

export const planSnapshotFromFrontmatter = (frontmatter: PlanFrontmatter, content: string) => {
  const completed = frontmatter.checklist.filter(item => item.status === 'completed').length;
  return {
    version: frontmatter.weave_plan_version,
    id: frontmatter.id,
    title: frontmatter.title,
    path: frontmatter.path,
    status: frontmatter.status,
    checklist: frontmatter.checklist,
    completed,
    total: frontmatter.checklist.length,
    updatedAt: frontmatter.updated_at,
    contentHash: hashText(content),
  };
};

export type PlanSnapshot = ReturnType<typeof planSnapshotFromFrontmatter>;

const appendEntries = (existing: string | undefined, entries: string[] | undefined, timestamp: string, prefix = '') => {
  const cleanEntries = (entries ?? []).map(item => item.trim()).filter(Boolean);
  if (cleanEntries.length === 0) return existing;
  const addition = cleanEntries.map(item => `- ${timestamp}: ${prefix}${item}`).join('\n');
  const base = existing?.trim();
  if (!base || base === '- None yet.' || base === 'TBD.') return addition;
  return `${base}\n${addition}`;
};

export const applyPlanSectionUpdates = (sections: PlanSections, updates: {
  progress?: string[];
  surprises?: string[];
  decisions?: string[];
  validation?: string[];
  blockers?: string[];
  outcomes?: string[];
  artifacts?: string[];
}, timestamp: string): PlanSections => ({
  ...sections,
  progress: appendEntries(sections.progress, updates.progress, timestamp),
  surprises: appendEntries(
    appendEntries(sections.surprises, updates.surprises, timestamp),
    updates.blockers,
    timestamp,
    'Blocked: ',
  ),
  decisions: appendEntries(sections.decisions, updates.decisions, timestamp),
  validation: appendEntries(sections.validation, updates.validation, timestamp),
  outcomes: appendEntries(sections.outcomes, updates.outcomes, timestamp),
  artifacts: appendEntries(sections.artifacts, updates.artifacts, timestamp),
});

export const applyChecklistUpdates = (
  checklist: PlanChecklistItem[],
  updates: Array<{ id: string; status: PlanStatus; text?: string }> | undefined,
) => {
  if (!updates?.length) return checklist;
  const byId = new Map(checklist.map(item => [item.id, item]));

  for (const update of updates) {
    if (!byId.has(update.id)) throw new Error(`Unknown checklist id: ${update.id}`);
  }

  const next = checklist.map(item => {
    const update = updates.find(candidate => candidate.id === item.id);
    return update ? { ...item, status: update.status, ...(update.text ? { text: update.text.trim() } : {}) } : item;
  });

  if (next.filter(item => item.status === 'in_progress').length > 1) {
    throw new Error('At most one checklist item can be in_progress');
  }

  return next;
};

export const __planArtifactTest = {
  applyChecklistUpdates,
  applyPlanSectionUpdates,
  dockerStylePlanName,
  normalizeChecklist,
  parsePlanArtifact,
  planPathForName,
  renderPlanArtifact,
  resolveUniquePlanPath,
  validatePlanPath,
};
