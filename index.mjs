/** The service runs within Magpie's plugin host and registers no model provider. */
import { startServer } from './lib/server.mjs';
/** Port handover uses a bounded delay while the retiring plugin host releases its listener. */
import { setTimeout as delay } from 'node:timers/promises';

/** One service belongs to each plugin host; importing this module does not listen. */
let running;

/** Initialize the embedded sidebar service through Magpie's normal plugin lifecycle. */
export default {
  id: 'magpie-route-monitor',
  /** Share one startup and retry a short listener handover without caching a failed startup. */
  async server(_input, options = {}) {
    if (!running) {
      running = (async () => {
        for (let attempt = 0; ; attempt++) {
          try {
            return await startServer({ port: Number(options.port) || 3491, gateway: options.gateway || '' });
          } catch (error) {
            if (error.code !== 'EADDRINUSE' || attempt >= 11) throw error;
            // Startup must stay alive until the bounded listener handover finishes.
            await delay(250);
          }
        }
      })().catch((error) => {
        running = undefined;
        throw error;
      });
    }
    await running;
    return {};
  },
};
