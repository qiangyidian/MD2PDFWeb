<script setup>
import { computed, ref } from 'vue'
import FileTree from './FileTree.vue'
import PreviewPane from './PreviewPane.vue'
import OptionsForm from './OptionsForm.vue'
import UserBadge from './UserBadge.vue'
import { fileUrl, jobZipUrl } from '../api'

const props = defineProps({
  jobId: { type: String, required: true },
  allFiles: { type: Array, default: () => [] },
  tasks: { type: Array, default: () => [] },
  selectedPath: { type: String, default: '' },
  archives: { type: Array, default: () => [] },
  stats: { type: Object, default: null },
  currentFile: { type: String, default: '' },
  phase: { type: String, required: true }, // ready | converting | finished
  jobError: { type: String, default: '' },
  jobStatus: { type: String, default: '' },
  // 排队状态（多用户消息队列）：{ position, estimatedWaitSec, paused, message }
  queueInfo: { type: Object, default: null },
  startError: { type: String, default: '' },
  // 当前登录用户（顶栏展示 + 登出）
  user: { type: Object, default: null },
  // 剩余可处理文件数（配额接口就绪后由 App 传入；null = 未接通显示占位）
  quota: { type: Number, default: null }
})

const options = defineModel({ type: Object, required: true })

const emit = defineEmits(['select', 'start', 'cancel', 'reset', 'logout'])

const selectedTask = computed(() =>
  props.tasks.find((t) => t.inputRel === props.selectedPath) || null
)

const isConverting = computed(() => props.phase === 'converting')
const isFinished = computed(() => props.phase === 'finished')

const successCount = computed(() => props.tasks.filter((t) => t.status === 'success').length)
const failedCount = computed(() => props.tasks.filter((t) => t.status === 'failed').length)
const doneCount = computed(() => successCount.value + failedCount.value)
// 转换前任务列表为空，用文件树里的 .md 数量兜底
const mdCount = computed(() =>
  props.tasks.length || props.allFiles.filter((f) => /\.md$/i.test(f.path)).length
)

const percent = computed(() => {
  if (!mdCount.value) return 0
  if (props.phase === 'finished') return 100
  return Math.min(100, Math.round((doneCount.value / mdCount.value) * 100))
})

const resultTitle = computed(() => {
  if (props.jobError) return '❌ 转换失败'
  if (props.jobStatus === 'cancelled') return '⏹ 已取消'
  if (failedCount.value) return '⚠️ 部分文件转换失败'
  return '🎉 转换完成'
})

// ===== 交互细节 =====
const confirmExit = ref(false)

// 等待时间人性化：>60s 显示 1分05秒
function fmtWait(sec) {
  if (!sec || sec < 60) return `~${sec || 0}s`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `~${m}分${s ? s + '秒' : ''}`
}

function onExitClick() {
  if (props.phase === 'converting') {
    confirmExit.value = true
    return
  }
  emit('reset')
}

function onConfirmExit() {
  confirmExit.value = false
  emit('cancel')
  emit('reset')
}
</script>

<template>
  <div class="wb">
    <!-- ====== 顶栏：品牌 | 进度/结果 | 设置 | 动作 ====== -->
    <header class="topbar">
      <div class="brand">
        <span class="logo">M↓</span>
        <span class="brand-name">MD2PDF</span>
      </div>
      <div class="mid">
        <!-- 就绪 -->
        <template v-if="phase === 'ready'">
          <div class="prog-line">
            <span class="dot ok" />
            <span class="state ok">已就绪</span>
            <span class="meta">{{ mdCount }} 个 Markdown · {{ allFiles.length }} 个文件</span>
          </div>
        </template>

        <!-- 转换中 -->
        <template v-else-if="isConverting">
          <!-- 排队中：显示位置与预计等待 -->
          <template v-if="queueInfo">
            <div class="prog-line">
              <span class="state" :class="queueInfo.paused ? 'warn' : 'busy'">
                {{ queueInfo.paused ? '🚦 系统繁忙' : '⏳ 排队中' }}
              </span>
              <span class="meta">
                第 {{ queueInfo.position }} 位 · 预计等待 {{ fmtWait(queueInfo.estimatedWaitSec) }}
                <template v-if="queueInfo.message"> · {{ queueInfo.message }}</template>
              </span>
            </div>
            <div class="prog-bar">
              <div class="prog-fill queue" :style="{ width: '100%' }" />
            </div>
          </template>
          <template v-else>
            <div class="prog-line">
              <span class="state busy">转换中</span>
              <span class="meta mono ellipsis" :title="currentFile">{{ currentFile || '准备中…' }}</span>
              <span class="meta nums">{{ doneCount }}/{{ mdCount }}</span>
              <span class="pct">{{ percent }}%</span>
            </div>
            <div class="prog-bar">
              <div class="prog-fill" :style="{ width: percent + '%' }" />
            </div>
          </template>
        </template>

        <!-- 完成 -->
        <template v-else>
          <div class="prog-line">
            <span class="state" :class="{ ok: !failedCount && !jobError, warn: failedCount || jobError }">
              {{ resultTitle }}
            </span>
            <span class="meta nums">
              成功 {{ stats?.success ?? 0 }} · 失败 {{ stats?.failed ?? 0 }} · 跳过 {{ stats?.skipped ?? 0 }}
            </span>
          </div>
          <div class="prog-bar">
            <div
              class="prog-fill"
              :class="{ done: !failedCount && !jobError, err: failedCount || jobError }"
              :style="{ width: percent + '%' }"
            />
          </div>
        </template>

        <div v-if="jobError" class="job-error">{{ jobError }}</div>
        <div v-if="startError" class="job-error">{{ startError }}</div>
      </div>

      <!-- 设置（转换开始后锁定） -->
      <div class="settings" :class="{ locked: phase !== 'ready' }">
        <OptionsForm v-model="options" compact />
      </div>

      <!-- 动作 -->
      <div class="actions">
        <UserBadge
          v-if="user"
          :user="user"
          :quota="quota"
          @logout="emit('logout')"
        />
        <button v-if="phase === 'ready'" class="btn btn-primary btn-start" @click="emit('start')">
          🚀 开始转换
        </button>
        <button v-else-if="isConverting" class="btn btn-ghost" @click="emit('cancel')">取消</button>
        <template v-else>
          <a class="link" :href="fileUrl(jobId, 'log')" title="下载转换日志">convert-log.txt</a>
          <a v-if="successCount" class="btn btn-primary" :href="jobZipUrl(jobId)">
            ⬇️ 下载全部 PDF（{{ successCount }}）
          </a>
        </template>
        <button
          class="btn btn-ghost btn-icon"
          :title="phase === 'finished' ? '开始新任务' : '退出'"
          :aria-label="phase === 'finished' ? '开始新任务' : '退出'"
          @click="onExitClick"
        >✕</button>
      </div>
    </header>

    <!-- 退出确认（转换中防误触，M3 对话框） -->
    <Teleport to="body">
      <Transition name="dlg">
        <div v-if="confirmExit" class="dlg-scrim" @click.self="confirmExit = false">
          <div class="dlg" role="dialog" aria-modal="true" aria-label="退出确认">
            <h3 class="dlg-title">退出当前任务？</h3>
            <p class="dlg-text">
              任务仍在排队/转换中，退出后需重新上传才能再次查看。确定要退出吗？
            </p>
            <div class="dlg-actions">
              <button class="btn btn-ghost" @click="confirmExit = false">继续转换</button>
              <button class="btn btn-primary" @click="onConfirmExit">退出并取消任务</button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>

    <!-- ====== 三栏：目录树 | 源文件 | PDF ====== -->
    <div class="panels">
      <aside class="panel side">
        <div class="panel-head">
          <span>资源管理器</span>
          <span class="badge">
            <template v-if="isConverting || isFinished">✅{{ successCount }} ❌{{ failedCount }}</template>
            <template v-else>{{ allFiles.length }} 文件</template>
          </span>
        </div>
        <div v-if="archives.length" class="archives" :title="archives.join('、')">
          📦 {{ archives.join('、') }}
        </div>
        <div class="panel-body">
          <FileTree :files="allFiles" :tasks="tasks" :selected="selectedPath" @select="emit('select', $event)" />
        </div>
      </aside>

      <section class="panel">
        <PreviewPane
          :job-id="jobId"
          :selected-path="selectedPath"
          :task="selectedTask"
          :finished="isFinished"
          view="md"
        />
      </section>

      <section class="panel">
        <PreviewPane
          :job-id="jobId"
          :selected-path="selectedPath"
          :task="selectedTask"
          :finished="isFinished"
          :options="options"
          view="pdf"
        />
      </section>
    </div>
  </div>
</template>

<style scoped>
.wb {
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px;
}

/* ---- 顶栏 ---- */
.topbar {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: #fbfcfe;
  padding: 9px 14px;
  box-shadow: var(--shadow-1);
  flex-shrink: 0;
}

.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.logo {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  background: var(--accent);
  color: #fff;
  border-radius: 8px;
  font-size: 12px;
  font-weight: 800;
}

.brand-name {
  font-weight: 800;
  font-size: 14px;
  letter-spacing: 0.02em;
}

.mid {
  flex: 1 1 280px;
  min-width: 200px;
  display: flex;
  flex-direction: column;
  gap: 5px;
  justify-content: center;
}

.prog-line {
  display: flex;
  align-items: baseline;
  gap: 10px;
  font-size: 12.5px;
  min-width: 0;
}

.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
  align-self: center;
}

.dot.ok {
  background: var(--ok);
  box-shadow: 0 0 0 3px rgba(22, 163, 74, 0.15);
}

.state {
  font-weight: 800;
  flex-shrink: 0;
}

.state.ok { color: var(--ok); }
.state.busy { color: var(--accent); }
.state.warn { color: var(--warn); }

.meta {
  color: var(--ink-soft);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.meta.mono {
  font-family: 'SF Mono', Consolas, monospace;
  font-size: 12px;
  flex: 1;
  min-width: 0;
}

.nums {
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}

.pct {
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}

.prog-bar {
  height: 4px;
  background: #e8ecf1;
  border-radius: 999px;
  overflow: hidden;
}

.prog-fill {
  height: 100%;
  background: var(--accent);
  border-radius: 999px;
  transition: width 0.35s var(--ease);
}

.prog-fill.done { background: var(--ok); }
.prog-fill.err { background: var(--warn); }

/* 排队中：MD3 不定进度条（滑块往复，柔和天蓝） */
.prog-fill.queue {
  background: #93b8f5;
  width: 40% !important;
  animation: queue-slide 1.4s var(--ease) infinite;
}

@keyframes queue-slide {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(250%); }
}

.job-error {
  font-size: 12px;
  color: var(--err);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.settings {
  flex: 0 1 auto;
  transition: opacity 0.2s ease;
}

.settings.locked {
  opacity: 0.55;
  pointer-events: none;
}

.actions {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-left: auto;
  flex-shrink: 0;
  flex-wrap: wrap;
}

.actions .btn-primary {
  text-decoration: none;
}

.btn-start {
  padding: 9px 24px;
}

/* ---- M3 对话框 ---- */
.dlg-scrim {
  position: fixed;
  inset: 0;
  z-index: 100;
  background: rgba(15, 23, 42, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  backdrop-filter: blur(2px);
}

.dlg {
  background: #fff;
  border-radius: 24px;
  padding: 24px;
  width: min(400px, 100%);
  box-shadow: 0 8px 32px rgba(15, 23, 42, 0.28);
}

.dlg-title {
  margin: 0 0 10px;
  font-size: 18px;
  font-weight: 700;
}

.dlg-text {
  margin: 0 0 22px;
  font-size: 13.5px;
  color: var(--ink-soft);
  line-height: 1.7;
}

.dlg-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.dlg-enter-active,
.dlg-leave-active {
  transition: opacity 200ms var(--ease);
}

.dlg-enter-active .dlg,
.dlg-leave-active .dlg {
  transition: transform 200ms var(--ease), opacity 200ms var(--ease);
}

.dlg-enter-from,
.dlg-leave-to {
  opacity: 0;
}

.dlg-enter-from .dlg,
.dlg-leave-to .dlg {
  transform: scale(0.92);
  opacity: 0;
}

.link {
  font-size: 12px;
  color: var(--ink-soft);
  white-space: nowrap;
}

.link:hover {
  color: var(--accent);
}

/* ---- 三栏 ---- */
.panels {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: clamp(190px, 17vw, 270px) minmax(0, 1fr) minmax(0, 1fr);
  gap: 10px;
}

.panel {
  border: 1px solid var(--line);
  border-radius: 12px;
  background: #fff;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: var(--shadow-1);
}

.side {
  background: #fbfcfe;
}

.panel-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  padding: 9px 12px;
  font-size: 12px;
  font-weight: 700;
  color: #475569;
  border-bottom: 1px solid #eef2f7;
  flex-shrink: 0;
}

.badge {
  font-size: 11px;
  font-weight: 600;
  color: var(--ink-soft);
  background: #eef2f7;
  border-radius: 999px;
  padding: 2px 8px;
  white-space: nowrap;
}

.archives {
  font-size: 11.5px;
  color: var(--ink-soft);
  background: #f1f5f9;
  border-radius: 7px;
  padding: 5px 9px;
  margin: 8px 10px 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex-shrink: 0;
}

.panel-body {
  flex: 1;
  overflow-y: auto;
  padding: 5px;
  min-height: 0;
}

/* PreviewPane 填满面板 */
.panel :deep(.preview) {
  height: 100%;
  min-height: 0;
  padding: 10px;
}

.panel :deep(.placeholder) {
  min-height: 140px;
  border-style: solid;
  border-color: #f1f5f9;
}

.panel :deep(.panes) {
  min-height: 0;
}

.panel :deep(.pane) {
  min-height: 0;
  flex: 1;
}

.panel :deep(.frame-box) {
  min-height: 0;
}

.panel :deep(.frame-box iframe) {
  min-height: 0;
  height: 100%;
}

/* ---- 自适应：窄屏纵向堆叠，整体滚动 ---- */
@media (max-width: 980px) {
  .wb {
    height: 100dvh;
    overflow: hidden;
  }

  .panels {
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
  }

  .side {
    flex-shrink: 0;
    max-height: 260px;
  }

  .panel:not(.side) {
    flex: 0 0 auto;
    min-height: 380px;
  }

  .actions {
    margin-left: 0;
  }
}
</style>
