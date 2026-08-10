import { chatModule } from './chat/routes';
import { codeModule } from './code/routes';
import { notesModule } from './notes/routes';
import { workspaceCompositionModule } from './workspace-composition/index.ts';

export const serverModules = [
  chatModule,
  codeModule,
  notesModule,
  workspaceCompositionModule,
];
