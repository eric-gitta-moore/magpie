/** Exercise listener handover in its own host process so every collector exits with that host. */
import { execFile } from 'node:child_process';
/** Fail the regression when startup or capability delivery cannot recover. */
import assert from 'node:assert/strict';
/** Tie the bounded subprocess to Node's test lifecycle. */
import { test } from 'node:test';

test('plugin startup retries listener handover and clears a failed startup', { timeout: 10000 }, async () => {
  const script = `
    import http from 'node:http';
    import assert from 'node:assert/strict';
    for (const recoverAfterFailure of [false, true]) {
      const holder = http.createServer((_, response) => response.end('held'));
      await new Promise((resolve) => holder.listen(0, '127.0.0.1', resolve));
      const port = holder.address().port;
      const plugin = (await import('./index.mjs?retry=' + recoverAfterFailure)).default;
      const options = { port, gateway: 'http://127.0.0.1:1' };
      if (recoverAfterFailure) {
        await assert.rejects(plugin.server({}, options), (error) => error.code === 'EADDRINUSE');
        await new Promise((resolve) => holder.close(resolve));
      } else {
        setTimeout(() => holder.close(), 100);
      }
      await plugin.server({}, options);
      const response = await fetch('http://127.0.0.1:' + port);
      assert.equal(response.status, 200);
      assert.match(await response.text(), /路由监控/);
    }
    process.exit(0);
  `;
  const result = await new Promise((resolve) => {
    execFile(process.execPath, ['--input-type=module', '-e', script], { cwd: new URL('../', import.meta.url), timeout: 9000 }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
  });
  assert.equal(result.error, null, result.stderr);
});
