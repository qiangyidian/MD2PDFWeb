const os = require('node:os');

const config = require('../config');

/**
 * 多用户转换调度器（进程内消息队列）
 *
 * 设计目标：在 2 核 / 3.8G 的小机器上承载真实多用户，不压垮系统。
 *
 * - 渲染并发由本调度器统一控制（pdf.js 不再自带信号量），默认 2 路
 * - 任务级 Round-Robin：多个用户的批量文件交错执行，小任务不被大任务饿死
 * - 内存水位保护：空闲内存不足时暂停派发，恢复后自动继续（背压）
 * - 高优先级通道：文本直转等交互式请求插队于批量任务
 * - 队列透明：随时可查询排队位置与预计等待，SSE 推送位置变化
 */

const HIGH = 'high';
const NORMAL = 'normal';

class Scheduler {
  constructor() {
    this.concurrency = Math.max(1, config.concurrency);
    this.lanes = { [HIGH]: [], [NORMAL]: [] };
    this.rr = 0; // round-robin 游标（normal 通道）
    this.running = 0;
    this.paused = false;
    this.pausedReason = '';
    this.durations = []; // 最近任务耗时样本（EWMA）
    this.memoryTimer = null;
    this.handled = 0;
  }

  // ---------- 统计 ----------

  avgTaskMs() {
    if (!this.durations.length) return 3000;
    const sum = this.durations.reduce((a, b) => a + b, 0);
    return Math.round(sum / this.durations.length);
  }

  memory() {
    const freeMem = os.freemem();
    const totalMem = os.totalmem();
    return {
      freeMemBytes: freeMem,
      totalMemBytes: totalMem,
      freePct: Math.round((freeMem / totalMem) * 100),
      heapUsedPct: Math.round((process.memoryUsage().heapUsed / process.memoryUsage().heapTotal) * 100),
      low: freeMem < config.queue.minFreeMemBytes
    };
  }

  waitingJobs() {
    return [...this.lanes[HIGH], ...this.lanes[NORMAL]].filter((h) => h.pending.length > 0).length;
  }

  // 某个 handle 的排队位置（1 = 下一个就轮到）与预计等待
  positionOf(handle) {
    const ahead = [...this.lanes[HIGH], ...this.lanes[NORMAL]];
    const idx = ahead.indexOf(handle);
    let tasksAhead = 0;
    for (let i = 0; i < idx; i += 1) tasksAhead += ahead[i].pending.length;
    const estSec = Math.ceil((tasksAhead + this.running) * this.avgTaskMs() / this.concurrency / 1000);
    return { position: idx + 1, tasksAhead, estimatedWaitSec: estSec };
  }

  stats() {
    const mem = this.memory();
    return {
      running: this.running,
      concurrency: this.concurrency,
      queuedJobs: this.waitingJobs(),
      queuedTasks: [...this.lanes[HIGH], ...this.lanes[NORMAL]].reduce((n, h) => n + h.pending.length, 0),
      paused: this.paused,
      pausedReason: this.pausedReason,
      avgTaskMs: this.avgTaskMs(),
      processed: this.handled,
      memory: mem
    };
  }

  // 某个 IP 当前占用（排队中 + 转换中）的任务数
  countByIp(ip) {
    let n = 0;
    for (const lane of [this.lanes[HIGH], this.lanes[NORMAL]]) {
      for (const h of lane) {
        if (h.ip === ip && !h.cancelled) n += 1;
      }
    }
    return n;
  }

  // ---------- 准入 ----------

  // 批量任务入队；队列已满或系统过载时抛 429
  submit({ jobId, ip, tasks, runTask, callbacks, priority = NORMAL }) {
    if (this.paused) {
      const error = new Error('系统当前负载较高，请稍后再试');
      error.statusCode = 503;
      throw error;
    }
    if (this.waitingJobs() >= config.queue.maxWaitingJobs) {
      const error = new Error(`当前排队任务过多（上限 ${config.queue.maxWaitingJobs}），请稍后再试`);
      error.statusCode = 429;
      throw error;
    }

    const handle = {
      jobId,
      ip,
      pending: [...tasks],
      total: tasks.length,
      runningCount: 0,
      cancelled: false,
      finished: false,
      started: false, // 是否已有任务真正开跑（用于状态切换与事件）
      runTask,
      callbacks,
      enqueuedAt: Date.now()
    };

    const lane = this.lanes[priority] || this.lanes[NORMAL];
    lane.push(handle);
    if (priority === NORMAL) this.rr = Math.max(0, this.rr - 1); // 新任务尽快参与轮转
    setImmediate(() => this.#pump());
    return handle;
  }

  // 单任务快捷通道（文本直转），返回 Promise
  submitOne(fn, { priority = HIGH } = {}) {
    return new Promise((resolve, reject) => {
      let handle;
      const task = {
        run: () => fn().then(resolve, reject),
        done: () => {}
      };
      // 轻量 handle：复用 submit 机制但独享生命周期
      handle = {
        jobId: `oneoff-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        ip: '',
        pending: [{ __oneoff: task }],
        total: 1,
        runningCount: 0,
        cancelled: false,
        finished: false,
        started: false,
        runTask: async (t) => t.run(),
        callbacks: {
          onJobEvent: () => {},
          onTaskStart: () => {},
          onTaskDone: () => {},
          onTaskError: () => {},
          onJobDone: () => {}
        },
        enqueuedAt: Date.now()
      };
      const lane = this.lanes[priority] || this.lanes[NORMAL];
      lane.push(handle);
      setImmediate(() => this.#pump());
    });
  }

  // 取消（排队中的立即失效，转换中的由调用方通过标志位协作取消）
  cancel(handle) {
    if (handle) handle.cancelled = true;
  }

  // 任务清理（TTL 回收）时移除 handle
  remove(handle) {
    for (const key of [HIGH, NORMAL]) {
      const i = this.lanes[key].indexOf(handle);
      if (i >= 0) this.lanes[key].splice(i, 1);
    }
  }

  // ---------- 内存水位保护 ----------

  #checkMemory() {
    const mem = this.memory();
    if (mem.low && !this.paused) {
      this.paused = true;
      this.pausedReason = `系统内存不足（空闲 ${mem.freePct}%），已暂停派发新渲染，正在等待恢复`;
      console.warn(`[scheduler] ${this.pausedReason}`);
      this.#notifyWaiting('系统内存不足，排队等待中…');
    }
    this.#scheduleMemoryCheck();
  }

  #scheduleMemoryCheck() {
    if (this.memoryTimer) return;
    this.memoryTimer = setInterval(() => {
      const mem = this.memory();
      if (this.paused && !mem.low) {
        this.paused = false;
        this.pausedReason = '';
        console.log('[scheduler] 内存已恢复，继续派发任务');
        this.#notifyWaiting('系统已恢复，继续处理队列…');
        this.#pump();
      }
      if (!this.paused && !mem.low && this.running === 0 && this.waitingJobs() === 0) {
        clearInterval(this.memoryTimer);
        this.memoryTimer = null;
      }
    }, config.queue.memoryCheckIntervalMs);
    this.memoryTimer.unref?.();
  }

  #notifyWaiting(message) {
    for (const handle of [...this.lanes[HIGH], ...this.lanes[NORMAL]]) {
      if (handle.callbacks?.onQueueUpdate) {
        const pos = this.positionOf(handle);
        handle.callbacks.onQueueUpdate({ ...pos, paused: this.paused, message });
      }
    }
  }

  // ---------- 派发 ----------

  // Round-Robin 选出下一个待执行 handle：高优先级优先，普通通道轮转
  #nextHandle() {
    const high = this.lanes[HIGH].find((h) => h.pending.length > 0 && !h.cancelled);
    if (high) return high;

    const normal = this.lanes[NORMAL];
    for (let i = 0; i < normal.length; i += 1) {
      const h = normal[(this.rr + i) % normal.length];
      if (h.pending.length > 0 && !h.cancelled) {
        this.rr = (this.rr + i + 1) % normal.length;
        return h;
      }
    }
    return null;
  }

  #pump() {
    if (this.paused) return;

    // 清理已取消且无在跑任务的句柄（否则其 pending 永远无人处理，泄漏队列槽位）
    for (const key of [HIGH, NORMAL]) {
      const lane = this.lanes[key];
      for (let i = lane.length - 1; i >= 0; i -= 1) {
        const h = lane[i];
        if (h.cancelled && !h.finished && h.runningCount === 0) {
          lane.splice(i, 1);
          h.finished = true;
          h.callbacks.onJobDone?.(true);
        }
      }
    }

    while (this.running < this.concurrency) {
      const handle = this.#nextHandle();
      if (!handle) break;

      const task = handle.pending.shift();
      if (!task) break;

      if (handle.cancelled || handle.finished) continue;

      if (!handle.started) {
        handle.started = true;
        handle.callbacks.onJobStart?.();
      }

      this.running += 1;
      handle.runningCount += 1;
      const startedAt = Date.now();

      this.#runOne(handle, task, startedAt);
    }

    // 通知所有仍在排队者位置变化
    this.#notifyWaiting('');

    // 预约内存检查（有任务在跑或有人排队时保持守护）
    if (this.running > 0 || this.waitingJobs() > 0) this.#scheduleMemoryCheck();
  }

  async #runOne(handle, task, startedAt) {
    try {
      if (handle.cancelled) throw Object.assign(new Error('已取消'), { cancelled: true });

      // 超时保护：单个任务卡死不拖垮整个队列
      const result = await Promise.race([
        handle.runTask(task),
        new Promise((_resolve, reject) => setTimeout(
          () => reject(Object.assign(new Error('单文件转换超时，已跳过'), { timeout: true })),
          config.queue.taskTimeoutMs
        ))
      ]);

      handle.callbacks.onTaskDone?.(task, result);
      this.handled += 1;
    } catch (error) {
      handle.callbacks.onTaskError?.(task, error);
    } finally {
      const elapsed = Date.now() - startedAt;
      this.durations.push(elapsed);
      if (this.durations.length > 30) this.durations.shift();

      this.running -= 1;
      handle.runningCount -= 1;

      // 任务全部结束（含取消）
      if (handle.pending.length === 0 && handle.runningCount === 0) {
        this.#finish(handle);
      }

      // 内存守护：跑完一个任务顺手检查，防止连续重压
      this.#checkMemory();
      this.#pump();
    }
  }

  #finish(handle) {
    if (handle.finished) return;
    handle.finished = true;
    const lanes = [this.lanes[HIGH], this.lanes[NORMAL]];
    for (const lane of lanes) {
      const i = lane.indexOf(handle);
      if (i >= 0) lane.splice(i, 1);
    }
    handle.callbacks.onJobDone?.(handle.cancelled);
  }
}

module.exports = new Scheduler();
