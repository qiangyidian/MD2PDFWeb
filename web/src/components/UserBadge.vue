<script setup>
import { computed } from 'vue'

/**
 * 全局用户标识徽章
 *
 * 展示：头像（首字符）+ 昵称 + 剩余处理文件数 + 管理员标识与管理入口。
 */
const props = defineProps({
  user: { type: Object, required: true }, // { name, email, isAdmin }
  // 剩余可处理文件数：null = 未接通（显示占位）；数字 = 实际额度
  quota: { type: Number, default: null }
})

const emit = defineEmits(['logout', 'open-admin'])

const initial = computed(() => (props.user?.name || props.user?.email || '?').trim().charAt(0).toUpperCase())

const quotaText = computed(() => {
  if (props.quota === null || props.quota === undefined) return '剩余额度 --'
  return props.quota > 0 ? `剩余 ${props.quota} 个文件` : '额度已用完'
})

const quotaExhausted = computed(() => props.quota === 0)
const isAdmin = computed(() => !!props.user?.isAdmin)
</script>

<template>
  <div class="badge">
    <span class="avatar" :title="user?.email">{{ initial }}</span>
    <span class="meta">
      <span class="name">
        {{ user?.name }}
        <span v-if="isAdmin" class="admin-chip" title="管理员">管理</span>
      </span>
      <span class="quota" :class="{ ready: quota !== null && quota !== undefined, exhausted: quotaExhausted }">
        <template v-if="quota === null || quota === undefined">⏳ {{ quotaText }}</template>
        <template v-else-if="quotaExhausted">🚫 {{ quotaText }}</template>
        <template v-else>📄 {{ quotaText }}</template>
      </span>
    </span>
    <button v-if="isAdmin" class="admin-btn" title="进入管理后台" @click="emit('open-admin')">管理</button>
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
  display: flex;
  align-items: center;
  gap: 5px;
}

.admin-chip {
  font-size: 10px;
  font-weight: 700;
  color: var(--accent-dark);
  background: var(--accent-soft);
  border-radius: 999px;
  padding: 0 6px;
  line-height: 1.6;
  flex-shrink: 0;
}

.admin-btn {
  border: none;
  background: var(--accent-soft);
  color: var(--accent-dark);
  font-size: 12px;
  font-weight: 600;
  padding: 5px 10px;
  border-radius: 999px;
  cursor: pointer;
  transition: all var(--speed) var(--ease);
}

.admin-btn:hover {
  background: var(--accent);
  color: #fff;
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

.quota.exhausted {
  color: #b45309;
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
