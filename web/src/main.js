import { createApp } from 'vue'
import App from './App.vue'
import './style.css'

const app = createApp(App)

// ===== Material 涟漪反馈：全局注入，凡可点元素自动生效 =====
const RIPPLE_SELECTOR = '.btn, .tab, .mode, .file-row.clickable, .dir-row, .dz-btn'

document.addEventListener('pointerdown', (e) => {
  const target = e.target instanceof Element ? e.target.closest(RIPPLE_SELECTOR) : null
  if (!target || target.disabled) return

  const rect = target.getBoundingClientRect()
  const size = Math.max(rect.width, rect.height) * 2
  const ink = document.createElement('span')
  ink.className = 'ripple-ink'
  ink.style.width = ink.style.height = `${size}px`
  ink.style.left = `${e.clientX - rect.left - size / 2}px`
  ink.style.top = `${e.clientY - rect.top - size / 2}px`

  target.classList.add('has-ripple')
  target.appendChild(ink)
  setTimeout(() => ink.remove(), 600)
}, { passive: true })

app.mount('#app')
