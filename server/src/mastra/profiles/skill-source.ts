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

type RegisteredProfileSkills = {
  roots: string[];
  skillsByName: Map<string, string>;
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

let sourceSkillIndex: Map<string, string> | undefined;

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

const scanSourceSkills = () => {
  if (sourceSkillIndex) return sourceSkillIndex;

  const byName = new Map<string, string>();
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
      if (name && skillPath) byName.set(name, skillPath);
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
  registry.skillsByName.set(skillName, skillDir);
};

const addSnapshotSkills = (
  registry: RegisteredProfileSkills,
  root: string,
  files: WeaveContextFile[] | undefined,
) => {
  const skillFiles = files?.filter(file => file.kind === 'skill') ?? [];
  if (skillFiles.length === 0) return;
  registry.roots.push(root);
  for (const file of skillFiles) addVirtualSkill(registry, root, file);
};

const isSkillPath = (name: string) => name.includes('/');

const combinedSkillsByName = (registry: RegisteredProfileSkills) => {
  const byName = new Map(scanSourceSkills());
  for (const [name, path] of registry.skillsByName) byName.set(name, path);
  return byName;
};

const resolveRequestedSkillPaths = (registry: RegisteredProfileSkills, requestedSkills: string[]) => {
  const byName = combinedSkillsByName(registry);
  if (requestedSkills.includes('*') || requestedSkills.includes('all')) {
    return [...byName.values()];
  }

  const paths: string[] = [];
  const addPath = (path: string) => {
    if (!paths.includes(path)) paths.push(path);
  };

  for (const name of requestedSkills) {
    if (isSkillPath(name)) addPath(name);

    const resolvedPath = byName.get(name);
    if (resolvedPath) addPath(resolvedPath);
  }

  return paths;
};

export const __profileSkillSourceTest = {
  skillNameFromContent,
};

export const registerResolvedProfileSkills = (resolved: ResolvedProfileContext) => {
  const registryId = createRegistryId();
  const root = `${virtualSkillRoot}/${registryId}`;
  const registry: RegisteredProfileSkills = {
    roots: [],
    skillsByName: new Map(),
    files: new Map(),
  };

  addSnapshotSkills(registry, `${root}/global`, resolved.globalSnapshot?.files);
  addSnapshotSkills(registry, `${root}/project`, resolved.projectSnapshot?.files);

  registries.set(registryId, registry);
  return resolveRequestedSkillPaths(registry, resolved.profile.skills);
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
