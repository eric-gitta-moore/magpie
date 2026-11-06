import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startServer } from '../lib/server.mjs';

test('page reads require the fresh capability, allow only local origins and methods, and expose no proxy', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'route-monitor-page-'));
  t.after(() => fs.rm(directory, { recursive: true }));
  await fs.writeFile(path.join(directory, 'index.html'), '<meta content="__ROUTE_MONITOR_CAPABILITY__">');
  await fs.writeFile(path.join(directory, 'app.js'), 'console.log("page")');
  await fs.writeFile(path.join(directory, 'style.css'), 'body{}');
  let stopped = false;
  const collector = { start() {}, stop() { stopped = true; }, getState() { return { concurrency: { requests: 8, waiting: 5 } }; } };
  const service = await startServer({ port: 0, webRoot: pathToFileURL(directory + '/'), collector });
  t.after(() => service.close());
  const url = `http://127.0.0.1:${service.port}`;
  const html = await (await fetch(url)).text();
  const key = html.match(/content="([a-f0-9]{64})"/)[1];
  assert(!html.includes('__ROUTE_MONITOR_CAPABILITY__'));
  for (const pathname of ['/', '/index.html']) {
    const opaqueRead = await fetch(url + pathname, { headers: { Origin: 'null' } });
    assert.equal(opaqueRead.headers.get('Access-Control-Allow-Origin'), null, 'an unrelated opaque frame cannot read the HTML capability');
  }
  assert.equal((await fetch(url + '/api/state')).status, 403);
  assert.equal((await fetch(url + '/api/state', { headers: { 'X-Route-Monitor-Key': 'wrong' } })).status, 403);
  const response = await fetch(url + '/api/state', { headers: { Origin: 'null', 'X-Route-Monitor-Key': key } });
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'null');
  assert.deepEqual(await response.json(), { concurrency: { requests: 8, waiting: 5 } });
  assert.equal((await fetch(url + '/api/state', { headers: { Origin: 'https://example.com', 'X-Route-Monitor-Key': key } })).status, 403);
  // Node fetch normalizes Host, so send the attempted rebinding on the wire.
  const rebound = await new Promise((resolve, reject) => {
    const request = http.get(url + '/api/state', { headers: { Host: `evil.example:${service.port}`, 'X-Route-Monitor-Key': key } }, (response) => {
      response.resume(); response.once('end', () => resolve(response.statusCode));
    });
    request.once('error', reject);
  });
  assert.equal(rebound, 403);
  assert.equal((await fetch(url + '/api/state', { method: 'POST', headers: { 'X-Route-Monitor-Key': key } })).status, 405);
  assert.equal((await fetch(url + '/api/state', { method: 'OPTIONS', headers: { Origin: 'null' } })).status, 204);
  assert.equal((await fetch(url + '/api/forward?url=http://example.com')).status, 404);
  const asset = await fetch(url + '/app.js', { headers: { Origin: 'null' } });
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('Content-Security-Policy'), /default-src 'none'/);
  await service.close();
  assert(stopped);
});

test('service capabilities are regenerated after restart', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'route-monitor-page-'));
  t.after(() => fs.rm(directory, { recursive: true }));
  await fs.writeFile(path.join(directory, 'index.html'), '__ROUTE_MONITOR_CAPABILITY__');
  const collector = { start() {}, stop() {}, getState() { return {}; } };
  const one = await startServer({ port: 0, webRoot: pathToFileURL(directory + '/'), collector });
  const oldKey = await (await fetch(`http://127.0.0.1:${one.port}`)).text();
  await one.close();
  const two = await startServer({ port: 0, webRoot: pathToFileURL(directory + '/'), collector });
  t.after(() => two.close());
  assert.equal((await fetch(`http://127.0.0.1:${two.port}/api/state`, { headers: { 'X-Route-Monitor-Key': oldKey } })).status, 403);
});

// URLs normalize HTTP's default port away; actual browser Host headers do too.
test('default HTTP port accepts the normalized loopback Host', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'route-monitor-port80-'));
  t.after(() => fs.rm(directory, { recursive: true }));
  await fs.writeFile(path.join(directory, 'index.html'), '__ROUTE_MONITOR_CAPABILITY__');
  let service;
  try {
    service = await startServer({ port: 80, webRoot: pathToFileURL(directory + '/'), collector: { start() {}, stop() {}, getState() { return {}; } } });
  } catch (error) {
    if (['EACCES', 'EADDRINUSE'].includes(error.code)) { t.skip('Port 80 is unavailable on this host'); return; }
    throw error;
  }
  t.after(() => service.close());
  const key = await (await fetch('http://127.0.0.1:80/')).text();
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.equal((await fetch('http://127.0.0.1:80/api/state', { headers: { 'X-Route-Monitor-Key': key } })).status, 200);
});
