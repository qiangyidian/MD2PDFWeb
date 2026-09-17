// 后端 API 封装
// 401 全局回调：会话过期时由 App.vue 切回登录页（避免每个调用点重复处理）
let onUnauthorized = null
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn
}

async function request(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      // 自定义头触发 CORS 预检的同时，也作为「同源 XHR」标记参与 CSRF 防线
      'X-Requested-With': 'XMLHttpRequest',
      ...(options.headers || {})
    }
  })
  const contentType = res.headers.get('content-type') || ''
  const data = contentType.includes('application/json') ? await res.json() : null

  if (!res.ok) {
    if (res.status === 401 && onUnauthorized) onUnauthorized()
    throw new Error((data && data.error) || `请求失败（HTTP ${res.status}）`)
  }
  return data
}

// ===== 认证 =====
// 下发邮箱验证码（purpose: 'register' | 'login'）
export function requestEmailCode(email, purpose) {
  return request('/api/auth/email/request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, purpose })
  })
}

export function register({ email, password, name, code }) {
  return request('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name, code })
  })
}

export function loginWithPassword({ email, password }) {
  return request('/api/auth/login/password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  })
}

export function loginWithEmailCode({ email, code }) {
  return request('/api/auth/login/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, code })
  })
}

export function logout() {
  return request('/api/auth/logout', { method: 'POST' })
}

export function fetchMe() {
  return request('/api/auth/me')
}

// items: [{ file, relPath }] — relPath 为文件夹内相对路径（保留目录结构），散文件为空串
export function uploadFiles(items) {
  const form = new FormData()
  items.forEach((it) => {
    form.append('files', it.file, it.relPath || it.file.name)
    form.append('path', it.relPath || '')
  })
  return request('/api/jobs', { method: 'POST', body: form })
}

export function getJob(id) {
  return request(`/api/jobs/${id}`)
}

// 全局队列水位（多用户排队透明化）
export function getQueueStats() {
  return request('/api/queue')
}

export function startJob(id, options) {
  return request(`/api/jobs/${id}/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options)
  })
}

export function cancelJob(id) {
  return request(`/api/jobs/${id}/cancel`, { method: 'POST' })
}

export function openEventStream(id, handlers, { onOpen, onError } = {}) {
  const es = new EventSource(`/api/jobs/${id}/events`)
  const dispatch = { snapshot: () => {}, ...handlers }

  Object.keys(dispatch).forEach((event) => {
    if (event === 'heartbeat') return
    es.addEventListener(event, (e) => {
      try {
        dispatch[event](JSON.parse(e.data))
      } catch {
        /* 忽略畸形消息 */
      }
    })
  })

  if (onOpen) es.onopen = onOpen
  if (onError) es.onerror = onError
  return es
}

export function fileUrl(jobId, name) {
  return `/api/jobs/${jobId}/files/${encodeURIComponent(name)}/download`
}

// 浏览器内嵌预览（Content-Disposition: inline）
export function pdfPreviewUrl(jobId, name) {
  return `/api/jobs/${jobId}/files/${encodeURIComponent(name)}/download?inline=1`
}

// Markdown 源文件在线预览（复用转换渲染管线）
export function mdPreviewUrl(jobId, path) {
  return `/api/jobs/${jobId}/preview?path=${encodeURIComponent(path)}`
}

export function jobZipUrl(jobId) {
  return `/api/jobs/${jobId}/download`
}

// ===== 管理后台（requireAdmin，403 由调用点提示） =====
export function adminStats() {
  return request('/api/admin/stats')
}

export function adminListUsers() {
  return request('/api/admin/users')
}

export function adminCreateUser({ email, password, name, role }) {
  return request('/api/admin/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name, role })
  })
}

export function adminSetRole(id, role) {
  return request(`/api/admin/users/${id}/role`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role })
  })
}

export function adminAdjustQuota(id, delta) {
  return request(`/api/admin/users/${id}/quota`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ delta })
  })
}

export function adminResetPassword(id) {
  return request(`/api/admin/users/${id}/password`, { method: 'POST' })
}

export function adminDeleteUser(id) {
  return request(`/api/admin/users/${id}`, { method: 'DELETE' })
}

export function adminListJobs() {
  return request('/api/admin/jobs')
}

export function adminCancelJob(id) {
  return request(`/api/admin/jobs/${id}/cancel`, { method: 'POST' })
}

export function adminDeleteJob(id) {
  return request(`/api/admin/jobs/${id}`, { method: 'DELETE' })
}
