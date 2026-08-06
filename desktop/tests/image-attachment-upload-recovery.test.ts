import { describe, expect, it, vi } from 'vitest';
import {
  createImageAttachmentAdapter,
} from '../../packages/client/src/lib/image-attachment-adapter';
import {
  ComposerAttachmentUploadRecovery,
} from '../../packages/client/src/lib/composer-attachment-upload-recovery';

describe('composer image upload recovery', () => {
  it('restores text and the pending image when deferred upload fails', async () => {
    const file = new File([
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ], 'screenshot.png', { type: 'image/png' });
    const state: { text: string; attachments: any[] } = {
      text: 'Please inspect this screenshot',
      attachments: [],
    };
    const composer = {
      getState: () => state,
      setText: (text: string) => {
        state.text = text;
      },
      addAttachment: vi.fn(async (restoredFile: File) => {
        state.attachments.push({ file: restoredFile, id: 'restored-image' });
      }),
    };
    const recovery = new ComposerAttachmentUploadRecovery();
    const uploadErrors: string[] = [];
    const adapter = createImageAttachmentAdapter({
      onSendError: async (error) => {
        await recovery.restore();
        uploadErrors.push(error instanceof Error ? error.message : String(error));
      },
    });
    const pending = await adapter.add({ file });
    state.attachments = [pending];
    recovery.capture(composer);

    vi.stubGlobal('window', {
      weaveDesktop: {
        rpcRequest: vi.fn(async () => {
          throw new Error('attachment storage unavailable');
        }),
      },
    });
    try {
      const sending = adapter.send(pending as any);
      state.text = '';
      state.attachments = [];

      await expect(sending).rejects.toThrow('attachment storage unavailable');
      expect(state.text).toBe('Please inspect this screenshot');
      expect(state.attachments).toEqual([{ file, id: 'restored-image' }]);
      expect(uploadErrors).toEqual(['attachment storage unavailable']);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
