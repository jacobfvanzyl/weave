import React from 'react';
import ReactDOM from 'react-dom/client';
import { Providers } from '@weave/client/app/providers';
import '@weave/client/styles/globals.css';
import { App } from './app/App';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Providers>
      <App />
    </Providers>
  </React.StrictMode>,
);
