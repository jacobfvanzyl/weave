import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

import { createWeaveClientDefines } from '../../scripts/client-vite-env';

const emptyEnvironment = {};

export default defineConfig({
  define: createWeaveClientDefines({
    appEnv: emptyEnvironment,
    shellEnv: emptyEnvironment,
    workspaceEnv: emptyEnvironment,
  }),
  plugins: [react(), tailwindcss()],
});
