<script setup>
import { ref, computed, onBeforeUnmount } from 'vue'
import FileDrop from './components/FileDrop.vue'
import Workbench from './components/Workbench.vue'
import AuthView from './components/AuthView.vue'
import UserBadge from './components/UserBadge.vue'
import { uploadFiles, getJob, getQueueStats, startJob, cancelJob, openEventStream, fetchMe, logout, setUnauthorizedHandler } from './api'

// ---- 登录态：boot（会话恢复中）→ auth（未登录）→ app（已登录） ----
const boot = ref('loading') // loading | auth | app
const user = ref(null)
// 剩余可处理文件数（配额接口就绪后接上；null = 未接通，徽章显示占位）
const remainingQuota = ref(null)

// 会话过期（任意接口 401）→ 全局切回登录页
setUnauthorizedHandler(() => {
  user.value = null
  boot.value = 'auth'
  reset()
})

async function onAuthenticated(u) {
  user.value = u
  boot.value = 'app'
}

async function onLogout() {
  try {
    await logout()
  } catch { /* 会话已失效也照常退出 */ }
  user.value = null
  boot.value = 'auth'
  reset()
}

// 页面加载时恢复会话（Cookie 自动携带）
fetchMe()
  .then(({ user: u }) => {
    user.value = u
    boot.value = 'app'
  })
  .catch(() => {
    boot.value = 'auth'
  })

// ---- 文件转换流程状态 ----
const phase = ref('select') // select | uploading | ready | converting | finished
const jobId = ref('')
const error = ref('')
const allFiles = ref([]) // 任务内全部文件（含资源），驱动文件树
const archives = ref([])
const stats = ref({ total: 0, success: 0, failed: 0, skipped: 0 })
const currentFile = ref('')
const logs = ref([])
const tasks = ref([])
const jobError = ref('')
const jobStatus = ref('')
const queueInfo = ref(null) // { position, estimatedWaitSec, paused, message }
const startError = ref('') // 准入失败（429/503）提示
const selectedPath = ref('')
const landingQueue = ref(null) // 落地页队列水位展示
const options = ref({
  pageSize: 'A4',
  marginMm: 20,
  printBackground: true,
  recursive: true
})

let es = null

const converting = computed(() => phase.value === 'converting')
const finished = computed(() => phase.value === 'finished')

function pushLog(entry) {
  logs.value.push(entry)
  if (logs.value.length > 400) logs.value.shift()
}

function reset() {
  if (es) {
    es.close()
    es = null
  }
  phase.value = 'select'
  jobId.value = ''
  error.value = ''
  jobError.value = ''
  startError.value = ''
  queueInfo.value = null
  allFiles.value = []
  archives.value = []
  stats.value = { total: 0, success: 0, failed: 0, skipped: 0 }
  currentFile.value = ''
  logs.value = []
  tasks.value = []
  selectedPath.value = ''
  refreshLandingQueue()
}

async function onFiles(items) {
  reset()
  phase.value = 'uploading'

  try {
    const job = await uploadFiles(items)
    jobId.value = job.id
    jobStatus.value = job.status
    allFiles.value = job.allFiles || []
    archives.value = job.archives || []
    // 自动选中第一个 md：进入工作台即刻可见内容
    selectedPath.value = job.allMarkdown?.[0] || ''
    phase.value = 'ready'
  } catch (e) {
    error.value = e.message
    phase.value = 'select'
  }
}

async function begin() {
  if (!jobId.value) return
  error.value = ''
  startError.value = ''
  queueInfo.value = null
  logs.value = []
  currentFile.value = ''
  phase.value = 'converting'

  // 先建立 SSE 连接，再发起转换，避免错过早期事件
  listen()

  try {
    await startJob(jobId.value, options.value)
  } catch (e) {
    es?.close()
    es = null
    startError.value = e.message
    phase.value = 'ready'
  }
}

// SSE 实时点亮单个文件状态
function applyFileEvent(index, patch) {
  const task = tasks.value[index]
  if (task) Object.assign(task, patch)
}

function applySnapshot(s) {
  jobStatus.value = s.status
  stats.value = s.stats
  tasks.value = s.tasks
  if (s.queueInfo) queueInfo.value = s.queueInfo
}

function listen() {
  es = openEventStream(
    jobId.value,
    {
      // SSE 连接建立时的状态同步（含快速任务的终态兜底）
      snapshot: (s) => {
        if (['done', 'cancelled', 'failed'].includes(s.status)) {
          applySnapshot(s)
          if (s.status === 'failed') {
            jobError.value = s.error
          }
          phase.value = 'finished'
          es?.close()
          es = null
        } else {
          stats.value = s.stats
          tasks.value = s.tasks
          if (s.status === 'queued' && s.queueInfo) queueInfo.value = s.queueInfo
        }
      },
      // 排队中：位置/预计等待更新
      queued: (p) => {
        queueInfo.value = p
      },
      'queue-update': (p) => {
        queueInfo.value = p
      },
      // 离开队列开始渲染
      'job-start': () => {
        queueInfo.value = null
      },
      started: (p) => {
        queueInfo.value = null
        stats.value = { total: p.total, success: 0, failed: 0, skipped: 0 }
      },
      progress: (p) => {
        stats.value = {
          total: p.total,
          success: p.success,
          failed: p.failed,
          skipped: p.skipped
        }
        currentFile.value = p.currentFile
      },
      log: (entry) => pushLog(entry),
      'file-success': (p) => applyFileEvent(p.index, { status: 'success', missingImages: p.missingImages }),
      'file-error': (p) => applyFileEvent(p.index, { status: 'failed', error: p.error }),
      finished: async () => {
        await refresh()
      },
      cancelled: async () => {
        await refresh()
      },
      failed: (p) => {
        jobError.value = p.error
        jobStatus.value = 'failed'
        phase.value = 'finished'
        es?.close()
        es = null
      }
    },
    {
      onError: () => {
        // SSE 断开时若任务仍在进行，拉一次快照兜底
        if (phase.value === 'converting') {
          refresh().catch(() => {})
        }
      }
    }
  )
}

async function refresh() {
  es?.close()
  es = null
  try {
    const snapshot = await getJob(jobId.value)
    jobStatus.value = snapshot.status
    stats.value = snapshot.stats
    tasks.value = snapshot.tasks
    if (snapshot.status === 'failed') jobError.value = snapshot.error
    currentFile.value = ''
  } catch { /* 忽略 */ }
  phase.value = 'finished'
}

async function cancel() {
  if (!jobId.value) return
  try {
    await cancelJob(jobId.value)
  } catch { /* 状态由 SSE 兜底 */ }
}

// 落地页队列水位（每 20s 轻量刷新）
async function refreshLandingQueue() {
  try {
    landingQueue.value = await getQueueStats()
  } catch { /* 忽略 */ }
}

refreshLandingQueue()
const queueTimer = setInterval(refreshLandingQueue, 20000)

onBeforeUnmount(() => {
  es?.close()
  clearInterval(queueTimer)
})
</script>

<template>
  <!-- ============ 会话恢复中 ============ -->
  <div v-if="boot === 'loading'" class="boot">
    <span class="spinner" />
  </div>

  <!-- ============ 登录 / 注册 ============ -->
  <AuthView v-else-if="boot === 'auth'" @authenticated="onAuthenticated" />

  <!-- ============ 已登录：主应用 ============ -->
  <template v-else>
    <!-- ============ 全屏 IDE 工作台（上传成功后铺满视口） ============ -->
    <Transition name="wb">
      <div v-if="phase !== 'select' && phase !== 'uploading'" class="fullscreen">
        <Workbench
          v-model="options"
          :job-id="jobId"
          :all-files="allFiles"
          :tasks="tasks"
          :selected-path="selectedPath"
          :archives="archives"
          :stats="stats"
          :current-file="currentFile"
          :phase="phase"
          :job-error="jobError"
          :job-status="jobStatus"
          :queue-info="queueInfo"
          :start-error="startError"
          :user="user"
          :quota="remainingQuota"
          @logout="onLogout"
          @select="selectedPath = $event"
          @start="begin"
          @cancel="cancel"
          @reset="reset"
        />
      </div>
    </Transition>

    <!-- ============ 落地页 ============ -->
    <div class="page" :class="{ leaving: phase !== 'select' && phase !== 'uploading' }">
      <!-- 全局用户标识（右上角悬浮；quota 待配额接口接通） -->
      <div class="user-corner">
        <UserBadge :user="user" :quota="remainingQuota" @logout="onLogout" />
      </div>
      <header class="hero">
        <div class="logo">M↓</div>
        <h1>MD2PDF Web</h1>
        <p>在线 Markdown 批量转 PDF · 支持整文件夹上传 / 代码高亮 / 中文排版 / 在线预览对照</p>
      </header>

      <main class="container">
        <div class="card">
          <FileDrop :disabled="phase === 'uploading'" @files="onFiles" />
          <p v-if="phase === 'uploading'" class="hint uploading">
            <span class="spinner" /> 正在上传与整理目录…
          </p>
          <p v-if="error" class="error">{{ error }}</p>
          <p v-if="landingQueue && (landingQueue.queuedJobs || landingQueue.running)" class="queue-chip">
            🚦 当前 {{ landingQueue.running }} 路转换中 · {{ landingQueue.queuedJobs }} 个任务排队
            <template v-if="landingQueue.paused"> · 系统繁忙，新任务可能延迟</template>
          </p>
        </div>

        <footer class="footer">
          由 MD2PDF Web 提供服务 · 渲染引擎 markdown-it + Chromium · 任务文件保留 2 小时
        </footer>
      </main>
    </div>
  </template>
</template>

<style scoped>
/* ===== 全局用户标识（右上角悬浮）===== */
.user-corner {
  position: fixed;
  top: 14px;
  right: 16px;
  z-index: 50;
  animation: hero-in 480ms var(--ease) both;
}

/* ===== 会话恢复中 ===== */
.boot {
  min-height: 100dvh;
  display: flex;
  align-items: center;
  justify-content: center;
}

.link {
  border: none;
  background: transparent;
  color: var(--accent);
  cursor: pointer;
  padding: 0;
  font: inherit;
  font-size: inherit;
}

.link:hover {
  text-decoration: underline;
}

/* ===== 全屏工作台层 ===== */
.fullscreen {
  position: fixed;
  inset: 0;
  z-index: 40;
  background: var(--bg);
}

/* 转场：缩放 + 淡入，落地页同步后退 */
.wb-enter-active {
  transition: opacity 0.38s cubic-bezier(0.22, 1, 0.36, 1), transform 0.38s cubic-bezier(0.22, 1, 0.36, 1);
}

.wb-leave-active {
  transition: opacity 0.26s cubic-bezier(0.4, 0, 1, 1), transform 0.26s cubic-bezier(0.4, 0, 1, 1);
}

.wb-enter-from {
  opacity: 0;
  transform: scale(1.045);
}

.wb-leave-to {
  opacity: 0;
  transform: scale(0.97);
}

.page {
  min-height: 100dvh;
  transition: opacity 0.3s ease, transform 0.3s ease, filter 0.3s ease;
}

/* 工作台在场时落地页后退虚化（仍在文档流中，退出转场更顺滑） */
.page.leaving {
  opacity: 0;
  transform: scale(0.985);
  filter: blur(6px);
  pointer-events: none;
}

.hero {
  text-align: center;
  padding: 44px 16px 28px;
  animation: hero-in 480ms var(--ease) both;
}

@keyframes hero-in {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
}

.logo {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 52px;
  height: 52px;
  background: var(--accent);
  color: #fff;
  border-radius: 16px;
  font-size: 22px;
  font-weight: 800;
  margin-bottom: 12px;
  box-shadow: 0 4px 14px rgba(91, 141, 239, 0.32);
}

.hero h1 {
  margin: 0;
  font-size: 28px;
}

.hero p {
  margin: 8px 0 0;
  color: var(--ink-soft);
  font-size: 14px;
}

.container {
  max-width: 1160px;
  margin: 0 auto;
  padding: 0 20px 64px;
}

.hint {
  color: var(--ink-soft);
  font-size: 13.5px;
  margin: 12px 0 0;
}

.hint.uploading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 9px;
}

.spinner {
  width: 15px;
  height: 15px;
  border: 2px solid #e2e8f0;
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.error {
  color: var(--err);
  font-size: 13.5px;
  margin: 12px 0 0;
}

.queue-chip {
  margin: 12px 0 0;
  text-align: center;
  font-size: 12.5px;
  color: var(--ink-soft);
  background: #f1f5f9;
  border-radius: 8px;
  padding: 7px 12px;
}

.footer {
  text-align: center;
  color: #9ca3af;
  font-size: 12.5px;
  margin-top: 26px;
}
</style>
