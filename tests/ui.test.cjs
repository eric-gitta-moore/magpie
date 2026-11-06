/** Tests use actual page assets with controlled API states, without a model request. */
const assert = require('node:assert/strict');
/** Read the product assets so regressions exercise the shipped DOM and styles. */
const fs = require('node:fs/promises');
/** Resolve package assets and acceptance screenshots. */
const path = require('node:path');
/** Node's runner owns each isolated browser context. */
const { test } = require('node:test');
/** Attach to the Chrome displayed in Selkies instead of installing a second browser. */
const { chromium } = require('playwright');
/** Screenshot evidence may be directed to a workspace artifact folder. */
const artifacts = process.env.ARTIFACT_DIR || path.join(require('node:os').tmpdir(), 'magpie-route-monitor-ui-artifacts');
/** Reuse the gateway's route and concurrency wire shape in the test responses. */
const initial = {
  gateway: { url: 'http://127.0.0.1:3425', connected: true },
  concurrency: { requests: 72, waiting: 12, tools: 0, active: [] },
  rate: { qps: 1.2, complete: true, windowSeconds: 60, coveredSeconds: 60, notice: '统计最近 60 秒收到的路由开始事件，重试不重复计数。' },
  routes: [{ id: 'abc', time: '2026-11-06T14:50:00Z', agent: 'codex', provider: 'Genius', model: 'gpt-6.1-sol', attempt: 1, phase: 'responding', status: 200, failed: false }],
  updatedAt: '2026-11-06T14:50:01Z',
};

for (const theme of ['light', 'dark']) {
  test(`${theme}: global metrics, incomplete windows, recovery and narrow layout`, { timeout: 45000 }, async (t) => {
    const browser = process.env.CHROMIUM_CDP_URL ? await chromium.connectOverCDP(process.env.CHROMIUM_CDP_URL) : await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH });
    const context = await browser.newContext({ viewport: { width: 1060, height: 850 }, deviceScaleFactor: 1, timezoneId: 'Asia/Shanghai' });
    const page = await context.newPage();
    const errors = [];
    let state = structuredClone(initial), queries = 0, responseStatus = 200;
    t.after(async () => { await context.close(); await browser.close(); });
    page.on('pageerror', (error) => errors.push(error.message));
    await context.addInitScript(() => {
      window.__hidden = false;
      Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: () => window.__hidden });
      window.__visibility = (hidden) => { window.__hidden = hidden; document.dispatchEvent(new Event('visibilitychange')); };
    });
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'route-monitor.test') return route.abort();
      if (url.pathname === '/api/state') {
        queries++;
        assert.equal(route.request().headers()['x-route-monitor-key'], 'ui-test-capability');
        return responseStatus === 200 ? route.fulfill({ json: state }) : route.fulfill({ status: responseStatus, body: 'Unavailable' });
      }
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (!['index.html', 'app.js', 'style.css'].includes(file)) return route.fulfill({ status: 404 });
      let body = await fs.readFile(path.resolve(__dirname, '../web', file), 'utf8');
      if (file === 'index.html') body = body.replace('__ROUTE_MONITOR_CAPABILITY__', 'ui-test-capability');
      return route.fulfill({ body, contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
    });
    await page.goto(`http://route-monitor.test/?theme=${theme}`);
    await page.waitForFunction(() => document.getElementById('requests').textContent === '72');
    assert.equal(await page.locator('#waiting').textContent(), '12');
    assert.equal(await page.locator('#qps').textContent(), '1.20');
    assert.equal(await page.locator('.route').count(), 1, 'Global metrics must not depend on recent trace row count');
    assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
    const tree = await page.locator('main').ariaSnapshot();
    assert.match(tree, /路由 QPS/);
    assert.match(tree, /最近 60 秒/);
    await page.evaluate(() => { window.__keptGraph = document.getElementById('graph').firstChild; window.__keptRoute = document.querySelector('.route'); });
    state.concurrency = { requests: 0, waiting: 0, active: [] };
    state.rate.qps = 0;
    await page.locator('#refresh').click();
    await page.waitForFunction(() => document.getElementById('requests').textContent === '0');
    assert.equal(await page.locator('#qps').textContent(), '0.00');
    assert(await page.evaluate(() => window.__keptGraph === document.getElementById('graph').firstChild && window.__keptRoute === document.querySelector('.route')), 'Changing only metrics must retain routing DOM');
    state.rate = { qps: 99, complete: false, coveredSeconds: 8, notice: '统计预热：已连续观察 8 / 60 秒' };
    state.concurrency = null;
    await page.locator('#refresh').click();
    await page.waitForFunction(() => document.getElementById('qps').textContent === '—');
    assert.equal(await page.locator('#requests').textContent(), '—');
    assert.equal(await page.locator('#waiting').textContent(), '—');
    assert.match(await page.locator('#rate-notice').textContent(), /统计预热/);
    state = structuredClone(initial);
    state.gateway.connected = false;
    await page.locator('#refresh').click();
    await page.waitForFunction(() => document.getElementById('connection').textContent === '连接中断');
    assert.equal(await page.locator('#qps').textContent(), '—');
    assert.equal(await page.locator('.route-state').textContent(), '状态待确认');
    responseStatus = 503;
    await page.locator('#refresh').click();
    await page.waitForFunction(() => document.getElementById('updated').textContent === '尚未收到有效数据');
    assert.equal(await page.locator('#requests').textContent(), '—');
    assert.equal(await page.locator('#qps').textContent(), '—');
    responseStatus = 200;
    await page.evaluate(() => window.__visibility(true));
    const hiddenQueries = queries;
    await page.waitForTimeout(1250);
    assert.equal(queries, hiddenQueries, 'Hidden pages must not keep polling');
    state = structuredClone(initial);
    state.concurrency.requests = 5;
    state.concurrency.waiting = 1;
    state.rate.qps = 0.3;
    await page.evaluate(() => window.__visibility(false));
    await page.waitForFunction(() => document.getElementById('requests').textContent === '5');
    assert.equal(await page.locator('#qps').textContent(), '0.30');
    // A hidden Magpie iframe stays document-visible; the host's message is authoritative.
    await page.evaluate(() => window.postMessage({ magpie: 1, event: 'visibility', data: { visible: false } }, '*'));
    await page.waitForTimeout(40);
    const sidebarQueries = queries;
    await page.waitForTimeout(1250);
    assert.equal(queries, sidebarQueries, 'Hidden sidebar frames must stop polling even when document.hidden is false');
    await page.evaluate(() => window.postMessage({ magpie: 1, event: 'visibility', data: { visible: true } }, '*'));
    await page.waitForFunction(() => document.getElementById('requests').textContent === '5');
    await page.evaluate((dark) => window.postMessage({ magpie: 1, event: 'theme', data: { dark, tokens: { bg: '#222222', accent: 'url(https://invalid.test/a)' } } }, '*'), theme === 'light');
    await page.waitForFunction((expected) => document.documentElement.dataset.theme === expected, theme === 'light' ? 'dark' : 'light');
    assert.equal(await page.evaluate(() => document.documentElement.style.getPropertyValue('--accent')), '');
    await page.evaluate((dark) => window.postMessage({ magpie: 1, event: 'theme', data: { dark, tokens: {} } }, '*'), theme === 'dark');
    await page.waitForFunction((expected) => document.documentElement.dataset.theme === expected, theme);
    await fs.mkdir(artifacts, { recursive: true });
    await page.screenshot({ path: path.join(artifacts, `${theme}-desktop.png`) });
    await page.setViewportSize({ width: 360, height: 780 });
    await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 360);
    const bounds = await page.locator('#requests, #waiting, #qps, .hub, .node').evaluateAll((nodes) => nodes.map((node) => ({ text: node.textContent, width: node.clientWidth, scroll: node.scrollWidth })));
    assert(bounds.every((bound) => bound.scroll <= bound.width + 1), 'All metric and graph nodes must fit the narrow page');
    await page.screenshot({ path: path.join(artifacts, `${theme}-narrow.png`) });
    state.routes[0].provider = '<img src=x onerror="window.attacked=true">';
    state.routes[0].model = '<svg onload="window.attacked=true">';
    await page.locator('#refresh').click();
    await page.waitForFunction(() => document.querySelector('.route-model').textContent.includes('<svg'));
    assert.equal(await page.locator('img').count(), 0);
    assert.equal(await page.evaluate(() => window.attacked), undefined);
    assert.deepEqual(errors, []);
  });
}
