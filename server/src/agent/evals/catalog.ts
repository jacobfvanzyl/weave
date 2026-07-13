import { parse as parseYaml } from 'yaml';
import { type EvalCatalogV1, evalCatalogV1Schema, type EvalTrialV1, evalTrialV1Schema } from './schema.ts';

export const loadEvalCatalog = async (path: string): Promise<EvalCatalogV1> => {
  const text = await Deno.readTextFile(path);
  const value = path.endsWith('.yaml') || path.endsWith('.yml') ? parseYaml(text) : JSON.parse(text);
  return evalCatalogV1Schema.parse(value);
};

export const loadEvalTrials = async (path: string): Promise<EvalTrialV1[]> => {
  const text = await Deno.readTextFile(path);
  const values = path.endsWith('.jsonl')
    ? text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
    : JSON.parse(text);
  if (!Array.isArray(values)) throw new Error('Evaluation result file must contain an array or JSONL records.');
  return values.map((value) => evalTrialV1Schema.parse(value));
};
