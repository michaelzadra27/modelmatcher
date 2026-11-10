import { createRoot } from 'react-dom/client'
import App from './App'
import { hydrate } from './lib/store'
import './styles.css'

// Load saved work from IndexedDB before the first render so screens never flash empty.
hydrate().finally(() => createRoot(document.getElementById('root')!).render(<App />))
