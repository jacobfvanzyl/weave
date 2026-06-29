import React from 'react';
import ReactDOM from 'react-dom/client';
import { Providers } from '@weave/client/app/providers';
import { getClientAppDefinition } from '@weave/client/lib/client-app';
import '@weave/client/styles/globals.css';
import { App } from './app/App';

document.documentElement.dataset.weaveClientApp = getClientAppDefinition().id;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Providers>
      <App />
    </Providers>
  </React.StrictMode>,
);
