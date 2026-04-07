import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../static',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/conversation': 'http://localhost:5000',
      '/history': 'http://localhost:5000',
      '/frontend_settings': 'http://localhost:5000',
      '/.auth': 'http://localhost:5000',
    },
  },
})
