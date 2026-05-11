export type PromptTemplate = {
  name: string;
  command: string;
  description: string;
  argumentHint?: string;
  tags: string[];
  content: string;
  source: 'app';
};

export type PromptSummary = Omit<PromptTemplate, 'content'>;
