import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Workspace, LocalSkillSource } from '@mastra/core/workspace';

const findProjectRoot = (startPath: string) => {
  let currentPath = startPath;

  while (dirname(currentPath) !== currentPath) {
    if (existsSync(join(currentPath, 'package.json')) && existsSync(join(currentPath, 'skills'))) {
      return currentPath;
    }

    currentPath = dirname(currentPath);
  }

  return startPath;
};

const projectRoot = findProjectRoot(process.cwd());
const skillSource = new LocalSkillSource({ basePath: projectRoot });
const checkSkillFileMtime = process.env.NODE_ENV !== 'production';

export const baseWorkspace = new Workspace({
  skills: ['skills/base'],
  skillSource,
  bm25: true,
  checkSkillFileMtime,
});

export const gitDemiplaneWorkspace = new Workspace({
  skills: ['skills/base', 'skills/coding'],
  skillSource,
  bm25: true,
  checkSkillFileMtime,
});

export const workspace = baseWorkspace;
