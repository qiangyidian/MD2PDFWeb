<script setup>
const model = defineModel({ type: Object, required: true })

const props = defineProps({
  compact: { type: Boolean, default: false }
})
</script>

<template>
  <div class="options" :class="{ compact }">
    <label class="field">
      <span class="label">页面大小</span>
      <select v-model="model.pageSize">
        <option value="A4">A4</option>
        <option value="Letter">Letter</option>
      </select>
    </label>

    <label class="field">
      <span class="label">页面边距</span>
      <span class="range-wrap">
        <input v-model.number="model.marginMm" type="range" min="0" max="40" step="1" />
        <span class="range-value">{{ model.marginMm }} mm</span>
      </span>
    </label>

    <label class="check">
      <input v-model="model.printBackground" type="checkbox" />
      <span>打印背景颜色</span>
    </label>

    <label v-if="!compact" class="check">
      <input v-model="model.recursive" type="checkbox" />
      <span>递归转换压缩包内子文件夹</span>
    </label>
  </div>
</template>

<style scoped>
.options {
  display: flex;
  flex-wrap: wrap;
  gap: 18px 28px;
  align-items: flex-end;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.label {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--ink-soft);
}

select {
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 7px 10px;
  background: #fff;
  min-width: 110px;
}

.range-wrap {
  display: flex;
  align-items: center;
  gap: 10px;
}

input[type='range'] {
  width: 160px;
  accent-color: var(--accent);
}

.range-value {
  font-size: 13px;
  color: var(--ink-soft);
  min-width: 52px;
  font-variant-numeric: tabular-nums;
}

.check {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 14px;
  cursor: pointer;
  padding-bottom: 7px;
}

.check input {
  width: 16px;
  height: 16px;
  accent-color: var(--accent);
}

.compact {
  row-gap: 10px;
}
</style>
