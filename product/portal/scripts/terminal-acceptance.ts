import { TERMINAL_EVENT_METHOD, TERMINAL_RPC_METHODS } from '@weave/product-protocol';
import { pairPortalCredential, required, RpcResponseError, RpcSocket } from './rpc-client.ts';

const baseUrl = required('PORTAL_URL').replace(/\/$/, '');
const executionContextId = required('PORTAL_WORKSPACE_ID');
const marker = process.env['PORTAL_TERMINAL_ACCEPTANCE_MARKER']?.trim() || `WVE43_${crypto.randomUUID()}`;
const credential = await pairPortalCredential(
  baseUrl,
  required('PORTAL_PAIRING_TOKEN'),
  'Terminal acceptance',
);
const controller = await RpcSocket.open(`${baseUrl}/rpc`, credential);
const observer = await RpcSocket.open(`${baseUrl}/rpc`, credential);
let terminalId: string | undefined;
let controllerAttachmentId: string | undefined;
let observerAttachmentId: string | undefined;

const output = (socket: RpcSocket, expectedTerminalId: string) =>
  socket.notifications
    .filter((message) => message.method === TERMINAL_EVENT_METHOD)
    .map((message) =>
      message.params as {
        terminalId?: unknown;
        event?: { type?: unknown; data?: unknown };
      }
    )
    .filter((params) =>
      params.terminalId === expectedTerminalId &&
      params.event?.type === 'output'
    )
    .map((params) => new TextDecoder().decode(params.event?.data as Uint8Array))
    .join('');

try {
  const capabilities = await controller.request('portal.capabilities') as { capabilities: string[] };
  for (const capability of TERMINAL_RPC_METHODS) {
    if (!capabilities.capabilities.includes(capability)) {
      throw new Error(`Portal does not advertise ${capability}.`);
    }
  }

  const created = await controller.request('terminal.create', {
    executionContextId,
    cols: 91,
    rows: 27,
  }) as { terminal: { terminalId: string } };
  terminalId = created.terminal.terminalId;
  const controlled = await controller.request('terminal.attach', {
    executionContextId,
    terminalId,
    mode: 'shared',
  }) as { attachment: { attachmentId: string } };
  controllerAttachmentId = controlled.attachment.attachmentId;

  await observer.request('terminal.attach', { executionContextId, terminalId, mode: 'shared' });

  const observed = await observer.request('terminal.attach', {
    executionContextId,
    terminalId,
    mode: 'observe',
  }) as { attachment: { attachmentId: string } };
  observerAttachmentId = observed.attachment.attachmentId;

  await controller.request('terminal.resize', {
    executionContextId,
    terminalId,
    attachmentId: controllerAttachmentId,
    cols: 91,
    rows: 27,
  });
  let converged = false;
  for (let attempt = 0; attempt < 20 && !converged; attempt += 1) {
    await controller.request('terminal.input', {
      executionContextId,
      terminalId,
      attachmentId: controllerAttachmentId,
      data: new TextEncoder().encode(`printf '${marker}\\n'; stty size\r`),
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    converged = [controller, observer].every((socket) =>
      output(socket, terminalId as string).includes(marker) &&
      output(socket, terminalId as string).includes('27 91')
    );
  }
  if (!converged) {
    const snapshot = await controller.request('terminal.snapshot', {
      executionContextId,
      terminalId,
    }) as { snapshot: { data: Uint8Array } };
    throw new Error(
      `Terminal output did not converge. controller=${JSON.stringify(output(controller, terminalId))} ` +
        `observer=${JSON.stringify(output(observer, terminalId))} ` +
        `snapshot=${JSON.stringify(snapshot.snapshot.data)}`,
    );
  }

  await controller.request('terminal.detach', {
    executionContextId,
    terminalId,
    attachmentId: controllerAttachmentId,
  });
  controllerAttachmentId = undefined;
  await observer.request('terminal.detach', {
    executionContextId,
    terminalId,
    attachmentId: observerAttachmentId,
  });
  observerAttachmentId = undefined;

  const reattached = await observer.request('terminal.attach', {
    executionContextId,
    terminalId,
    mode: 'shared',
  }) as {
    attachment: { attachmentId: string };
    snapshot: { data: Uint8Array };
  };
  observerAttachmentId = reattached.attachment.attachmentId;
  if (new TextDecoder().decode(reattached.snapshot.data.subarray(0, 8)) !== 'GHOSTSNP') {
    throw new Error('Detached Terminal did not return an upstream binary snapshot.');
  }
  const listed = await observer.request('terminal.list', { executionContextId }) as {
    terminals: Array<{ terminalId: string }>;
  };
  if (!listed.terminals.some((terminal) => terminal.terminalId === terminalId)) {
    throw new Error('Detached Terminal did not persist in terminal.list.');
  }

  await observer.request('terminal.close', {
    executionContextId,
    terminalId,
    attachmentId: observerAttachmentId,
  });
  observerAttachmentId = undefined;
  terminalId = undefined;
  console.log(JSON.stringify({ ok: true, executionContextId, marker, clients: 2 }));
} finally {
  if (terminalId && controllerAttachmentId) {
    await controller.request('terminal.close', {
      executionContextId,
      terminalId,
      attachmentId: controllerAttachmentId,
    }).catch(() => undefined);
  } else if (terminalId && observerAttachmentId) {
    await observer.request('terminal.close', {
      executionContextId,
      terminalId,
      attachmentId: observerAttachmentId,
    }).catch(() => undefined);
  }
  await controller.request('credential.revoke').catch(() => undefined);
  controller.close();
  observer.close();
}
