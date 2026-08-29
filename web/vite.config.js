import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

const backend = process.env.MD2PDF_BACKEND || 'http://127.0.0.1:8002'
const proxy = {
  '/api': { target: backend, changeOrigin: true }
}

export default defineConfig({
  plugins: [vue()],
  server: {
    host: true,
    port: 5002,
    proxy
  },
  preview: {
    host: true,
    port: 5002,
    allowedHosts: true,
    proxy
  }
})
