import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { fileURLToPath, URL } from "node:url";
import { createWeaveClientDefines } from "../scripts/client-vite-env";

const desktopRoot = fileURLToPath(new URL(".", import.meta.url));
const workspaceRoot = fileURLToPath(new URL("..", import.meta.url));

export default defineConfig(({ mode }) => {
  const appEnv = loadEnv(mode, desktopRoot, "");
  const workspaceEnv = loadEnv(mode, workspaceRoot, "");

  return {
    define: createWeaveClientDefines({
      appEnv,
      shellEnv: process.env,
      workspaceEnv,
    }),
    plugins: [react(), tailwindcss()],
    resolve: {
      preserveSymlinks: false,
    },
  };
});
