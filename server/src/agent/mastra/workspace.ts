import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Workspace, LocalSkillSource } from '@mastra/core/workspace';
import { ContextSkillSource } from './context/skill-source';
import { contextSkillPathsRequestContextKey } from './context/resolver';

const findProjectRoot = (startPath: string) => {
  let currentPath = startPath;
  let packageRoot = startPath;

  while (dirname(currentPath) !== currentPath) {
    if (existsSync(join(currentPath, 'server/package.json')) && existsSync(join(currentPath, 'packages')) && existsSync(join(currentPath, 'portal'))) {
      return currentPath;
    }

    if (existsSync(join(currentPath, 'package.json'))) packageRoot = currentPath;
    currentPath = dirname(currentPath);
  }

  return packageRoot;
};

const projectRoot = findProjectRoot(process.cwd());
const skillSource = new ContextSkillSource(new LocalSkillSource({ basePath: projectRoot }));
const checkSkillFileMtime = process.env.NODE_ENV !== 'production';
const resolveSkillPaths = ({ requestContext }: { requestContext?: any }) => {
  const paths = requestContext?.get?.(contextSkillPathsRequestContextKey);
  return Array.isArray(paths) ? paths.filter((path): path is string => typeof path === 'string') : [];
};

export const baseWorkspace = new Workspace({
  skills: resolveSkillPaths,
  skillSource,
  bm25: true,
  checkSkillFileMtime,
});

export const gitProjectWorkspace = new Workspace({
  skills: resolveSkillPaths,
  skillSource,
  bm25: true,
  checkSkillFileMtime,
});

export const workspace = baseWorkspace;
