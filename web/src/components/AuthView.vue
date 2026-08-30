<script setup>
import { ref, computed, onBeforeUnmount } from 'vue'
import { loginWithPassword, loginWithEmailCode, register, requestEmailCode } from '../api'

const emit = defineEmits(['authenticated'])

// mode: login | register；loginMethod: password | email
const mode = ref('login')
const loginMethod = ref('password')
const email = ref('')
const password = ref('')
const name = ref('')
const code = ref('')
const showPassword = ref(false)
const submitting = ref(false)
const sending = ref(false)
const error = ref('')
const notice = ref('') // 非阻断提示（如「验证码已发送」）

// 验证码发送倒计时（60s 内禁止重发）
const countdown = ref(0)
let countdownTimer = null

const isLogin = computed(() => mode.value === 'login')
const isPasswordLogin = computed(() => loginMethod.value === 'password')

function switchMode() {
  mode.value = isLogin.value ? 'register' : 'login'
  error.value = ''
  notice.value = ''
  code.value = ''
}

function switchLoginMethod(method) {
  loginMethod.value = method
  error.value = ''
  notice.value = ''
  code.value = ''
}

function startCountdown() {
  countdown.value = 60
  countdownTimer = setInterval(() => {
    countdown.value -= 1
    if (countdown.value <= 0) {
      clearInterval(countdownTimer)
      countdownTimer = null
    }
  }, 1000)
}

onBeforeUnmount(() => {
  if (countdownTimer) clearInterval(countdownTimer)
})

const passwordHint = computed(() =>
  !isLogin.value && password.value && password.value.length < 8 ? '密码至少 8 位' : ''
)

async function sendCode() {
  if (sending.value || countdown.value > 0) return
  error.value = ''
  notice.value = ''

  if (!email.value.trim()) {
    error.value = '请先输入邮箱'
    return
  }

  sending.value = true
  try {
    const purpose = isLogin.value ? 'login' : 'register'
    const result = await requestEmailCode(email.value.trim(), purpose)
    startCountdown()
    notice.value = `验证码已发送到 ${email.value.trim()}，请注意查收（含垃圾邮件箱）`
    if (result.debugCode) {
      // 本地调试模式（邮件未启用）：后端直接回显验证码
      code.value = result.debugCode
      notice.value = `［调试模式］验证码：${result.debugCode}`
    }
  } catch (e) {
    error.value = e.message
  } finally {
    sending.value = false
  }
}

async function submit() {
  if (submitting.value) return
  error.value = ''
  notice.value = ''

  if (!email.value.trim()) {
    error.value = '请输入邮箱'
    return
  }

  if (isLogin.value && isPasswordLogin.value && !password.value) {
    error.value = '请输入密码'
    return
  }
  if (!isLogin.value && password.value.length < 8) {
    error.value = '密码至少 8 位'
    return
  }
  if ((!isLogin.value || !isPasswordLogin.value) && !code.value.trim()) {
    error.value = '请输入邮箱验证码'
    return
  }

  submitting.value = true
  try {
    const trimmedEmail = email.value.trim()
    let result
    if (isLogin.value) {
      result = isPasswordLogin.value
        ? await loginWithPassword({ email: trimmedEmail, password: password.value })
        : await loginWithEmailCode({ email: trimmedEmail, code: code.value.trim() })
    } else {
      result = await register({
        email: trimmedEmail,
        password: password.value,
        name: name.value.trim(),
        code: code.value.trim()
      })
    }
    emit('authenticated', result.user)
  } catch (e) {
    error.value = e.message
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="auth-page">
    <div class="auth-card">
      <div class="brand">
        <div class="logo">M↓</div>
        <h1>MD2PDF Web</h1>
        <p class="sub">{{ isLogin ? '登录后开始批量转换' : '创建账号，开始批量转换' }}</p>
      </div>

      <!-- 登录方式切换（仅登录态显示） -->
      <div v-if="isLogin" class="method-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          :aria-selected="isPasswordLogin"
          class="tab"
          :class="{ active: isPasswordLogin }"
          @click="switchLoginMethod('password')"
        >密码登录</button>
        <button
          type="button"
          role="tab"
          :aria-selected="!isPasswordLogin"
          class="tab"
          :class="{ active: !isPasswordLogin }"
          @click="switchLoginMethod('email')"
        >验证码登录</button>
      </div>

      <form @submit.prevent="submit">
        <label class="field">
          <span class="label">邮箱</span>
          <input
            v-model="email"
            type="email"
            name="email"
            autocomplete="username"
            placeholder="you@example.com"
            required
          />
        </label>

        <label v-if="!isLogin" class="field">
          <span class="label">昵称 <em class="opt">可选</em></span>
          <input
            v-model="name"
            type="text"
            name="name"
            maxlength="40"
            autocomplete="nickname"
            placeholder="怎么称呼你"
          />
        </label>

        <!-- 密码：注册 & 密码登录 -->
        <label v-if="!isLogin || isPasswordLogin" class="field">
          <span class="label">密码</span>
          <span class="pw-wrap">
            <input
              v-model="password"
              :type="showPassword ? 'text' : 'password'"
              name="password"
              :autocomplete="isLogin ? 'current-password' : 'new-password'"
              :placeholder="isLogin ? '输入密码' : '至少 8 位'"
              required
            />
            <button
              type="button"
              class="pw-toggle"
              :aria-label="showPassword ? '隐藏密码' : '显示密码'"
              @click="showPassword = !showPassword"
            >
              {{ showPassword ? '隐藏' : '显示' }}
            </button>
          </span>
          <span v-if="passwordHint" class="hint">{{ passwordHint }}</span>
        </label>

        <!-- 验证码：注册 & 验证码登录 -->
        <div v-if="!isLogin || !isPasswordLogin" class="field">
          <span class="label">邮箱验证码</span>
          <span class="code-row">
            <input
              v-model="code"
              type="text"
              inputmode="numeric"
              maxlength="6"
              autocomplete="one-time-code"
              placeholder="6 位数字"
              class="code-input"
              required
            />
            <button
              type="button"
              class="btn-send"
              :disabled="sending || countdown > 0"
              @click="sendCode"
            >
              <span v-if="sending" class="mini-spinner" />
              {{ countdown > 0 ? `${countdown}s 后可重发` : sending ? '发送中…' : '获取验证码' }}
            </button>
          </span>
        </div>

        <p v-if="error" class="error" role="alert">{{ error }}</p>
        <p v-else-if="notice" class="notice-inline">{{ notice }}</p>

        <button class="submit" type="submit" :disabled="submitting">
          <span v-if="submitting" class="spinner" />
          {{ submitting ? '请稍候…' : isLogin ? '登 录' : '注册并登录' }}
        </button>
      </form>

      <p class="switch">
        {{ isLogin ? '还没有账号？' : '已有账号？' }}
        <button type="button" class="link" @click="switchMode">
          {{ isLogin ? '注册一个' : '直接登录' }}
        </button>
      </p>

      <p class="notice">
        🔒 全站 HTTPS 传输 · 密码 scrypt 加盐哈希存储 · 验证码登录与密码登录二选一
      </p>
    </div>
  </div>
</template>

<style scoped>
.auth-page {
  min-height: 100dvh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px 16px;
  animation: card-in 420ms var(--ease) both;
}

@keyframes card-in {
  from {
    opacity: 0;
    transform: translateY(12px);
  }
}

.auth-card {
  width: 100%;
  max-width: 380px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  box-shadow: var(--shadow-2);
  padding: 34px 30px 26px;
}

.brand {
  text-align: center;
  margin-bottom: 20px;
}

.logo {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  background: var(--accent);
  color: #fff;
  border-radius: 14px;
  font-size: 20px;
  font-weight: 800;
  margin-bottom: 10px;
  box-shadow: 0 4px 14px rgba(91, 141, 239, 0.32);
}

.brand h1 {
  margin: 0;
  font-size: 22px;
}

.sub {
  margin: 6px 0 0;
  color: var(--ink-soft);
  font-size: 13.5px;
}

/* ---- 登录方式切换 ---- */
.method-tabs {
  display: flex;
  background: var(--bg);
  border-radius: var(--radius-s);
  padding: 4px;
  margin-bottom: 18px;
}

.tab {
  flex: 1;
  border: none;
  background: transparent;
  padding: 7px 0;
  border-radius: 8px;
  font-size: 13.5px;
  color: var(--ink-soft);
  cursor: pointer;
  transition: background var(--speed) var(--ease), color var(--speed) var(--ease);
}

.tab.active {
  background: var(--card);
  color: var(--accent);
  font-weight: 600;
  box-shadow: var(--shadow-1);
}

.field {
  display: block;
  margin-bottom: 16px;
}

.label {
  display: block;
  font-size: 13px;
  font-weight: 600;
  color: var(--ink);
  margin-bottom: 6px;
}

.opt {
  font-style: normal;
  font-weight: 400;
  color: var(--ink-faint);
  font-size: 12px;
}

input {
  width: 100%;
  padding: 10px 12px;
  border: 1.5px solid var(--line);
  border-radius: var(--radius-s);
  background: var(--bg);
  transition: border-color var(--speed) var(--ease), box-shadow var(--speed) var(--ease);
}

input:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(91, 141, 239, 0.15);
  background: #fff;
}

.pw-wrap {
  position: relative;
  display: block;
}

.pw-wrap input {
  padding-right: 58px;
}

.pw-toggle {
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  border: none;
  background: transparent;
  color: var(--ink-soft);
  font-size: 12.5px;
  padding: 6px 8px;
  border-radius: 8px;
  cursor: pointer;
}

.pw-toggle:hover {
  color: var(--accent);
  background: var(--accent-soft);
}

/* ---- 验证码行 ---- */
.code-row {
  display: flex;
  gap: 8px;
}

.code-input {
  flex: 1;
  letter-spacing: 2px;
  font-variant-numeric: tabular-nums;
}

.btn-send {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0 14px;
  border: 1.5px solid var(--accent);
  background: transparent;
  color: var(--accent);
  border-radius: var(--radius-s);
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
  transition: background var(--speed) var(--ease), opacity var(--speed) var(--ease);
}

.btn-send:hover:not(:disabled) {
  background: var(--accent-soft);
}

.btn-send:disabled {
  opacity: 0.55;
  cursor: default;
  border-color: var(--line);
  color: var(--ink-faint);
}

.mini-spinner {
  width: 11px;
  height: 11px;
  border: 2px solid rgba(91, 141, 239, 0.3);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}

.hint {
  display: block;
  margin-top: 5px;
  font-size: 12px;
  color: var(--ink-faint);
}

.error {
  margin: 0 0 14px;
  padding: 9px 12px;
  background: #f1f5f9;
  border-left: 3px solid var(--ink-soft);
  border-radius: 8px;
  color: var(--ink);
  font-size: 13px;
}

.notice-inline {
  margin: 0 0 14px;
  padding: 9px 12px;
  background: var(--accent-soft);
  border-left: 3px solid var(--accent);
  border-radius: 8px;
  color: var(--ink);
  font-size: 12.5px;
}

.submit {
  width: 100%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 11px 16px;
  background: var(--accent);
  color: #fff;
  border: none;
  border-radius: var(--radius-s);
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
  transition: background var(--speed) var(--ease), transform 100ms var(--ease);
}

.submit:hover:not(:disabled) {
  background: var(--accent-dark);
}

.submit:active:not(:disabled) {
  transform: scale(0.985);
}

.submit:disabled {
  opacity: 0.6;
  cursor: default;
}

.spinner {
  width: 14px;
  height: 14px;
  border: 2px solid rgba(255, 255, 255, 0.4);
  border-top-color: #fff;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.switch {
  text-align: center;
  margin: 18px 0 0;
  font-size: 13.5px;
  color: var(--ink-soft);
}

.link {
  border: none;
  background: transparent;
  color: var(--accent);
  font-weight: 600;
  cursor: pointer;
  padding: 2px 4px;
}

.link:hover {
  text-decoration: underline;
}

.notice {
  text-align: center;
  margin: 20px 0 0;
  padding-top: 16px;
  border-top: 1px solid var(--line);
  color: var(--ink-faint);
  font-size: 12px;
}
</style>
