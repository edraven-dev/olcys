import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
// oxlint-disable-next-line import/no-unassigned-import -- global stylesheet, bundled by Vite
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root element missing');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
