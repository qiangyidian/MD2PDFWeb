<script setup>
import { ref, computed } from 'vue'
import { login, register } from '../api'

const emit = defineEmits(['authenticated'])

// mode: login | register
const mode = ref('login')
const email = ref('')
const password = ref('')
const name = ref('')
const showPassword = ref(false)
const submitting = ref(false)
const error = ref('')

const isLogin = computed(() => mode.value === 'login')

function switchMode() {
  mode.value = isLogin.value ? 'register' : 'login'
  error.value = ''
}

const passwordHint = computed(() =>
  password.value && password.value.length < 8 ? '密码至少 8 位' : ''
)

async function submit() {
  if (submitting.value) return
  error.value = ''

  if (!email.value.trim() || !password.value) {
    error.value = isLogin.value ? '请输入邮箱和密码' : '请填写邮箱和密码'
    return
  }
  if (!isLogin.value && password.value.length < 8) {
    error.value = '密码至少 8 位'
    return
  }

  submitting.value = true
  try {
    const payload = isLogin.value
      ? { email: email.value.trim(), password: password.value }
      : { email: email.value.trim(), password: password.value, name: name.value.trim() }
    const result = isLogin.value ? await login(payload) : await register(payload)
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

        <label class="field">
          <span class="label">密码</span>
          <span class="pw-wrap">
            <input
              v-model="password"
              :type="showPassword ? 'text' : 'password'"
              name="password"
              :autocomplete="isLogin ? 'current-password' : 'new-password'"
              placeholder="至少 8 位"
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
          <span v-if="!isLogin && passwordHint" class="hint">{{ passwordHint }}</span>
        </label>

        <p v-if="error" class="error" role="alert">{{ error }}</p>

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

      <p class="notice">🔒 全站 HTTPS 传输 · 密码 scrypt 加盐哈希存储 · 会话 7 天免登录</p>
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
  margin-bottom: 24px;
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
