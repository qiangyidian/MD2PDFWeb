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
 * - 队列透明：随时可查询排队位置与预计等待，SSE 推送位置变化
 */

class Scheduler {
  constructor() {
    this.concurrency = Math.max(1, config.concurrency);
    this.lane = []; // 等待/转换中的任务句柄（FIFO + 轮转）
    this.rr = 0; // round-robin 游标
    this.running = 0;
    this.paused = false;
    this.pausedReason = '';
    this.durations = []; // 最近任务耗时样本
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
    return this.lane.filter((h) => h.pending.length > 0).length;
  }

  // 某个 handle 的排队位置（1 = 下一个就轮到）与预计等待
  positionOf(handle) {
    const idx = this.lane.indexOf(handle);
    let tasksAhead = 0;
    for (let i = 0; i < idx; i += 1) tasksAhead += this.lane[i].pending.length;
    const estSec = Math.ceil((tasksAhead + this.running) * this.avgTaskMs() / this.concurrency / 1000);
    return { position: idx + 1, tasksAhead, estimatedWaitSec: estSec };
  }

  stats() {
    const mem = this.memory();
    return {
      running: this.running,
      concurrency: this.concurrency,
      queuedJobs: this.waitingJobs(),
      queuedTasks: this.lane.reduce((n, h) => n + h.pending.length, 0),
      paused: this.paused,
      pausedReason: this.pausedReason,
      avgTaskMs: this.avgTaskMs(),
      processed: this.handled,
      memory: mem
    };
  }

  // 某个归属（登录用户 id，未登录兜底 IP）当前占用（排队中 + 转换中）的任务数
  countByOwner(ownerKey) {
    return this.lane.filter((h) => h.ownerKey === ownerKey && !h.cancelled).length;
  }

  // ---------- 准入 ----------

  // 批量任务入队；队列已满或系统过载时抛 429/503
  submit({ jobId, ownerKey, tasks, runTask, callbacks }) {
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
      ownerKey,
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

    this.lane.push(handle);
    this.rr = Math.max(0, this.rr - 1); // 新任务尽快参与轮转
    setImmediate(() => this.#pump());
    return handle;
  }

  // 取消（排队中的立即失效，转换中的由调用方通过标志位协作取消）
  cancel(handle) {
    if (handle) handle.cancelled = true;
  }

  // 任务清理（TTL 回收 / 排队中取消）时移除句柄
  remove(handle) {
    const i = this.lane.indexOf(handle);
    if (i >= 0) this.lane.splice(i, 1);
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
    for (const handle of this.lane) {
      if (handle.callbacks?.onQueueUpdate) {
        const pos = this.positionOf(handle);
        handle.callbacks.onQueueUpdate({ ...pos, paused: this.paused, message });
      }
    }
  }

  // ---------- 派发 ----------

  #nextHandle() {
    for (let i = 0; i < this.lane.length; i += 1) {
      const h = this.lane[(this.rr + i) % this.lane.length];
      if (h.pending.length > 0 && !h.cancelled && !h.finished) {
        this.rr = (this.rr + i + 1) % this.lane.length;
        return h;
      }
    }
    return null;
  }

  #pump() {
    if (this.paused) return;

    // 清理已取消且无在跑任务的句柄（否则其 pending 永远无人处理，泄漏队列槽位）
    for (let i = this.lane.length - 1; i >= 0; i -= 1) {
      const h = this.lane[i];
      if (h.cancelled && !h.finished && h.runningCount === 0) {
        this.lane.splice(i, 1);
        h.finished = true;
        h.callbacks.onJobDone?.(true);
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
    const i = this.lane.indexOf(handle);
    if (i >= 0) this.lane.splice(i, 1);
    handle.callbacks.onJobDone?.(handle.cancelled);
  }
}

module.exports = new Scheduler();
