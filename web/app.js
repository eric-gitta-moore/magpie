/** 页面节点集中引用，指标更新不重建路由图和请求列表。 */
const view = Object.fromEntries(['connection', 'gateway', 'requests', 'waiting', 'qps', 'rate-notice', 'graph', 'graph-summary', 'graph-note', 'routes', 'updated', 'refresh'].map((id) => [id, document.getElementById(id)]));
/** 格式化路由 QPS 时保留两位小数。 */
const qpsFormat = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** 展示原始事件阶段，不根据阶段反推全局在途数。 */
const phases = { started: '等待路由', attempt: '正在请求', responding: '正在回答', attempt_done: '尝试已结束', done: '已完成', dropped: '记录已移出' };
/** 当前页面只有一个状态请求和一个下一次轮询计时器。 */
let pending = false, timer = null, request = null;
/** 仅当原始路由内容或连接状态变化时更新图和列表。 */
let shownRoutes = '';
/** 上一次有效状态用于尺寸变化时重新计算连线。 */
let latest = null;
/** 宿主隐藏 iframe 不会改变 document.hidden，因此独立保留侧栏可见状态。 */
let pageVisible = new URLSearchParams(location.search).get('visible') !== 'false';

/** 从宿主传来的颜色值设置主题，拒绝不属于颜色的 CSS 内容。 */
function applyTheme(theme) {
  const params = new URLSearchParams(location.search);
  document.documentElement.dataset.theme = theme ? (theme.dark ? 'dark' : 'light') : params.get('theme') === 'dark' ? 'dark' : 'light';
  let tokens = {};
  try { tokens = theme ? theme.tokens || {} : JSON.parse(params.get('tokens') || '{}'); } catch { /* 缺失主题值时沿用本页默认颜色。 */ }
  if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) return;
  for (const [name, variable] of [['bg', '--bg'], ['card', '--card'], ['fg', '--fg'], ['muted', '--muted'], ['line', '--line'], ['accent', '--accent']]) {
    document.documentElement.style.removeProperty(variable);
    const color = tokens[name] ?? tokens[variable];
    if (typeof color === 'string' && !/[;{}]|url\s*\(/i.test(color) && CSS.supports('color', color)) {
      document.documentElement.style.setProperty(variable, color);
    }
  }
}

/** 在同一份原始状态上更新三项指标，并明确显示统计窗口是否完整。 */
function draw(state) {
  latest = state;
  const connected = state.gateway?.connected === true;
  view.connection.textContent = connected ? '已连接' : '连接中断';
  view.connection.className = 'connection ' + (connected ? 'online' : 'offline');
  view.gateway.textContent = state.gateway?.url ? '本机网关 · ' + state.gateway.url : '正在寻找本机 Magpie 网关';
  for (const [key, field] of [['requests', 'requests'], ['waiting', 'waiting']]) {
    const value = state.concurrency?.[field];
    view[key].textContent = connected && Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString('zh-CN') : '—';
  }
  const rate = state.rate;
  view.qps.textContent = connected && rate?.complete === true && Number.isFinite(rate.qps) && rate.qps >= 0 ? qpsFormat.format(rate.qps) : '—';
  view['rate-notice'].className = 'notice' + (rate?.complete === true ? '' : ' incomplete');
  view['rate-notice'].textContent = !connected ? '连接中断，实时指标暂不可用；重连后会检查路由事件是否完整。' : rate?.notice || (rate?.complete === true ? '统计最近 60 秒收到的路由开始事件，重试不重复计数。' : '统计窗口不完整，路由 QPS 暂不可用。');
  const routes = Array.isArray(state.routes) ? state.routes.slice(0, 12) : [];
  const changed = JSON.stringify([connected, routes]);
  if (changed !== shownRoutes) {
    shownRoutes = changed;
    drawGraph(routes, connected);
    drawRoutes(routes, connected);
  }
  const at = new Date(state.updatedAt || '');
  view.updated.textContent = Number.isFinite(at.getTime()) ? '更新于 ' + at.toLocaleTimeString('zh-CN', { hour12: false }) : '尚未收到有效数据';
}

/** 按原始 Agent 与供应商分组，最多六个节点；连线坐标来自实际节点位置。 */
function drawGraph(routes, connected) {
  const active = routes.filter((route) => !['done', 'dropped'].includes(route.phase));
  const displayed = active.length ? active : routes;
  const groups = [new Map(), new Map()];
  for (const route of displayed) {
    for (const [index, label] of [route.agent || '未知 Agent', route.provider || '等待供应商'].entries()) {
      const previous = groups[index].get(label) || { count: 0, busy: false };
      previous.count++;
      previous.busy ||= connected && !['done', 'dropped'].includes(route.phase);
      groups[index].set(label, previous);
    }
  }
  const columns = groups.map((group, index) => {
    const list = document.createElement('ul');
    list.className = 'node-list ' + (index === 0 ? 'left' : 'right');
    list.setAttribute('aria-label', index === 0 ? 'Agent' : '供应商');
    const entries = [...group.entries()];
    if (entries.length > 6) {
      const others = entries.splice(5);
      entries.push(['其余 ' + others.length + ' 组', { count: others.reduce((sum, [, item]) => sum + item.count, 0), busy: others.some(([, item]) => item.busy) }]);
    }
    if (!entries.length) entries.push([index === 0 ? '等待 Agent' : '等待供应商', { count: 0, busy: false }]);
    for (const [label, item] of entries) {
      const node = document.createElement('li');
      node.className = 'node' + (item.busy ? ' busy' : '');
      node.title = label;
      const dot = document.createElement('span');
      dot.className = 'node-dot';
      dot.setAttribute('aria-hidden', 'true');
      const text = document.createElement('span');
      text.className = 'node-label';
      text.textContent = label === 'codex' ? 'Codex' : label;
      const count = document.createElement('span');
      count.className = 'node-count';
      count.textContent = item.count > 1 ? item.count + ' 条' : '';
      node.append(dot, text, count);
      list.append(node);
    }
    return list;
  });
  const hub = document.createElement('div');
  hub.className = 'hub' + (connected && active.length ? ' busy' : '');
  hub.textContent = 'magpie';
  const wires = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  wires.classList.add('wires');
  wires.setAttribute('aria-hidden', 'true');
  view.graph.replaceChildren(wires, columns[0], hub, columns[1]);
  view.graph.style.height = Math.max(180, Math.max(columns[0].children.length, columns[1].children.length) * 42 + 40) + 'px';
  const frame = view.graph.getBoundingClientRect(), center = hub.getBoundingClientRect();
  wires.setAttribute('viewBox', `0 0 ${frame.width} ${frame.height}`);
  for (const [index, list] of columns.entries()) {
    for (const node of list.children) {
      const point = node.getBoundingClientRect();
      const x = (index === 0 ? point.right : point.left) - frame.left;
      const y = point.y + point.height / 2 - frame.y;
      const toX = (index === 0 ? center.left : center.right) - frame.left;
      const toY = center.y + center.height / 2 - frame.y;
      const middle = (x + toX) / 2;
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', `M ${x} ${y} C ${middle} ${y}, ${middle} ${toY}, ${toX} ${toY}`);
      if (node.classList.contains('busy')) path.classList.add('busy');
      wires.append(path);
    }
  }
  view['graph-summary'].textContent = active.length ? '显示 ' + active.length + ' 条在途路由记录' : displayed.length ? '最近路由 · 当前空闲' : '等待路由事件';
  view['graph-note'].textContent = active.length ? '路由记录可能少于全网关在途数，在途与排队来自全局接口。' : routes.length ? '新请求开始后会自动更新线路。' : '还没有路由记录';
}

/** 只用 textContent 展示模型和供应商；未完成记录不假装已有耗时结果。 */
function drawRoutes(routes, connected) {
  const rows = routes.map((route) => {
    const row = document.createElement('li');
    const active = !['done', 'dropped'].includes(route.phase);
    row.className = 'route' + (route.failed ? ' failed' : connected && active ? ' busy' : '');
    const top = document.createElement('div');
    top.className = 'route-top';
    const agent = document.createElement('span');
    agent.className = 'route-agent';
    agent.textContent = route.agent === 'codex' ? 'Codex' : route.agent || '未知 Agent';
    const model = document.createElement('span');
    model.className = 'route-model';
    model.textContent = route.model || '等待模型信息';
    const time = document.createElement('time');
    time.className = 'route-time';
    const at = new Date(route.time || '');
    if (Number.isFinite(at.getTime())) {
      time.dateTime = at.toISOString();
      time.textContent = at.toLocaleTimeString('zh-CN', { hour12: false });
    } else time.textContent = '—';
    top.append(agent, model, time);
    const bottom = document.createElement('div');
    bottom.className = 'route-bottom';
    const target = document.createElement('span');
    target.className = 'route-target';
    target.textContent = '→ ' + (route.provider || '等待供应商') + ' · ';
    const phase = document.createElement('span');
    phase.className = 'route-state';
    phase.textContent = !connected && active ? '状态待确认' : route.failed ? '请求失败' : phases[route.phase] || '状态未知';
    target.append(phase);
    const duration = document.createElement('span');
    duration.className = 'route-duration';
    duration.textContent = Number.isFinite(route.ms) && route.ms >= 0 && !active ? (route.ms < 1000 ? Math.round(route.ms) + ' 毫秒' : (route.ms / 1000).toFixed(1) + ' 秒') : '';
    bottom.append(target, duration);
    row.append(top, bottom);
    return row;
  });
  if (!rows.length) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = connected ? '等待第一条路由记录' : '网关连接恢复后会重新读取路由';
    rows.push(empty);
  }
  view.routes.replaceChildren(...rows);
}

/** 仅页面可见时读取状态；后台统计由服务负责，不随本页关闭而清空。 */
async function poll() {
  if (pending || !pageVisible || document.hidden) return;
  clearTimeout(timer);
  pending = true;
  request = new AbortController();
  const deadline = setTimeout(() => request?.abort(), 5000);
  try {
    const response = await fetch(new URL('api/state', location.href), { credentials: 'omit', headers: { 'X-Route-Monitor-Key': document.querySelector('meta[name="route-monitor-key"]').content }, signal: request.signal, cache: 'no-store' });
    if (!response.ok) throw new Error('State read failed');
    const state = await response.json();
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('Invalid state');
    if (pageVisible && !document.hidden) draw(state);
  } catch {
    if (pageVisible && !document.hidden) draw({ gateway: { url: latest?.gateway?.url, connected: false }, routes: latest?.routes || [], concurrency: null, rate: null });
  } finally {
    clearTimeout(deadline);
    pending = false;
    request = null;
    if (pageVisible && !document.hidden) timer = setTimeout(poll, 1000);
  }
}

applyTheme();
view.refresh.addEventListener('click', poll);
document.addEventListener('visibilitychange', () => {
  clearTimeout(timer);
  if (!pageVisible || document.hidden) request?.abort();
  else poll();
});
// 宿主消息只从当前父窗口接收，其他 frame 不能改变本页状态。
window.addEventListener('message', (event) => {
  if (event.source !== parent || event.data?.magpie !== 1) return;
  if (event.data.event === 'theme' && typeof event.data.data?.dark === 'boolean') applyTheme(event.data.data);
  if (event.data.event === 'visibility' && typeof event.data.data?.visible === 'boolean') {
    pageVisible = event.data.data.visible;
    clearTimeout(timer);
    if (!pageVisible || document.hidden) request?.abort();
    else poll();
  }
});
window.addEventListener('beforeunload', () => { clearTimeout(timer); request?.abort(); });
window.addEventListener('resize', () => { if (latest) drawGraph(Array.isArray(latest.routes) ? latest.routes.slice(0, 12) : [], latest.gateway?.connected === true); });
poll();
