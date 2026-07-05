import type { JsonValue } from '../services/types';
import { type WorkflowRunInput } from './definition';
import { executeWorkflowDefinition, type WorkflowStepRunner } from './runner';
import { type WorkflowServiceRuntime, workflowServiceRuntime } from './service-runtime';

export const weaveDbosWorkflowName = 'weave.workflow.run';

export type DbosRuntimeConfig = {
  name: string;
  systemDatabaseUrl: string;
};

export type DbosWorkflowConfig = {
  name: string;
};

export type DbosStepConfig = {
  name: string;
};

export type WeaveDbosWorkflow = (input: WorkflowRunInput) => Promise<JsonValue>;

export type DbosAdapter = {
  setConfig(config: DbosRuntimeConfig): void;
  registerWorkflow(fn: WeaveDbosWorkflow, config: DbosWorkflowConfig): WeaveDbosWorkflow;
  runStep<T>(operation: () => Promise<T>, config: DbosStepConfig): Promise<T>;
  launch(): Promise<void>;
};

export type DbosWorkflowRuntimeLaunchResult =
  | { enabled: false; launched: false }
  | { enabled: true; launched: true; workflowName: string; workflow: WeaveDbosWorkflow };

export type DbosWorkflowRuntimeOptions = {
  env?: Record<string, string | undefined>;
  adapter?: DbosAdapter;
  loadAdapter?: () => Promise<DbosAdapter>;
  runtime?: WorkflowServiceRuntime;
};

let defaultLaunch: DbosWorkflowRuntimeLaunchResult | undefined;

export const maybeLaunchDbosWorkflowRuntime = async (
  options: DbosWorkflowRuntimeOptions = {},
): Promise<DbosWorkflowRuntimeLaunchResult> => {
  const env = options.env ?? process.env;
  if (env.WEAVE_DBOS_ENABLED !== '1') return { enabled: false, launched: false };

  const systemDatabaseUrl = env.DBOS_SYSTEM_DATABASE_URL?.trim();
  if (!systemDatabaseUrl) {
    throw new Error('WEAVE_DBOS_ENABLED=1 requires DBOS_SYSTEM_DATABASE_URL for the DBOS system database.');
  }

  const usesDefaultRuntime = !options.adapter && !options.loadAdapter && !options.runtime;
  if (usesDefaultRuntime && defaultLaunch?.enabled) return defaultLaunch;

  const adapter = options.adapter ?? await (options.loadAdapter ?? loadDefaultDbosAdapter)();
  adapter.setConfig({
    name: env.WEAVE_DBOS_APP_NAME?.trim() || 'weave-workflows',
    systemDatabaseUrl,
  });
  const workflow = registerWeaveDbosWorkflow(adapter, options.runtime ?? workflowServiceRuntime);
  await adapter.launch();

  const result = { enabled: true, launched: true, workflowName: weaveDbosWorkflowName, workflow } as const;
  if (usesDefaultRuntime) defaultLaunch = result;
  return result;
};

export const registerWeaveDbosWorkflow = (
  adapter: DbosAdapter,
  runtime: WorkflowServiceRuntime = workflowServiceRuntime,
) => {
  const stepRunner: WorkflowStepRunner = (name, operation) => adapter.runStep(operation, { name });
  return adapter.registerWorkflow(
    (input) => executeWorkflowDefinition(input, { runtime, runStep: stepRunner }),
    { name: weaveDbosWorkflowName },
  );
};

export const resetDbosWorkflowRuntimeForTests = () => {
  defaultLaunch = undefined;
};

const loadDefaultDbosAdapter = async (): Promise<DbosAdapter> => {
  const { DBOS } = await import('@dbos-inc/dbos-sdk');
  return DBOS as unknown as DbosAdapter;
};
