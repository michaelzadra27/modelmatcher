import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Local-first model alias workbook tool. No backend.
export default defineConfig({
  plugins: [react()],
  server: { port: 5183, strictPort: true },
})
