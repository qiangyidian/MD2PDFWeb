<script setup>
/**
 * 通用居中弹窗（M3 风格，全站统一）
 *
 * - Teleport 到 body，遮罩居中弹出，缩放+淡入过渡
 * - 点遮罩关闭（可选关）
 * - 标题 + 默认插槽（正文）+ actions 插槽（按钮区）
 */
defineProps({
  open: { type: Boolean, required: true },
  title: { type: String, required: true },
  // 点遮罩是否触发 close（危险操作确认时建议关掉防误触）
  scrimClose: { type: Boolean, default: true }
})

const emit = defineEmits(['close'])
</script>

<template>
  <Teleport to="body">
    <Transition name="app-dlg">
      <div v-if="open" class="scrim" @click.self="scrimClose && emit('close')">
        <div class="dialog" role="dialog" aria-modal="true" :aria-label="title">
          <h3 class="dlg-title">{{ title }}</h3>
          <div class="dlg-body">
            <slot />
          </div>
          <div class="dlg-actions">
            <slot name="actions" />
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.scrim {
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

.dialog {
  background: var(--card);
  border-radius: 24px;
  padding: 24px;
  width: min(400px, 100%);
  box-shadow: 0 8px 32px rgba(15, 23, 42, 0.28);
}

.dlg-title {
  margin: 0 0 10px;
  font-size: 18px;
  font-weight: 700;
  color: var(--ink);
}

.dlg-body {
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

/* 过渡：遮罩淡入淡出，卡片缩放浮现（M3 emphasized） */
.app-dlg-enter-active,
.app-dlg-leave-active {
  transition: opacity 200ms var(--ease);
}

.app-dlg-enter-active .dialog,
.app-dlg-leave-active .dialog {
  transition: transform 200ms var(--ease), opacity 200ms var(--ease);
}

.app-dlg-enter-from,
.app-dlg-leave-to {
  opacity: 0;
}

.app-dlg-enter-from .dialog,
.app-dlg-leave-to .dialog {
  transform: scale(0.92);
  opacity: 0;
}
</style>
