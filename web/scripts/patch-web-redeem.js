// 补丁：前端接入兑换码（用户端）
const fs = require('node:fs');
const path = require('node:path');

const web = path.resolve(__dirname, '..', 'web');
const read = (p) => fs.readFileSync(path.join(web, p), 'utf8');
const write = (p, s) => fs.writeFileSync(path.join(web, p), s);

// ---------- 1. api.js ----------
let api = read('src/api.js');
if (api.includes('export function redeemCode')) {
  console.log('api.js: 已存在，跳过');
} else {
  api += `
// 兑换码：成功后返回新余额，交由父组件同步到 UserBadge 与 Workbench，
// 不再额外拉一次 /api/auth/me（少一次往返，也避免与 SSE 的 quota 事件竞态）
export function redeemCode(code) {
  return request('/api/redeem', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code })
  })
}
`;
  write('src/api.js', api);
  console.log('api.js: 已加入 redeemCode');
}

// ---------- 2. UserBadge.vue ----------
let badge = read('src/components/UserBadge.vue');

if (badge.includes('openRedeem')) {
  console.log('UserBadge.vue: 已存在，跳过');
} else {
  // 2.1 引入
  badge = badge.replace(
    "import { computed } from 'vue'",
    "import { computed, ref } from 'vue'\nimport { redeemCode } from '../api'\nimport AppDialog from './AppDialog.vue'"
  );

  // 2.2 事件
  badge = badge.replace(
    "const emit = defineEmits(['logout', 'open-admin'])",
    "const emit = defineEmits(['logout', 'open-admin', 'redeemed'])"
  );

  // 2.3 状态与提交逻辑
  const stateAnchor = `const quotaExhausted = computed(() => props.quota === 0)
const isAdmin = computed(() => !!props.user?.isAdmin)`;
  if (!badge.includes(stateAnchor)) throw new Error('UserBadge.vue 状态锚点未找到');
  badge = badge.replace(
    stateAnchor,
    `${stateAnchor}

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
}`
  );

  // 2.4 模板：兑换按钮（放在管理按钮之前）
  const btnAnchor = `    <button v-if="isAdmin" class="admin-btn" title="进入管理后台" @click="emit('open-admin')">管理</button>`;
  if (!badge.includes(btnAnchor)) throw new Error('UserBadge.vue 按钮锚点未找到');
  badge = badge.replace(
    btnAnchor,
    `    <button class="redeem-btn" title="输入兑换码充值额度" @click="openRedeem">兑换</button>
${btnAnchor}`
  );

  // 2.5 模板：弹窗（AppDialog 用 :open 属性 + #actions 插槽）
  badge = badge.replace(
    '</template>',
    `  <AppDialog :open="showRedeem" title="兑换额度" @close="showRedeem = false">
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
</template>`
  );

  // 2.6 样式
  badge = badge.replace(
    '</style>',
    `
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
</style>`
  );

  write('src/components/UserBadge.vue', badge);
  console.log('UserBadge.vue: 已接入兑换入口');
}

// ---------- 3. Workbench.vue 转发事件 ----------
let wb = read('src/components/Workbench.vue');
if (wb.includes("'redeemed'")) {
  console.log('Workbench.vue: 已转发，跳过');
} else {
  wb = wb.replace(
    "const emit = defineEmits(['select', 'start', 'cancel', 'reset', 'logout'])",
    "const emit = defineEmits(['select', 'start', 'cancel', 'reset', 'logout', 'redeemed'])"
  );
  const anchor = `          :quota="quota"
          @logout="emit('logout')"`;
  if (!wb.includes(anchor)) throw new Error('Workbench.vue UserBadge 锚点未找到');
  wb = wb.replace(anchor, `${anchor}\n          @redeemed="emit('redeemed', $event)"`);
  write('src/components/Workbench.vue', wb);
  console.log('Workbench.vue: 已转发 redeemed');
}

// ---------- 4. App.vue 接收 ----------
let app = read('src/App.vue');
if (app.includes('onRedeemed')) {
  console.log('App.vue: 已接收，跳过');
} else {
  // 复用已有的 applyQuota：兑换成功返回的就是权威余额
  const anchor = `// 余额同步：SSE quota 事件与任务快照均携带最新剩余额度
function applyQuota(value) {
  if (typeof value === 'number') remainingQuota.value = value
}`;
  if (!app.includes(anchor)) throw new Error('App.vue applyQuota 锚点未找到');
  app = app.replace(
    anchor,
    `${anchor}

// 兑换成功后端直接返回新余额（权威值），走同一条同步逻辑
function onRedeemed(newRemaining) {
  applyQuota(newRemaining)
}`
  );

  // Workbench 与落地页两处都要挂上
  const wbAnchor = `          @logout="onLogout"
          @select="selectedPath = $event"`;
  if (!app.includes(wbAnchor)) throw new Error('App.vue Workbench 锚点未找到');
  app = app.replace(wbAnchor, `          @logout="onLogout"
          @redeemed="onRedeemed"
          @select="selectedPath = $event"`);

  const badgeAnchor = `<UserBadge :user="user" :quota="remainingQuota" @logout="onLogout" @open-admin="showAdmin = true" />`;
  if (!app.includes(badgeAnchor)) throw new Error('App.vue UserBadge 锚点未找到');
  app = app.replace(
    badgeAnchor,
    `<UserBadge
          :user="user"
          :quota="remainingQuota"
          @logout="onLogout"
          @open-admin="showAdmin = true"
          @redeemed="onRedeemed"
        />`
  );

  write('src/App.vue', app);
  console.log('App.vue: 已接收 redeemed');
}
