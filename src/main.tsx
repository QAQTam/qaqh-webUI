import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

// 不启用 StrictMode：SSE 连接在 effect 中建立，双调用会建立双份流。
createRoot(document.getElementById('root')!).render(<App />);
