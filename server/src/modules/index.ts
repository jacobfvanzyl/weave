import { attachmentsModule } from './attachments/routes';
import { chatModule } from './chat/routes';
import { codeModule } from './code/routes';
import { notesModule } from './notes/routes';

export const serverModules = [
  chatModule,
  codeModule,
  notesModule,
  attachmentsModule,
];
