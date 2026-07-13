import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { APP_NAME } from '../../shared/appName';
import App from './App';
import './index.css';
import { AppStateProvider } from './state';

document.title = APP_NAME;

// PWA bits only work in a secure context (https or localhost). Over plain
// http on a LAN IP we skip registration entirely; the app stays fully
// usable as a normal web page.
if (window.isSecureContext && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* PWA is optional; ignore */
    });
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HashRouter>
      <AppStateProvider>
        <App />
      </AppStateProvider>
    </HashRouter>
  </StrictMode>,
);
