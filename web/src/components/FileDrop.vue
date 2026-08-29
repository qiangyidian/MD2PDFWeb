<script setup>
import { ref } from 'vue'

const emit = defineEmits(['files'])

const input = ref(null)
const folderInput = ref(null)
const dragging = ref(false)
const dragDepth = ref(0)

// 收集要上传的条目：{ file, relPath }（relPath 为空表示散文件，只收 .md/.zip）
function emitItems(items) {
  const useful = items.filter((it) => {
    if (it.relPath) return true // 文件夹内的一切都收（图片等资源供相对引用）
    return /\.(md|zip)$/i.test(it.file.name)
  })
  if (useful.length) emit('files', useful)
}

function onDropFiles(fileList) {
  emitItems(Array.from(fileList || []).map((file) => ({ file, relPath: '' })))
}

function onChange(e) {
  onDropFiles(e.target.files)
  e.target.value = ''
}

function onFolderChange(e) {
  const items = Array.from(e.target.files || []).map((file) => ({
    file,
    relPath: file.webkitRelativePath || ''
  }))
  emitItems(items)
  e.target.value = ''
}

// 递归遍历拖入的目录（readEntries 每次最多返回 100 条，需循环读取）
async function readDirEntries(reader) {
  const all = []
  for (;;) {
    const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject))
    if (!batch.length) break
    all.push(...batch)
  }
  return all
}

async function traverseEntry(entry, basePath = '') {
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject))
    return [{ file, relPath: `${basePath}${entry.name}` }]
  }
  if (entry.isDirectory) {
    const entries = await readDirEntries(entry.createReader())
    const results = []
    for (const child of entries) {
      results.push(...(await traverseEntry(child, `${basePath}${entry.name}/`)))
    }
    return results
  }
  return []
}

async function onDrop(e) {
  dragDepth.value = 0
  dragging.value = false

  const entries = Array.from(e.dataTransfer?.items || [])
    .map((item) => (item.webkitGetAsEntry ? item.webkitGetAsEntry() : null))
    .filter(Boolean)

  if (!entries.length) {
    onDropFiles(e.dataTransfer?.files)
    return
  }

  const items = []
  for (const entry of entries) {
    items.push(...(await traverseEntry(entry)))
  }
  emitItems(items)
}

function onDragEnter() {
  dragDepth.value += 1
  dragging.value = true
}

function onDragLeave() {
  dragDepth.value = Math.max(0, dragDepth.value - 1)
  if (!dragDepth.value) dragging.value = false
}
</script>

<template>
  <div>
    <div
      class="dropzone"
      :class="{ dragging }"
      @dragover.prevent
      @dragenter.prevent="onDragEnter"
      @dragleave.prevent="onDragLeave"
      @drop.prevent="onDrop"
    >
      <input ref="input" type="file" multiple accept=".md,.zip" hidden @change="onChange" />
      <input
        ref="folderInput"
        type="file"
        multiple
        hidden
        webkitdirectory
        directory
        @change="onFolderChange"
      />
      <div class="dz-icon">📂</div>
      <div class="dz-main">拖拽 <b>.md 文件、.zip 压缩包</b> 或 <b>整个文件夹</b> 到这里</div>
      <div class="dz-sub">文件夹会递归读取全部内容并保留目录结构</div>
      <div class="dz-actions">
        <button class="btn btn-ghost" @click.stop="input?.click()">📄 选择文件</button>
        <button class="btn btn-primary" @click.stop="folderInput?.click()">📁 选择文件夹</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dropzone {
  border: 2px dashed #cbd5e1;
  border-radius: var(--radius);
  background: #fafbfc;
  padding: 34px 20px 28px;
  text-align: center;
  transition: all 0.15s ease;
}

.dropzone.dragging {
  border-color: var(--accent);
  background: var(--accent-soft);
  transform: scale(1.01);
}

.dz-icon {
  font-size: 32px;
  margin-bottom: 8px;
}

.dz-main {
  font-size: 15px;
}

.dz-main b {
  color: var(--accent);
}

.dz-sub {
  font-size: 12.5px;
  color: var(--ink-soft);
  margin-top: 4px;
}

.dz-actions {
  display: flex;
  justify-content: center;
  gap: 14px;
  margin-top: 16px;
  flex-wrap: wrap;
}
</style>
