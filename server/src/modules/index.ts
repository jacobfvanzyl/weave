import { attachmentsModule } from './attachments/routes';
import { chatModule } from './chat/routes';
import { codeModule } from './code/routes';
import { editorContextModule } from './editor-context';
import { notesModule } from './notes/routes';
import { notificationsModule } from './notifications';
import { userArtifactsModule } from './user-artifacts/routes';
import { workspaceFilesModule } from './workspace-files';
import { workflowsModule } from './workflows/routes';

export const serverModules = [
  chatModule,
  codeModule,
  editorContextModule,
  notesModule,
  notificationsModule,
  userArtifactsModule,
  workspaceFilesModule,
  attachmentsModule,
  workflowsModule,
];
