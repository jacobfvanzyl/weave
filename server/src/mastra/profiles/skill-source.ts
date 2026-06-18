import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname as pathDirname, join, relative } from 'node:path';
import { LocalSkillSource, type SkillSource, type SkillSourceEntry, type SkillSourceStat } from '@mastra/core/workspace';
import { parseFrontmatter } from '../prompt-templates/frontmatter';
import type { ResolvedProfileContext, WeaveContextFile } from './resolver';

const virtualSkillRoot = '__weave_profile_skills__';

type VirtualSkillFile = {
  path: string;
  content: string;
  size: number;
  modifiedAt: Date;
};

export type ResolvedSkillSummary = {
  name: string;
  source: 'source' | 'global' | 'project';
  path: string;
  description?: string;
};

type RegisteredSkill = ResolvedSkillSummary & {
  workspacePath: string;
};

type RegisteredProfileSkills = {
  id: string;
  roots: string[];
  skillsByName: Map<string, RegisteredSkill>;
  files: Map<string, VirtualSkillFile>;
};

const registries = new Map<string, RegisteredProfileSkills>();

const trimSlashes = (value: string) => value.replace(/^\/+|\/+$/g, '');
const basename = (value: string) => trimSlashes(value).split('/').filter(Boolean).pop() ?? '';

const isVirtualPath = (value: string) => trimSlashes(value).startsWith(virtualSkillRoot);

const findProjectRoot = (startPath: string) => {
  let currentPath = startPath;
  let packageRoot = startPath;

  while (pathDirname(currentPath) !== currentPath) {
    if (existsSync(join(currentPath, 'server/package.json')) && existsSync(join(currentPath, 'packages')) && existsSync(join(currentPath, 'portal'))) {
      return currentPath;
    }

    if (existsSync(join(currentPath, 'package.json'))) packageRoot = currentPath;
    currentPath = pathDirname(currentPath);
  }

  return packageRoot;
};

const projectRoot = findProjectRoot(process.cwd());
const sourceSkillsRoot = join(projectRoot, 'skills');

let sourceSkillIndex: Map<string, RegisteredSkill> | undefined;

const skillNameFromPath = (path: string) => {
  const parts = trimSlashes(path).split('/');
  const skillIndex = parts.lastIndexOf('skills');
  if (skillIndex >= 0 && parts[skillIndex + 1]) return parts[skillIndex + 1];
  return parts.at(-2) ?? basename(path).replace(/\.md$/, '');
};

const skillNameFromContent = (content: string, path: string) => {
  const { data } = parseFrontmatter(content);
  return typeof data.name === 'string' && data.name.trim() ? data.name.trim() : skillNameFromPath(path);
};

const skillDescriptionFromContent = (content: string) => {
  const { data } = parseFrontmatter(content);
  return typeof data.description === 'string' && data.description.trim() ? data.description.trim() : undefined;
};

const scanSourceSkills = () => {
  if (sourceSkillIndex) return sourceSkillIndex;

  const byName = new Map<string, RegisteredSkill>();
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (!entry.isFile() || entry.name !== 'SKILL.md') continue;

      const content = readFileSync(path, 'utf8');
      const name = skillNameFromContent(content, path);
      const skillPath = trimSlashes(relative(projectRoot, pathDirname(path)));
      if (name && skillPath) {
        byName.set(name, {
          name,
          source: 'source',
          path: `${skillPath}/SKILL.md`,
          workspacePath: skillPath,
          description: skillDescriptionFromContent(content),
        });
      }
    }
  };

  if (existsSync(sourceSkillsRoot) && statSync(sourceSkillsRoot).isDirectory()) visit(sourceSkillsRoot);
  sourceSkillIndex = byName;
  return byName;
};

const createRegistryId = () => `${Date.now().toString(36)}_${crypto.randomUUID()}`;

const normalizeSkillPath = (path: string) => trimSlashes(path);

const addVirtualSkill = (
  registry: RegisteredProfileSkills,
  root: string,
  file: WeaveContextFile,
  source: 'global' | 'project',
) => {
  const skillName = skillNameFromContent(file.content, file.path);
  if (!skillName) return;

  const skillDir = `${root}/${skillName}`;
  const skillFile = `${skillDir}/SKILL.md`;
  const modifiedAt = file.updatedAt ? new Date(file.updatedAt) : new Date();

  registry.files.set(skillFile, {
    path: skillFile,
    content: file.content,
    size: typeof file.size === 'number' ? file.size : new TextEncoder().encode(file.content).byteLength,
    modifiedAt,
  });
  registry.skillsByName.set(skillName, {
    name: skillName,
    source,
    path: file.path,
    workspacePath: skillDir,
    description: skillDescriptionFromContent(file.content),
  });
};

const addSnapshotSkills = (
  registry: RegisteredProfileSkills,
  root: string,
  files: WeaveContextFile[] | undefined,
  source: 'global' | 'project',
) => {
  const skillFiles = files?.filter(file => file.kind === 'skill') ?? [];
  if (skillFiles.length === 0) return;
  registry.roots.push(root);
  for (const file of skillFiles) addVirtualSkill(registry, root, file, source);
};

const mergeSkillRecords = (...layers: RegisteredSkill[][]) => {
  const byName = new Map<string, RegisteredSkill>();
  for (const layer of layers) {
    for (const skill of layer) byName.set(skill.name, skill);
  }
  return byName;
};

const combinedSkillsByName = (registry: RegisteredProfileSkills) =>
  mergeSkillRecords([...scanSourceSkills().values()], [...registry.skillsByName.values()]);

export const __profileSkillSourceTest = {
  combinedSkillsByName,
  mergeSkillRecords,
  skillNameFromContent,
};

const createResolvedProfileSkillRegistry = (resolved: ResolvedProfileContext) => {
  const registryId = createRegistryId();
  const root = `${virtualSkillRoot}/${registryId}`;
  const registry: RegisteredProfileSkills = {
    id: registryId,
    roots: [],
    skillsByName: new Map(),
    files: new Map(),
  };

  addSnapshotSkills(registry, `${root}/global`, resolved.globalSnapshot?.files, 'global');
  addSnapshotSkills(registry, `${root}/project`, resolved.projectSnapshot?.files, 'project');

  return registry;
};

export const registerResolvedProfileSkills = (resolved: ResolvedProfileContext) => {
  const registry = createResolvedProfileSkillRegistry(resolved);

  registries.set(registry.id, registry);
  return [...combinedSkillsByName(registry).values()].map(skill => skill.workspacePath);
};

export const listResolvedProfileSkillSummaries = (resolved: ResolvedProfileContext): ResolvedSkillSummary[] => {
  const registry = createResolvedProfileSkillRegistry(resolved);
  return [...combinedSkillsByName(registry).values()].map(({ workspacePath: _workspacePath, ...summary }) => summary);
};

export class ProfileSkillSource implements SkillSource {
  constructor(private readonly localSkillSource: LocalSkillSource) {}

  private getVirtualFile(path: string) {
    const normalized = normalizeSkillPath(path);
    if (!isVirtualPath(normalized)) return undefined;

    for (const registry of registries.values()) {
      const file = registry.files.get(normalized);
      if (file) return file;
    }

    return undefined;
  }

  private getVirtualChildren(path: string) {
    const normalized = normalizeSkillPath(path);
    if (!isVirtualPath(normalized)) return [];

    const children = new Map<string, SkillSourceEntry>();
    for (const registry of registries.values()) {
      for (const filePath of registry.files.keys()) {
        if (filePath === normalized) continue;
        if (!filePath.startsWith(`${normalized}/`)) continue;

        const remainder = filePath.slice(normalized.length + 1);
        const childName = remainder.split('/')[0];
        children.set(childName, {
          name: childName,
          type: remainder.includes('/') ? 'directory' : 'file',
        });
      }
    }

    return [...children.values()];
  }

  async exists(path: string) {
    if (isVirtualPath(path)) {
      return Boolean(this.getVirtualFile(path) || this.getVirtualChildren(path).length > 0);
    }

    return this.localSkillSource.exists(path);
  }

  async stat(path: string): Promise<SkillSourceStat> {
    const file = this.getVirtualFile(path);
    if (file) {
      return {
        name: basename(file.path),
        type: 'file',
        size: file.size,
        createdAt: file.modifiedAt,
        modifiedAt: file.modifiedAt,
        mimeType: 'text/markdown',
      };
    }

    if (isVirtualPath(path) && this.getVirtualChildren(path).length > 0) {
      const modifiedAt = new Date();
      return {
        name: basename(path),
        type: 'directory',
        size: 0,
        createdAt: modifiedAt,
        modifiedAt,
      };
    }

    return this.localSkillSource.stat(path);
  }

  async readFile(path: string) {
    const file = this.getVirtualFile(path);
    if (file) return file.content;
    return this.localSkillSource.readFile(path);
  }

  async readdir(path: string) {
    if (isVirtualPath(path)) return this.getVirtualChildren(path);
    return this.localSkillSource.readdir(path);
  }

  async realpath(path: string) {
    if (isVirtualPath(path)) return normalizeSkillPath(path);
    return this.localSkillSource.realpath(path);
  }
}
