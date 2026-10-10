// Cross-replica events over Postgres LISTEN/NOTIFY. Each gateway replica keeps its own upstream connections, health
// loops and listen streams; what must be shared is admin intent (servers added/edited/removed, tool access rules,
// approved tool definitions) and key revocations (to close that key's open streams on every replica).
// A replica applies its own change locally first, then publishes; receivers skip their own messages.
import crypto from 'node:crypto';
import pg from 'pg';
import { config } from './config.js';
import { q } from './db.js';
import { log } from './log.js';

export type GatewayEvent =
  | { t: 'upstream'; id: number }
  | { t: 'access'; id: number; tool: string }
  | { t: 'pin'; id: number; tool: string }
  | { t: 'revoke'; keyIds: number[] };

const CHANNEL = 'urumi_events';
const INSTANCE = crypto.randomUUID();

export const publish = (ev: GatewayEvent) =>
  q('select pg_notify($1, $2)', [CHANNEL, JSON.stringify({ ...ev, from: INSTANCE })])
    .catch((e) => log.warn({ err: e.message, ev }, 'publish failed'));

export function subscribe(onEvent: (ev: GatewayEvent) => void | Promise<void>, onResync: () => void) {
  let first = true;
  const connect = async () => {
    const c = new pg.Client({ connectionString: config.databaseUrl });
    c.on('error', (e) => log.warn({ err: e.message }, 'event listener error'));
    c.on('end', () => setTimeout(connect, 2000)); // reconnect; anything missed meanwhile is covered by onResync
    c.on('notification', (m) => {
      try {
        const ev = JSON.parse(m.payload ?? '{}');
        if (ev.from !== INSTANCE) Promise.resolve(onEvent(ev)).catch((e) => log.warn({ err: e.message, ev }, 'event handler failed'));
      } catch {}
    });
    try {
      await c.connect();
      await c.query(`listen ${CHANNEL}`);
      if (!first) onResync();
      first = false;
      log.info({ instance: INSTANCE }, 'listening for cross-replica events');
    } catch (e) {
      log.warn({ err: (e as Error).message }, 'event listener connect failed');
      c.removeAllListeners('end');
      c.end().catch(() => {});
      setTimeout(connect, 2000);
    }
  };
  connect();
}
