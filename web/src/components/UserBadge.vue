<script setup>
import { computed } from 'vue'

/**
 * 全局用户标识徽章
 *
 * 展示：头像（首字符）+ 昵称 + 剩余处理文件数。
 * quota 暂未接通后端（传 null 显示占位「--」），后续配额接口就绪后
 * 由父组件传入数字即可点亮，无需改本组件。
 */
const props = defineProps({
  user: { type: Object, required: true }, // { name, email }
  // 剩余可处理文件数：null = 未接通（显示占位）；数字 = 实际额度
  quota: { type: Number, default: null }
})

const emit = defineEmits(['logout'])

const initial = computed(() => (props.user?.name || props.user?.email || '?').trim().charAt(0).toUpperCase())

const quotaText = computed(() =>
  props.quota === null || props.quota === undefined ? '剩余额度 --' : `剩余 ${props.quota} 个文件`
)
</script>

<template>
  <div class="badge">
    <span class="avatar" :title="user?.email">{{ initial }}</span>
    <span class="meta">
      <span class="name">{{ user?.name }}</span>
      <span class="quota" :class="{ ready: quota !== null && quota !== undefined }">
        <template v-if="quota === null || quota === undefined">⏳ {{ quotaText }}</template>
        <template v-else>📄 {{ quotaText }}</template>
      </span>
    </span>
    <button class="logout" title="退出登录" aria-label="退出登录" @click="emit('logout')">退出</button>
  </div>
</template>

<style scoped>
.badge {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  padding: 5px 8px 5px 6px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 999px;
  box-shadow: var(--shadow-1);
}

.avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--accent);
  color: #fff;
  font-size: 13px;
  font-weight: 700;
  flex-shrink: 0;
  user-select: none;
}

.meta {
  display: flex;
  flex-direction: column;
  line-height: 1.2;
}

.name {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--ink);
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.quota {
  font-size: 11px;
  color: var(--ink-faint);
  white-space: nowrap;
}

.quota.ready {
  color: var(--accent);
  font-weight: 600;
}

.logout {
  border: none;
  background: transparent;
  color: var(--ink-soft);
  font-size: 12px;
  padding: 5px 8px;
  border-radius: 999px;
  cursor: pointer;
  transition: color var(--speed) var(--ease), background var(--speed) var(--ease);
}

.logout:hover {
  color: var(--accent);
  background: var(--accent-soft);
}
</style>
