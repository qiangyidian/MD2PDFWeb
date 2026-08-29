<script setup>
import { computed, ref, watch } from 'vue'
import { mdPreviewUrl, pdfPreviewUrl, fileUrl } from '../api'

const props = defineProps({
  jobId: { type: String, required: true },
  // 选中的 md 相对路径；空表示未选中
  selectedPath: { type: String, default: '' },
  // 选中文件对应的转换任务（可能尚未转换：null）
  task: { type: Object, default: null },
  // 任务是否已结束（决定是否自动切换到对比视图）
  finished: { type: Boolean, default: false },
  // 'both'：单面板内三态切换（源文件/PDF/对比）
  // 'md' | 'pdf'：IDE 布局下固定渲染某一侧（忽略三态）
  view: { type: String, default: 'both' },
  // 右栏转换前的 A4 纸张排版预览所需的当前设置
  options: { type: Object, default: null }
})

const mdLoaded = ref(false)
const pdfLoaded = ref(false)

const canPdf = computed(() => !!props.task && props.task.status === 'success')
const hasMissingImages = computed(() => !!props.task?.missingImages?.length)

// 挂载时即处于完成态（结果页新挂载）则直接进入对比视图
const mode = ref(canPdf.value && props.finished ? 'split' : 'md')

// 选中变化：加载态复位 + 视图自动切换
watch(() => props.selectedPath, () => {
  mdLoaded.value = false
  pdfLoaded.value = false
  mode.value = canPdf.value && props.finished ? 'split' : 'md'
})

// IDE 双栏模式：文件转换成功瞬间即为该文件重置 PDF 加载遮罩
watch(canPdf, (val) => {
  if (val) pdfLoaded.value = false
})

watch(canPdf, (val) => {
  if (val && props.finished && mode.value === 'md') mode.value = 'split'
})

// 任务结束时若还停在源文件视图，自动切到对比视图
watch(() => props.finished, (val) => {
  if (val && canPdf.value && mode.value === 'md') mode.value = 'split'
})

const mdSrc = computed(() =>
  props.selectedPath ? mdPreviewUrl(props.jobId, props.selectedPath) : ''
)

// 转换前右栏：与转换一致的 A4/Letter 纸张排版实时预览（跟随当前设置）
const paperSrc = computed(() => {
  if (!props.selectedPath) return ''
  const o = props.options || {}
  const qs = new URLSearchParams({
    style: 'print',
    pageSize: o.pageSize || 'A4',
    marginMm: String(o.marginMm ?? 20),
    printBackground: String(o.printBackground !== false)
  })
  return `${mdPreviewUrl(props.jobId, props.selectedPath)}&${qs}`
})

const pdfSrc = computed(() =>
  canPdf.value ? pdfPreviewUrl(props.jobId, props.task.index) : ''
)

const fileName = computed(() => {
  if (!props.selectedPath) return ''
  return props.selectedPath.split('/').pop()
})

// 当前应显示哪些面板：view 固定指定某一侧，'both' 走三态切换
const showMd = computed(() =>
  props.view === 'pdf' ? false : props.view === 'md' ? true : mode.value !== 'pdf'
)
const showPdf = computed(() =>
  props.view === 'pdf' ? true : props.view === 'md' ? false : mode.value !== 'md'
)
</script>

<template>
  <div class="preview">
    <!-- 未选中 -->
    <div v-if="!selectedPath" class="placeholder">
      <div class="ph-icon">📄</div>
      <div class="ph-main">在左侧选择一个 <b>.md 文件</b> 开始预览</div>
      <div class="ph-sub">中间为源文件渲染效果 · 右侧为纸张排版与 PDF 结果对照</div>
    </div>

    <template v-else>
      <!-- 工具栏（仅三态模式显示） -->
      <div v-if="view === 'both'" class="toolbar">
        <div class="modes">
          <button class="mode" :class="{ active: mode === 'md' }" @click="mode = 'md'">
            📄 源文件
          </button>
          <button
            class="mode"
            :class="{ active: mode === 'pdf', disabled: !canPdf }"
            :disabled="!canPdf"
            :title="canPdf ? '' : task?.status === 'failed' ? '该文件转换失败' : '转换完成后可查看'"
            @click="canPdf && (mode = 'pdf')"
          >
            📕 PDF
          </button>
          <button
            class="mode"
            :class="{ active: mode === 'split', disabled: !canPdf }"
            :disabled="!canPdf"
            @click="canPdf && (mode = 'split')"
          >
            🪞 对比
          </button>
        </div>

        <span class="fname" :title="selectedPath">{{ fileName }}</span>

        <a
          v-if="canPdf"
          class="btn btn-ghost btn-sm"
          :href="fileUrl(jobId, String(task.index))"
        >⬇️ 下载 PDF</a>
      </div>

      <div v-if="hasMissingImages" class="warn-tip">
        ⚠️ 该文件有 {{ task.missingImages.length }} 张图片未能加载（转换时缺失）
      </div>
      <div v-else-if="task && task.status === 'failed'" class="error-tip">
        ❌ 转换失败：{{ task.error }}
      </div>

      <!-- 内容区 -->
      <div class="panes" :class="{ split: view === 'both' && mode === 'split' }">
        <div v-if="showMd" class="pane">
          <div v-if="view !== 'both'" class="pane-label">
            {{ view === 'md' ? '📄 Markdown 源文件' : 'Markdown 源文件（渲染预览）' }}
          </div>
          <div class="frame-box">
            <div v-if="!mdLoaded" class="skeleton loading" aria-label="加载中">
              <div class="sk-lines">
                <span class="sk-line" style="width: 34%" />
                <span class="sk-line" style="width: 88%" />
                <span class="sk-line" style="width: 76%" />
                <span class="sk-line" style="width: 92%" />
                <span class="sk-line" style="width: 60%" />
              </div>
            </div>
            <iframe
              :key="`md:${selectedPath}`"
              :src="mdSrc"
              title="MD 预览"
              @load="mdLoaded = true"
            />
          </div>
        </div>

        <div v-if="showPdf" class="pane">
          <div v-if="view !== 'both'" class="pane-label">
            {{ canPdf ? '📕 PDF 转换结果' : '📄 纸张排版预览（转换前）' }}
          </div>
          <div class="frame-box" :class="{ paper: !canPdf && view === 'pdf' }">
            <div v-if="canPdf && !pdfLoaded" class="skeleton loading" aria-label="加载中">
              <div class="sk-lines">
                <span class="sk-line" style="width: 30%" />
                <span class="sk-line" style="width: 84%" />
                <span class="sk-line" style="width: 70%" />
                <span class="sk-line" style="width: 90%" />
                <span class="sk-line" style="width: 55%" />
              </div>
            </div>
            <iframe
              v-if="canPdf"
              :key="`pdf:${task.index}`"
              :src="pdfSrc"
              title="PDF 预览"
              @load="pdfLoaded = true"
            />
            <!-- 转换前：与 PDF 同参数的纸张化实时排版预览 -->
            <iframe
              v-else-if="task?.status !== 'failed'"
              :key="`paper:${selectedPath}:${options?.pageSize}:${options?.marginMm}`"
              :src="paperSrc"
              title="纸张排版预览"
            />
            <div v-else class="empty-pdf">
              <div class="ep-icon">❌</div>
              <div>该文件转换失败：{{ task.error }}</div>
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.preview {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 380px;
}

.placeholder {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  color: var(--ink-soft);
  border: 1px dashed var(--line);
  border-radius: 10px;
  min-height: 300px;
}

.ph-icon {
  font-size: 34px;
  margin-bottom: 4px;
}

.ph-main {
  font-size: 14px;
}

.ph-main b {
  color: var(--accent);
}

.ph-sub {
  font-size: 12px;
  color: var(--ink-faint);
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}

.modes {
  display: inline-flex;
  background: #f1f5f9;
  border-radius: 9px;
  padding: 3px;
  gap: 2px;
}

.mode {
  border: 0;
  background: transparent;
  padding: 5px 12px;
  border-radius: 7px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--ink-soft);
  cursor: pointer;
  white-space: nowrap;
}

.mode.active {
  background: #fff;
  color: var(--accent);
  box-shadow: 0 1px 2px rgba(16, 24, 40, 0.12);
}

.mode.disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.fname {
  flex: 1;
  font-size: 12.5px;
  color: var(--ink-soft);
  font-family: 'SF Mono', Consolas, monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.warn-tip,
.error-tip {
  font-size: 12.5px;
  border-radius: 8px;
  padding: 7px 12px;
  margin-bottom: 8px;
}

.warn-tip {
  background: #fffbeb;
  color: #92400e;
}

.error-tip {
  background: #fef2f2;
  color: #b91c1c;
}

.panes {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
}

.panes.split {
  flex-direction: row;
}

.pane {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 320px;
}

.pane-label {
  font-size: 11.5px;
  font-weight: 700;
  color: #94a3b8;
  letter-spacing: 0.04em;
  margin-bottom: 5px;
  text-transform: uppercase;
}

.frame-box {
  position: relative;
  flex: 1;
  border: 1px solid var(--line);
  border-radius: 10px;
  overflow: hidden;
  background: #f8fafc;
  min-height: 300px;
}

.frame-box iframe {
  display: block;
  width: 100%;
  height: 100%;
  min-height: 300px;
  border: 0;
  background: #fff;
}

.loading {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #f8fafc;
  z-index: 1;
}

/* 骨架行：模拟文档版式 */
.sk-lines {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: min(420px, 70%);
}

.sk-line {
  height: 12px;
  border-radius: 6px;
}

/* 纸张预览底色：模拟桌面，衬托白纸 */
.frame-box.paper {
  background: #e8ebef;
}

.frame-box.paper iframe {
  background: transparent;
}

.empty-pdf {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--ink-soft);
  font-size: 13px;
  background: repeating-linear-gradient(-45deg, #fafbfc, #fafbfc 12px, #f4f6f8 12px, #f4f6f8 24px);
}

.ep-icon {
  font-size: 26px;
}

@media (max-width: 860px) {
  .panes.split {
    flex-direction: column;
  }
}
</style>
