import type { Context } from 'hono';
import { getOwner } from '../../owner/auth';
import { defineRoute, mountRoute } from '../../server/routes';
import type { ServerVariables } from '../../server/types';
import type { ServerModule } from '../types';
import {
  WorkflowControlError,
  type WorkflowControlService,
  workflowControlService,
  workflowDefinitionResponse,
  workflowRunEventResponse,
  workflowRunResponse,
} from '../../workflows/control-service';
import { type WorkflowDefinition, WorkflowDefinitionError } from '../../workflows/definition';

const optionalString = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;
type WorkflowRouteContext = Context<{ Variables: ServerVariables }>;

const parseJsonBody = async (c: WorkflowRouteContext) => {
  const body = await c.req.json().catch(() => undefined);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {};
  return body as Record<string, unknown>;
};

const parseDefinitionBody = (body: Record<string, unknown>) =>
  (body.definition && typeof body.definition === 'object' && !Array.isArray(body.definition)
    ? body.definition
    : body) as WorkflowDefinition;

const parseRunBody = (body: Record<string, unknown>) => ({
  input: body.input,
  requestId: optionalString(body.requestId),
  runId: optionalString(body.runId),
});

const parseLimit = (value: string | undefined) => {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
};

const parseAfterSequence = (value: string | undefined) => {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
};

const errorResponse = (c: WorkflowRouteContext, error: unknown) => {
  if (error instanceof WorkflowControlError) {
    return c.json({ error: error.message, code: error.code, details: error.details }, error.status as never);
  }
  if (error instanceof WorkflowDefinitionError) {
    return c.json({ error: error.message, code: 'invalid_definition' }, 400);
  }
  const message = error instanceof Error ? error.message : String(error);
  return c.json({ error: message }, 500);
};

export const createWorkflowRoutes = (service: WorkflowControlService = workflowControlService) => [
  defineRoute('/workflows', {
    method: 'GET',
    handler: async (c) => {
      const owner = getOwner(c);
      const definitions = await service.listDefinitions(owner.id);
      return c.json({ workflows: definitions.map(workflowDefinitionResponse) });
    },
  }),
  defineRoute('/workflows', {
    method: 'POST',
    handler: async (c) => {
      const owner = getOwner(c);
      const body = await parseJsonBody(c);
      try {
        const stored = await service.saveDefinition(owner.id, parseDefinitionBody(body));
        return c.json({ workflow: workflowDefinitionResponse(stored) }, 201);
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  defineRoute('/workflows/:workflowId', {
    method: 'GET',
    handler: async (c) => {
      const owner = getOwner(c);
      try {
        const stored = await service.getDefinition(owner.id, c.req.param('workflowId'));
        return c.json({ workflow: workflowDefinitionResponse(stored) });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  defineRoute('/workflows/:workflowId', {
    method: 'PUT',
    handler: async (c) => {
      const owner = getOwner(c);
      const workflowId = c.req.param('workflowId');
      const body = await parseJsonBody(c);
      const definition = parseDefinitionBody(body);
      if (definition.id !== workflowId) {
        return c.json({ error: 'Workflow id must match the route parameter.', code: 'invalid_definition' }, 400);
      }
      try {
        const stored = await service.saveDefinition(owner.id, definition);
        return c.json({ workflow: workflowDefinitionResponse(stored) });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  defineRoute('/workflows/:workflowId', {
    method: 'DELETE',
    handler: async (c) => {
      const owner = getOwner(c);
      await service.deleteDefinition(owner.id, c.req.param('workflowId'));
      return c.body(null, 204);
    },
  }),
  defineRoute('/workflows/:workflowId/runs', {
    method: 'POST',
    handler: async (c) => {
      const owner = getOwner(c);
      const body = await parseJsonBody(c);
      const runBody = parseRunBody(body);
      try {
        const run = await service.startRun({
          ownerId: owner.id,
          workflowId: c.req.param('workflowId'),
          input: runBody.input as never,
          requestId: runBody.requestId,
          runId: runBody.runId,
        });
        return c.json({ run: workflowRunResponse(run) }, 202);
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  defineRoute('/workflow-runs', {
    method: 'GET',
    handler: async (c) => {
      const owner = getOwner(c);
      const runs = await service.listRuns(owner.id, {
        workflowId: optionalString(c.req.query('workflowId')),
        limit: parseLimit(c.req.query('limit')),
      });
      return c.json({ runs: runs.map(workflowRunResponse) });
    },
  }),
  defineRoute('/workflow-runs/:runId', {
    method: 'GET',
    handler: async (c) => {
      const owner = getOwner(c);
      const run = await service.getRun(owner.id, c.req.param('runId'));
      if (!run) return c.json({ error: 'Workflow run was not found.', code: 'not_found' }, 404);
      return c.json({ run: workflowRunResponse(run) });
    },
  }),
  defineRoute('/workflow-runs/:runId/cancel', {
    method: 'POST',
    handler: async (c) => {
      const owner = getOwner(c);
      try {
        const run = await service.cancelRun(owner.id, c.req.param('runId'));
        return c.json({ run: workflowRunResponse(run) });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  defineRoute('/workflow-runs/:runId/events', {
    method: 'GET',
    handler: async (c) => {
      const owner = getOwner(c);
      try {
        const events = await service.listRunEvents(owner.id, c.req.param('runId'), {
          afterSequence: parseAfterSequence(c.req.query('afterSequence')),
          limit: parseLimit(c.req.query('limit')),
        });
        return c.json({ events: events.map(workflowRunEventResponse) });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
];

export const workflowRoutes = createWorkflowRoutes();

export const workflowsModule: ServerModule = {
  id: 'workflows',
  registerRoutes: (app) => {
    for (const route of workflowRoutes) mountRoute(app, route);
  },
};
