import type { Attachment } from '@assistant-ui/core';

type ComposerState = {
  text: string;
  attachments: readonly Attachment[];
};

export type ComposerAttachmentUploadRecoveryTarget = {
  getState: () => ComposerState;
  setText: (text: string) => void;
  addAttachment: (file: File) => Promise<void>;
};

type ComposerAttachmentUploadSnapshot = {
  target: ComposerAttachmentUploadRecoveryTarget;
  text: string;
  files: File[];
};

const attachmentFiles = (attachments: readonly Attachment[]) =>
  attachments.flatMap((attachment) => attachment.file ? [attachment.file] : []);

export class ComposerAttachmentUploadRecovery {
  private snapshot?: ComposerAttachmentUploadSnapshot;

  capture(target: ComposerAttachmentUploadRecoveryTarget) {
    const state = target.getState();
    this.snapshot = {
      target,
      text: state.text,
      files: attachmentFiles(state.attachments),
    };
  }

  async restore() {
    const snapshot = this.snapshot;
    if (!snapshot) return false;
    this.snapshot = undefined;

    const current = snapshot.target.getState();
    if (current.text.length === 0 && snapshot.text.length > 0) snapshot.target.setText(snapshot.text);

    const currentFiles = new Set(attachmentFiles(current.attachments));
    for (const file of snapshot.files) {
      if (currentFiles.has(file)) continue;
      await snapshot.target.addAttachment(file);
    }

    return true;
  }
}
