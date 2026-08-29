<script setup>
import { ref } from 'vue'

const props = defineProps({
  node: { type: Object, required: true }, // { name, dirs: Map, files: [] }
  basePath: { type: String, default: '' }, // 当前节点对应的目录前缀
  taskMap: { type: Map, required: true },
  selected: { type: String, default: '' },
  depth: { type: Number, default: 0 }
})

const emit = defineEmits(['select'])

// 默认展开；折叠状态按目录完整路径记录
const collapsed = ref(false)

const STATUS_META = {
  pending: { icon: '⏳', title: '等待转换' },
  success: { icon: '✅', title: '转换成功' },
  failed: { icon: '❌', title: '转换失败' }
}

function fileIcon(name) {
  if (/\.md$/i.test(name)) return '📄'
  if (/\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(name)) return '🖼️'
  return '📎'
}

function fmtSize(bytes) {
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function statusOf(path) {
  const task = props.taskMap.get(path)
  if (!task) return null
  return STATUS_META[task.status] || null
}

function onFileClick(file) {
  if (/\.md$/i.test(file.name)) {
    emit('select', file.path)
  }
}
</script>

<template>
  <div class="node-wrap">
    <!-- 子目录 -->
    <div v-for="[name, dir] in node.dirs" :key="`d:${basePath}${name}/`" class="dir">
      <div
        class="row dir-row"
        :style="{ paddingLeft: depth * 14 + 6 + 'px' }"
        :title="`${basePath}${name}/`"
        :aria-expanded="!collapsed"
        @click="collapsed = !collapsed"
      >
        <span class="caret" :class="{ collapsed }">▸</span>
        <span class="icon">📁</span>
        <span class="name">{{ name }}</span>
      </div>
      <div class="children" :class="{ collapsed }">
        <TreeNode
          :node="dir"
          :base-path="`${basePath}${name}/`"
          :task-map="taskMap"
          :selected="selected"
          :depth="depth + 1"
          @select="emit('select', $event)"
        />
      </div>
    </div>

    <!-- 文件 -->
    <div
      v-for="file in node.files"
      :key="`f:${file.path}`"
      class="row file-row"
      :class="{ selected: selected === file.path, clickable: /\.md$/i.test(file.name) }"
      :style="{ paddingLeft: depth * 14 + 22 + 'px' }"
      :title="`${file.path}${fmtSize(file.size) ? ' · ' + fmtSize(file.size) : ''}`"
      @click="onFileClick(file)"
    >
      <span class="icon">{{ fileIcon(file.name) }}</span>
      <span class="name" :class="{ md: /\.md$/i.test(file.name) }">{{ file.name }}</span>
      <span v-if="statusOf(file.path)" class="status" :title="statusOf(file.path).title">
        {{ statusOf(file.path).icon }}
      </span>
    </div>
  </div>
</template>

<style scoped>
.row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-radius: 8px;
  line-height: 1.5;
  user-select: none;
  transition: background-color 120ms var(--ease);
}

.dir-row {
  cursor: pointer;
  font-weight: 600;
  color: #475569;
}

.dir-row:hover {
  background: #f1f5f9;
}

/* 目录展开/收起：平滑高度过渡 */
.children {
  display: grid;
  grid-template-rows: 1fr;
  transition: grid-template-rows 200ms var(--ease), opacity 180ms var(--ease);
  opacity: 1;
}

.children.collapsed {
  grid-template-rows: 0fr;
  opacity: 0;
}

.children > :deep(*) {
  overflow: hidden;
  min-height: 0;
}

.caret {
  display: inline-block;
  transition: transform 180ms var(--ease);
  font-size: 11px;
  color: #94a3b8;
  width: 12px;
}

.caret.collapsed {
  transform: rotate(-90deg);
}

.file-row.clickable {
  cursor: pointer;
}

.file-row.clickable:hover {
  background: #f1f5f9;
}

.file-row.selected {
  background: var(--accent-soft);
}

.file-row.selected .name {
  color: var(--accent);
  font-weight: 600;
}

.icon {
  flex-shrink: 0;
  font-size: 13px;
}

.name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink);
}

.name.md {
  color: #0f172a;
}

.status {
  flex-shrink: 0;
  font-size: 12px;
}
</style>
