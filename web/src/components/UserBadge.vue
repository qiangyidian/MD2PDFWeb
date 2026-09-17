<script setup>
import { computed, ref } from 'vue'
import { redeemCode } from '../api'
import AppDialog from './AppDialog.vue'

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

const emit = defineEmits(['logout', 'open-admin', 'redeemed'])

const initial = computed(() => (props.user?.name || props.user?.email || '?').trim().charAt(0).toUpperCase())

const quotaText = computed(() => {
  if (props.quota === null || props.quota === undefined) return '剩余额度 --'
  return props.quota > 0 ? `剩余 ${props.quota} 个文件` : '额度已用完'
})

const quotaExhausted = computed(() => props.quota === 0)
const isAdmin = computed(() => !!props.user?.isAdmin)

// ---- 兑换码 ----
const showRedeem = ref(false)
const redeemInput = ref('')
const redeemBusy = ref(false)
const redeemError = ref('')
const redeemSuccess = ref('')

function openRedeem() {
  redeemInput.value = ''
  redeemError.value = ''
  redeemSuccess.value = ''
  showRedeem.value = true
}

async function submitRedeem() {
  const code = redeemInput.value.trim()
  if (!code) {
    redeemError.value = '请输入兑换码'
    return
  }
  redeemBusy.value = true
  redeemError.value = ''
  redeemSuccess.value = ''
  try {
    const result = await redeemCode(code)
    redeemSuccess.value = result.message
    redeemInput.value = ''
    // 余额以后端返回的为准，交给父组件统一同步给所有展示位
    emit('redeemed', result.quotaRemaining)
  } catch (e) {
    redeemError.value = e.message
  } finally {
    redeemBusy.value = false
  }
}
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
        <template v-if="quota === null || quota === undefined">⏳ {{ quotaText }}  <AppDialog :open="showRedeem" title="兑换额度" @close="showRedeem = false">
    <p class="redeem-hint">输入你的兑换码，额度将立即到账。</p>
    <input
      v-model="redeemInput"
      class="redeem-input"
      type="text"
      placeholder="MD2PDF-XXXXX-XXXXX-XXXXX"
      autocomplete="off"
      spellcheck="false"
      :disabled="redeemBusy"
      @keyup.enter="submitRedeem"
    />
    <p v-if="redeemError" class="redeem-error">{{ redeemError }}</p>
    <p v-if="redeemSuccess" class="redeem-success">{{ redeemSuccess }}</p>
    <template #actions>
      <button class="redeem-cancel" :disabled="redeemBusy" @click="showRedeem = false">关闭</button>
      <button class="redeem-submit" :disabled="redeemBusy" @click="submitRedeem">
        {{ redeemBusy ? '兑换中…' : '确认兑换' }}
      </button>
    </template>
  </AppDialog>
</template>
        <template v-else-if="quotaExhausted">🚫 {{ quotaText }}</template>
        <template v-else>📄 {{ quotaText }}</template>
      </span>
    </span>
    <button class="redeem-btn" title="输入兑换码充值额度" @click="openRedeem">兑换</button>
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

.redeem-btn {
  border: none;
  background: var(--accent-soft);
  color: var(--accent-dark);
  font-size: 12px;
  font-weight: 600;
  padding: 5px 10px;
  border-radius: 999px;
  cursor: pointer;
  flex-shrink: 0;
  transition: all var(--speed) var(--ease);
}

.redeem-btn:hover {
  background: var(--accent);
  color: #fff;
}

.redeem-hint {
  margin: 0 0 10px;
}

.redeem-input {
  width: 100%;
  box-sizing: border-box;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 10px;
  font-size: 15px;
  letter-spacing: 0.06em;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  text-transform: uppercase;
}

.redeem-input:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

.redeem-error {
  margin: 10px 0 0;
  font-size: 13px;
  color: var(--err);
}

.redeem-success {
  margin: 10px 0 0;
  font-size: 13px;
  color: #15803d;
  font-weight: 600;
}

.redeem-cancel,
.redeem-submit {
  border: none;
  border-radius: 10px;
  padding: 8px 16px;
  font-size: 13.5px;
  font-weight: 600;
  cursor: pointer;
}

.redeem-cancel {
  background: #f1f5f9;
  color: var(--ink-soft);
}

.redeem-submit {
  background: var(--accent);
  color: #fff;
}

.redeem-submit:disabled,
.redeem-cancel:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
