<script setup>
import { computed } from 'vue'

const props = defineProps({
  stats: { type: Object, required: true },
  currentFile: { type: String, default: '' },
  logs: { type: Array, default: () => [] },
  done: { type: Boolean, default: false }
})

const percent = computed(() => {
  if (!props.stats.total) return 0
  return Math.min(100, Math.round(((props.stats.success + props.stats.failed + props.stats.skipped) / props.stats.total) * 100))
})
</script>

<template>
  <div>
    <div class="bar-head">
      <span class="current" :title="currentFile">{{ currentFile || '准备中…' }}</span>
      <span class="percent">{{ percent }}%</span>
    </div>

    <div class="bar">
      <div
        class="bar-fill"
        :class="{ done }"
        :style="{ width: percent + '%' }"
      />
    </div>

    <div class="stat-row">
      <div class="stat">
        <span class="num">{{ stats.total }}</span>
        <span class="cap">总数</span>
      </div>
      <div class="stat ok">
        <span class="num">{{ stats.success }}</span>
        <span class="cap">成功</span>
      </div>
      <div class="stat err">
        <span class="num">{{ stats.failed }}</span>
        <span class="cap">失败</span>
      </div>
      <div class="stat warn">
        <span class="num">{{ stats.skipped }}</span>
        <span class="cap">跳过</span>
      </div>
    </div>

    <div v-if="logs.length" class="console">
      <div v-for="(log, i) in logs" :key="i" class="log-line" :class="log.level">
        <span class="log-time">{{ log.time }}</span>
        <span class="log-msg">{{ log.message }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.bar-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 13px;
  margin-bottom: 8px;
}

.current {
  color: var(--ink-soft);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.percent {
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.bar {
  height: 10px;
  background: #eef1f5;
  border-radius: 999px;
  overflow: hidden;
}

.bar-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--accent), #fb7185);
  border-radius: 999px;
  transition: width 0.3s ease;
}

.bar-fill.done {
  background: var(--ok);
}

.stat-row {
  display: flex;
  gap: 12px;
  margin: 16px 0 4px;
  flex-wrap: wrap;
}

.stat {
  flex: 1;
  min-width: 72px;
  background: #f8fafc;
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 10px;
  text-align: center;
  display: flex;
  flex-direction: column;
}

.stat .num {
  font-size: 20px;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
}

.stat .cap {
  font-size: 12px;
  color: var(--ink-soft);
}

.stat.ok .num { color: var(--ok); }
.stat.err .num { color: var(--err); }
.stat.warn .num { color: var(--warn); }

.console {
  margin-top: 14px;
  background: #0f172a;
  color: #cbd5e1;
  border-radius: 10px;
  padding: 12px 14px;
  max-height: 220px;
  overflow-y: auto;
  font-family: "SF Mono", Consolas, "Courier New", monospace;
  font-size: 12px;
  line-height: 1.7;
}

.log-time {
  color: #64748b;
  margin-right: 10px;
}

.log-line.warn .log-msg { color: #fbbf24; }
.log-line.error .log-msg { color: #f87171; }
</style>
