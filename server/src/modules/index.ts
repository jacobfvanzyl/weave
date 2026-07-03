import { attachmentsModule } from './attachments/routes';
import { chatModule } from './chat/routes';
import { codeModule } from './code/routes';
import { notesModule } from './notes/routes';
import { workspaceFilesModule } from './workspace-files';

export const serverModules = [
  chatModule,
  codeModule,
  notesModule,
  workspaceFilesModule,
  attachmentsModule,
];
