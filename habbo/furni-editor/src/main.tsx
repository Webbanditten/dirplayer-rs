import { createRoot } from 'react-dom/client';
import { App } from './App';
import { logoSvg } from './components/Icon';
import './styles.css';

// The favicon is the logo.
const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
if (icon) icon.href = 'data:image/svg+xml,' + encodeURIComponent(logoSvg());

createRoot(document.getElementById('root')!).render(<App />);
