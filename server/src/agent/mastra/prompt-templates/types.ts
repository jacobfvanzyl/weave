export type PromptTemplate = {
  name: string;
  command: string;
  description: string;
  argumentHint?: string;
  tags: string[];
  content: string;
  source: 'app' | 'user' | 'project';
  path?: string;
};

export type PromptSummary = Omit<PromptTemplate, 'content'>;
