import {createRoot} from 'react-dom/client';
import {registerSW} from 'virtual:pwa-register';
import App from './App.tsx';
import './index.css';

if (typeof window !== 'undefined' && !window.gestdepotDesktop?.isDesktop) {
  registerSW({immediate: true});
}

createRoot(document.getElementById('root')!).render(<App />);
