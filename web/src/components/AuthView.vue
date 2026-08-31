<script setup>
import { ref, computed, onBeforeUnmount } from 'vue'
import { loginWithPassword, loginWithEmailCode, register, requestEmailCode } from '../api'

const emit = defineEmits(['authenticated'])

// mode: login | register；loginMethod: password | email（借鉴 SQL2ER 双模式 + MyGPT Tab 切换）
const mode = ref('login')
const loginMethod = ref('password')
const email = ref('')
const password = ref('')
const confirmPassword = ref('')
const name = ref('')
const code = ref('')
const showPassword = ref(false)
const showConfirm = ref(false)
const capsLockOn = ref(false)
const submitting = ref(false)
const sending = ref(false)
const error = ref('')
const notice = ref('') // 成功提示（绿）：验证码已发送等

// 验证码发送倒计时（60s 内禁止重发）
const countdown = ref(0)
let countdownTimer = null

const isLogin = computed(() => mode.value === 'login')
const isRegister = computed(() => mode.value === 'register')
const isPasswordLogin = computed(() => loginMethod.value === 'password')
const needCode = computed(() => isRegister.value || !isPasswordLogin.value)
const needPassword = computed(() => isRegister.value || isPasswordLogin.value)

// 客户端预校验（镜像后端规则，避免明显错误打到服务器）
const emailValid = computed(() => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value.trim()))
const passwordLongEnough = computed(() => password.value.length >= 8)

// 密码强度（注册时显示）：长度 + 字符类别
const passwordStrength = computed(() => {
  if (!isRegister.value || !password.value) return null
  let score = 0
  if (password.value.length >= 8) score += 1
  if (password.value.length >= 12) score += 1
  if (/[a-z]/.test(password.value) && /[A-Z]/.test(password.value)) score += 1
  if (/\d/.test(password.value)) score += 1
  if (/[^A-Za-z0-9]/.test(password.value)) score += 1
  return score // 0-5
})
const strengthMeta = computed(() => {
  const s = passwordStrength.value
  if (s === null) return null
  if (s <= 1) return { label: '弱', pct: 20 }
  if (s <= 2) return { label: '一般', pct: 40 }
  if (s <= 3) return { label: '中等', pct: 60 }
  if (s <= 4) return { label: '较强', pct: 80 }
  return { label: '强', pct: 100 }
})
const confirmMismatch = computed(
  () => isRegister.value && confirmPassword.value.length > 0 && confirmPassword.value !== password.value
)

function switchMode(target) {
  mode.value = target
  error.value = ''
  notice.value = ''
}

function switchLoginMethod(method) {
  loginMethod.value = method
  error.value = ''
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

// 验证码只保留数字（粘贴含空格/字母时自动清洗）
function onCodeInput(e) {
  code.value = e.target.value.replace(/\D/g, '').slice(0, 6)
}

// Caps Lock 检测（大写锁定是密码「输错」的常见原因）
function detectCapsLock(e) {
  if (typeof e.getModifierState === 'function') {
    capsLockOn.value = e.getModifierState('CapsLock')
  }
}

async function sendCode() {
  if (sending.value || countdown.value > 0) return
  error.value = ''
  notice.value = ''

  if (!emailValid.value) {
    error.value = '请先输入合法的邮箱地址，再发送验证码'
    return
  }

  sending.value = true
  try {
    const purpose = isRegister.value ? 'register' : 'login'
    const result = await requestEmailCode(email.value.trim(), purpose)
    startCountdown()
    if (result.debugCode) {
      // 本地调试模式（邮件未启用）：后端直接回显验证码
      code.value = result.debugCode
      notice.value = `［调试模式］验证码：${result.debugCode}`
    } else {
      notice.value = `验证码已发送到 ${email.value.trim()}，请查收（含垃圾邮件箱）`
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

  if (!emailValid.value) {
    error.value = '请输入合法的邮箱地址'
    return
  }
  if (needPassword.value && !password.value) {
    error.value = '请输入密码'
    return
  }
  if (isRegister.value && !passwordLongEnough.value) {
    error.value = '密码至少 8 位'
    return
  }
  if (isRegister.value && confirmMismatch.value) {
    error.value = '两次输入的密码不一致'
    return
  }
  if (needCode.value && !/^\d{6}$/.test(code.value)) {
    error.value = '请输入 6 位邮箱验证码'
    return
  }

  submitting.value = true
  try {
    const trimmedEmail = email.value.trim()
    let result
    if (isRegister.value) {
      result = await register({
        email: trimmedEmail,
        password: password.value,
        name: name.value.trim(),
        code: code.value
      })
    } else if (isPasswordLogin.value) {
      result = await loginWithPassword({ email: trimmedEmail, password: password.value })
    } else {
      result = await loginWithEmailCode({ email: trimmedEmail, code: code.value })
    }
    emit('authenticated', result.user, result.quotaRemaining)
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
      <!-- ===== 头部：品牌 + 视图标题（借鉴 SQL2ER 的信息层级）===== -->
      <div class="brand">
        <div class="brand-row">
          <div class="logo">M↓</div>
          <div class="brand-text">
            <p class="brand-name">MD2PDF Web</p>
            <p class="brand-sub">{{ isLogin ? '登录后进入工作台' : '注册一个新账号' }}</p>
          </div>
        </div>
        <div class="headline">
          <h1>{{ isRegister ? '创建账号' : '账号登录' }}</h1>
          <p class="headline-sub">
            {{
              isRegister
                ? '使用邮箱完成验证并设置登录密码，注册成功后自动登录。'
                : '使用密码或邮箱验证码进入工作台。'
            }}
          </p>
        </div>
      </div>

      <!-- ===== 登录/注册顶置 Tab（借鉴 MyGPT）===== -->
      <div class="mode-tabs" role="tablist" aria-label="认证模式">
        <button
          type="button"
          role="tab"
          :aria-selected="isLogin"
          class="mode-tab"
          :class="{ active: isLogin }"
          @click="switchMode('login')"
        >登录</button>
        <button
          type="button"
          role="tab"
          :aria-selected="isRegister"
          class="mode-tab"
          :class="{ active: isRegister }"
          @click="switchMode('register')"
        >注册</button>
      </div>

      <form @submit.prevent="submit">
        <!-- ===== 登录方式切换（仅登录态；借鉴 SQL2ER 下划线 Tab）===== -->
        <div v-if="isLogin" class="method-tabs" role="tablist" aria-label="登录方式">
          <button
            type="button"
            role="tab"
            :aria-selected="isPasswordLogin"
            class="method-tab"
            :class="{ active: isPasswordLogin }"
            @click="switchLoginMethod('password')"
          >密码登录</button>
          <button
            type="button"
            role="tab"
            :aria-selected="!isPasswordLogin"
            class="method-tab"
            :class="{ active: !isPasswordLogin }"
            @click="switchLoginMethod('email')"
          >验证码登录</button>
        </div>

        <!-- 表单体：固定最小高度，切换模式时不跳动（借鉴 SQL2ER 的防跳设计） -->
        <div class="form-body">
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

          <label v-if="isRegister" class="field">
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
          <label v-if="needPassword" class="field">
            <span class="label">{{ isRegister ? '设置密码' : '密码' }}</span>
            <span class="pw-wrap">
              <input
                v-model="password"
                :type="showPassword ? 'text' : 'password'"
                name="password"
                :autocomplete="isRegister ? 'new-password' : 'current-password'"
                :placeholder="isRegister ? '至少 8 位' : '输入密码'"
                required
                @keyup="detectCapsLock"
              />
              <button
                type="button"
                class="pw-toggle"
                :aria-label="showPassword ? '隐藏密码' : '显示密码'"
                :aria-pressed="showPassword"
                @click="showPassword = !showPassword"
              >
                <svg v-if="!showPassword" viewBox="0 0 24 24" class="eye" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
                <svg v-else viewBox="0 0 24 24" class="eye" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M2.5 12S6 5.5 12 5.5c1.7 0 3.2.55 4.5 1.32M21.5 12S18 18.5 12 18.5c-1.7 0-3.2-.55-4.5-1.32" />
                  <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
                  <path d="m4 20 16-16" />
                </svg>
              </button>
            </span>
            <!-- 密码强度条（注册时） -->
            <span v-if="strengthMeta" class="strength">
              <span class="strength-bar">
                <span
                  class="strength-fill"
                  :class="`s-${Math.min(passwordStrength, 5)}`"
                  :style="{ width: strengthMeta.pct + '%' }"
                />
              </span>
              <span class="strength-label">{{ strengthMeta.label }}</span>
            </span>
            <span v-if="capsLockOn" class="caps-hint">⇪ Caps Lock 已开启</span>
          </label>

          <!-- 确认密码（注册时；借鉴 SQL2ER/MyGPT） -->
          <label v-if="isRegister" class="field">
            <span class="label">确认密码</span>
            <span class="pw-wrap">
              <input
                v-model="confirmPassword"
                :type="showConfirm ? 'text' : 'password'"
                name="confirm-password"
                autocomplete="new-password"
                placeholder="再次输入密码"
                required
                @keyup="detectCapsLock"
              />
              <button
                type="button"
                class="pw-toggle"
                :aria-label="showConfirm ? '隐藏密码' : '显示密码'"
                @click="showConfirm = !showConfirm"
              >
                <svg v-if="!showConfirm" viewBox="0 0 24 24" class="eye" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
                <svg v-else viewBox="0 0 24 24" class="eye" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M2.5 12S6 5.5 12 5.5c1.7 0 3.2.55 4.5 1.32M21.5 12S18 18.5 12 18.5c-1.7 0-3.2-.55-4.5-1.32" />
                  <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
                  <path d="m4 20 16-16" />
                </svg>
              </button>
            </span>
            <span v-if="confirmMismatch" class="mismatch">两次输入的密码不一致</span>
          </label>

          <!-- 验证码：注册 & 验证码登录 -->
          <div v-if="needCode" class="field">
            <span class="label">邮箱验证码</span>
            <span class="code-row">
              <input
                :value="code"
                @input="onCodeInput"
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
                {{ countdown > 0 ? `${countdown}s 后重发` : sending ? '发送中…' : '发送验证码' }}
              </button>
            </span>
          </div>
        </div>

        <!-- 消息槽：固定高度防跳动；成功（蓝）/错误（灰红）分色（借鉴 SQL2ER） -->
        <div class="msg-slot" aria-live="polite">
          <p v-if="error" class="error" role="alert">{{ error }}</p>
          <p v-else-if="notice" class="notice-inline">{{ notice }}</p>
        </div>

        <button class="submit" type="submit" :disabled="submitting">
          <span v-if="submitting" class="spinner" />
          {{ submitting ? (isRegister ? '注册中…' : '登录中…') : isRegister ? '完成注册' : '登 录' }}
        </button>
      </form>

      <p class="switch">
        {{ isRegister ? '已有账号？' : '还没有账号？' }}
        <button type="button" class="link" @click="switchMode(isRegister ? 'login' : 'register')">
          {{ isRegister ? '返回登录' : '注册一个' }}
        </button>
      </p>

      <p class="notice">
        🔒 全站 HTTPS 传输 · 密码 scrypt 加盐存储 · 验证码 5 分钟内有效 ·
        登录方式：密码 或 邮箱验证码
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
  padding: 28px 16px;
  background:
    radial-gradient(1200px 500px at 50% -10%, rgba(91, 141, 239, 0.1), transparent 65%),
    var(--bg);
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
  max-width: 400px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  box-shadow: var(--shadow-2);
  padding: 30px 30px 24px;
}

/* ===== 头部 ===== */
.brand-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.logo {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 42px;
  height: 42px;
  background: var(--accent);
  color: #fff;
  border-radius: 12px;
  font-size: 18px;
  font-weight: 800;
  flex-shrink: 0;
  box-shadow: 0 4px 14px rgba(91, 141, 239, 0.32);
}

.brand-name {
  margin: 0;
  font-size: 15px;
  font-weight: 700;
  color: var(--ink);
}

.brand-sub {
  margin: 2px 0 0;
  font-size: 12.5px;
  color: var(--ink-soft);
}

.headline {
  margin-top: 20px;
}

.headline h1 {
  margin: 0;
  font-size: 24px;
  font-weight: 700;
  color: var(--ink);
  letter-spacing: -0.02em;
}

.headline-sub {
  margin: 6px 0 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--ink-soft);
}

/* ===== 登录/注册顶置 Tab（MyGPT 风格胶囊）===== */
.mode-tabs {
  display: flex;
  background: var(--bg);
  border-radius: var(--radius-s);
  padding: 4px;
  margin-top: 20px;
}

.mode-tab {
  flex: 1;
  border: none;
  background: transparent;
  padding: 8px 0;
  border-radius: 8px;
  font-size: 14px;
  color: var(--ink-soft);
  cursor: pointer;
  transition: background var(--speed) var(--ease), color var(--speed) var(--ease),
    box-shadow var(--speed) var(--ease);
}

.mode-tab.active {
  background: var(--card);
  color: var(--accent);
  font-weight: 600;
  box-shadow: var(--shadow-1);
}

/* ===== 登录方式下划线 Tab（SQL2ER 风格）===== */
.method-tabs {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid var(--line);
  margin: 16px 0 4px;
}

.method-tab {
  border: none;
  background: transparent;
  padding: 8px 2px 10px;
  margin-right: 18px;
  font-size: 13.5px;
  color: var(--ink-soft);
  cursor: pointer;
  border-bottom: 2px solid transparent;
  transition: color var(--speed) var(--ease), border-color var(--speed) var(--ease);
}

.method-tab:hover {
  color: var(--ink);
}

.method-tab.active {
  color: var(--accent);
  border-bottom-color: var(--accent);
  font-weight: 600;
}

/* ===== 表单 ===== */
.form-body {
  min-height: 216px; /* 最长表单（注册全字段）约 216px，切换时不跳 */
  padding-top: 14px;
  display: flex;
  flex-direction: column;
}

.field {
  display: block;
  margin-bottom: 14px;
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
  height: 44px;
  padding: 0 12px;
  border: 1.5px solid var(--line);
  border-radius: var(--radius-s);
  background: var(--bg);
  font-size: 14.5px;
  transition: border-color var(--speed) var(--ease), box-shadow var(--speed) var(--ease);
}

input:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(91, 141, 239, 0.15);
  background: #fff;
}

/* ===== 密码可见切换（SVG 图标，SQL2ER 同款）===== */
.pw-wrap {
  position: relative;
  display: block;
}

.pw-wrap input {
  padding-right: 46px;
}

.pw-toggle {
  position: absolute;
  right: 4px;
  top: 50%;
  transform: translateY(-50%);
  border: none;
  background: transparent;
  color: var(--ink-soft);
  padding: 7px;
  border-radius: 50%;
  cursor: pointer;
  display: inline-flex;
  transition: color var(--speed) var(--ease), background var(--speed) var(--ease);
}

.pw-toggle:hover {
  color: var(--accent);
  background: var(--accent-soft);
}

.eye {
  width: 19px;
  height: 19px;
  display: block;
}

/* ===== 密码强度条 ===== */
.strength {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
}

.strength-bar {
  flex: 1;
  height: 4px;
  background: #e8edf3;
  border-radius: 999px;
  overflow: hidden;
}

.strength-fill {
  display: block;
  height: 100%;
  border-radius: 999px;
  transition: width 240ms var(--ease), background 240ms var(--ease);
}

.strength-fill.s-1 { background: #aab4c4; }
.strength-fill.s-2 { background: #93a3bd; }
.strength-fill.s-3 { background: #7d95b8; }
.strength-fill.s-4 { background: #6486ef; }
.strength-fill.s-5 { background: var(--ok); }

.strength-label {
  font-size: 11.5px;
  color: var(--ink-faint);
  min-width: 26px;
  text-align: right;
}

.caps-hint {
  display: block;
  margin-top: 5px;
  font-size: 12px;
  color: var(--ink-soft);
}

.mismatch {
  display: block;
  margin-top: 5px;
  font-size: 12px;
  color: var(--ink-soft);
}

/* ===== 验证码行 ===== */
.code-row {
  display: flex;
  gap: 8px;
}

.code-input {
  flex: 1;
  letter-spacing: 3px;
  font-variant-numeric: tabular-nums;
}

.btn-send {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 44px;
  padding: 0 14px;
  border: 1.5px solid var(--accent);
  background: transparent;
  color: var(--accent);
  border-radius: var(--radius-s);
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
  transition: background var(--speed) var(--ease), opacity var(--speed) var(--ease),
    border-color var(--speed) var(--ease), color var(--speed) var(--ease);
}

.btn-send:hover:not(:disabled) {
  background: var(--accent-soft);
}

.btn-send:disabled {
  opacity: 0.6;
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

/* ===== 消息槽（固定高度防跳动）===== */
.msg-slot {
  min-height: 44px;
  display: flex;
  align-items: flex-start;
  margin-top: 2px;
}

.error {
  margin: 0;
  width: 100%;
  padding: 9px 12px;
  background: #f4f1f2;
  border-left: 3px solid var(--ink-soft);
  border-radius: 8px;
  color: var(--ink);
  font-size: 13px;
  line-height: 1.5;
  animation: shake 300ms var(--ease);
}

@keyframes shake {
  25% { transform: translateX(-2px); }
  75% { transform: translateX(2px); }
}

.notice-inline {
  margin: 0;
  width: 100%;
  padding: 9px 12px;
  background: var(--accent-soft);
  border-left: 3px solid var(--accent);
  border-radius: 8px;
  color: var(--ink);
  font-size: 12.5px;
  line-height: 1.5;
}

.submit {
  width: 100%;
  height: 46px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin-top: 6px;
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
  margin: 14px 0 0;
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
  margin: 18px 0 0;
  padding-top: 14px;
  border-top: 1px solid var(--line);
  color: var(--ink-faint);
  font-size: 11.5px;
  line-height: 1.7;
}

/* ===== 小屏适配 ===== */
@media (max-width: 460px) {
  .auth-card {
    padding: 24px 20px 20px;
  }

  .form-body {
    min-height: 0; /* 小屏不强制高度，避免空白过大 */
  }

  .code-row {
    flex-direction: column;
  }

  .btn-send {
    width: 100%;
  }
}
</style>
