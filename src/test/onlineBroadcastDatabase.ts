import { readFileSync } from 'node:fs';
import type { PGlite } from '@electric-sql/pglite';

export const broadcastMigration = () => readFileSync(new URL('../../supabase/migrations/202610160003_online_version_broadcast.sql', import.meta.url), 'utf8');

/** Hosted Supabase owns realtime.send. This local test double reproduces its
 * current wire metadata (auto-added message ID), not the Realtime server. */
export async function enableTestBroadcast(db: PGlite) {
  await db.exec(`
    create schema realtime;
    create table realtime.test_outbox (seq bigserial primary key, payload jsonb, event text, topic text, private boolean);
    create function realtime.send(payload jsonb, event text, topic text, private boolean default true)
    returns void language plpgsql as $$
    begin
      if current_setting('test.broadcast_fail', true) = 'on' then raise exception 'test delivery failure'; end if;
      insert into realtime.test_outbox(payload,event,topic,private)
        values(payload || jsonb_build_object('id',gen_random_uuid()),event,topic,private);
    end;
    $$;
  `);
  await db.exec(broadcastMigration());
}
