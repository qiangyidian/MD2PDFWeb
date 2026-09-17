<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import AppDialog from './AppDialog.vue'
import {
  adminStats, adminListUsers, adminCreateUser, adminSetRole,
  adminAdjustQuota, adminResetPassword, adminDeleteUser,
  adminListJobs, adminCancelJob, adminDeleteJob
} from '../api'

/**
 * 管理后台面板（仅 admin 角色可见；后端 /api/admin/* 二次校验）
 *
 * 三个标签页：
 * - 概览：用户/任务/队列/内存水位
 * - 用户：列表 + 角色/余额/重置密码/删除/新建
 * - 任务：全量任务 + 取消/强制删除
 */

const props = defineProps({
  me: { type: Object, required: true } // 当前管理员 { id, name, email }
})
const emit = defineEmits(['close'])

const tab = ref('overview') // overview | users | jobs
const loading = ref(false)
const error = ref('')
const stats = ref(null)
const users = ref([])
const jobs = ref([])

// ---- 弹窗状态机（同一时刻最多一个弹窗） ----
const dialog = ref(null) // null | 'createUser' | 'resetPwd' | 'deleteUser' | 'deleteJob' | 'quota'
const dialogBusy = ref(false)
const dialogError = ref('')

const createUserForm = ref({ email: '', password: '', name: '', role: 'user' })
const resetPwdTarget = ref(null)
const resetPwdResult = ref('')
const deleteUserTarget = ref(null)
const deleteJobTarget = ref(null)
const quotaTarget = ref(null)
const quotaInput = ref('')

let refreshTimer = null

async function refreshAll() {
  loading.value = true
  error.value = ''
  try {
    const [s, u, j] = await Promise.all([adminStats(), adminListUsers(), adminListJobs()])
    stats.value = s
    users.value = u.users || []
    jobs.value = j.jobs || []
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  refreshAll()
  refreshTimer = setInterval(refreshAll, 15000) // 15s 轮询保活
})

onBeforeUnmount(() => clearInterval(refreshTimer))

// 用户 id -> 展示名（任务列表标注归属）
const userIndex = computed(() => {
  const map = new Map()
  for (const u of users.value) map.set(u.id, u)
  return map
})

function ownerLabel(job) {
  const u = userIndex.value.get(job.userId)
  return u ? `${u.name}（${u.email}）` : (job.userId ? job.userId.slice(0, 8) + '…' : '匿名')
}

function fmtTime(ts) {
  if (!ts) return '--'
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

function fmtBytes(n) {
  if (!n && n !== 0) return '--'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1 }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`
}

const JOB_STATUS = {
  created: ['已创建', 'st-created'],
  queued: ['排队中', 'st-queued'],
  converting: ['转换中', 'st-run'],
  done: ['已完成', 'st-done'],
  cancelled: ['已取消', 'st-cancel'],
  failed: ['失败', 'st-fail']
}

function statusLabel(s) { return (JOB_STATUS[s] || [s, ''])[0] }
function statusClass(s) { return (JOB_STATUS[s] || ['', ''])[1] }

// ---- 用户操作 ----

function openCreateUser() {
  createUserForm.value = { email: '', password: '', name: '', role: 'user' }
  dialogError.value = ''
  dialog.value = 'createUser'
}

async function submitCreateUser() {
  dialogBusy.value = true
  dialogError.value = ''
  try {
    await adminCreateUser(createUserForm.value)
    dialog.value = null
    await refreshAll()
  } catch (e) {
    dialogError.value = e.message
  } finally {
    dialogBusy.value = false
  }
}

async function toggleRole(user) {
  error.value = ''
  try {
    await adminSetRole(user.id, user.role === 'admin' ? 'user' : 'admin')
    await refreshAll()
  } catch (e) {
    error.value = e.message
  }
}

function openQuota(user) {
  quotaTarget.value = user
  quotaInput.value = ''
  dialogError.value = ''
  dialog.value = 'quota'
}

async function submitQuota() {
  const delta = Number(quotaInput.value)
  if (!Number.isFinite(delta) || delta === 0 || !Number.isInteger(delta)) {
    dialogError.value = '请输入非零整数'
    return
  }
  dialogBusy.value = true
  dialogError.value = ''
  try {
    await adminAdjustQuota(quotaTarget.value.id, delta)
    dialog.value = null
    await refreshAll()
  } catch (e) {
    dialogError.value = e.message
  } finally {
    dialogBusy.value = false
  }
}

function openResetPwd(user) {
  resetPwdTarget.value = user
  resetPwdResult.value = ''
  dialogError.value = ''
  dialog.value = 'resetPwd'
}

async function submitResetPwd() {
  if (resetPwdResult.value) { dialog.value = null; return } // 已生成：再次点击即关闭
  dialogBusy.value = true
  dialogError.value = ''
  try {
    const { newPassword } = await adminResetPassword(resetPwdTarget.value.id)
    resetPwdResult.value = newPassword
  } catch (e) {
    dialogError.value = e.message
  } finally {
    dialogBusy.value = false
  }
}

function openDeleteUser(user) {
  deleteUserTarget.value = user
  dialogError.value = ''
  dialog.value = 'deleteUser'
}

async function submitDeleteUser() {
  dialogBusy.value = true
  dialogError.value = ''
  try {
    await adminDeleteUser(deleteUserTarget.value.id)
    dialog.value = null
    await refreshAll()
  } catch (e) {
    dialogError.value = e.message
  } finally {
    dialogBusy.value = false
  }
}

// ---- 任务操作 ----

async function cancelJob(job) {
  error.value = ''
  try {
    await adminCancelJob(job.id)
    await refreshAll()
  } catch (e) {
    error.value = e.message
  }
}

function openDeleteJob(job) {
  deleteJobTarget.value = job
  dialogError.value = ''
  dialog.value = 'deleteJob'
}

async function submitDeleteJob() {
  dialogBusy.value = true
  dialogError.value = ''
  try {
    await adminDeleteJob(deleteJobTarget.value.id)
    dialog.value = null
    await refreshAll()
  } catch (e) {
    dialogError.value = e.message
  } finally {
    dialogBusy.value = false
  }
}
</script>

<template>
  <div class="admin-shell">
    <!-- 顶栏 -->
    <header class="admin-top">
      <div class="brand">
        <span class="logo">M↓</span>
        <div>
          <h2>管理后台</h2>
          <p>{{ me?.name }} · {{ me?.email }}</p>
        </div>
      </div>
      <div class="top-actions">
        <button class="ghost" :class="{ spinning: loading }" @click="refreshAll">刷新</button>
        <button class="primary" @click="emit('close')">返回应用</button>
      </div>
    </header>

    <!-- 标签页 -->
    <nav class="tabs">
      <button :class="{ active: tab === 'overview' }" @click="tab = 'overview'">概览</button>
      <button :class="{ active: tab === 'users' }" @click="tab = 'users'">
        用户 <span class="count">{{ users.length }}</span>
      </button>
      <button :class="{ active: tab === 'jobs' }" @click="tab = 'jobs'">
        任务 <span class="count">{{ jobs.length }}</span>
      </button>
    </nav>

    <p v-if="error" class="error">{{ error }}</p>

    <!-- ============ 概览 ============ -->
    <section v-if="tab === 'overview'" class="panel">
      <div v-if="stats" class="stat-grid">
        <div class="stat-card">
          <span class="stat-num">{{ stats.users.total }}</span>
          <span class="stat-label">注册用户</span>
          <span class="stat-sub">今日新增 {{ stats.users.newToday }} · 管理员 {{ stats.users.admins }}</span>
        </div>
        <div class="stat-card">
          <span class="stat-num">{{ stats.jobs.active }}</span>
          <span class="stat-label">进行中任务</span>
          <span class="stat-sub">累计任务 {{ stats.jobs.total }}（2 小时窗口内）</span>
        </div>
        <div class="stat-card">
          <span class="stat-num">{{ stats.jobs.filesProcessed }}</span>
          <span class="stat-label">已渲染文件</span>
          <span class="stat-sub">失败 {{ stats.jobs.filesFailed }}</span>
        </div>
        <div class="stat-card" :class="{ warn: stats.queue.paused }">
          <span class="stat-num">{{ stats.queue.running }}/{{ stats.queue.concurrency }}</span>
          <span class="stat-label">渲染并发</span>
          <span class="stat-sub">
            排队 {{ stats.queue.queuedJobs }} 任务 / {{ stats.queue.queuedTasks }} 文件
            <template v-if="stats.queue.paused"> · ⚠️ {{ stats.queue.pausedReason || '已暂停派发' }}</template>
          </span>
        </div>
        <div class="stat-card" :class="{ warn: stats.queue.memory?.low }">
          <span class="stat-num">{{ stats.queue.memory?.freePct ?? '--' }}%</span>
          <span class="stat-label">空闲内存</span>
          <span class="stat-sub">{{ fmtBytes(stats.queue.memory?.freeMemBytes) }} / {{ fmtBytes(stats.queue.memory?.totalMemBytes) }}</span>
        </div>
        <div class="stat-card">
          <span class="stat-num">{{ Math.round((stats.queue.avgTaskMs || 0) / 100) / 10 }}s</span>
          <span class="stat-label">平均单文件耗时</span>
          <span class="stat-sub">累计处理 {{ stats.queue.processed }} 个文件</span>
        </div>
      </div>
      <div v-if="stats" class="config-chip">
        注册赠送额度 {{ stats.config.freeGrant }} 次 · 并发 {{ stats.config.concurrency }} 路 · 任务保留 {{ stats.config.jobTtlHours }} 小时
      </div>
    </section>

    <!-- ============ 用户管理 ============ -->
    <section v-else-if="tab === 'users'" class="panel">
      <div class="panel-head">
        <h3>用户列表</h3>
        <button class="primary" @click="openCreateUser">＋ 新建用户</button>
      </div>
      <div class="table-wrap">
        <table class="tbl">
          <thead>
            <tr>
              <th>用户</th>
              <th>角色</th>
              <th>剩余额度</th>
              <th>进行中任务</th>
              <th>注册时间</th>
              <th class="ops">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="u in users" :key="u.id" :class="{ self: u.id === me?.id }">
              <td>
                <div class="cell-user">
                  <span class="avatar">{{ (u.name || u.email).charAt(0).toUpperCase() }}</span>
                  <span>
                    <span class="u-name">{{ u.name }}</span>
                    <span class="u-email">{{ u.email }}</span>
                  </span>
                </div>
              </td>
              <td>
                <span class="role" :class="{ admin: u.role === 'admin' }">{{ u.role === 'admin' ? '管理员' : '用户' }}</span>
              </td>
              <td :class="{ 'q-zero': u.quotaRemaining === 0 }">{{ u.quotaRemaining }}</td>
              <td>{{ u.activeJobs }}</td>
              <td class="t">{{ fmtTime(u.createdAt) }}</td>
              <td class="ops">
                <button class="link" @click="toggleRole(u)">
                  {{ u.role === 'admin' ? '降为用户' : '升为管理员' }}
                </button>
                <button class="link" @click="openQuota(u)">调整额度</button>
                <button class="link" @click="openResetPwd(u)">重置密码</button>
                <button v-if="u.id !== me?.id" class="link danger" @click="openDeleteUser(u)">删除</button>
                <span v-else class="self-mark">（当前账号）</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- ============ 任务管理 ============ -->
    <section v-else class="panel">
      <div class="panel-head">
        <h3>任务列表（保留 2 小时窗口内）</h3>
      </div>
      <p v-if="!jobs.length" class="empty">暂无任务</p>
      <div v-else class="table-wrap">
        <table class="tbl">
          <thead>
            <tr>
              <th>任务</th>
              <th>归属</th>
              <th>状态</th>
              <th>文件进度</th>
              <th>创建时间</th>
              <th class="ops">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="j in jobs" :key="j.id">
              <td class="mono">{{ j.id.slice(0, 8) }}…<span v-if="j.quotaExempt" class="exempt" title="管理员任务不消耗额度">免额度</span></td>
              <td>{{ ownerLabel(j) }}</td>
              <td><span class="status" :class="statusClass(j.status)">{{ statusLabel(j.status) }}</span></td>
              <td>
                <span v-if="j.stats.total">
                  ✅ {{ j.stats.success }} · ❌ {{ j.stats.failed }} · ⏭ {{ j.stats.skipped }} / {{ j.stats.total }}
                </span>
                <span v-else>--</span>
              </td>
              <td class="t">{{ fmtTime(j.createdAt) }}</td>
              <td class="ops">
                <button
                  v-if="['queued', 'converting'].includes(j.status)"
                  class="link"
                  @click="cancelJob(j)"
                >取消</button>
                <button class="link danger" @click="openDeleteJob(j)">删除</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- ============ 弹窗 ============ -->
    <AppDialog :open="dialog === 'createUser'" title="新建用户" :scrim-close="false" @close="dialog = null">
      <div class="form">
        <label>邮箱<input v-model.trim="createUserForm.email" type="email" placeholder="user@example.com" /></label>
        <label>昵称<input v-model.trim="createUserForm.name" maxlength="40" placeholder="可留空（取邮箱前缀）" /></label>
        <label>初始密码<input v-model="createUserForm.password" type="text" placeholder="至少 8 位" /></label>
        <label>角色
          <select v-model="createUserForm.role">
            <option value="user">普通用户</option>
            <option value="admin">管理员</option>
          </select>
        </label>
        <p class="dlg-note">新建用户免邮箱验证，自动赠送注册额度；请线下把密码告知用户。</p>
        <p v-if="dialogError" class="error">{{ dialogError }}</p>
      </div>
      <template #actions>
        <button class="ghost" :disabled="dialogBusy" @click="dialog = null">取消</button>
        <button class="primary" :disabled="dialogBusy" @click="submitCreateUser">创建</button>
      </template>
    </AppDialog>

    <AppDialog :open="dialog === 'quota'" :title="`调整额度 — ${quotaTarget?.name || ''}`" :scrim-close="false" @close="dialog = null">
      <div class="form">
        <p class="dlg-note">当前剩余 <b>{{ quotaTarget?.quotaRemaining }}</b> 次。输入正数充值、负数扣减（不低于 0）。</p>
        <label>调整数额<input v-model.trim="quotaInput" type="number" placeholder="如 50 或 -10" /></label>
        <p v-if="dialogError" class="error">{{ dialogError }}</p>
      </div>
      <template #actions>
        <button class="ghost" :disabled="dialogBusy" @click="dialog = null">取消</button>
        <button class="primary" :disabled="dialogBusy" @click="submitQuota">确认</button>
      </template>
    </AppDialog>

    <AppDialog :open="dialog === 'resetPwd'" :title="`重置密码 — ${resetPwdTarget?.name || ''}`" :scrim-close="false" @close="dialog = null">
      <template v-if="!resetPwdResult">
        <p class="dlg-note">
          将为 <b>{{ resetPwdTarget?.email }}</b> 生成随机新密码，其全部登录会话即刻失效。
          新密码仅显示一次，请妥善转达。
        </p>
        <p v-if="dialogError" class="error">{{ dialogError }}</p>
      </template>
      <template v-else>
        <p class="dlg-note">新密码（仅此一次显示）：</p>
        <code class="pwd">{{ resetPwdResult }}</code>
      </template>
      <template #actions>
        <button v-if="!resetPwdResult" class="ghost" :disabled="dialogBusy" @click="dialog = null">取消</button>
        <button class="primary" :disabled="dialogBusy" @click="submitResetPwd">
          {{ resetPwdResult ? '完成' : '生成新密码' }}
        </button>
      </template>
    </AppDialog>

    <AppDialog :open="dialog === 'deleteUser'" title="删除用户" :scrim-close="false" @close="dialog = null">
      <p class="dlg-note">
        确认删除 <b>{{ deleteUserTarget?.name }}（{{ deleteUserTarget?.email }}）</b>？
        其余额清零、全部会话踢下线；历史任务按 TTL 自然过期。此操作不可撤销。
      </p>
      <p v-if="dialogError" class="error">{{ dialogError }}</p>
      <template #actions>
        <button class="ghost" :disabled="dialogBusy" @click="dialog = null">取消</button>
        <button class="danger-btn" :disabled="dialogBusy" @click="submitDeleteUser">确认删除</button>
      </template>
    </AppDialog>

    <AppDialog :open="dialog === 'deleteJob'" title="删除任务" :scrim-close="false" @close="dialog = null">
      <p class="dlg-note">
        确认强制删除任务 <b>{{ deleteJobTarget?.id?.slice(0, 8) }}…</b>（{{ ownerLabel(deleteJobTarget || {}) }}）？
        任务目录与全部产物将立即清除，进行中的转换一并中止。此操作不可撤销。
      </p>
      <p v-if="dialogError" class="error">{{ dialogError }}</p>
      <template #actions>
        <button class="ghost" :disabled="dialogBusy" @click="dialog = null">取消</button>
        <button class="danger-btn" :disabled="dialogBusy" @click="submitDeleteJob">确认删除</button>
      </template>
    </AppDialog>
  </div>
</template>

<style scoped>
.admin-shell {
  min-height: 100dvh;
  background: var(--bg);
  max-width: 1160px;
  margin: 0 auto;
  padding: 24px 20px 64px;
  animation: hero-in 380ms var(--ease) both;
}

@keyframes hero-in {
  from { opacity: 0; transform: translateY(8px); }
}

/* ===== 顶栏 ===== */
.admin-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 20px;
}

.brand {
  display: flex;
  align-items: center;
  gap: 12px;
}

.logo {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  background: var(--accent);
  color: #fff;
  border-radius: 14px;
  font-size: 18px;
  font-weight: 800;
  box-shadow: 0 4px 14px rgba(91, 141, 239, 0.32);
}

.brand h2 { margin: 0; font-size: 20px; }
.brand p { margin: 2px 0 0; font-size: 12.5px; color: var(--ink-soft); }

.top-actions { display: flex; gap: 10px; }

/* ===== 按钮 ===== */
button { cursor: pointer; }

.primary,
.ghost,
.danger-btn {
  border: none;
  border-radius: 999px;
  padding: 8px 18px;
  font-size: 13.5px;
  font-weight: 600;
  transition: all var(--speed) var(--ease);
}

.primary { background: var(--accent); color: #fff; }
.primary:hover { background: var(--accent-dark); }
.primary:disabled, .ghost:disabled, .danger-btn:disabled { opacity: 0.55; cursor: not-allowed; }

.ghost { background: var(--card); color: var(--ink-soft); border: 1px solid var(--line); }
.ghost:hover { color: var(--accent); border-color: var(--accent); }
.ghost.spinning { opacity: 0.6; pointer-events: none; }

.danger-btn { background: #fee2e2; color: #b91c1c; }
.danger-btn:hover { background: #fecaca; }

.link {
  border: none;
  background: transparent;
  color: var(--accent);
  font-size: 12.5px;
  padding: 3px 6px;
  border-radius: 6px;
  white-space: nowrap;
}

.link:hover { background: var(--accent-soft); }
.link.danger { color: #b91c1c; }
.link.danger:hover { background: #fee2e2; }

/* ===== 标签页 ===== */
.tabs {
  display: flex;
  gap: 6px;
  margin-bottom: 18px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 4px;
  width: fit-content;
  box-shadow: var(--shadow-1);
}

.tabs button {
  border: none;
  background: transparent;
  color: var(--ink-soft);
  font-size: 13.5px;
  font-weight: 600;
  padding: 7px 18px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  transition: all var(--speed) var(--ease);
}

.tabs button.active { background: var(--accent); color: #fff; }
.tabs .count {
  font-size: 11px;
  background: rgba(255, 255, 255, 0.25);
  border-radius: 999px;
  padding: 1px 7px;
}

.tabs button:not(.active) .count { background: #f1f5f9; color: var(--ink-soft); }

/* ===== 概览 ===== */
.stat-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 14px;
  margin-bottom: 16px;
}

.stat-card {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 18px;
  display: flex;
  flex-direction: column;
  gap: 3px;
  box-shadow: var(--shadow-1);
}

.stat-card.warn { border-color: #d9a441; background: #fffbeb; }

.stat-num { font-size: 26px; font-weight: 800; color: var(--ink); line-height: 1.15; }
.stat-label { font-size: 13.5px; font-weight: 600; color: var(--ink-soft); }
.stat-sub { font-size: 12px; color: var(--ink-faint); }

.config-chip {
  font-size: 12.5px;
  color: var(--ink-soft);
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: var(--radius-s);
  padding: 9px 14px;
}

/* ===== 面板与表格 ===== */
.panel {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 18px;
  box-shadow: var(--shadow-1);
}

.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
}

.panel-head h3 { margin: 0; font-size: 15.5px; }

.table-wrap { overflow-x: auto; }

.tbl { width: 100%; border-collapse: collapse; font-size: 13px; }

.tbl th {
  text-align: left;
  font-size: 12px;
  color: var(--ink-faint);
  font-weight: 600;
  padding: 8px 10px;
  border-bottom: 1px solid var(--line);
  white-space: nowrap;
}

.tbl td {
  padding: 10px;
  border-bottom: 1px solid var(--line);
  vertical-align: middle;
}

.tbl tr:last-child td { border-bottom: none; }
.tbl tr:hover td { background: #fafbfd; }
.tbl tr.self td { background: var(--accent-soft); }
.tbl td.t { color: var(--ink-faint); font-size: 12px; white-space: nowrap; }
.tbl td.ops { white-space: nowrap; }
.tbl .mono { font-family: ui-monospace, monospace; font-size: 12px; }

.cell-user { display: flex; align-items: center; gap: 9px; }

.avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: var(--accent);
  color: #fff;
  font-size: 13px;
  font-weight: 700;
  flex-shrink: 0;
}

.u-name { display: block; font-weight: 600; line-height: 1.3; }
.u-email { display: block; font-size: 11.5px; color: var(--ink-faint); }

.role {
  font-size: 11.5px;
  padding: 2px 9px;
  border-radius: 999px;
  background: #f1f5f9;
  color: var(--ink-soft);
  white-space: nowrap;
}

.role.admin { background: var(--accent-soft); color: var(--accent-dark); font-weight: 700; }

.q-zero { color: #b45309; font-weight: 700; }
.self-mark { font-size: 11.5px; color: var(--ink-faint); }

.status {
  font-size: 11.5px;
  padding: 2px 9px;
  border-radius: 999px;
  white-space: nowrap;
  background: #f1f5f9;
  color: var(--ink-soft);
}

.st-queued { background: #fef9c3; color: #a16207; }
.st-run { background: var(--accent-soft); color: var(--accent-dark); }
.st-done { background: #d1fae5; color: #047857; }
.st-cancel { background: #f1f5f9; color: var(--ink-faint); }
.st-fail { background: #fee2e2; color: #b91c1c; }

.exempt {
  margin-left: 6px;
  font-size: 10.5px;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent-dark);
}

.empty { color: var(--ink-faint); font-size: 13px; text-align: center; padding: 30px 0; margin: 0; }

.error {
  color: #b91c1c;
  background: #fef2f2;
  border-left: 3px solid #dc2626;
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 13px;
  margin: 0 0 14px;
}

/* ===== 弹窗表单 ===== */
.form { display: flex; flex-direction: column; gap: 12px; }

.form label {
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--ink-soft);
}

.form input,
.form select {
  border: 1px solid var(--line);
  border-radius: var(--radius-s);
  padding: 9px 12px;
  font-size: 13.5px;
  background: #fff;
  color: var(--ink);
  outline: none;
  transition: border-color var(--speed) var(--ease);
}

.form input:focus,
.form select:focus { border-color: var(--accent); }

.dlg-note { margin: 0; font-size: 13px; line-height: 1.7; }

.pwd {
  display: block;
  background: #f8fafc;
  border: 1px dashed var(--line);
  border-radius: var(--radius-s);
  padding: 12px 14px;
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.5px;
  user-select: all;
  word-break: break-all;
}

@media (max-width: 720px) {
  .admin-top { flex-direction: column; align-items: flex-start; }
  .panel { padding: 12px; }
}
</style>
