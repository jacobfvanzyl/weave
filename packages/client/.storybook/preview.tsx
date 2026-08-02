import type { Decorator, Preview } from '@storybook/react-vite';

import '../src/styles/globals.css';

const applyStoryTheme = (theme: unknown) => {
  const dark = theme !== 'light';
  const root = document.documentElement;

  root.dataset.theme = dark ? 'mocha' : 'latte';
  root.dataset.weaveClientApp = 'weave';
  root.classList.toggle('dark', dark);
  root.style.colorScheme = dark ? 'dark' : 'light';
};

const withWeaveTheme: Decorator = (Story, context) => {
  applyStoryTheme(context.globals.theme);
  return <Story />;
};

const preview: Preview = {
  decorators: [withWeaveTheme],
  globalTypes: {
    theme: {
      description: 'Weave color theme',
      toolbar: {
        icon: 'paintbrush',
        items: [
          { value: 'dark', title: 'Dark' },
          { value: 'light', title: 'Light' },
        ],
      },
    },
  },
  initialGlobals: {
    theme: 'dark',
  },
  parameters: {
    a11y: {
      test: 'error',
    },
    layout: 'fullscreen',
  },
};

export default preview;
