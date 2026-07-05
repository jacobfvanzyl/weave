import type { JsonValue } from '../services/types';
import { getDbosSystemDatabaseUrl } from '../storage/database-url';
import { type WorkflowRunInput } from './definition';
import { createWorkflowRunnerEventRecorder } from './events';
import { executeWorkflowDefinition, type WorkflowStepRunner } from './runner';
import type { WorkflowRunnerEventHandler } from './runner';
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

export type DbosStartWorkflowConfig = {
  workflowID: string;
  workflowAttributes?: Record<string, unknown>;
};

export type DbosWorkflowHandle = {
  workflowID: string;
  getResult(): Promise<JsonValue>;
};

export type DbosWorkflowStatus = {
  workflowID: string;
  status: string;
  output?: unknown;
  error?: unknown;
  createdAt?: number;
  updatedAt?: number;
  completedAt?: number;
};

export type DbosAdapter = {
  setConfig(config: DbosRuntimeConfig): void;
  registerWorkflow(fn: WeaveDbosWorkflow, config: DbosWorkflowConfig): WeaveDbosWorkflow;
  runStep<T>(operation: () => Promise<T>, config: DbosStepConfig): Promise<T>;
  startWorkflow?(
    workflow: WeaveDbosWorkflow,
    config: DbosStartWorkflowConfig,
  ): (input: WorkflowRunInput) => Promise<DbosWorkflowHandle>;
  getWorkflowStatus?(workflowID: string): Promise<DbosWorkflowStatus | null>;
  cancelWorkflow?(workflowID: string, options?: { cancelChildren?: boolean }): Promise<void>;
  launch(): Promise<void>;
};

export type DbosWorkflowRuntimeLaunchResult =
  | { enabled: false; launched: false }
  | {
    enabled: true;
    launched: true;
    workflowName: string;
    workflow: WeaveDbosWorkflow;
    adapter: DbosAdapter;
  };

export type DbosWorkflowRuntimeOptions = {
  env?: Record<string, string | undefined>;
  adapter?: DbosAdapter;
  loadAdapter?: () => Promise<DbosAdapter>;
  runtime?: WorkflowServiceRuntime;
  createRunnerEventHandler?: (input: WorkflowRunInput) => WorkflowRunnerEventHandler | undefined;
};

let defaultLaunch: DbosWorkflowRuntimeLaunchResult | undefined;

export const maybeLaunchDbosWorkflowRuntime = async (
  options: DbosWorkflowRuntimeOptions = {},
): Promise<DbosWorkflowRuntimeLaunchResult> => {
  const env = options.env ?? process.env;
  if (env.WEAVE_DBOS_ENABLED !== '1') return { enabled: false, launched: false };

  const systemDatabaseUrl = getDbosSystemDatabaseUrl(env);
  if (!systemDatabaseUrl) {
    throw new Error('WEAVE_DBOS_ENABLED=1 requires WEAVE_DATABASE_URL or DBOS_SYSTEM_DATABASE_URL for the DBOS system database.');
  }

  const usesDefaultRuntime = !options.adapter && !options.loadAdapter && !options.runtime;
  if (usesDefaultRuntime && defaultLaunch?.enabled) return defaultLaunch;

  const adapter = options.adapter ?? await (options.loadAdapter ?? loadDefaultDbosAdapter)();
  adapter.setConfig({
    name: env.WEAVE_DBOS_APP_NAME?.trim() || 'weave-workflows',
    systemDatabaseUrl,
  });
  const workflow = registerWeaveDbosWorkflow(
    adapter,
    options.runtime ?? workflowServiceRuntime,
    options.createRunnerEventHandler,
  );
  await adapter.launch();

  const result = { enabled: true, launched: true, workflowName: weaveDbosWorkflowName, workflow, adapter } as const;
  if (usesDefaultRuntime) defaultLaunch = result;
  return result;
};

export const registerWeaveDbosWorkflow = (
  adapter: DbosAdapter,
  runtime: WorkflowServiceRuntime = workflowServiceRuntime,
  createRunnerEventHandler: (input: WorkflowRunInput) => WorkflowRunnerEventHandler | undefined =
    createWorkflowRunnerEventRecorder,
) => {
  const stepRunner: WorkflowStepRunner = (name, operation) => adapter.runStep(operation, { name });
  return adapter.registerWorkflow(
    (input) =>
      executeWorkflowDefinition(input, {
        runtime,
        runStep: stepRunner,
        onEvent: createRunnerEventHandler(input),
      }),
    { name: weaveDbosWorkflowName },
  );
};

export const resetDbosWorkflowRuntimeForTests = () => {
  defaultLaunch = undefined;
};

export const startDbosWorkflowExecution = async (
  input: WorkflowRunInput,
  options: DbosWorkflowRuntimeOptions = {},
) => {
  const launch = await maybeLaunchDbosWorkflowRuntime(options);
  if (!launch.enabled) return undefined;
  if (!launch.adapter.startWorkflow) throw new Error('DBOS adapter does not support startWorkflow.');

  const handle = await launch.adapter.startWorkflow(launch.workflow, {
    workflowID: input.workflowRunId,
    workflowAttributes: {
      source: 'weave',
      ownerId: input.ownerId,
      workflowId: input.definition.id,
      workflowVersion: input.definition.version,
    },
  })(input);

  return {
    workflowID: handle.workflowID,
    result: handle.getResult(),
  };
};

export const getDbosWorkflowStatus = async (
  workflowID: string,
  options: DbosWorkflowRuntimeOptions = {},
) => {
  const launch = await maybeLaunchDbosWorkflowRuntime(options);
  if (!launch.enabled || !launch.adapter.getWorkflowStatus) return undefined;
  return launch.adapter.getWorkflowStatus(workflowID);
};

export const cancelDbosWorkflowExecution = async (
  workflowID: string,
  options: DbosWorkflowRuntimeOptions = {},
) => {
  const launch = await maybeLaunchDbosWorkflowRuntime(options);
  if (!launch.enabled || !launch.adapter.cancelWorkflow) return false;
  await launch.adapter.cancelWorkflow(workflowID, { cancelChildren: true });
  return true;
};

const loadDefaultDbosAdapter = async (): Promise<DbosAdapter> => {
  const { DBOS } = await import('@dbos-inc/dbos-sdk');
  return DBOS as unknown as DbosAdapter;
};
