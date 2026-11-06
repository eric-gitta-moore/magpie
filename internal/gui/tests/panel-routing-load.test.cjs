// The tray panel reads gateway-wide load, including requests outside its
// short recent list. Controlled responses exercise idle updates, unknown
// data, recovery and visibility without calling a real gateway or vendor.
/** Node assertions used to describe observable panel behavior. */
const assert = require("node:assert/strict");
/** File reader for serving the real GUI assets in isolated browser contexts. */
const fs = require("node:fs/promises");
/** Asset and screenshot path resolution. */
const path = require("node:path");
/** Node's test runner keeps each browser lifecycle tied to its test. */
const { test } = require("node:test");
/** Both GUI engines used by the upstream browser suite. */
const { chromium, webkit } = require("playwright");

/** An older asset tree may be selected to prove the missing-feature regression. */
const assets = path.resolve(process.env.MAGPIE_ASSETS || path.join(__dirname, "../assets"));
/** Localized labels and number punctuation visible in the compact load row. */
const words = {
  en: { labels: ["In flight", "Queued", "QPS"], decimal: "." },
  zh: { labels: ["并发", "排队", "QPS"], decimal: "." },
  "zh-TW": { labels: ["並行", "排隊", "QPS"], decimal: "." },
  ja: { labels: ["処理中", "待機中", "QPS"], decimal: "." },
  de: { labels: ["Parallel", "Wartend", "QPS"], decimal: "," },
};

/** Desktop styling matches the Mac tray; narrow web styling is checked separately. */
const surfaces = [
  { name: "mac-panel", web: false, platform: "MacIntel", viewport: { width: 440, height: 560 }, deviceScaleFactor: 2 },
  { name: "web-panel", web: true, platform: "Linux x86_64", viewport: { width: 360, height: 640 }, deviceScaleFactor: 1 },
];

for (const surface of surfaces) {
  for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ["chromium", "webkit"])) {
    for (const [lang, w] of Object.entries(words)) {
      test(`${surface.name} ${engine} ${lang}: the tray panel shows gateway load without repainting idle routes`, { timeout: 60000 }, async (t) => {
        // A supplied Chrome binary lets the same regression run inside Selkies.
        const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({
          channel: process.env.CHROMIUM_EXECUTABLE_PATH ? undefined : "chromium",
          executablePath: process.env.CHROMIUM_EXECUTABLE_PATH,
        }));
        const context = await browser.newContext({ viewport: surface.viewport, deviceScaleFactor: surface.deviceScaleFactor, reducedMotion: "reduce" });
        const page = await context.newPage();
        const errors = [], queries = [];
        let answer, queued, closing = false;
        let nextRead = new Promise((resolve) => { queued = resolve; });
        t.after(async () => {
          if (process.env.ARTIFACT_DIR) {
            await fs.mkdir(process.env.ARTIFACT_DIR, { recursive: true });
            await page.setViewportSize(surface.viewport);
            await page.screenshot({ path: path.join(process.env.ARTIFACT_DIR, `${surface.name}-${engine}-${lang}-panel-routing-load.png`) });
          }
          closing = true;
          if (answer) answer({ abort: true });
          await browser.close();
        });
        page.on("pageerror", (e) => errors.push(e.message));
        page.setDefaultTimeout(10000);
        page.setDefaultNavigationTimeout(60000);
        await context.addInitScript((platform) => {
          Object.defineProperty(Navigator.prototype, "platform", { configurable: true, get: () => platform });
          localStorage.setItem("magpie.panelTab", "routing");
          window.__hidden = false;
          Object.defineProperty(Document.prototype, "hidden", { configurable: true, get: () => window.__hidden });
          Object.defineProperty(Document.prototype, "visibilityState", { configurable: true, get: () => window.__hidden ? "hidden" : "visible" });
          window.__visibility = (hidden) => { window.__hidden = hidden; document.dispatchEvent(new Event("visibilitychange")); };
        }, surface.platform);
        const started = new Date().toISOString();
        const seat = { id: "relay:test", provider: "relay", name: "Relay", kind: "key", who: "test", model: "gpt-6-sol" };
        const routeRecord = { id: 1, seq: 1, time: started, agent: "codex", model: "relay/gpt-6-sol", provider: "relay", order: [seat],
          tries: [{ id: seat.id, model: seat.model, start: started, done: true, status: 200, ms: 1200 }], done: true, status: 200, ms: 1200, tokens: 400 };
        const trace = { mine: true, now: started, seq: 1, ids: [1], totals: { requests: 1, rerouted: 0, errors: 0 }, routes: [routeRecord] };
        await page.route("**/*", async (route) => {
          const url = new URL(route.request().url());
          if (url.hostname !== "magpie.test") return route.fulfill({ status: 404, body: "" });
          if (url.pathname === "/boot.js") return route.fulfill({ contentType: "text/javascript", body: `window.bootPrefs=${JSON.stringify({ lang, theme: "light", web: surface.web, textSize: 100 })};` });
          if (url.pathname === "/wails/runtime.js") return route.fulfill({ contentType: "text/javascript", body: "export const Window={};" });
          if (url.pathname === "/api/state") return route.fulfill({ json: { agents: [{ id: "codex", name: "Codex", path: "/test/config.toml", fields: [] }], profiles: [], settings: { lang, theme: "light", textSize: 100 } } });
          if (url.pathname === "/api/providers") return route.fulfill({ json: { providers: [], gateway: { running: true, window: true } } });
          if (url.pathname === "/api/groups") return route.fulfill({ json: { groups: [] } });
          if (url.pathname === "/api/gateway/history") return route.fulfill({ json: { cut: false, days: [], routes: [] } });
          if (url.pathname === "/api/usage") return route.fulfill({ json: { calls: 42, input: 1000000, output: 0, series: [] } });
          if (url.pathname === "/api/usage/quotas") return route.fulfill({ json: [] });
          if (url.pathname === "/api/gateway/trace") {
            queries.push(url.searchParams);
            if (queries.length === 1) return route.fulfill({ json: { ...trace, metrics: { requests: 72, waiting: 12, qps: 1.2, windowSeconds: 60 } } });
            if (closing) return route.abort();
            // Hold every later response until the assertion before it has
            // completed; no wall-clock traffic simulation can race the test.
            const change = await new Promise((resolve) => { answer = resolve; queued(); });
            answer = null;
            if (change.abort) return route.abort("failed");
            return route.fulfill({ json: { ...trace, routes: [], ...change } });
          }
          if (url.pathname.startsWith("/api/")) return route.fulfill({ json: {} });
          const file = path.join(assets, url.pathname === "/" ? "index.html" : url.pathname);
          const contentType = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" }[path.extname(file)];
          try { return await route.fulfill({ body: await fs.readFile(file), contentType }); }
          catch { return route.fulfill({ status: 404, body: "" }); }
        });
        await page.goto("http://magpie.test/?mode=panel");
        await page.locator('button[data-ptab="routing"]').click();
        await page.locator("#panelRouting .pr-req").first().waitFor();
        if (!surface.web) {
          // Browser emulation checks the desktop CSS path, not the native macOS host.
          assert.equal(await page.locator("body.panel.mac").count(), 1, "the Mac tray must use its desktop classes");
          assert.equal(await page.locator("body.web").count(), 0, "the Mac tray must not inherit web touch-target spacing");
          assert.equal(await page.evaluate(() => window.devicePixelRatio), 2, "the Mac tray uses the reference Retina density");
          assert.equal(await page.locator(".pr-head").evaluate((row) => getComputedStyle(row).minHeight), "22px", "the Mac usage row must retain desktop spacing");
          assert(await page.locator(".pr-head").evaluate((row) => row.getBoundingClientRect().height < 24), "desktop fonts must not enlarge the usage row to a web touch target");
        }
        // A real behavior assertion goes red on old assets, rather than
        // treating a missing selector's timeout as the regression evidence.
        assert.equal(await page.locator("#panelRouting .pr-metrics").count(), 1, "the Routing panel needs a gateway load row");
        await page.waitForFunction((expected) => expected.every((s) => document.querySelector(".pr-metrics").textContent.includes(s)),
          [`${w.labels[0]} 72`, `${w.labels[1]} 12`, `QPS 1${w.decimal}20`]);
        assert.equal(await page.locator("#panelRouting .pr-req").count(), 1, "the load count must cover more than the recent routes");
        const notes = await page.locator(".pr-metrics").evaluate((row) => [row, ...row.querySelectorAll("[title]")].map((e) => e.title).join(" "));
        assert.match(notes, /60/, "the QPS description names its averaging window");
        await page.evaluate(() => {
          window.__keptStage = document.querySelector(".pr-stage");
          window.__keptRequest = document.querySelector(".pr-req");
          window.__keptMetrics = document.querySelector(".pr-metrics");
        });

        await nextRead;
        assert.equal(queries.at(-1).get("timeout"), "1000", "visible panel metrics must refresh during an idle trace");
        nextRead = new Promise((resolve) => { queued = resolve; });
        answer({ metrics: { requests: 6, waiting: 2, qps: 0.1, windowSeconds: 60 } });
        await page.waitForFunction((expected) => expected.every((s) => document.querySelector(".pr-metrics").textContent.includes(s)),
          [`${w.labels[0]} 6`, `${w.labels[1]} 2`, `QPS 0${w.decimal}10`]);
        assert(await page.evaluate(() => window.__keptStage === document.querySelector(".pr-stage") && window.__keptRequest === document.querySelector(".pr-req") && window.__keptMetrics === document.querySelector(".pr-metrics")),
          "an idle metric update must preserve the stage, recent rows and load row");

        await nextRead;
        nextRead = new Promise((resolve) => { queued = resolve; });
        answer({ metrics: { requests: 0, waiting: 0, qps: 0, windowSeconds: 60 } });
        await page.waitForFunction((expected) => expected.every((s) => document.querySelector(".pr-metrics").textContent.includes(s)),
          [`${w.labels[0]} 0`, `${w.labels[1]} 0`, `QPS 0${w.decimal}00`]);
        await nextRead;
        nextRead = new Promise((resolve) => { queued = resolve; });
        answer({});
        await page.waitForFunction(() => (document.querySelector(".pr-metrics").textContent.match(/—/g) || []).length === 3);
        await nextRead;
        nextRead = new Promise((resolve) => { queued = resolve; });
        answer({ metrics: { requests: 9, waiting: 0, qps: 0.5, windowSeconds: 60 } });
        await page.waitForFunction((label) => document.querySelector(".pr-metrics").textContent.includes(label + " 9"), w.labels[0]);
        await nextRead;
        nextRead = new Promise((resolve) => { queued = resolve; });
        answer({ abort: true });
        await page.waitForFunction(() => (document.querySelector(".pr-metrics").textContent.match(/—/g) || []).length === 3);
        await nextRead;
        nextRead = new Promise((resolve) => { queued = resolve; });
        answer({ metrics: { requests: 8, waiting: 1, qps: 0.6, windowSeconds: 60 } });
        await page.waitForFunction((label) => document.querySelector(".pr-metrics").textContent.includes(label + " 8"), w.labels[0]);

        await nextRead;
        nextRead = new Promise((resolve) => { queued = resolve; });
        await page.evaluate(() => window.__visibility(true));
        const hiddenReads = queries.length;
        answer({ metrics: { requests: 4, waiting: 0, qps: 0.2, windowSeconds: 60 } });
        // Let the already pending response finish. Its fetch is allowed,
        // but the next turn must wait for visibility rather than read again.
        await page.waitForTimeout(300);
        assert.equal(queries.length, hiddenReads, "the hidden panel must stop polling gateway metrics");
        await page.evaluate(() => window.__visibility(false));
        await nextRead;
        nextRead = new Promise((resolve) => { queued = resolve; });
        answer({ metrics: { requests: 5, waiting: 1, qps: 0.3, windowSeconds: 60 } });
        await page.waitForFunction((label) => document.querySelector(".pr-metrics").textContent.includes(label + " 5"), w.labels[0]);
        await page.setViewportSize({ width: 320, height: 640 });
        // The tab thumb refits on resize; measure overflow after that layout settles.
        await page.waitForFunction(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
        const overflow = await page.locator(".pr-metrics").evaluate((row) => ({
          row: row.scrollWidth > row.clientWidth + 1,
          page: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
          cut: [...row.children].filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent),
        }));
        assert.deepEqual(overflow, { row: false, page: false, cut: [] }, "all three metrics fit the narrow panel");
        if (process.env.ARTIFACT_DIR) {
          await fs.mkdir(process.env.ARTIFACT_DIR, { recursive: true });
          await page.screenshot({ path: path.join(process.env.ARTIFACT_DIR, `${surface.name}-${engine}-${lang}-panel-routing-load-narrow.png`) });
        }
        assert.deepEqual(errors, []);
      });
    }
  }
}
