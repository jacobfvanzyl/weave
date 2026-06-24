import { agentModule } from './agent/routes';
import { attachmentsModule } from './attachments/routes';
import { chatModule } from './chat/routes';
import { codeModule } from './code/routes';
import { notesModule } from './notes/routes';
import { portalModule } from './portal/routes';

export const serverModules = [
  chatModule,
  agentModule,
  codeModule,
  notesModule,
  portalModule,
  attachmentsModule,
];
