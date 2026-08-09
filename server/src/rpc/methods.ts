import { ownerResponse } from '../owner/auth.ts';
import { updateClientToolHost } from '../client-tools/registry.ts';
import type { AgentCore } from '../agent/index.ts';
import type { InternalServices } from '../services/index.ts';
import type { PortalCore } from '../portal/types.ts';
import type { RpcRouter, RpcSession } from './router.ts';
import { RpcApplicationError } from '@weave/protocol/peer';
import { rpcErrorCode } from '@weave/protocol';
import {
  getString,
  getSubmittedUserMessages,
  normalizeMessageImageAttachments,
  sanitizeSubmittedMessagesForMastra,
  submittedMessagesForMemory,
  toAgentMessageInput,
} from '../modules/chat/routes/chat.ts';
import { loadChatThreadUiMessages } from '../modules/chat/routes/chat-state.ts';
import { callerForOwner } from '../services/types.ts';
import { BinaryTransferRegistry } from './binary-transfers.ts';
import {
  type BinaryTransferDescriptor,
  binaryTransferDescriptorSchema,
  parseRpcRequestParams,
  type PortalToolName,
  type RpcNotificationMethod,
  type RpcRequestMethod,
  type RpcRequestResult,
  WEAVE_RPC_BINARY_CHUNK_BYTES,
  WEAVE_RPC_BINARY_WINDOW_SIZE,
} from '@weave/protocol';
import {
  workflowControlService,
  workflowDefinitionResponse,
  workflowRunEventResponse,
  workflowRunResponse,
} from '../workflows/control-service.ts';
import {
  type UserArtifactRecord,
  userArtifactRepository,
  type UserSkillFile,
} from '../modules/user-artifacts/repository.ts';
import {
  browseOwnerPortal,
  issueOwnerPortalToken,
  listOwnerPortals,
  setOwnerPrimaryPortal,
} from '../portal/service.ts';
import { productProjectRepository } from '../products/project-repository.ts';
import { getNotesVaultBackend } from '../modules/notes/storage/registry.ts';
import { createServicePortalNotesVaultBackend } from '../modules/notes/storage/portal-backend.ts';
import { parseNotesVaultTarget, resolveNotesVaultForProjectAsync } from '../modules/notes/storage/resolver.ts';
import type { NotesProject, NotesVaultBackend, ResolvedNotesVaultBinding } from '../modules/notes/storage/types.ts';
import { adjustRpcSubscriptions, recordRpcReplayEvent, recordRpcReplayRequest } from './metrics.ts';
import { getServerNotificationResumeWindow } from '../modules/notifications/service.ts';
import { guarded, isRecord, optionalString, recordParams, requiredString } from './handlers.ts';
const safeSequence = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type ContextUsageResult = RpcRequestResult<'client', 'server', 'chat.thread.contextUsage'>;

const contextUsageResponse = (
  usage: Awaited<ReturnType<AgentCore['service']['getChatThreadContextUsage']>>,
): ContextUsageResult => ({
  modelId: usage.modelId,
  tokens: usage.tokens,
  contextWindow: usage.contextWindow,
  contextLimitPercent: usage.contextLimitPercent,
  contextLimitTokens: usage.contextLimitTokens,
  percent: usage.percent,
  compactionEnabled: usage.compactionEnabled,
  source: usage.source,
  updatedAt: usage.updatedAt,
  ...(usage.totalProcessedTokens === undefined ? {} : { totalProcessedTokens: usage.totalProcessedTokens }),
  ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
  ...(usage.cachedInputTokens === undefined ? {} : { cachedInputTokens: usage.cachedInputTokens }),
  ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
  ...(usage.compaction && usage.compaction.state !== 'rejected'
    ? {
      compaction: {
        generation: usage.compaction.generation,
        state: usage.compaction.state,
        at: usage.compaction.at,
        ...(usage.compaction.projectedTokens === undefined
          ? {}
          : { projectedTokens: usage.compaction.projectedTokens }),
      },
    }
    : {}),
});

const artifactSummary = (record: UserArtifactRecord) => ({
  kind: record.kind,
  name: record.name,
  objectKey: record.objectKey,
  objectPrefix: record.objectPrefix,
  contentHash: record.contentHash,
  sizeBytes: record.sizeBytes,
  metadata: record.metadata,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
});

const skillFileResponse = (file: UserSkillFile) => ({
  path: file.path,
  objectKey: file.objectKey,
  sizeBytes: file.sizeBytes,
  updatedAt: file.updatedAt,
  ...(file.content === undefined ? {} : { content: file.content }),
});

const bytesToBase64 = (bytes: Uint8Array) => {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
};

const base64ToBytes = (value: string) => {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const sha256 = async (bytes: Uint8Array) => {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', copy.buffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
};

export const registerCoreRpcMethods = (
  router: RpcRouter,
  services: {
    agent: AgentCore;
    portal: PortalCore;
    internal: InternalServices;
  },
  dependencies: {
    projects: {
      get(ownerId: string, projectId: string): Promise<
        { workspaces: Array<{ id: string }> } | undefined
      >;
    };
  } = { projects: productProjectRepository },
) => {
  const chatSubscriptions = new Map<string, {
    connectionId: string;
    reader: ReadableStreamDefaultReader<{ sequence: number; chunk: unknown }>;
  }>();
  const notificationSubscriptions = new Map<string, {
    connectionId: string;
    reader: ReadableStreamDefaultReader<{ sequence: number; event: unknown }>;
  }>();
  const workflowSubscriptions = new Map<string, {
    connectionId: string;
    reader: ReadableStreamDefaultReader<
      import('../workflows/repository.ts').WorkflowRunEventRecord
    >;
  }>();
  const portalForwarders = new Map<string, () => void>();
  const pendingFileWatchRescans = new Set<string>();
  const binaryTransfers = new BinaryTransferRegistry();

  router.registerValidated(
    'binary.begin',
    ['client', 'portal'],
    (params, { session }) => binaryTransfers.beginUpload(params, session),
  );
  router.registerValidated(
    'binary.chunk',
    ['client', 'portal'],
    (params, { session }) => binaryTransfers.chunk(params, session),
  );
  router.registerValidated(
    'binary.complete',
    ['client', 'portal'],
    (params, { session }) => binaryTransfers.complete(params, session),
  );
  router.registerValidated('binary.ack', ['client', 'portal'], () => ({ ok: true }));
  router.registerValidated(
    'binary.abort',
    ['client', 'portal'],
    (params, { session }) => binaryTransfers.abort(params, session),
  );

  router.registerValidated('owner.get', 'client', (_params, { session }) => {
    if (session.role !== 'client') {
      throw new Error('Expected a client RPC session.');
    }
    return ownerResponse(session.ownerContext.owner);
  });

  router.registerValidated(
    'agent.tools.list',
    'client',
    () => ({ contributions: services.agent.listContributions() }),
  );

  router.registerValidated(
    'agent.models.list',
    'client',
    () => guarded(() => services.agent.service.listModels()),
  );

  router.registerValidated(
    'agent.prompts.list',
    'client',
    (params, { session }) =>
      guarded(async () => {
        const body = recordParams(params);
        return {
          prompts: await services.agent.service.listPromptTemplates({
            resourceId: session.ownerContext.owner.id,
            threadId: optionalString(body.threadId),
            projectId: optionalString(body.projectId),
            workspaceId: optionalString(body.workspaceId),
          }),
        };
      }),
  );

  router.registerValidated(
    'agent.prompts.expand',
    'client',
    (params, { session }) =>
      guarded(async () => {
        const body = recordParams(params);
        const name = requiredString(body.name, 'name');
        const args = typeof body.arguments === 'string' ? body.arguments : '';
        if (args.length > 20_000) {
          throw new RpcApplicationError(
            rpcErrorCode.invalidParams,
            'Prompt arguments too long.',
            {
              code: 'INVALID_PARAMS',
            },
          );
        }
        const text = await services.agent.service.expandPrompt(name, args, {
          resourceId: session.ownerContext.owner.id,
          threadId: optionalString(body.threadId),
          projectId: optionalString(body.projectId),
          workspaceId: optionalString(body.workspaceId),
        });
        if (text === undefined) {
          throw new RpcApplicationError(
            rpcErrorCode.notFound,
            'Prompt not found.',
            { code: 'NOT_FOUND' },
          );
        }
        return { name, text };
      }),
  );

  router.registerValidated(
    'agent.chatgpt.authStatus',
    'client',
    (_params, { session }) =>
      guarded(() =>
        services.agent.service.getChatGPTAuthStatus(
          session.ownerContext.owner.id,
        )
      ),
  );
  router.registerValidated(
    'agent.chatgpt.login.start',
    'client',
    (_params, { session }) =>
      guarded(() =>
        services.agent.service.startChatGPTBrowserLogin(
          session.ownerContext.owner.id,
        )
      ),
  );
  router.registerValidated(
    'agent.chatgpt.login.complete',
    'client',
    (params, { session }) =>
      guarded(async () => {
        const body = recordParams(params);
        const credentials = await services.agent.service
          .completeChatGPTBrowserLogin({
            ownerId: session.ownerContext.owner.id,
            code: requiredString(body.code, 'code'),
            state: requiredString(body.state, 'state'),
          }) as { accountId?: unknown; expires?: unknown };
        return {
          connected: true,
          accountId: credentials.accountId,
          expires: credentials.expires,
        };
      }),
  );

  router.registerValidated(
    'chat.thread.list',
    'client',
    (_params, { session }) =>
      guarded(async () => ({
        threads: await services.agent.service.listChatThreads({
          resourceId: session.ownerContext.owner.id,
        }),
      })),
  );
  router.registerValidated(
    'chat.thread.get',
    'client',
    (params, { session }) =>
      guarded(async () => {
        const threadId = requiredString(
          recordParams(params).threadId,
          'threadId',
        );
        const thread = (await services.agent.service.listChatThreads({
          resourceId: session.ownerContext.owner.id,
        }))
          .find((candidate) => candidate.id === threadId);
        if (!thread) {
          throw new RpcApplicationError(
            rpcErrorCode.notFound,
            'Thread was not found.',
            { code: 'NOT_FOUND' },
          );
        }
        return { thread };
      }),
  );
  router.registerValidated(
    'chat.thread.create',
    'client',
    (params, { session }) =>
      guarded(async () => {
        const body = recordParams(params);
        const projectId = requiredString(body.projectId, 'projectId');
        const workspaceId = requiredString(body.workspaceId, 'workspaceId');
        const project = await dependencies.projects.get(
          session.ownerContext.owner.id,
          projectId,
        );
        if (!project) {
          throw new RpcApplicationError(
            rpcErrorCode.notFound,
            'Project was not found.',
            { code: 'NOT_FOUND' },
          );
        }
        if (!project.workspaces.some((workspace) => workspace.id === workspaceId)) {
          throw new RpcApplicationError(
            rpcErrorCode.notFound,
            'Workspace was not found.',
            { code: 'NOT_FOUND' },
          );
        }
        return {
          thread: await services.agent.service.createChatThread({
            resourceId: session.ownerContext.owner.id,
            threadId: optionalString(body.threadId),
            title: optionalString(body.title) ?? '...',
            projectId,
            workspaceId,
          }),
        };
      }),
  );
  router.registerValidated(
    'chat.thread.reorder',
    'client',
    (params, { session }) =>
      guarded(async () => {
        const body = recordParams(params);
        const scope = recordParams(body.scope);
        await services.agent.service.reorderChatThreads({
          resourceId: session.ownerContext.owner.id,
          threadIds: Array.isArray(body.threadIds)
            ? body.threadIds.filter((id): id is string => typeof id === 'string')
            : [],
          scope: {
            projectId: optionalString(scope.projectId),
            workspaceId: optionalString(scope.workspaceId),
            ...(scope.plain === true ? { plain: true } : {}),
          },
        });
        return { ok: true };
      }),
  );
  router.registerValidated(
    'chat.thread.messages.list',
    'client',
    (params, { session }) =>
      guarded(async () => ({
        messages: await loadChatThreadUiMessages(services.agent.service, {
          resourceId: session.ownerContext.owner.id,
          threadId: requiredString(recordParams(params).threadId, 'threadId'),
        }),
      })),
  );
  router.registerValidated(
    'chat.thread.contextUsage',
    'client',
    (params, { session }) =>
      guarded(async () => {
        const body = recordParams(params);
        return contextUsageResponse(
          await services.agent.service.getChatThreadContextUsage({
            resourceId: session.ownerContext.owner.id,
            threadId: requiredString(body.threadId, 'threadId'),
            modelId: requiredString(body.model, 'model'),
          }),
        );
      }),
  );
  router.registerValidated(
    'chat.thread.compact',
    'client',
    (params, { session, signal }) =>
      guarded(() => {
        const body = recordParams(params);
        return services.agent.service.compactChatThread({
          resourceId: session.ownerContext.owner.id,
          threadId: requiredString(body.threadId, 'threadId'),
          model: requiredString(body.model, 'model'),
          instructions: optionalString(body.instructions),
          abortSignal: signal,
        });
      }),
  );
  router.registerValidated(
    'chat.thread.update',
    'client',
    (params, { session }) =>
      guarded(async () => {
        const body = recordParams(params);
        const title = optionalString(body.title);
        const hasArchived = typeof body.archived === 'boolean';
        if (!title && !hasArchived) {
          throw new RpcApplicationError(
            rpcErrorCode.invalidParams,
            'title or archived is required.',
            {
              code: 'INVALID_PARAMS',
            },
          );
        }
        return {
          thread: await services.agent.service.updateChatThread({
            resourceId: session.ownerContext.owner.id,
            threadId: requiredString(body.threadId, 'threadId'),
            ...(title ? { title } : {}),
            ...(hasArchived ? { archived: body.archived as boolean } : {}),
          }),
        };
      }),
  );
  router.registerValidated(
    'chat.thread.delete',
    'client',
    (params, { session }) =>
      guarded(async () => {
        await services.agent.service.deleteChatThread({
          resourceId: session.ownerContext.owner.id,
          threadId: requiredString(recordParams(params).threadId, 'threadId'),
        });
        return { ok: true };
      }),
  );

  router.registerValidated(
    'chat.run.start',
    'client',
    (params, { session }) =>
      guarded(async () => {
        const body = { ...recordParams(params) };
        const requestId = optionalString(body.requestId);
        if (requestId && !uuidPattern.test(requestId)) {
          throw new RpcApplicationError(
            rpcErrorCode.invalidParams,
            'requestId must be a UUID.',
            { code: 'INVALID_PARAMS' },
          );
        }
        delete body.requestId;
        const memory = recordParams(body.memory);
        const threadId = optionalString(memory.thread);
        body.messages = sanitizeSubmittedMessagesForMastra(
          await normalizeMessageImageAttachments(
            submittedMessagesForMemory(body.messages, threadId),
            {
              resourceId: session.ownerContext.owner.id,
              threadId,
              resources: services.internal.resources,
            },
          ),
        );
        const current = threadId
          ? services.agent.service.getChatRun(
            session.ownerContext.owner.id,
            threadId,
          )
          : undefined;
        if (
          threadId &&
          services.agent.service.hasActiveThreadRun(
            session.ownerContext.owner.id,
            threadId,
          ) &&
          current?.status !== 'awaiting_approval' &&
          current?.runId !== requestId
        ) {
          throw new RpcApplicationError(
            rpcErrorCode.conflict,
            'thread has an active stream',
            { code: 'CONFLICT' },
          );
        }
        const started = await services.agent.service.startChatRun({
          resourceId: session.ownerContext.owner.id,
          threadId,
          requestId,
          params: body,
          requestContext: session.ownerContext.requestContext,
          submittedUserMessages: getSubmittedUserMessages(body.messages),
        });
        await started.stream.cancel().catch(() => undefined);
        return { run: started.snapshot };
      }),
  );

  router.registerValidated(
    'chat.run.get',
    'client',
    (params, { session }) =>
      guarded(async () => {
        const body = recordParams(params);
        const threadId = requiredString(body.threadId, 'threadId');
        const runId = optionalString(body.runId);
        const run = runId
          ? await services.agent.service.getChatRunById(session.ownerContext.owner.id, threadId, runId)
          : services.agent.service.getChatRun(session.ownerContext.owner.id, threadId);
        const persisted = run.status === 'idle'
          ? await services.agent.service.getPersistedChatRun(
            session.ownerContext.owner.id,
            threadId,
            runId,
          )
          : undefined;
        return { run, persisted };
      }),
  );

  router.registerValidated(
    'chat.run.subscribe',
    'client',
    (params, { session }) =>
      guarded(async () => {
        const body = recordParams(params);
        const threadId = requiredString(body.threadId, 'threadId');
        const runId = optionalString(body.runId);
        const afterSequence = safeSequence(body.afterSequence);
        if (afterSequence > 0) recordRpcReplayRequest();
        const stream = await services.agent.service.replaySequencedChatRun(
          session.ownerContext.owner.id,
          threadId,
          afterSequence,
          runId,
        );
        if (!stream) {
          return { subscriptionId: null, active: false, afterSequence };
        }
        const subscriptionId = `chat_sub_${crypto.randomUUID()}`;
        const reader = stream.getReader();
        chatSubscriptions.set(subscriptionId, {
          connectionId: session.connectionId,
          reader,
        });
        adjustRpcSubscriptions(1);
        let lastSequence = afterSequence;
        const abort = () => void reader.cancel('RPC connection closed.').catch(() => undefined);
        session.lifetimeSignal.addEventListener('abort', abort, { once: true });
        void (async () => {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              lastSequence = value.sequence;
              if (afterSequence > 0) recordRpcReplayEvent();
              await session.peer.waitForWritable(session.lifetimeSignal);
              session.peer.notify('chat.run.event', {
                subscriptionId,
                threadId,
                ...(runId ? { runId } : {}),
                sequence: value.sequence,
                event: value.chunk,
              }, 1);
            }
            await session.peer.waitForWritable(session.lifetimeSignal);
            session.peer.notify('chat.run.event', {
              subscriptionId,
              threadId,
              ...(runId ? { runId } : {}),
              sequence: lastSequence,
              done: true,
            }, 1);
          } catch (error) {
            if (!session.lifetimeSignal.aborted) {
              session.peer.notify('chat.run.event', {
                subscriptionId,
                threadId,
                ...(runId ? { runId } : {}),
                sequence: lastSequence,
                error: error instanceof Error ? error.message : String(error),
              }, 1);
            }
          } finally {
            session.lifetimeSignal.removeEventListener('abort', abort);
            chatSubscriptions.delete(subscriptionId);
            adjustRpcSubscriptions(-1);
            reader.releaseLock();
          }
        })();
        return { subscriptionId, active: true, afterSequence };
      }),
  );

  router.registerValidated(
    'chat.run.unsubscribe',
    'client',
    (params, { session }) =>
      guarded(async () => {
        const subscriptionId = requiredString(
          recordParams(params).subscriptionId,
          'subscriptionId',
        );
        const subscription = chatSubscriptions.get(subscriptionId);
        if (
          subscription && subscription.connectionId !== session.connectionId
        ) {
          throw new RpcApplicationError(
            rpcErrorCode.notFound,
            'Subscription was not found.',
            { code: 'NOT_FOUND' },
          );
        }
        chatSubscriptions.delete(subscriptionId);
        await subscription?.reader.cancel('Unsubscribed.').catch(() => undefined);
        return { ok: true };
      }),
  );

  router.registerValidated(
    'notification.subscribe',
    'client',
    (params, { session }) =>
      guarded(async () => {
        const afterSequence = safeSequence(recordParams(params).afterSequence);
        if (afterSequence > 0) recordRpcReplayRequest();
        const resumeWindow = getServerNotificationResumeWindow(
          session.ownerContext.owner.id,
        );
        if (
          afterSequence > 0 && resumeWindow.oldestSequence > afterSequence + 1
        ) {
          throw new RpcApplicationError(
            rpcErrorCode.resumeGap,
            'Notification replay buffer no longer covers this sequence.',
            {
              code: 'RESUME_GAP',
              afterSequence,
              ...resumeWindow,
            },
          );
        }
        const subscriptionId = `notification_sub_${crypto.randomUUID()}`;
        const reader = services.internal.events.observeNotifications(
          callerForOwner(session.ownerContext.owner.id, 'ui'),
          afterSequence,
        ).getReader();
        notificationSubscriptions.set(subscriptionId, {
          connectionId: session.connectionId,
          reader,
        });
        adjustRpcSubscriptions(1);
        const abort = () => void reader.cancel('RPC connection closed.').catch(() => undefined);
        session.lifetimeSignal.addEventListener('abort', abort, { once: true });
        void (async () => {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (afterSequence > 0) recordRpcReplayEvent();
              await session.peer.waitForWritable(session.lifetimeSignal);
              session.peer.notify('notification.event', {
                subscriptionId,
                sequence: value.sequence,
                event: value.event,
              }, 3);
            }
          } finally {
            session.lifetimeSignal.removeEventListener('abort', abort);
            notificationSubscriptions.delete(subscriptionId);
            adjustRpcSubscriptions(-1);
            reader.releaseLock();
          }
        })();
        return { subscriptionId, afterSequence };
      }),
  );

  router.registerValidated(
    'notification.unsubscribe',
    'client',
    (params, { session }) =>
      guarded(async () => {
        const subscriptionId = requiredString(
          recordParams(params).subscriptionId,
          'subscriptionId',
        );
        const subscription = notificationSubscriptions.get(subscriptionId);
        if (
          subscription && subscription.connectionId !== session.connectionId
        ) {
          throw new RpcApplicationError(
            rpcErrorCode.notFound,
            'Subscription was not found.',
            { code: 'NOT_FOUND' },
          );
        }
        notificationSubscriptions.delete(subscriptionId);
        await subscription?.reader.cancel('Unsubscribed.').catch(() => undefined);
        return { ok: true };
      }),
  );

  router.registerValidated(
    'notification.test',
    'client',
    (params, { session }) =>
      guarded(async () => {
        const body = recordParams(params);
        const title = requiredString(body.title, 'title').slice(0, 160);
        const notificationBody = optionalString(body.body)?.slice(0, 512);
        const stored = await services.internal.events.publishNotification(
          callerForOwner(session.ownerContext.owner.id, 'ui'),
          {
            kind: 'notification.test',
            title,
            ...(notificationBody ? { body: notificationBody } : {}),
            priority: 'normal',
          },
        );
        return { ok: true, sequence: stored.sequence, event: stored.event };
      }),
  );

  const artifactOwner = (session: RpcSession) => session.ownerContext.owner.id;
  const artifactName = (params: unknown) => requiredString(recordParams(params).name, 'name');
  const artifactContent = (params: unknown) => {
    const content = recordParams(params).content;
    if (typeof content !== 'string') {
      throw new RpcApplicationError(
        rpcErrorCode.invalidParams,
        'content must be a string.',
        {
          code: 'INVALID_PARAMS',
        },
      );
    }
    return content;
  };
  const requireArtifact = <T>(value: T | undefined, label: string): T => {
    if (value === undefined) {
      throw new RpcApplicationError(
        rpcErrorCode.notFound,
        `${label} was not found.`,
        { code: 'NOT_FOUND' },
      );
    }
    return value;
  };

  router.registerValidated(
    'userArtifact.prompt.list',
    'client',
    (_params, { session }) =>
      guarded(async () => ({
        prompts: (await userArtifactRepository.listPrompts(artifactOwner(session)))
          .map(artifactSummary),
      })),
  );
  router.registerValidated(
    'userArtifact.prompt.get',
    'client',
    (params, { session }) =>
      guarded(async () => {
        const prompt = requireArtifact(
          await userArtifactRepository.getPrompt(
            artifactOwner(session),
            artifactName(params),
          ),
          'Prompt',
        );
        return {
          prompt: { ...artifactSummary(prompt), content: prompt.content },
        };
      }),
  );
  router.registerValidated(
    'userArtifact.prompt.put',
    'client',
    (params, { session }) =>
      guarded(async () => ({
        prompt: artifactSummary(
          await userArtifactRepository.putPrompt({
            ownerId: artifactOwner(session),
            name: artifactName(params),
            content: artifactContent(params),
          }),
        ),
      })),
  );
  router.registerValidated(
    'userArtifact.prompt.delete',
    'client',
    (params, { session }) =>
      guarded(async () => {
        await userArtifactRepository.deletePrompt(
          artifactOwner(session),
          artifactName(params),
        );
        return { ok: true };
      }),
  );

  router.registerValidated(
    'userArtifact.skill.list',
    'client',
    (_params, { session }) =>
      guarded(async () => ({
        skills: (await userArtifactRepository.listSkills(artifactOwner(session))).map(
          artifactSummary,
        ),
      })),
  );
  router.registerValidated(
    'userArtifact.skill.get',
    'client',
    (params, { session }) =>
      guarded(async () => {
        const skill = requireArtifact(
          await userArtifactRepository.getSkill(
            artifactOwner(session),
            artifactName(params),
          ),
          'Skill',
        );
        return {
          skill: {
            ...artifactSummary(skill),
            files: skill.files.map(skillFileResponse),
            ...(skill.entrypoint === undefined ? {} : { entrypoint: skill.entrypoint }),
          },
        };
      }),
  );
  router.registerValidated(
    'userArtifact.skill.put',
    'client',
    (params, { session }) =>
      guarded(async () => ({
        skill: artifactSummary(
          await userArtifactRepository.putSkill({
            ownerId: artifactOwner(session),
            name: artifactName(params),
            content: artifactContent(params),
          }),
        ),
      })),
  );
  router.registerValidated(
    'userArtifact.skill.delete',
    'client',
    (params, { session }) =>
      guarded(async () => {
        await userArtifactRepository.deleteSkill(
          artifactOwner(session),
          artifactName(params),
        );
        return { ok: true };
      }),
  );
  router.registerValidated(
    'userArtifact.skill.files.list',
    'client',
    (params, { session }) =>
      guarded(async () => {
        const skill = requireArtifact(
          await userArtifactRepository.getSkill(
            artifactOwner(session),
            artifactName(params),
          ),
          'Skill',
        );
        return { files: skill.files.map(skillFileResponse) };
      }),
  );
  router.registerValidated(
    'userArtifact.skill.file.get',
    'client',
    (params, { session }) =>
      guarded(async () => {
        const body = recordParams(params);
        const file = requireArtifact(
          await userArtifactRepository.getSkillFile(
            artifactOwner(session),
            requiredString(body.name, 'name'),
            requiredString(body.path, 'path'),
          ),
          'Skill file',
        );
        return { file: skillFileResponse(file) };
      }),
  );
  router.registerValidated(
    'userArtifact.skill.file.put',
    'client',
    (params, { session }) =>
      guarded(async () => {
        const body = recordParams(params);
        const skill = await userArtifactRepository.putSkillFile({
          ownerId: artifactOwner(session),
          name: requiredString(body.name, 'name'),
          path: requiredString(body.path, 'path'),
          content: artifactContent(params),
        });
        return { skill: artifactSummary(skill) };
      }),
  );
  router.registerValidated(
    'userArtifact.skill.file.delete',
    'client',
    (params, { session }) =>
      guarded(async () => {
        const body = recordParams(params);
        await userArtifactRepository.deleteSkillFile(
          artifactOwner(session),
          requiredString(body.name, 'name'),
          requiredString(body.path, 'path'),
        );
        return { ok: true };
      }),
  );

  router.registerValidated(
    'attachment.put',
    'client',
    (params, { session }) =>
      guarded(async () => {
        const body = recordParams(params);
        const transferId = requiredString(body.transferId, 'transferId');
        const transfer = binaryTransfers.consumeUpload(transferId, session);
        if (transfer.descriptor.purpose !== 'attachment.image') {
          throw new RpcApplicationError(
            rpcErrorCode.invalidParams,
            'Binary transfer is not an image attachment.',
            {
              code: 'INVALID_PARAMS',
            },
          );
        }
        const mimeType = optionalString(body.mimeType) ??
          transfer.descriptor.mimeType;
        if (!mimeType?.startsWith('image/')) {
          throw new RpcApplicationError(
            rpcErrorCode.invalidParams,
            'Only image attachments are supported.',
            {
              code: 'INVALID_PARAMS',
            },
          );
        }
        return await services.internal.resources.putAttachment(
          callerForOwner(session.ownerContext.owner.id, 'ui'),
          {
            bytes: transfer.bytes,
            mimeType,
            originalName: optionalString(body.originalName) ?? 'image',
            threadId: optionalString(body.threadId),
          },
        );
      }),
  );

  router.registerValidated(
    'attachment.read',
    'client',
    (params, { session }) =>
      guarded(async () => {
        const attachmentId = requiredString(
          recordParams(params).attachmentId,
          'attachmentId',
        );
        const attachment = await services.internal.resources.getAttachment(
          callerForOwner(session.ownerContext.owner.id, 'ui'),
          attachmentId,
        );
        if (!attachment) {
          throw new RpcApplicationError(
            rpcErrorCode.notFound,
            'Attachment was not found.',
            { code: 'NOT_FOUND' },
          );
        }
        const transfer = await binaryTransfers.createDownload({
          session,
          purpose: 'attachment.image',
          bytes: attachment.bytes,
          mimeType: attachment.mimeType,
          metadata: {
            attachmentId,
            originalName: attachment.originalName,
          },
        });
        return {
          transfer,
          attachment: {
            id: attachmentId,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
            originalName: attachment.originalName,
          },
        };
      }),
  );

  router.registerValidated(
    'workflow.definition.list',
    'client',
    (_params, { session }) =>
      guarded(async () => ({
        workflows: (await workflowControlService.listDefinitions(
          session.ownerContext.owner.id,
        )).map(
          workflowDefinitionResponse,
        ),
      })),
  );
  router.registerValidated(
    'workflow.definition.create',
    'client',
    (params, { session }) =>
      guarded(async () => {
        return {
          workflow: workflowDefinitionResponse(
            await workflowControlService.saveDefinition(
              session.ownerContext.owner.id,
              params.definition,
            ),
          ),
        };
      }),
  );
  router.registerValidated(
    'workflow.definition.get',
    'client',
    (params, { session }) =>
      guarded(async () => ({
        workflow: workflowDefinitionResponse(
          await workflowControlService.getDefinition(
            session.ownerContext.owner.id,
            params.workflowId,
          ),
        ),
      })),
  );
  router.registerValidated(
    'workflow.definition.update',
    'client',
    (params, { session }) =>
      guarded(async () => {
        if (params.definition.id !== params.workflowId) {
          throw new RpcApplicationError(
            rpcErrorCode.invalidParams,
            'Workflow id must match the definition.',
            {
              code: 'INVALID_PARAMS',
            },
          );
        }
        return {
          workflow: workflowDefinitionResponse(
            await workflowControlService.saveDefinition(
              session.ownerContext.owner.id,
              params.definition,
            ),
          ),
        };
      }),
  );
  router.registerValidated(
    'workflow.definition.delete',
    'client',
    (params, { session }) =>
      guarded(async () => {
        await workflowControlService.deleteDefinition(
          session.ownerContext.owner.id,
          params.workflowId,
        );
        return { ok: true };
      }),
  );
  router.registerValidated(
    'workflow.run.start',
    'client',
    (params, { session }) =>
      guarded(async () => {
        const run = await workflowControlService.startRun({
          ownerId: session.ownerContext.owner.id,
          workflowId: params.workflowId,
          input: params.input,
          requestId: params.requestId,
          runId: params.runId,
        });
        return { run: workflowRunResponse(run) };
      }),
  );
  router.registerValidated(
    'workflow.run.list',
    'client',
    (params, { session }) =>
      guarded(async () => {
        return {
          runs: (await workflowControlService.listRuns(
            session.ownerContext.owner.id,
            {
              workflowId: params?.workflowId,
              limit: params?.limit,
            },
          )).map(workflowRunResponse),
        };
      }),
  );
  router.registerValidated(
    'workflow.run.get',
    'client',
    (params, { session }) =>
      guarded(async () => {
        const run = await workflowControlService.getRun(
          session.ownerContext.owner.id,
          params.runId,
        );
        if (!run) {
          throw new RpcApplicationError(
            rpcErrorCode.notFound,
            'Workflow run was not found.',
            { code: 'NOT_FOUND' },
          );
        }
        return { run: workflowRunResponse(run) };
      }),
  );
  router.registerValidated(
    'workflow.run.cancel',
    'client',
    (params, { session }) =>
      guarded(async () => ({
        run: workflowRunResponse(
          await workflowControlService.cancelRun(
            session.ownerContext.owner.id,
            params.runId,
          ),
        ),
      })),
  );
  router.registerValidated(
    'workflow.run.subscribe',
    'client',
    (params, { session }) =>
      guarded(async () => {
        const body = recordParams(params);
        const runId = requiredString(body.runId, 'runId');
        const afterSequence = safeSequence(body.afterSequence);
        if (afterSequence > 0) recordRpcReplayRequest();
        const subscriptionId = `workflow_sub_${crypto.randomUUID()}`;
        const reader = (await workflowControlService.observeRunEvents(
          session.ownerContext.owner.id,
          runId,
          afterSequence,
        )).getReader();
        workflowSubscriptions.set(subscriptionId, {
          connectionId: session.connectionId,
          reader,
        });
        adjustRpcSubscriptions(1);
        const abort = () => void reader.cancel('RPC connection closed.').catch(() => undefined);
        session.lifetimeSignal.addEventListener('abort', abort, { once: true });
        void (async () => {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (afterSequence > 0) recordRpcReplayEvent();
              await session.peer.waitForWritable(session.lifetimeSignal);
              session.peer.notify('workflow.run.event', {
                subscriptionId,
                runId,
                sequence: value.sequence,
                event: workflowRunEventResponse(value),
              }, 1);
            }
          } finally {
            session.lifetimeSignal.removeEventListener('abort', abort);
            workflowSubscriptions.delete(subscriptionId);
            adjustRpcSubscriptions(-1);
            reader.releaseLock();
          }
        })();
        return { subscriptionId, runId, afterSequence };
      }),
  );
  router.registerValidated(
    'workflow.run.unsubscribe',
    'client',
    (params, { session }) =>
      guarded(async () => {
        const subscriptionId = requiredString(
          recordParams(params).subscriptionId,
          'subscriptionId',
        );
        const subscription = workflowSubscriptions.get(subscriptionId);
        if (
          subscription && subscription.connectionId !== session.connectionId
        ) {
          throw new RpcApplicationError(
            rpcErrorCode.notFound,
            'Subscription was not found.',
            { code: 'NOT_FOUND' },
          );
        }
        workflowSubscriptions.delete(subscriptionId);
        await subscription?.reader.cancel('Unsubscribed.').catch(() => undefined);
        return { ok: true };
      }),
  );

  router.registerValidated(
    'chat.run.approval.respond',
    'client',
    (params, { session }) =>
      guarded(async () => {
        const body = recordParams(params);
        const decision = body.decision === 'approve' || body.decision === 'deny' ? body.decision : undefined;
        if (!decision) {
          throw new RpcApplicationError(
            rpcErrorCode.invalidParams,
            'decision is required.',
          );
        }
        const resumed = await services.agent.service.respondToToolApproval({
          resourceId: session.ownerContext.owner.id,
          threadId: requiredString(body.threadId, 'threadId'),
          runId: requiredString(body.runId, 'runId'),
          toolCallId: requiredString(body.toolCallId, 'toolCallId'),
          decision,
          rememberForRun: body.rememberForRun === true,
          requestContext: session.ownerContext.requestContext,
        });
        await resumed.stream.cancel().catch(() => undefined);
        return { run: resumed.snapshot };
      }),
  );

  router.registerValidated(
    'chat.run.cancel',
    'client',
    (params, { session }) =>
      guarded(() => ({
        ok: true,
        run: services.agent.service.cancelChatRun(
          session.ownerContext.owner.id,
          requiredString(recordParams(params).threadId, 'threadId'),
        ),
      })),
  );

  router.registerValidated(
    'chat.run.steer',
    'client',
    (params, { session }) =>
      guarded(async () => {
        const body = recordParams(params);
        const threadId = requiredString(body.threadId, 'threadId');
        const requestedRunId = optionalString(body.runId);
        const run = services.agent.service.getChatRun(
          session.ownerContext.owner.id,
          threadId,
        );
        if (!run.active || (requestedRunId && run.runId !== requestedRunId)) {
          throw new RpcApplicationError(
            rpcErrorCode.conflict,
            'Run is not active or is stale.',
            {
              code: 'CONFLICT',
              run,
            },
          );
        }
        const submittedMessages = Array.isArray(body.messages) ? body.messages : body.message ? [body.message] : [];
        const normalized = sanitizeSubmittedMessagesForMastra(
          await normalizeMessageImageAttachments(
            submittedMessagesForMemory(submittedMessages, threadId),
            {
              resourceId: session.ownerContext.owner.id,
              threadId,
              resources: services.internal.resources,
            },
          ),
        );
        const message = getSubmittedUserMessages(normalized)[0];
        if (!message) {
          throw new RpcApplicationError(
            rpcErrorCode.invalidParams,
            'Steering requires a user message.',
          );
        }
        const result = await services.agent.service.sendChatMessage({
          resourceId: session.ownerContext.owner.id,
          threadId,
          activeThreadRunId: requestedRunId,
          message: toAgentMessageInput(message),
        });
        if (!result.accepted) {
          throw new RpcApplicationError(
            rpcErrorCode.conflict,
            'Run is stale.',
            { code: 'CONFLICT' },
          );
        }
        return {
          ok: true,
          accepted: true,
          runId: result.runId,
          messageId: result.messageId,
        };
      }),
  );

  router.registerValidated(
    'portal.list',
    'client',
    (_params, { session }) =>
      guarded(async () => ({
        portals: await listOwnerPortals(session.ownerContext.owner.id),
      })),
  );

  router.registerValidated('portal.browse', 'client', (params, { session }) => {
    const body = recordParams(params);
    return guarded(() =>
      browseOwnerPortal({
        ownerId: session.ownerContext.owner.id,
        portalId: requiredString(body.portalId, 'portalId'),
        rootId: optionalString(body.rootId),
        path: typeof body.path === 'string' ? body.path : undefined,
      })
    );
  });
  router.registerValidated(
    'portal.primary.set',
    'client',
    (params, { session }) =>
      guarded(() =>
        setOwnerPrimaryPortal(
          session.ownerContext.owner.id,
          requiredString(recordParams(params).portalId, 'portalId'),
        )
      ),
  );
  router.registerValidated(
    'portal.token.issue',
    'client',
    (_params, { session }) => guarded(() => issueOwnerPortalToken(session.ownerContext.owner.id)),
  );

  const resolvePortal = (raw: Record<string, unknown>, userId: string) => {
    const target = isRecord(raw.target) ? raw.target : raw;
    const portal = services.portal.resolveForTarget({
      userId,
      portalId: optionalString(target.portalId),
      projectId: optionalString(target.projectId),
      rootId: optionalString(target.rootId),
      repoPath: optionalString(target.repoPath),
      workspacePath: optionalString(target.workspacePath),
    });
    if (!portal) {
      throw new RpcApplicationError(
        rpcErrorCode.portalUnavailable,
        'Portal is unavailable.',
        {
          code: 'PORTAL_UNAVAILABLE',
        },
      );
    }
    return { portal, target };
  };

  const sendBinaryToPortal = async (
    portalId: string,
    bytes: Uint8Array,
    purpose: string,
    mimeType?: string,
  ) => {
    const transferId = `server_upload_${crypto.randomUUID()}`;
    const digest = await sha256(bytes);
    const descriptor: BinaryTransferDescriptor = {
      transferId,
      direction: 'upload',
      purpose,
      sizeBytes: bytes.byteLength,
      sha256: digest,
      mimeType,
      chunkBytes: WEAVE_RPC_BINARY_CHUNK_BYTES,
      windowSize: WEAVE_RPC_BINARY_WINDOW_SIZE,
    };
    await services.portal.requestRpc(portalId, 'binary.begin', descriptor);
    const chunkCount = Math.ceil(
      bytes.byteLength / WEAVE_RPC_BINARY_CHUNK_BYTES,
    );
    try {
      for (
        let offset = 0;
        offset < chunkCount;
        offset += WEAVE_RPC_BINARY_WINDOW_SIZE
      ) {
        await Promise.all(
          Array.from({
            length: Math.min(WEAVE_RPC_BINARY_WINDOW_SIZE, chunkCount - offset),
          }, (_, windowIndex) => {
            const index = offset + windowIndex;
            const start = index * WEAVE_RPC_BINARY_CHUNK_BYTES;
            return services.portal.requestRpc(portalId, 'binary.chunk', {
              transferId,
              index,
              data: bytesToBase64(
                bytes.subarray(start, start + WEAVE_RPC_BINARY_CHUNK_BYTES),
              ),
            });
          }),
        );
      }
      await services.portal.requestRpc(portalId, 'binary.complete', {
        transferId,
        chunks: chunkCount,
        sha256: digest,
      });
      return descriptor;
    } catch (error) {
      void services.portal.requestRpc(portalId, 'binary.abort', { transferId })
        .catch(() => undefined);
      throw error;
    }
  };

  const receiveBinaryFromPortal = async (
    portalId: string,
    descriptor: BinaryTransferDescriptor,
  ) => {
    const chunkCount = Math.ceil(
      descriptor.sizeBytes / WEAVE_RPC_BINARY_CHUNK_BYTES,
    );
    const chunks = new Map<number, Uint8Array>();
    try {
      for (
        let offset = 0;
        offset < chunkCount;
        offset += WEAVE_RPC_BINARY_WINDOW_SIZE
      ) {
        const results = await Promise.all(
          Array.from(
            {
              length: Math.min(
                WEAVE_RPC_BINARY_WINDOW_SIZE,
                chunkCount - offset,
              ),
            },
            (_, windowIndex) =>
              services.portal.requestRpc(portalId, 'binary.chunk', {
                transferId: descriptor.transferId,
                index: offset + windowIndex,
              }),
          ),
        );
        for (const result of results) {
          const record = recordParams(result);
          const index = Number(record.index);
          if (!Number.isSafeInteger(index) || typeof record.data !== 'string') {
            throw new Error('Portal returned an invalid binary chunk.');
          }
          chunks.set(index, base64ToBytes(record.data));
        }
      }
      const bytes = new Uint8Array(descriptor.sizeBytes);
      let byteOffset = 0;
      for (let index = 0; index < chunkCount; index += 1) {
        const chunk = chunks.get(index);
        if (!chunk) {
          throw new Error(`Portal binary transfer is missing chunk ${index}.`);
        }
        bytes.set(chunk, byteOffset);
        byteOffset += chunk.byteLength;
      }
      const digest = await sha256(bytes);
      if (digest !== descriptor.sha256.toLowerCase()) {
        throw new Error('Portal binary transfer checksum mismatch.');
      }
      await services.portal.requestRpc(portalId, 'binary.complete', {
        transferId: descriptor.transferId,
        chunks: chunkCount,
        sha256: digest,
      });
      return bytes;
    } catch (error) {
      void services.portal.requestRpc(portalId, 'binary.abort', {
        transferId: descriptor.transferId,
      }).catch(() => undefined);
      throw error;
    }
  };

  const callPortalSession = async <Method extends RpcRequestMethod<'server', 'portal'>>(input: {
    session: RpcSession;
    params: unknown;
    channel: 'terminal' | 'workspaceFile.watch' | 'lsp' | 'jupyter';
    portalMethod: Method;
    portalEvent: RpcNotificationMethod<'portal', 'server'>;
    publicEvent: RpcNotificationMethod<'server', 'client'>;
  }) => {
    const body = recordParams(input.params);
    const sessionId = requiredString(body.sessionId, 'sessionId');
    const { portal } = resolvePortal(body, input.session.ownerContext.owner.id);
    const clientId = `${input.session.connectionId}:${input.channel}:${sessionId}`;
    const key = `${portal.portalId}:${clientId}:${input.publicEvent}`;
    if (!portalForwarders.has(key)) {
      const detach = services.portal.subscribeRpcEvent(
        portal.portalId,
        input.portalEvent,
        async (raw) => {
          if (!isRecord(raw) || raw.clientId !== clientId) return;
          if (
            input.channel === 'workspaceFile.watch' &&
            input.session.peer.stats.overHighWatermark
          ) {
            if (pendingFileWatchRescans.has(key)) return;
            pendingFileWatchRescans.add(key);
            try {
              await input.session.peer.waitForWritable(
                input.session.lifetimeSignal,
              );
              input.session.peer.notify(input.publicEvent, {
                sessionId,
                event: {
                  type: 'workspace-file.watch.change',
                  event: {
                    kind: 'any',
                    paths: [],
                    affectedDirectories: [],
                    rescan: true,
                  },
                },
              }, 3);
            } finally {
              pendingFileWatchRescans.delete(key);
            }
            return;
          }
          await input.session.peer.waitForWritable(
            input.session.lifetimeSignal,
          );
          input.session.peer.notify(input.publicEvent, {
            sessionId,
            event: raw.event,
          }, input.channel === 'workspaceFile.watch' ? 3 : 2);
        },
      );
      portalForwarders.set(key, detach);
      input.session.lifetimeSignal.addEventListener('abort', () => {
        portalForwarders.get(key)?.();
        portalForwarders.delete(key);
        pendingFileWatchRescans.delete(key);
      }, { once: true });
    }
    const portalParams = parseRpcRequestParams(
      'server',
      'portal',
      input.portalMethod,
      {
        ...body,
        clientId,
      },
    );
    return await services.portal.requestRpc(
      portal.portalId,
      input.portalMethod,
      portalParams,
    );
  };

  const terminalCall = (
    action: 'snapshot' | 'list' | 'create' | 'attach' | 'input' | 'resize' | 'close' | 'detach',
    params: unknown,
    session: RpcSession,
  ) =>
    guarded(() =>
      callPortalSession({
        session,
        params,
        channel: 'terminal',
        portalMethod: `portal.terminal.${action}`,
        portalEvent: 'portal.terminal.event',
        publicEvent: 'terminal.event',
      })
    );
  router.registerValidated(
    'terminal.snapshot',
    'client',
    (params, { session }) => terminalCall('snapshot', params, session),
  );
  router.registerValidated(
    'terminal.list',
    'client',
    (params, { session }) => terminalCall('list', params, session),
  );
  router.registerValidated(
    'terminal.create',
    'client',
    (params, { session }) => terminalCall('create', params, session),
  );
  router.registerValidated(
    'terminal.attach',
    'client',
    (params, { session }) => terminalCall('attach', params, session),
  );
  router.registerValidated(
    'terminal.input',
    'client',
    (params, { session }) => terminalCall('input', params, session),
  );
  router.registerValidated(
    'terminal.resize',
    'client',
    (params, { session }) => terminalCall('resize', params, session),
  );
  router.registerValidated(
    'terminal.close',
    'client',
    (params, { session }) => terminalCall('close', params, session),
  );
  router.registerValidated(
    'terminal.detach',
    'client',
    (params, { session }) => terminalCall('detach', params, session),
  );

  const invokeNotesBackend = async (
    backend: NotesVaultBackend,
    binding: ResolvedNotesVaultBinding,
    action: string,
    body: Record<string, unknown>,
  ) => {
    if (action === 'index') {
      return await backend.index(binding, {
        path: optionalString(body.path) ?? '',
      });
    }
    if (action === 'read') {
      return await backend.read(binding, {
        path: optionalString(body.path) ?? '',
      });
    }
    if (action === 'write') {
      return await backend.write(binding, {
        path: optionalString(body.path) ?? '',
        content: typeof body.content === 'string' ? body.content : undefined,
        version: optionalString(body.version),
      });
    }
    if (action === 'mkdir') {
      return await backend.mkdir(binding, {
        path: optionalString(body.path) ?? '',
      });
    }
    if (action === 'move') {
      return await backend.move(binding, {
        fromPath: optionalString(body.fromPath) ?? '',
        toPath: optionalString(body.toPath) ?? '',
        overwrite: body.overwrite === true,
      });
    }
    if (action === 'delete') {
      return await backend.delete(binding, {
        path: optionalString(body.path) ?? '',
        recursive: body.recursive === true,
      });
    }
    if (action === 'upload') {
      return await backend.upload(binding, {
        path: optionalString(body.path) ?? '',
        base64Content: typeof body.base64Content === 'string' ? body.base64Content : undefined,
        contentType: optionalString(body.contentType),
      });
    }
    throw new RpcApplicationError(
      rpcErrorCode.invalidParams,
      `${action} is unavailable for Notes projects.`,
      {
        code: 'INVALID_PARAMS',
      },
    );
  };

  const callNotesWorkspaceFile = async (
    action: string,
    body: Record<string, unknown>,
    session: RpcSession,
  ): Promise<{ handled: false } | { handled: true; result: unknown }> => {
    const target = isRecord(body.target) ? body.target : body;
    const projectId = requiredString(target.projectId, 'target.projectId');
    const project = await productProjectRepository.get(
      session.ownerContext.owner.id,
      projectId,
    );
    if (!project) {
      throw new RpcApplicationError(
        rpcErrorCode.notFound,
        'Project was not found.',
        { code: 'NOT_FOUND' },
      );
    }
    if (project.projectKind !== 'notes') return { handled: false };
    if (action === 'hash' || action === 'diffPreview') {
      throw new RpcApplicationError(
        rpcErrorCode.invalidParams,
        'This workspace file operation is only available for Git projects.',
        { code: 'INVALID_PARAMS' },
      );
    }
    const requestBody = { ...body };
    if (action === 'upload' || action === 'write') {
      const transfer = binaryTransfers.consumeUpload(
        requiredString(body.transferId, 'transferId'),
        session,
      );
      if (transfer.descriptor.purpose !== `workspaceFile.${action}`) {
        throw new RpcApplicationError(
          rpcErrorCode.invalidParams,
          `Binary transfer is not a workspace ${action}.`,
          {
            code: 'INVALID_PARAMS',
          },
        );
      }
      if (action === 'upload') {
        requestBody.base64Content = bytesToBase64(transfer.bytes);
      } else {requestBody.content = new TextDecoder('utf-8', { fatal: true })
          .decode(transfer.bytes);}
    }
    const { backend, binding } = await resolveNotesVaultForProjectAsync(
      project as NotesProject,
      session.ownerContext.owner.id,
      parseNotesVaultTarget(body),
      {
        tools: services.internal.tools,
        getBackend: (kind) =>
          kind === 'portal'
            ? createServicePortalNotesVaultBackend(services.internal.tools)
            : getNotesVaultBackend(kind),
      },
    );
    const rawResult = await invokeNotesBackend(
      backend,
      binding,
      action,
      requestBody,
    );
    const result = isRecord(rawResult) && rawResult.ok === true
      ? Object.fromEntries(
        Object.entries(rawResult).filter(([key]) => key !== 'ok'),
      )
      : rawResult;
    const resultRecord = isRecord(result) ? result as Record<string, unknown> : undefined;
    if (
      action === 'read' && resultRecord &&
      typeof resultRecord.content === 'string'
    ) {
      const contentTransfer = await binaryTransfers.createDownload({
        session,
        purpose: 'workspaceFile.read',
        bytes: new TextEncoder().encode(resultRecord.content),
        mimeType: 'text/plain; charset=utf-8',
      });
      const { content: _content, ...metadata } = resultRecord;
      return { handled: true, result: { ...metadata, contentTransfer } };
    }
    return { handled: true, result };
  };

  for (
    const action of [
      'list',
      'read',
      'hash',
      'diffPreview',
      'write',
      'mkdir',
      'move',
      'delete',
      'index',
      'upload',
    ] as const
  ) {
    router.registerValidated(
      `workspaceFile.${action}`,
      'client',
      (params, { session }) =>
        guarded(async () => {
          const body = recordParams(params);
          const notes = await callNotesWorkspaceFile(action, body, session);
          if (notes.handled) return notes.result;
          const { portal, target } = resolvePortal(
            body,
            session.ownerContext.owner.id,
          );
          const args = { ...body };
          delete args.target;
          if (action === 'upload' || action === 'write') {
            const localTransfer = binaryTransfers.consumeUpload(
              requiredString(body.transferId, 'transferId'),
              session,
            );
            if (
              localTransfer.descriptor.purpose !== `workspaceFile.${action}`
            ) {
              throw new RpcApplicationError(
                rpcErrorCode.invalidParams,
                `Binary transfer is not a workspace ${action}.`,
                {
                  code: 'INVALID_PARAMS',
                },
              );
            }
            const remoteTransfer = await sendBinaryToPortal(
              portal.portalId,
              localTransfer.bytes,
              `workspaceFile.${action}`,
              action === 'upload' ? optionalString(body.contentType) : 'text/plain; charset=utf-8',
            );
            args.transferId = remoteTransfer.transferId;
          }
          const portalMethod = `portal.workspaceFile.${action}` as const;
          const portalParams = parseRpcRequestParams(
            'server',
            'portal',
            portalMethod,
            { target, args },
          );
          const result = await services.portal.requestRpc(
            portal.portalId,
            portalMethod,
            portalParams,
          );
          const record = recordParams(result);
          if (record.ok === false) {
            throw new Error(
              optionalString(record.error) ??
                'Portal workspace file request failed.',
            );
          }
          const remoteTransfer = record.contentTransfer;
          if (action === 'read' && remoteTransfer) {
            const descriptor = binaryTransferDescriptorSchema.parse(remoteTransfer);
            const bytes = await receiveBinaryFromPortal(
              portal.portalId,
              descriptor,
            );
            const contentTransfer = await binaryTransfers.createDownload({
              session,
              purpose: 'workspaceFile.read',
              bytes,
              mimeType: descriptor.mimeType,
            });
            return { ...record, contentTransfer };
          }
          return record;
        }),
    );
  }
  const workspaceWatchCall = (
    action: 'start' | 'update' | 'stop',
    params: unknown,
    session: RpcSession,
  ) =>
    guarded(() =>
      callPortalSession({
        session,
        params,
        channel: 'workspaceFile.watch',
        portalMethod: `portal.workspaceFile.watch.${action}`,
        portalEvent: 'portal.workspaceFile.watch.event',
        publicEvent: 'workspaceFile.watch.event',
      })
    );
  router.registerValidated(
    'workspaceFile.watch.start',
    'client',
    (params, { session }) => workspaceWatchCall('start', params, session),
  );
  router.registerValidated(
    'workspaceFile.watch.update',
    'client',
    (params, { session }) => workspaceWatchCall('update', params, session),
  );
  router.registerValidated(
    'workspaceFile.watch.stop',
    'client',
    (params, { session }) => workspaceWatchCall('stop', params, session),
  );

  const requestPortalToolForTarget = (
    params: unknown,
    userId: string,
    tool: PortalToolName,
  ) => {
    const body = recordParams(params);
    const { portal, target } = resolvePortal(body, userId);
    return services.portal.requestTool({
      portalId: portal.portalId,
      projectId: optionalString(target.projectId),
      workspaceId: optionalString(target.workspaceId),
      rootId: optionalString(target.rootId),
      repoPath: optionalString(target.repoPath),
      workspacePath: optionalString(target.workspacePath),
      tool,
      args: body,
    });
  };
  router.registerValidated(
    'lsp.session.create',
    'client',
    (params, { session }) =>
      guarded(() =>
        requestPortalToolForTarget(
          params,
          session.ownerContext.owner.id,
          'portal.lsp.session',
        )
      ),
  );
  const lspCall = (action: 'start' | 'send' | 'close', params: unknown, session: RpcSession) =>
    guarded(() =>
      callPortalSession({
        session,
        params,
        channel: 'lsp',
        portalMethod: `portal.lsp.${action}`,
        portalEvent: 'portal.lsp.event',
        publicEvent: 'lsp.event',
      })
    );
  router.registerValidated(
    'lsp.session.start',
    'client',
    (params, { session }) => lspCall('start', params, session),
  );
  router.registerValidated(
    'lsp.session.send',
    'client',
    (params, { session }) => lspCall('send', params, session),
  );
  router.registerValidated(
    'lsp.session.close',
    'client',
    (params, { session }) => lspCall('close', params, session),
  );

  router.registerValidated(
    'jupyter.status',
    'client',
    (params, { session }) =>
      guarded(() =>
        requestPortalToolForTarget(
          params,
          session.ownerContext.owner.id,
          'portal.jupyter.status',
        )
      ),
  );
  router.registerValidated(
    'jupyter.kernelspecs',
    'client',
    (params, { session }) =>
      guarded(() =>
        requestPortalToolForTarget(
          params,
          session.ownerContext.owner.id,
          'portal.jupyter.kernelspecs',
        )
      ),
  );
  router.registerValidated(
    'jupyter.session.create',
    'client',
    (params, { session }) =>
      guarded(() =>
        requestPortalToolForTarget(
          params,
          session.ownerContext.owner.id,
          'portal.jupyter.session',
        )
      ),
  );
  const jupyterCall = (action: 'execute' | 'close', params: unknown, session: RpcSession) =>
    guarded(() =>
      callPortalSession({
        session,
        params,
        channel: 'jupyter',
        portalMethod: `portal.jupyter.${action}`,
        portalEvent: 'portal.jupyter.event',
        publicEvent: 'jupyter.event',
      })
    );
  router.registerValidated(
    'jupyter.session.execute',
    'client',
    (params, { session }) => jupyterCall('execute', params, session),
  );
  router.registerValidated(
    'jupyter.session.close',
    'client',
    (params, { session }) => jupyterCall('close', params, session),
  );
  router.registerValidated(
    'portal.shutdown',
    'client',
    (params, { session }) =>
      guarded(async () => {
        const { portal } = resolvePortal(
          recordParams(params),
          session.ownerContext.owner.id,
        );
        return await services.portal.requestRpc(
          portal.portalId,
          'portal.shutdown',
          {},
        );
      }),
  );

  router.registerValidated('client.surface.update', 'client', (params, { session }) => {
    if (session.role !== 'client') {
      throw new Error('Expected a client RPC session.');
    }
    return updateClientToolHost(session.clientId, params) ?? null;
  });
};
