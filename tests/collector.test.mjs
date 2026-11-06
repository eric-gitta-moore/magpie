import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { RouteCollector, localGateway, resolveGateway } from '../lib/collector.mjs';

/** Wait for an observable asynchronous state instead of relying on a guessed network delay. */
async function eventually(check) {
  const end = Date.now() + 3000;
  while (Date.now() < end) {
    if (check()) return;
    await delay(10);
  }
  assert(check(), 'the expected observer state did not arrive');
}

/** A real local SSE fixture exposes replay, a held backlog, gaps and concurrency failure. */
async function fixture(t) {
  const state = { seq: 0, connections: 0, polls: 0, streams: new Set(), history: [], failConcurrency: false,
    reset: false, pauseReplay: false, holdHeaders: false, pending: [], routes: [] };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.endsWith('/concurrency')) {
      state.polls++;
      res.writeHead(state.failConcurrency ? 503 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ requests: 72, waiting: 12, active: [] }));
    } else if (url.pathname.endsWith('/snapshot')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ cursor: `epoch:${state.seq}`, active: state.routes.length, routes: state.routes }));
    } else if (url.pathname.endsWith('/route-events')) {
      state.connections++;
      if (state.reset) { state.reset = false; res.writeHead(409).end('{}'); return; }
      if (state.holdHeaders) {
        state.streams.add(res); res.on('close', () => state.streams.delete(res)); return;
      }
      const after = Number(url.searchParams.get('after').split(':')[1]);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.flushHeaders();
      state.streams.add(res);
      res.on('close', () => state.streams.delete(res));
      const backlog = state.history.filter((event) => Number(event.cursor.split(':')[1]) > after);
      if (state.pauseReplay) state.pending.push([res, backlog]);
      else for (const event of backlog) res.write(`event: route\ndata: ${JSON.stringify(event)}\n\n`);
    } else res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const stream of state.streams) stream.end();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { state, gateway: `http://127.0.0.1:${server.address().port}`,
    send(kind, id, time, phase = 'started') {
      const event = { cursor: `epoch:${++state.seq}`, kind, route: { id, time: new Date(time).toISOString(), agent: 'codex', model: 'test-model', phase } };
      state.history.push(event);
      for (const res of state.streams) res.write(`event: route\ndata: ${JSON.stringify(event)}\n\n`);
      return event;
    },
    disconnect() { for (const res of [...state.streams]) res.end(); },
    releaseReplay() {
      state.pauseReplay = false;
      for (const [res, backlog] of state.pending.splice(0)) for (const event of backlog) res.write(`event: route\ndata: ${JSON.stringify(event)}\n\n`);
    },
  };
}

test('gateway resolution follows the configured port and rejects nonlocal or credential-bearing URLs', async (t) => {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'route-monitor-settings-'));
  t.after(() => fs.rm(configDir, { recursive: true }));
  await fs.writeFile(path.join(configDir, 'settings.json'), JSON.stringify({ port: 3591 }));
  assert.equal(await resolveGateway({ configDir, env: {} }), 'http://127.0.0.1:3591');
  assert.equal(localGateway('http://localhost:80'), 'http://localhost');
  assert.equal(await resolveGateway({ configDir, env: { MAGPIE_ADDR: '0.0.0.0:3827' } }), 'http://127.0.0.1:3827');
  assert.equal(await resolveGateway({ env: { MAGPIE_ADDR: ':3827' } }), 'http://127.0.0.1:3827');
  for (const value of ['https://localhost:3425', 'http://example.com:3425', 'http://user:secret@localhost:3425', 'http://localhost:3425/v1', 'http://localhost:3425/?x=1']) {
    assert.throws(() => localGateway(value), /本机回环/);
  }
});

test('initial active rows are not starts; short requests and retries retain the selected route rate', () => {
  let now = 0;
  const collector = new RouteCollector({ now: () => now });
  collector.acceptSnapshot({ cursor: 'epoch:0', routes: [{ id: 'existing', time: new Date(0).toISOString(), phase: 'started' }] });
  collector.feedConnected = true;
  assert.equal(collector.getState().rate.qps, null);
  now = 30000;
  collector.acceptEvent({ cursor: 'epoch:1', kind: 'request_started', route: { id: 'short', time: new Date(now).toISOString(), phase: 'started' } });
  collector.acceptEvent({ cursor: 'epoch:2', kind: 'attempt_started', route: { id: 'short', time: new Date(now).toISOString(), phase: 'attempt', attempt: 2 } });
  collector.acceptEvent({ cursor: 'epoch:3', kind: 'request_finished', route: { id: 'short', time: new Date(now).toISOString(), phase: 'done' } });
  collector.acceptEvent({ cursor: 'epoch:3', kind: 'request_finished', route: { id: 'short', time: new Date(now).toISOString(), phase: 'done' } });
  now = 60000;
  assert.equal(collector.getState().rate.qps, 1 / 60);
  assert.equal(collector.getState().routes[0].phase, 'done');
  now = 90000;
  assert.equal(collector.getState().rate.qps, 0);
  now = 50000;
  assert.equal(collector.getState().rate.qps, null);
  assert.match(collector.getState().rate.notice, /时间回拨/);
});

test('backlog counts original start seconds, with bounded history under heavy traffic', () => {
  let now = 0;
  const collector = new RouteCollector({ now: () => now });
  collector.acceptSnapshot({ cursor: 'epoch:0', routes: [] });
  collector.feedConnected = true;
  now = 120000;
  collector.acceptEvent({ cursor: 'epoch:1', kind: 'request_started', route: { id: 'old', time: new Date(30000).toISOString() } });
  collector.acceptEvent({ cursor: 'epoch:2', kind: 'request_started', route: { id: 'recent', time: new Date(90000).toISOString() } });
  collector.acceptEvent({ cursor: 'epoch:3', kind: 'request_started', route: { id: 'recent', time: new Date(90000).toISOString() } });
  assert.equal(collector.getState().rate.qps, 1 / 60);
  for (let i = 4; i <= 1000; i++) collector.acceptEvent({ cursor: `epoch:${i}`, kind: 'request_started', route: { id: `r${i}`, time: new Date(now).toISOString() } });
  assert.equal(collector.buckets.length, 60);
  assert(collector.startedIds.size <= 512);
  assert(collector.routes.size <= 120);
  assert.equal(collector.getState().routes.length, 12);
  assert.throws(() => collector.acceptEvent({ cursor: 'another:1001', kind: 'request_started', route: { id: 'bad' } }), /进程/);
});

test('real concurrency polls stay global and failures become unknown; stop cancels outstanding reads', async (t) => {
  const source = await fixture(t);
  const collector = new RouteCollector({ gateway: source.gateway, pollMs: 20, retryMs: 30 }).start();
  t.after(() => collector.stop());
  await eventually(() => collector.getState().concurrency?.requests === 72);
  assert.equal(collector.getState().concurrency.waiting, 12);
  assert.equal(collector.getState().routes.length, 0);
  source.state.failConcurrency = true;
  await eventually(() => collector.getState().concurrency === null);
  await collector.stop();
  const count = source.state.polls;
  await delay(80);
  assert.equal(source.state.polls, count);
  assert.equal(source.state.streams.size, 0);
});

test('resumed QPS waits for backlog catch-up, and unreplayable cursors restart the warm-up', async (t) => {
  let now = 0;
  const source = await fixture(t);
  const collector = new RouteCollector({ gateway: source.gateway, now: () => now, pollMs: 20, retryMs: 80 }).start();
  t.after(() => collector.stop());
  await eventually(() => source.state.connections === 1 && collector.feedConnected);
  now = 60000;
  source.send('request_started', 'one', now);
  await eventually(() => collector.cursor === 'epoch:1');
  assert.equal(collector.getState().rate.qps, 1 / 60);
  source.state.pauseReplay = true;
  source.disconnect();
  await eventually(() => !collector.feedConnected);
  assert.equal(collector.getState().rate.qps, null);
  source.send('request_started', 'two', now);
  await eventually(() => source.state.connections === 2);
  assert.equal(collector.getState().rate.qps, null, 'HTTP 200 is not a completed replay');
  source.releaseReplay();
  await eventually(() => collector.feedConnected && collector.cursor === 'epoch:2');
  assert.equal(collector.getState().rate.qps, 2 / 60);
  source.state.reset = true;
  source.disconnect();
  await eventually(() => source.state.connections >= 4 && collector.feedConnected);
  assert.equal(collector.getState().rate.qps, null);
  assert.equal(collector.getState().rate.coveredSeconds, 0);
  now = 120000;
  assert.equal(collector.getState().rate.qps, 0);
});

test('SSE frames support CRLF split across network chunks', async (t) => {
  let now = 0;
  const source = await fixture(t);
  const collector = new RouteCollector({ gateway: source.gateway, now: () => now, pollMs: 20 }).start();
  t.after(() => collector.stop());
  await eventually(() => collector.feedConnected);
  now = 60000;
  const event = { cursor: 'epoch:1', kind: 'request_started', route: { id: 'split', time: new Date(now).toISOString(), phase: 'started' } };
  for (const part of ['event: route\r', '\ndata: ' + JSON.stringify(event) + '\r', '\n\r', '\n']) {
    for (const response of source.state.streams) response.write(part);
    await delay(3);
  }
  await eventually(() => collector.cursor === 'epoch:1');
  assert.equal(collector.getState().rate.qps, 1 / 60);
});

test('changing the configured address immediately reconnects the route stream', async (t) => {
  const first = await fixture(t);
  const second = await fixture(t);
  const env = { MAGPIE_ADDR: first.gateway };
  const collector = new RouteCollector({ env, pollMs: 20, retryMs: 20 }).start();
  t.after(() => collector.stop());
  await eventually(() => collector.feedConnected && first.state.connections === 1);
  env.MAGPIE_ADDR = second.gateway;
  await eventually(() => collector.url === second.gateway && second.state.connections === 1 && collector.feedConnected);
  assert.equal(first.state.streams.size, 0, 'the old gateway stream is released');
  assert.equal(collector.getState().rate.qps, null);
  second.send('request_started', 'new-gateway', Date.now());
  await eventually(() => collector.getState().routes[0]?.id === 'new-gateway');
});

test('an SSE connection without response headers times out and retries', async (t) => {
  const source = await fixture(t);
  source.state.holdHeaders = true;
  const collector = new RouteCollector({ gateway: source.gateway, pollMs: 20, retryMs: 20, timeoutMs: 60 }).start();
  t.after(() => collector.stop());
  await eventually(() => source.state.connections >= 2);
  assert.equal(collector.getState().rate.qps, null);
  assert.equal(collector.getState().concurrency.requests, 72);
  source.state.holdHeaders = false;
  await eventually(() => collector.feedConnected);
});
