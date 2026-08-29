// 后端 API 封装
async function request(url, options = {}) {
  const res = await fetch(url, options)
  const contentType = res.headers.get('content-type') || ''
  const data = contentType.includes('application/json') ? await res.json() : null

  if (!res.ok) {
    throw new Error((data && data.error) || `请求失败（HTTP ${res.status}）`)
  }
  return data
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

export async function convertText(markdown, filename, options) {
  const res = await fetch('/api/convert/text', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ markdown, filename, options })
  })

  if (!res.ok) {
    let message = `转换失败（HTTP ${res.status}）`
    try {
      const data = await res.json()
      if (data && data.error) message = data.error
    } catch { /* 非 JSON 响应 */ }
    throw new Error(message)
  }

  return res.blob()
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
