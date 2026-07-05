import {
  type AgentRunRequest,
  type AgentRunSnapshot,
  type AgentService,
  agentService as defaultAgentService,
} from '../agent';
import type {
  AttachmentPayload,
  AttachmentReadResult,
  StoredAttachment,
  StoredAttachmentMetadata,
} from '../modules/attachments/storage';
import type { ServerNotificationInput, StoredNotificationEvent } from '../modules/notifications/types';
import {
  type EventService,
  internalServices,
  type ResourceService,
  type SessionService,
  type ToolService,
} from '../services';
import type { ServiceEvent } from '../services/event-service';
import type {
  JupyterSessionInput,
  LspSessionInput,
  TerminalSessionInput,
  WindowApplicationOpenInput,
  WindowSessionInput,
  WindowSessionToolInput,
  WorkspaceFileWatchSessionInput,
} from '../services/session-service';
import {
  callerForOwner,
  type JsonValue,
  requireServiceGrant,
  type ServiceCaller,
  type ServiceGrant,
  type ServiceOperationKind,
  serviceResourceScope,
  type ServiceScope,
  serviceScopeNone,
} from '../services/types';

export type WorkflowServiceContext = {
  ownerId: string;
  workflowRunId: string;
  requestId?: string;
  grants: ServiceGrant[];
};

export type WorkflowAgentRunInput = Omit<AgentRunRequest, 'caller'> & {
  grants?: ServiceGrant[];
};

export type WorkflowToolInput = {
  toolId: string;
  scope?: ServiceScope;
  input: unknown;
  timeoutMs?: number;
  grants?: ServiceGrant[];
};

export type WorkflowTerminalSessionInput = Omit<TerminalSessionInput, 'caller' | 'grants'> & {
  grants?: ServiceGrant[];
};

export type WorkflowLspSessionInput = Omit<LspSessionInput, 'caller' | 'grants'> & {
  grants?: ServiceGrant[];
};

export type WorkflowJupyterSessionInput = Omit<JupyterSessionInput, 'caller' | 'grants'> & {
  grants?: ServiceGrant[];
};

export type WorkflowWindowSessionToolInput = Omit<WindowSessionToolInput, 'caller' | 'grants'> & {
  grants?: ServiceGrant[];
};

export type WorkflowWindowApplicationOpenInput = Omit<WindowApplicationOpenInput, 'caller' | 'grants'> & {
  grants?: ServiceGrant[];
};

export type WorkflowWindowSessionInput = Omit<WindowSessionInput, 'caller' | 'grants'> & {
  grants?: ServiceGrant[];
};

export type WorkflowWorkspaceFileWatchSessionInput = Omit<WorkspaceFileWatchSessionInput, 'caller' | 'grants'> & {
  grants?: ServiceGrant[];
};

export type WorkflowEventInput = {
  stream: string;
  type: string;
  data: JsonValue;
  grants?: ServiceGrant[];
};

export type WorkflowRunEventInput = {
  runId?: string;
  type: string;
  data: JsonValue;
  grants?: ServiceGrant[];
};

export type WorkflowAuditEventInput = {
  scope?: string;
  type: string;
  data: JsonValue;
  grants?: ServiceGrant[];
};

export type WorkflowServiceRuntimeDeps = {
  agents?: AgentService;
  tools?: ToolService;
  sessions?: SessionService;
  resources?: ResourceService;
  events?: EventService;
};

export interface WorkflowServiceRuntime {
  caller(context: WorkflowServiceContext, correlation?: ServiceCaller['correlation']): ServiceCaller;
  listAgentCapabilities(context: WorkflowServiceContext): ReturnType<AgentService['listCapabilities']>;
  listAgentModels(context: WorkflowServiceContext): ReturnType<AgentService['listModels']>;
  startAgentRun(context: WorkflowServiceContext, input: WorkflowAgentRunInput): Promise<AgentRunSnapshot>;
  runAgentPrompt(context: WorkflowServiceContext, input: WorkflowAgentRunInput): Promise<JsonValue>;
  getAgentRun(context: WorkflowServiceContext, runId: string): Promise<AgentRunSnapshot | undefined>;
  streamAgentRun(context: WorkflowServiceContext, runId: string): ReadableStream<unknown>;
  cancelAgentRun(context: WorkflowServiceContext, runId: string): Promise<AgentRunSnapshot | undefined>;
  sendAgentSignal(
    context: WorkflowServiceContext,
    runId: string,
    signal: JsonValue,
  ): Promise<{ accepted: boolean }>;
  invokeTool<T = unknown>(context: WorkflowServiceContext, input: WorkflowToolInput): Promise<T>;
  issueTerminalToken(context: WorkflowServiceContext, input: WorkflowTerminalSessionInput): ReturnType<
    SessionService['issueTerminalToken']
  >;
  startLspSession(context: WorkflowServiceContext, input: WorkflowLspSessionInput): ReturnType<
    SessionService['startLspSession']
  >;
  handleJupyter(context: WorkflowServiceContext, input: WorkflowJupyterSessionInput): ReturnType<
    SessionService['handleJupyter']
  >;
  listWindows(context: WorkflowServiceContext, input: WorkflowWindowSessionToolInput): ReturnType<
    SessionService['listWindows']
  >;
  listApplications(context: WorkflowServiceContext, input: WorkflowWindowSessionToolInput): ReturnType<
    SessionService['listApplications']
  >;
  openApplication(context: WorkflowServiceContext, input: WorkflowWindowApplicationOpenInput): ReturnType<
    SessionService['openApplication']
  >;
  issueWindowSessionToken(context: WorkflowServiceContext, input: WorkflowWindowSessionInput): ReturnType<
    SessionService['issueWindowSessionToken']
  >;
  issueWorkspaceFileWatchToken(
    context: WorkflowServiceContext,
    input: WorkflowWorkspaceFileWatchSessionInput,
  ): ReturnType<SessionService['issueWorkspaceFileWatchToken']>;
  putAttachment(context: WorkflowServiceContext, input: AttachmentPayload): Promise<StoredAttachment>;
  getAttachment(context: WorkflowServiceContext, attachmentId: string): Promise<AttachmentReadResult | null>;
  findAttachmentsByThread(context: WorkflowServiceContext, threadId: string): Promise<StoredAttachmentMetadata[]>;
  findAttachmentsByOriginalName(
    context: WorkflowServiceContext,
    originalName: string,
    mimeType?: string,
  ): Promise<StoredAttachmentMetadata[]>;
  deleteAttachment(context: WorkflowServiceContext, attachmentId: string): Promise<void>;
  publishNotification(
    context: WorkflowServiceContext,
    input: ServerNotificationInput & { grants?: ServiceGrant[] },
  ): Promise<StoredNotificationEvent>;
  publishEvent(context: WorkflowServiceContext, input: WorkflowEventInput): Promise<ServiceEvent>;
  observeEvents(context: WorkflowServiceContext, stream: string, afterSequence?: number): ReadableStream<ServiceEvent>;
  publishWorkflowRunEvent(context: WorkflowServiceContext, input: WorkflowRunEventInput): Promise<ServiceEvent>;
  observeWorkflowRunEvents(
    context: WorkflowServiceContext,
    runId?: string,
    afterSequence?: number,
  ): ReadableStream<ServiceEvent>;
  publishAuditEvent(context: WorkflowServiceContext, input: WorkflowAuditEventInput): Promise<ServiceEvent>;
  observeAuditEvents(context: WorkflowServiceContext, scope?: string, afterSequence?: number): ReadableStream<
    ServiceEvent
  >;
}

export class DefaultWorkflowServiceRuntime implements WorkflowServiceRuntime {
  constructor(
    private readonly agents: AgentService = defaultAgentService,
    private readonly tools: ToolService = internalServices.tools,
    private readonly sessions: SessionService = internalServices.sessions,
    private readonly resources: ResourceService = internalServices.resources,
    private readonly events: EventService = internalServices.events,
  ) {}

  caller(context: WorkflowServiceContext, correlation?: ServiceCaller['correlation']): ServiceCaller {
    return callerForOwner(context.ownerId, 'workflow', {
      ...correlation,
      requestId: correlation?.requestId ?? context.requestId,
      workflowRunId: correlation?.workflowRunId ?? context.workflowRunId,
    });
  }

  listAgentCapabilities(context: WorkflowServiceContext) {
    this.requireGrant(context, undefined, 'agent', 'agent.capabilities', serviceScopeNone());
    return this.agents.listCapabilities();
  }

  listAgentModels(context: WorkflowServiceContext) {
    this.requireGrant(context, undefined, 'agent', 'agent.models', serviceScopeNone());
    return this.agents.listModels();
  }

  startAgentRun(context: WorkflowServiceContext, input: WorkflowAgentRunInput) {
    const agentId = publicAgentId(input.agentId);
    this.requireGrant(context, input, 'agent', 'agent.run', agentScope(agentId));
    return this.agents.startRun(this.agentRequest(context, input, agentId));
  }

  runAgentPrompt(context: WorkflowServiceContext, input: WorkflowAgentRunInput) {
    const agentId = publicAgentId(input.agentId);
    this.requireGrant(context, input, 'agent', 'agent.prompt', agentScope(agentId));
    return this.agents.runPrompt(this.agentRequest(context, input, agentId));
  }

  getAgentRun(context: WorkflowServiceContext, runId: string) {
    this.requireGrant(context, undefined, 'agent', 'agent.get', agentRunScope(runId));
    return this.agents.getRun(runId);
  }

  streamAgentRun(context: WorkflowServiceContext, runId: string) {
    this.requireGrant(context, undefined, 'agent', 'agent.stream', agentRunScope(runId));
    return this.agents.streamRun(runId);
  }

  cancelAgentRun(context: WorkflowServiceContext, runId: string) {
    this.requireGrant(context, undefined, 'agent', 'agent.cancel', agentRunScope(runId));
    return this.agents.cancelRun(runId);
  }

  sendAgentSignal(context: WorkflowServiceContext, runId: string, signal: JsonValue) {
    this.requireGrant(context, undefined, 'agent', 'agent.signal', agentRunScope(runId));
    return this.agents.sendSignal(runId, signal);
  }

  invokeTool<T = unknown>(context: WorkflowServiceContext, input: WorkflowToolInput) {
    const scope = input.scope ?? serviceScopeNone();
    this.requireGrant(context, input, 'tool', input.toolId, scope);
    return this.tools.invoke<T>({
      caller: this.caller(context),
      toolId: input.toolId,
      scope,
      input: input.input,
      timeoutMs: input.timeoutMs,
      grants: this.grants(context, input),
    });
  }

  issueTerminalToken(context: WorkflowServiceContext, input: WorkflowTerminalSessionInput) {
    this.requireGrant(context, input, 'session', 'portal.terminal.issue', input.scope);
    return this.sessions.issueTerminalToken(this.sessionInput(context, input));
  }

  startLspSession(context: WorkflowServiceContext, input: WorkflowLspSessionInput) {
    this.requireGrant(context, input, 'session', 'portal.lsp.session', input.scope);
    return this.sessions.startLspSession(this.sessionInput(context, input));
  }

  handleJupyter(context: WorkflowServiceContext, input: WorkflowJupyterSessionInput) {
    const operation = input.action === 'kernelspecs' ? 'portal.jupyter.kernelspecs' : `portal.jupyter.${input.action}`;
    this.requireGrant(context, input, 'session', operation, input.scope);
    return this.sessions.handleJupyter(this.sessionInput(context, input));
  }

  listWindows(context: WorkflowServiceContext, input: WorkflowWindowSessionToolInput) {
    this.requireGrant(context, input, 'session', 'portal.window.list', input.scope);
    return this.sessions.listWindows(this.sessionInput(context, input));
  }

  listApplications(context: WorkflowServiceContext, input: WorkflowWindowSessionToolInput) {
    this.requireGrant(context, input, 'session', 'portal.applications.list', input.scope);
    return this.sessions.listApplications(this.sessionInput(context, input));
  }

  openApplication(context: WorkflowServiceContext, input: WorkflowWindowApplicationOpenInput) {
    this.requireGrant(context, input, 'session', 'portal.applications.open', input.scope);
    return this.sessions.openApplication(this.sessionInput(context, input));
  }

  issueWindowSessionToken(context: WorkflowServiceContext, input: WorkflowWindowSessionInput) {
    this.requireGrant(context, input, 'session', 'portal.window.session', input.scope);
    return this.sessions.issueWindowSessionToken(this.sessionInput(context, input));
  }

  issueWorkspaceFileWatchToken(context: WorkflowServiceContext, input: WorkflowWorkspaceFileWatchSessionInput) {
    this.requireGrant(context, input, 'session', 'portal.fs.watch', input.scope);
    return this.sessions.issueWorkspaceFileWatchToken(this.sessionInput(context, input));
  }

  putAttachment(context: WorkflowServiceContext, input: AttachmentPayload) {
    this.requireGrant(context, undefined, 'resource', 'attachment.put', serviceScopeNone());
    return this.resources.putAttachment(this.caller(context), input);
  }

  getAttachment(context: WorkflowServiceContext, attachmentId: string) {
    this.requireGrant(context, undefined, 'resource', 'attachment.get', attachmentScope(attachmentId));
    return this.resources.getAttachment(this.caller(context), attachmentId);
  }

  findAttachmentsByThread(context: WorkflowServiceContext, threadId: string) {
    this.requireGrant(
      context,
      undefined,
      'resource',
      'attachment.findByThread',
      serviceResourceScope('thread', threadId),
    );
    return this.resources.findAttachmentsByThread(this.caller(context), threadId);
  }

  findAttachmentsByOriginalName(context: WorkflowServiceContext, originalName: string, mimeType?: string) {
    this.requireGrant(context, undefined, 'resource', 'attachment.findByOriginalName', serviceScopeNone());
    return this.resources.findAttachmentsByOriginalName(this.caller(context), originalName, mimeType);
  }

  deleteAttachment(context: WorkflowServiceContext, attachmentId: string) {
    this.requireGrant(context, undefined, 'resource', 'attachment.delete', attachmentScope(attachmentId));
    return this.resources.deleteAttachment(this.caller(context), attachmentId);
  }

  publishNotification(context: WorkflowServiceContext, input: ServerNotificationInput & { grants?: ServiceGrant[] }) {
    this.requireGrant(context, input, 'event', 'notification.publish', serviceScopeNone());
    const { grants: _grants, ...notification } = input;
    return this.events.publishNotification(this.caller(context), notification);
  }

  publishEvent(context: WorkflowServiceContext, input: WorkflowEventInput) {
    this.requireGrant(context, input, 'event', 'event.publish', eventStreamScope(input.stream));
    const { grants: _grants, ...event } = input;
    return this.events.publishEvent(this.caller(context), event);
  }

  observeEvents(context: WorkflowServiceContext, stream: string, afterSequence = 0) {
    this.requireGrant(context, undefined, 'event', 'event.observe', eventStreamScope(stream));
    return this.events.observeEvents(this.caller(context), stream, afterSequence);
  }

  publishWorkflowRunEvent(context: WorkflowServiceContext, input: WorkflowRunEventInput) {
    const runId = input.runId ?? context.workflowRunId;
    this.requireGrant(context, input, 'event', 'runEvent.publish', workflowRunScope(runId));
    return this.events.publishRunEvent(this.caller(context), {
      runKind: 'workflow',
      runId,
      type: input.type,
      data: input.data,
    });
  }

  observeWorkflowRunEvents(context: WorkflowServiceContext, runId = context.workflowRunId, afterSequence = 0) {
    this.requireGrant(context, undefined, 'event', 'runEvent.observe', workflowRunScope(runId));
    return this.events.observeRunEvents(this.caller(context), 'workflow', runId, afterSequence);
  }

  publishAuditEvent(context: WorkflowServiceContext, input: WorkflowAuditEventInput) {
    this.requireGrant(context, input, 'event', 'audit.publish', auditScope(input.scope));
    const { grants: _grants, ...event } = input;
    return this.events.publishAuditEvent(this.caller(context), event);
  }

  observeAuditEvents(context: WorkflowServiceContext, scope?: string, afterSequence = 0) {
    this.requireGrant(context, undefined, 'event', 'audit.observe', auditScope(scope));
    return this.events.observeAuditEvents(this.caller(context), scope, afterSequence);
  }

  private agentRequest(
    context: WorkflowServiceContext,
    input: WorkflowAgentRunInput,
    agentId: string,
  ): AgentRunRequest {
    return {
      caller: this.caller(context),
      agentId,
      input: input.input,
      ...(input.model ? { model: input.model } : {}),
      ...(input.maxSteps ? { maxSteps: input.maxSteps } : {}),
      memory: workflowAgentMemory(context, input.memory),
      ...(input.scope ? { scope: input.scope } : {}),
    };
  }

  private sessionInput<T extends { grants?: ServiceGrant[] }>(
    context: WorkflowServiceContext,
    input: T,
  ): T & { caller: ServiceCaller; grants: ServiceGrant[] } {
    return {
      ...input,
      caller: this.caller(context),
      grants: this.grants(context, input),
    };
  }

  private requireGrant(
    context: WorkflowServiceContext,
    input: { grants?: ServiceGrant[] } | undefined,
    service: ServiceOperationKind,
    operation: string,
    scope: ServiceScope,
  ) {
    requireServiceGrant(this.grants(context, input), { service, operation, scope });
  }

  private grants(context: WorkflowServiceContext, input?: { grants?: ServiceGrant[] }) {
    return input?.grants ?? context.grants ?? [];
  }
}

export const createWorkflowServiceRuntime = (deps: WorkflowServiceRuntimeDeps = {}) =>
  new DefaultWorkflowServiceRuntime(
    deps.agents,
    deps.tools,
    deps.sessions,
    deps.resources,
    deps.events,
  );

export const workflowServiceRuntime = createWorkflowServiceRuntime();

const publicAgentId = (agentId: string | undefined) => !agentId || agentId === 'mageHandAgent' ? 'mage-hand' : agentId;

const agentScope = (agentId: string) => serviceResourceScope('agent', publicAgentId(agentId));
const agentRunScope = (runId: string) => serviceResourceScope('agent-run', runId);
const attachmentScope = (attachmentId: string) => serviceResourceScope('attachment', attachmentId);
const eventStreamScope = (stream: string) => serviceResourceScope('event-stream', stream);
const workflowRunScope = (runId: string) => serviceResourceScope('workflow-run', runId);
const auditScope = (scope?: string) => serviceResourceScope('audit', scope ?? 'global');

const workflowAgentMemory = (
  context: WorkflowServiceContext,
  memory: AgentRunRequest['memory'],
): AgentRunRequest['memory'] => {
  if (!memory) return { scope: 'workflow', workflowRunId: context.workflowRunId };
  if (memory.scope !== 'workflow') return memory;
  return { ...memory, workflowRunId: memory.workflowRunId ?? context.workflowRunId };
};
