import React from 'react';
import ReactDOM from 'react-dom/client';
import { Capacitor } from '@capacitor/core';
import { App } from './App';
import './styles.css';

document.documentElement.classList.add('dark');

// The native shell says which device it runs on; in a browser, `?idiom=phone` stands in for it.
const idiom = new URLSearchParams(location.search).get('idiom');
if (!Capacitor.isNativePlatform() && (idiom === 'phone' || idiom === 'pad')) {
  document.documentElement.dataset.deviceIdiom = idiom;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
