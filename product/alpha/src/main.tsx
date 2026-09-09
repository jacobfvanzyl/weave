import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './styles.css';

document.documentElement.classList.add('dark');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

if (import.meta.env.VITE_ALPHA_ACCEPTANCE === '1' && new URLSearchParams(location.search).has('acceptance')) {
  import('./acceptance').then(async ({ runShellAcceptance, runLiveShellAcceptance }) => {
    const state = window as unknown as { alphaAcceptance: unknown; alphaAcceptanceIndex?: number; alphaAcceptanceStage?: string; alphaAcceptanceInput?: import('./acceptance').LiveAcceptanceInput | import('./acceptance').LiveAcceptanceInput[] };
    if (new URLSearchParams(location.search).get('acceptance') === 'live') {
      while (!state.alphaAcceptanceInput) await new Promise((resolve) => setTimeout(resolve, 50));
      const inputs = Array.isArray(state.alphaAcceptanceInput) ? state.alphaAcceptanceInput : [state.alphaAcceptanceInput];
      const results = [];
      for (let index = 0; index < inputs.length; index++) {
        state.alphaAcceptanceIndex = index;
        state.alphaAcceptanceStage = undefined;
        const result = await runLiveShellAcceptance(inputs[index]);
        results.push({ hostUrl: inputs[index].hostUrl, ...result });
        if (!result.passed) break;
      }
      state.alphaAcceptance = { passed: results.length === inputs.length && results.every((result) => result.passed), hosts: results };
    } else state.alphaAcceptance = await runShellAcceptance();
  });
}
