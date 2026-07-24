import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

// React StrictMode intentionally removed for local POS testing.
// StrictMode double-mounts components in development, which was causing
// document numbers to be consumed twice when opening a new document tab.
createRoot(document.getElementById('root')).render(<App />);
