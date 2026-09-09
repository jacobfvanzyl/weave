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
  import('./acceptance').then(async ({ runShellAcceptance }) => {
    (window as unknown as { alphaAcceptance: unknown }).alphaAcceptance = await runShellAcceptance();
  });
}
