export const sharedClientPackages = [
  '@ai-sdk/react',
  '@assistant-ui/core',
  '@assistant-ui/react',
  '@assistant-ui/react-ai-sdk',
  '@atomic-editor/editor',
  '@base-ui/react',
  '@blocksuite/blocks',
  '@blocksuite/presets',
  '@blocksuite/store',
  '@toeverything/theme',
  '@criblinc/docker-names',
  '@codemirror/autocomplete',
  '@codemirror/commands',
  '@codemirror/lang-css',
  '@codemirror/lang-html',
  '@codemirror/lang-javascript',
  '@codemirror/lang-json',
  '@codemirror/lang-markdown',
  '@codemirror/lang-yaml',
  '@codemirror/language',
  '@codemirror/lsp-client',
  '@codemirror/merge',
  '@codemirror/search',
  '@codemirror/state',
  '@codemirror/view',
  '@dnd-kit/core',
  '@dnd-kit/modifiers',
  '@dnd-kit/sortable',
  '@dnd-kit/utilities',
  '@excalidraw/excalidraw',
  '@lezer/common',
  '@lezer/highlight',
  '@lezer/lr',
  '@replit/codemirror-vim',
  '@tanstack/react-hotkeys',
  '@tanstack/react-query',
  'ai',
  'class-variance-authority',
  'clsx',
  'codemirror',
  'ghostty-web',
  'lucide-react',
  'react',
  'react-dom',
  'react-markdown',
  'rehype-raw',
  'rehype-sanitize',
  'remark-gfm',
  'shiki',
  'tailwind-merge',
  'tailwindcss',
  'yaml',
  'yjs',
  'zustand',
] as const;

export const mobileOnlySharedClientPackages = [
  '@capacitor/preferences',
] as const;

const allSharedClientPackages = [
  ...sharedClientPackages,
  ...mobileOnlySharedClientPackages,
] as const;

type SharedClientPackageOptions = {
  includeMobileOnly?: boolean;
};

export const isSharedClientPackage = (
  source: string,
  options: SharedClientPackageOptions = {},
) =>
  (options.includeMobileOnly ? allSharedClientPackages : sharedClientPackages)
    .some((packageName) =>
      source === packageName || source.startsWith(`${packageName}/`)
    );
