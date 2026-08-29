<script setup>
import { ref } from 'vue'
import OptionsForm from './OptionsForm.vue'
import { convertText } from '../api'

const markdown = ref('# 示例标题\n\n在这里粘贴你的 **Markdown** 内容…\n')
const filename = ref('document')
const converting = ref(false)
const error = ref('')
const options = ref({
  pageSize: 'A4',
  marginMm: 20,
  printBackground: true,
  recursive: true
})

async function convert() {
  if (converting.value) return
  converting.value = true
  error.value = ''

  try {
    const blob = await convertText(markdown.value, filename.value || 'document', options.value)
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${(filename.value || 'document').replace(/\.md$/i, '')}.pdf`
    a.click()
    URL.revokeObjectURL(url)
  } catch (e) {
    error.value = e.message || '转换失败'
  } finally {
    converting.value = false
  }
}
</script>

<template>
  <div>
    <div class="text-head">
      <label class="name-field">
        <span>文件名</span>
        <input v-model="filename" type="text" placeholder="document" />
      </label>
    </div>

    <textarea
      v-model="markdown"
      class="editor"
      spellcheck="false"
      placeholder="在此粘贴 Markdown 文本…"
    />

    <div class="bottom">
      <OptionsForm v-model="options" compact />
      <button class="btn btn-primary" :disabled="converting || !markdown.trim()" @click="convert">
        {{ converting ? '转换中…' : '转换为 PDF 并下载' }}
      </button>
    </div>

    <p v-if="error" class="error">{{ error }}</p>
  </div>
</template>

<style scoped>
.text-head {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 10px;
}

.name-field {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--ink-soft);
}

.name-field input {
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 6px 10px;
  width: 200px;
}

.editor {
  width: 100%;
  min-height: 340px;
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 14px;
  resize: vertical;
  background: #fafbfc;
  font-family: "SF Mono", Consolas, "Courier New", monospace;
  font-size: 13px;
  line-height: 1.7;
}

.editor:focus {
  outline: 2px solid var(--accent-soft);
  border-color: var(--accent);
}

.bottom {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  gap: 16px;
  margin-top: 16px;
  flex-wrap: wrap;
}

.error {
  color: var(--err);
  font-size: 13.5px;
  margin: 12px 0 0;
}
</style>
