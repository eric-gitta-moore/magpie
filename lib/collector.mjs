import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/** Validate a local gateway, so the monitor cannot become an arbitrary HTTP proxy. */
export function localGateway(value) {
  const url = new URL(value.includes('://') ? value : `http://${value}`);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('网关地址必须是本机回环 HTTP 地址');
  }
  if (!Number.isInteger(Number(url.port || 80)) || Number(url.port || 80) < 1) {
    throw new Error('网关地址需要有效端口');
  }
  return url.origin;
}

/** Read Magpie's configured port without reading provider accounts or gateway credentials. */
export async function resolveGateway({ gateway = '', configDir = '', env = process.env } = {}) {
  if (gateway) return localGateway(gateway);
  if (env.MAGPIE_ADDR) {
    const address = env.MAGPIE_ADDR.trim().replace(/^(?:0\.0\.0\.0|\[::\])?:/, '127.0.0.1:');
    return localGateway(address);
  }
  const directory = configDir || path.join(env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME)
    ? env.XDG_CONFIG_HOME : path.join(env.HOME || os.homedir(), '.config'), 'magpie');
  let port = 3425;
  try {
    const settings = JSON.parse(await fs.readFile(path.join(directory, 'settings.json'), 'utf8'));
    if (Number.isInteger(settings.port) && settings.port > 0 && settings.port <= 65535) port = settings.port;
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('无法读取 Magpie 的端口设置');
  }
  return `http://127.0.0.1:${port}`;
}

/** A bounded, gateway-owned observation window; it counts route starts, never client requests. */
export class RouteCollector {
  /** Inject the clock and HTTP reader for deterministic window and reconnection checks. */
  constructor({ gateway = '', configDir = '', env = process.env, fetcher = fetch, now = Date.now,
    pollMs = 1000, retryMs = 1000, timeoutMs = 5000 } = {}) {
    this.options = { gateway, configDir, env };
    this.fetcher = fetcher;
    this.now = now;
    this.pollMs = pollMs;
    this.retryMs = retryMs;
    this.timeoutMs = timeoutMs;
    this.url = '';
    this.cursor = '';
    this.routes = new Map();
    this.startedIds = new Map();
    this.buckets = Array.from({ length: 60 }, () => ({ second: -1, count: 0 }));
    this.knownSince = null;
    this.lastClock = this.now();
    this.lastFeedAt = this.lastClock;
    this.feedConnected = false;
    this.concurrency = null;
    this.concurrencyAt = 0;
    this.error = '';
    this.reason = '正在连接路由事件，统计窗口尚未完整';
    this.controller = null;
    this.streamController = null;
    this.tasks = [];
  }

  /** Start one feed and one global concurrency poller for the plugin host, independent of its page. */
  start() {
    if (this.controller) return this;
    this.controller = new AbortController();
    this.tasks = [this.pollConcurrency(this.controller.signal), this.watchRoutes(this.controller.signal)];
    return this;
  }

  /** Abort pending reads and timers so uninstall/reload/test teardown leaves no observer running. */
  async stop() {
    if (!this.controller) return;
    this.controller.abort();
    await Promise.allSettled(this.tasks);
    this.controller = null;
    this.tasks = [];
    this.feedConnected = false;
    this.concurrency = null;
  }

  /** Discard a window that cannot be reconstructed, while keeping the honest reason visible. */
  resetWindow(reason = '路由事件存在缺口，重新连续观察 60 秒') {
    for (const bucket of this.buckets) { bucket.second = -1; bucket.count = 0; }
    this.startedIds.clear();
    this.knownSince = this.now();
    this.lastClock = this.knownSince;
    this.reason = reason;
  }

  /** A snapshot seeds the display and cursor; existing active rows are not new start events. */
  acceptSnapshot(snapshot, reason) {
    if (typeof snapshot.cursor !== 'string' || !/^[^:]+:\d+$/.test(snapshot.cursor) || !Array.isArray(snapshot.routes)) {
      throw new Error('路由快照格式不完整');
    }
    this.cursor = snapshot.cursor;
    this.routes.clear();
    this.resetWindow(reason || '首次连接，正在连续观察 60 秒');
    for (const route of snapshot.routes.slice(-120)) {
      if (typeof route?.id === 'string') {
        this.routes.set(route.id, route);
        this.startedIds.set(route.id, Date.parse(route.time));
      }
    }
  }

  /** Apply each cursor once; replay timestamps stay in their original seconds rather than arrival time. */
  acceptEvent(event) {
    if (!event || typeof event.cursor !== 'string' || !event.route || typeof event.route.id !== 'string') {
      throw new Error('路由事件格式不完整');
    }
    const previous = this.cursor.split(':');
    const next = event.cursor.split(':');
    if (next.length !== 2 || !/^\d+$/.test(next[1])) throw new Error('路由事件游标无效');
    if (previous[0] !== next[0]) throw new Error('路由事件来自新的网关进程');
    if (Number(next[1]) <= Number(previous[1])) return;
    if (Number(next[1]) !== Number(previous[1]) + 1) throw new Error('路由事件游标存在缺口');
    this.checkClock();
    const now = this.now();
    const route = event.route;
    this.cursor = event.cursor;
    this.lastFeedAt = now;
    this.routes.delete(route.id);
    this.routes.set(route.id, route);
    while (this.routes.size > 120) this.routes.delete(this.routes.keys().next().value);
    if (event.kind !== 'request_started' || this.startedIds.has(route.id)) return;
    const time = Date.parse(route.time);
    if (!Number.isFinite(time) || time > now + 1000) throw new Error('路由开始时间无效');
    this.startedIds.set(route.id, time);
    // Cursor replay is bounded to 512 events. Keep enough identities to
    // reject duplicate start notifications without growing with lifetime traffic.
    while (this.startedIds.size > 512) this.startedIds.delete(this.startedIds.keys().next().value);
    const second = Math.floor(time / 1000);
    const current = Math.floor(now / 1000);
    if (second > current || second < current - 59) return;
    const bucket = this.buckets[((second % 60) + 60) % 60];
    if (bucket.second !== second) { bucket.second = second; bucket.count = 0; }
    bucket.count++;
  }

  /** A clock rollback invalidates history rather than reviving expired samples. */
  checkClock() {
    const now = this.now();
    if (now < this.lastClock) this.resetWindow('系统时间回拨，重新连续观察 60 秒');
    this.lastClock = now;
    return now;
  }

  /** Return original gateway wire objects plus a clearly qualified observation rate. */
  getState() {
    const now = this.checkClock();
    const current = Math.floor(now / 1000);
    const coveredSeconds = this.knownSince === null ? 0 : Math.min(60, Math.max(0, Math.floor((now - this.knownSince) / 1000)));
    const complete = this.feedConnected && coveredSeconds === 60;
    const count = this.buckets.reduce((sum, bucket) => sum + (bucket.second >= current - 59 && bucket.second <= current ? bucket.count : 0), 0);
    const concurrency = now - this.concurrencyAt <= this.timeoutMs + this.pollMs * 2 ? this.concurrency : null;
    const notice = !this.feedConnected ? '路由事件已断连，QPS 暂不可用；正在尝试补回事件'
      : !complete ? `${this.reason}（${coveredSeconds}/60 秒）` : '最近 60 秒路由记录数 ÷ 60，按记录的请求开始时间统计；重试不重复计数，非网关入口 QPS';
    return {
      gateway: { url: this.url, connected: concurrency !== null, error: this.error }, concurrency,
      rate: { qps: complete ? count / 60 : null, windowSeconds: 60, complete, coveredSeconds, notice },
      routes: [...this.routes.values()].reverse().slice(0, 12), updatedAt: new Date(now).toISOString(),
    };
  }

  /** Re-resolve settings on reconnection; switching ports starts a fresh observation window. */
  async gatewayURL() {
    const url = await resolveGateway(this.options);
    if (this.url && this.url !== url) {
      this.streamController?.abort();
      this.feedConnected = false;
      this.cursor = '';
      this.routes.clear();
      this.resetWindow('网关地址已变化，重新连续观察 60 秒');
      this.concurrency = null;
    }
    this.url = url;
    return url;
  }

  /** Poll the real global counter; neither trace pruning nor dropped events affect in-flight totals. */
  async pollConcurrency(signal) {
    while (!signal.aborted) {
      try {
        const url = await this.gatewayURL();
        const response = await this.fetcher(`${url}/v1/magpie/concurrency`, {
          redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]),
        });
        if (!response.ok) throw new Error(`并发接口返回 HTTP ${response.status}`);
        const value = await response.json();
        if (!Number.isInteger(value.requests) || value.requests < 0 || !Number.isInteger(value.waiting) || value.waiting < 0) {
          throw new Error('并发接口缺少全局请求数');
        }
        if (url === this.url) {
          this.concurrency = value;
          this.concurrencyAt = this.now();
          this.error = '';
        }
      } catch (error) {
        if (!signal.aborted) { this.concurrency = null; this.error = error.message || '并发接口暂不可用'; }
      }
      try { await delay(this.pollMs, undefined, { signal }); } catch { break; }
    }
  }

  /** Follow a resumable SSE cursor; only an unrecoverable cursor discards the known window. */
  async watchRoutes(signal) {
    let needsSnapshot = true;
    while (!signal.aborted) {
      const stream = new AbortController();
      this.streamController = stream;
      let watchdog, handshake;
      try {
        const url = await this.gatewayURL();
        if (!this.cursor) needsSnapshot = true;
        let target;
        if (needsSnapshot) {
          const response = await this.fetcher(`${url}/v1/magpie/route-events/snapshot`, {
            redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]),
          });
          if (!response.ok) throw new Error(`路由快照返回 HTTP ${response.status}`);
          this.acceptSnapshot(await response.json(), this.knownSince === null ? undefined : '路由事件存在缺口，重新连续观察 60 秒');
          needsSnapshot = false;
          target = this.cursor;
        } else {
          // A 200 stream response only proves replay is allowed. Read the
          // current cursor, then restore completeness after reaching it.
          const snapshot = await this.fetcher(`${url}/v1/magpie/route-events/snapshot`, {
            redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]),
          });
          if (!snapshot.ok) throw new Error(`路由快照返回 HTTP ${snapshot.status}`);
          target = (await snapshot.json()).cursor;
          if (typeof target !== 'string' || !/^[^:]+:\d+$/.test(target) || target.split(':')[0] !== this.cursor.split(':')[0]) {
            needsSnapshot = true;
            throw new Error('路由事件来自新的网关进程');
          }
        }
        handshake = setTimeout(() => stream.abort(), this.timeoutMs);
        handshake.unref?.();
        const response = await this.fetcher(`${url}/v1/magpie/route-events?after=${encodeURIComponent(this.cursor)}`, {
          redirect: 'error', signal: AbortSignal.any([signal, stream.signal]),
        });
        clearTimeout(handshake);
        if (response.status === 409) { needsSnapshot = true; throw new Error('路由事件已超出重放范围'); }
        if (!response.ok || !response.body) throw new Error(`路由事件返回 HTTP ${response.status}`);
        this.feedConnected = this.cursor === target;
        this.lastFeedAt = this.now();
        watchdog = setInterval(() => {
          if (this.now() - this.lastFeedAt > 35000) stream.abort();
        }, this.pollMs);
        watchdog.unref?.();
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            buffer = (buffer + decoder.decode(chunk.value, { stream: true })).replace(/\r\n/g, '\n');
            if (buffer.length > 262144) throw new Error('路由事件帧过长');
            let end;
            while ((end = buffer.indexOf('\n\n')) !== -1) {
              const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
              const lines = frame.split('\n');
              const kind = lines.find((line) => line.startsWith('event:'))?.slice(6).trim();
              const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
              this.lastFeedAt = this.now();
              if (kind === 'reset') { needsSnapshot = true; throw new Error('路由事件需要重新获取快照'); }
              if (kind === 'route') {
                this.acceptEvent(JSON.parse(data));
                if (Number(this.cursor.split(':')[1]) >= Number(target.split(':')[1])) this.feedConnected = true;
              }
              if (kind === 'heartbeat') this.feedConnected = true;
            }
          }
        } finally { await reader.cancel().catch(() => {}); }
        throw new Error('路由事件连接已结束');
      } catch (error) {
        if (!signal.aborted && /游标|进程|缺口|格式|时间/.test(error.message || '')) needsSnapshot = true;
        this.feedConnected = false;
      } finally {
        clearTimeout(handshake); clearInterval(watchdog); stream.abort();
        if (this.streamController === stream) this.streamController = null;
      }
      try { await delay(this.retryMs, undefined, { signal }); } catch { break; }
    }
  }
}
