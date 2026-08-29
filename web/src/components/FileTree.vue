<script setup>
import { computed } from 'vue'
import TreeNode from './TreeNode.vue'

const props = defineProps({
  // [{ path, size }] 任务内全部文件（含图片等资源）
  files: { type: Array, default: () => [] },
  // 转换任务（可空）：为 md 文件提供实时状态
  tasks: { type: Array, default: () => [] },
  selected: { type: String, default: '' }
})

const emit = defineEmits(['select'])

// 由扁平路径列表构建目录树（目录在前、文件在后，中文排序）
const root = computed(() => {
  const node = { name: '', dirs: new Map(), files: [] }

  for (const f of props.files) {
    const segs = f.path.split('/')
    let cur = node
    for (let i = 0; i < segs.length - 1; i += 1) {
      const seg = segs[i]
      if (!cur.dirs.has(seg)) {
        cur.dirs.set(seg, { name: seg, dirs: new Map(), files: [] })
      }
      cur = cur.dirs.get(seg)
    }
    cur.files.push({ name: segs[segs.length - 1], path: f.path, size: f.size })
  }

  const sortNode = (n) => {
    n.dirs = new Map([...n.dirs.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh-Hans-CN')))
    n.files.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
    n.dirs.forEach(sortNode)
  }
  sortNode(node)
  return node
})

// inputRel -> task 映射，供 md 文件显示转换状态
const taskMap = computed(() => {
  const map = new Map()
  props.tasks.forEach((t) => map.set(t.inputRel, t))
  return map
})
</script>

<template>
  <div class="tree">
    <div v-if="!files.length" class="tree-empty">暂无文件</div>
    <TreeNode
      v-else
      :node="root"
      base-path=""
      :task-map="taskMap"
      :selected="selected"
      :depth="0"
      @select="emit('select', $event)"
    />
  </div>
</template>

<style scoped>
.tree {
  font-size: 13px;
}

.tree-empty {
  color: var(--ink-soft);
  text-align: center;
  padding: 24px 0;
  font-size: 12.5px;
}
</style>
