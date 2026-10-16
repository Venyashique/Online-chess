// @vitest-environment node
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { createOnlineTestDatabase } from '../../../test/onlineDatabase';
import { enableTestBroadcast, broadcastMigration } from '../../../test/onlineBroadcastDatabase';

let database: Awaited<ReturnType<typeof createOnlineTestDatabase>>;
const token = 'a'.repeat(64), other = 'b'.repeat(64);
beforeAll(async () => { database = await createOnlineTestDatabase(); await enableTestBroadcast(database.db); }, 30000);
afterAll(async () => { await database?.db.close(); });

async function outbox() { return (await database.db.query<{ payload: Record<string, unknown>; topic: string; event: string; private: boolean }>('select payload,topic,event,private from realtime.test_outbox order by seq')).rows; }
async function create() {
  const id = crypto.randomUUID();
  await database.rpc('create_online_game_with_seat', { p_id: id, p_color_choice: 'white', p_token: token });
  return id;
}

describe('Database Broadcast boundary', () => {
  it('emits only safe version signals for creation, join and committed moves', async () => {
    const id = await create();
    await database.rpc('join_online_game', { p_id: id, p_token: other });
    await database.handler(new Request('https://online-chess.test', { method: 'POST', body: JSON.stringify({ game_id: id, player_token: token, expected_version: 2, from: 'e2', to: 'e4' }) }));
    const messages = (await outbox()).filter(row => row.payload.game_id === id);
    expect(messages.map(row => row.payload.version)).toEqual([1, 2, 3]);
    for (const row of messages) {
      expect(Object.keys(row.payload).sort()).toEqual(['game_id','id','version']);
      expect(row.topic).toBe(`online-game:${id}`); expect(row.event).toBe('version_changed'); expect(row.private).toBe(false);
      const json = JSON.stringify(row); expect(json).not.toContain('token_hash'); expect(json).not.toContain(token); expect(json).not.toContain(other); expect(json).not.toContain('fen');
    }
  });
  it('does not emit an idempotent join or an unchanged/decreased version', async () => {
    const id = await create(); await database.rpc('join_online_game', { p_id: id, p_token: other });
    const count = (await outbox()).length;
    await database.rpc('join_online_game', { p_id: id, p_token: other });
    await database.db.query('update public.online_games set version=version where id=$1', [id]);
    expect((await outbox()).length).toBe(count);
  });
  it('preserves direct table and helper-function denial for browser roles', async () => {
    for (const role of ['anon','authenticated']) {
      for (const sql of ['select creator_token_hash from public.online_games', 'update public.online_games set version=version+1', 'select public.notify_online_game_version()']) {
        await expect(database.db.transaction(async tx => { await tx.exec(`set local role ${role}`); await tx.exec(sql); })).rejects.toMatchObject({ code: '42501' });
      }
    }
    const publications = await database.db.query("select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='online_games'");
    expect(publications.rows).toEqual([]);
  });
  it('keeps authoritative writes working when notification delivery fails', async () => {
    await database.db.exec("set test.broadcast_fail='on'");
    try {
      const id = await create();
      const joined = await database.rpc('join_online_game', { p_id: id, p_token: other }); expect(joined.code).toBe('OK');
      const response = await database.handler(new Request('https://online-chess.test', { method: 'POST', body: JSON.stringify({ game_id: id, player_token: token, expected_version: 2, from: 'e2', to: 'e4' }) }));
      expect(response.status).toBe(200); expect((await response.json()).session.game.version).toBe(3);
    } finally { await database.db.exec("set test.broadcast_fail='off'"); }
  });
  it('refuses an unsafe pre-existing publication rather than exposing the table', async () => {
    await database.db.exec('create publication supabase_realtime for table public.online_games');
    try {
      await expect(database.db.exec(broadcastMigration())).rejects.toThrow('online_games must not be in supabase_realtime');
      await database.db.exec('rollback');
    } finally { await database.db.exec('drop publication supabase_realtime'); }
  });
});
