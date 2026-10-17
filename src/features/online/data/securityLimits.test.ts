// @vitest-environment node
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createOnlineTestDatabase } from '../../../test/onlineDatabase';
import { enableTestBroadcast } from '../../../test/onlineBroadcastDatabase';
import { createOnlineApiHandler } from '../../../../supabase/functions/online-api/handler';
import { createSubmitMoveHandler } from '../../../../supabase/functions/submit-online-move/handler';
import { createOnlineBackend } from '../../../../supabase/functions/_shared/backend';
import { createTurnstileVerifier } from '../../../../supabase/functions/_shared/turnstile';
import { HTTP_POLICY } from '../../../../supabase/functions/_shared/http';
let d: Awaited<ReturnType<typeof createOnlineTestDatabase>>;
let defaults: Record<string, unknown>;
let stageGrants: unknown[];
let preservedId: string;
const A = 'a'.repeat(64), B = 'b'.repeat(64), X = 'c'.repeat(64);
const backend = () => createOnlineBackend({ rpc: async (name, args) => ({ data: await d.rpc(name, args, 'service_role'), error: null }) });
const verify = vi.fn(async () => 'OK' as const);
const api = (body: unknown) => createOnlineApiHandler(backend(), verify)(new Request('https://isolated.test', { method: 'POST', body: JSON.stringify(body) }));
const request = (action: string, id: string, token: string | null = A, extra = {}) => api({ action, game_id: id, player_token: token, ...extra });
const create = async () => {
  const id = crypto.randomUUID(); const r = await request('create', id, A, { color_choice: 'white', turnstile_token: 'isolated-proof' });
  expect(r.status).toBe(200); return id;
};
const join = (id: string) => request('join', id, B);
const move = (id: string, extra = {}) => d.handler(new Request('https://isolated.test', { method: 'POST', body: JSON.stringify({ game_id: id, player_token: A, expected_version: 2, from: 'e2', to: 'e4', ...extra }) }));
const q = async (sql: string, args: unknown[] = []) => (await d.db.query<any>(sql, args)).rows;
const policy = (sql: string) => d.db.exec('update online_security.policy set ' + sql);
beforeAll(async () => {
  d = await createOnlineTestDatabase({ limits: false }); await enableTestBroadcast(d.db);
  preservedId = crypto.randomUUID();
  await d.rpc('create_online_game_with_seat', { p_id: preservedId, p_color_choice: 'white', p_token: A });
  for (const name of ['202610170004_online_api_limits.sql', '202610170005_online_retention.sql']) await d.db.exec(readFileSync(new URL('../../../../supabase/migrations/' + name, import.meta.url), 'utf8'));
  defaults = (await q('select * from online_security.policy'))[0];
  stageGrants = await q("select has_function_privilege('anon','public.create_online_game_with_seat(uuid,text,text)','execute') as allowed");
  await d.db.exec(readFileSync(new URL('../../../../supabase/migrations/202610170006_online_api_cutover.sql', import.meta.url), 'utf8'));
}, 30000);
beforeEach(async () => {
  verify.mockClear();
  await d.db.exec('truncate online_security.buckets, online_security.move_bursts');
  for (const [key, value] of Object.entries(defaults)) if (key !== 'singleton') await d.db.query(`update online_security.policy set ${key}=$1`, [value]);
});
afterAll(async () => { await d?.db.close(); });
describe('Security Fix 1: exact migrations, SQL quotas and real HTTP handlers', () => {
  it('preserves old grants through 004/005 and closes all old RPC only at cutover', async () => {
    expect(stageGrants).toEqual([{ allowed: true }]);
    for (const role of ['anon','authenticated']) {
      for (const name of ['create_online_game','create_online_game_with_seat','get_online_game','get_online_game_session','join_online_game','commit_online_move','online_api_admit','online_api_create','online_api_join','online_api_commit_move','online_cleanup_preview']) {
        const rows = await q('select has_function_privilege($1,p.oid,\'execute\') as allowed from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname=\'public\' and p.proname=$2', [role,name]);
        expect(rows).toEqual([{ allowed: false }]);
      }
      await expect(d.db.transaction(async tx => { await tx.exec(`set local role ${role}`); await tx.exec('select * from online_security.buckets'); })).rejects.toMatchObject({ code: '42501' });
      await expect(d.rpc('get_online_game_session', { p_id: preservedId, p_token: A }, role as 'anon' | 'authenticated')).rejects.toMatchObject({ code: '42501' });
      await expect(d.rpc('online_api_admit', { p_operation: 'read', p_id: preservedId, p_token: A }, role as 'anon' | 'authenticated')).rejects.toMatchObject({ code: '42501' });
      await expect(d.db.transaction(async tx => { await tx.exec(`set local role ${role}`); await tx.exec('select creator_token_hash,opponent_token_hash from public.online_games'); })).rejects.toMatchObject({ code: '42501' });
      await expect(d.db.transaction(async tx => { await tx.exec(`set local role ${role}`); await tx.query('update public.online_games set version=version+1 where id=$1', [preservedId]); })).rejects.toMatchObject({ code: '42501' });
    }
  });
  it('preserves pre-cutover UUID and token ownership without copying credentials into URLs or Broadcast', async () => {
    const r = await request('read', preservedId, A); expect(r.status).toBe(200);
    const body = await r.json(); expect(body.session.player_color).toBe('w'); expect(body.session.game.id).toBe(preservedId);
    expect(JSON.stringify(body)).not.toContain(A); expect(JSON.stringify(body)).not.toContain('token_hash');
  });
  it('retains cross-game authorization, strict API input, version conflicts and one-winner races after cutover', async () => {
    const id = await create(); await join(id);
    const other = crypto.randomUUID(); await request('create', other, X, { color_choice: 'white', turnstile_token: 'proof' });
    const cross = await d.handler(new Request('https://isolated.test', { method: 'POST', body: JSON.stringify({ game_id: other, player_token: A, expected_version: 1, from: 'e2', to: 'e4' }) })); expect(cross.status).toBe(403);
    expect((await request('read', id, A, { player_color: 'b' })).status).toBe(400);
    const responses = await Promise.all([move(id), move(id, { from: 'd2', to: 'd4' })]); expect(responses.map(r => r.status).sort()).toEqual([200,409]);
    expect((await (await move(id)).json()).code).toBe('VERSION_CONFLICT');
    expect((await q('select jsonb_array_length(moves)::int as n from public.online_games where id=$1', [id]))[0].n).toBe(1);
  });
  it('keeps default values centralized and all definer search_paths empty', async () => {
    expect(defaults).toMatchObject({ create_minute: 10, create_day: 100, stored_games: 1000, player_reads_minute: 120, spectator_reads_minute: 120, moves_minute: 60, move_burst: 4, waiting_seconds: 86400, joined_seconds: 604800 });
    const rows = await q("select p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where (n.nspname='online_security' or p.proname like 'online_api_%') and p.prosecdef");
    for (const row of rows) expect(row.proconfig).toContain('search_path=""');
  });
  it('serializes global creation cap and idempotent concurrent requests across handlers', async () => {
    await policy('create_minute=2');
    const ids = [crypto.randomUUID(),crypto.randomUUID(),crypto.randomUUID()];
    const responses = await Promise.all(ids.map(id => request('create', id, A, { color_choice: 'white', turnstile_token: 'proof' })));
    expect(responses.map(r => r.status).sort()).toEqual([200,200,429]);
    const successful = ids[responses.findIndex(r => r.status === 200)];
    verify.mockClear(); const retry = await request('create', successful, A, { color_choice: 'white' });
    expect(retry.status).toBe(200); expect(verify).not.toHaveBeenCalled();
    expect((await q("select hits from online_security.buckets where key='created:minute'"))[0].hits).toBe(2);
    const same = crypto.randomUUID(); await policy('create_minute=10');
    const sameResponses = await Promise.all([1,2].map(() => request('create',same,A,{color_choice:'white',turnstile_token:'proof'})));
    expect(sameResponses.map(r=>r.status)).toEqual([200,200]); expect((await q('select count(*)::int as n from public.online_games where id=$1',[same]))[0].n).toBe(1);
  });
  it('enforces UTC-day and inventory caps without consuming successful-create quotas on rejection', async () => {
    await policy('create_day=1'); const id = await create();
    const denied = await request('create',crypto.randomUUID(),A,{color_choice:'white',turnstile_token:'proof'});
    expect(denied.status).toBe(429); expect((await q("select hits from online_security.buckets where key='created:minute'"))[0].hits).toBe(1);
    const n = (await q('select count(*)::int as n from public.online_games'))[0].n; await policy(`stored_games=${n}`);
    expect((await (await request('create',crypto.randomUUID(),A,{color_choice:'white',turnstile_token:'proof'})).json()).code).toBe('CAPACITY_REACHED');
    expect((await request('create',id,A,{color_choice:'white'})).status).toBe(200);
  });
  it('counts failed requests independently of later validation and database rollback', async () => {
    const id = await create(); await join(id);
    expect((await move(id,{to:'e5'})).status).toBe(422);
    const broken = createSubmitMoveHandler({ ...backend(), commitMove: async command => d.db.transaction(async tx => {
      await tx.exec('set local role service_role');
      await tx.query('select public.online_api_commit_move($1,$2,$3,$4,$5,$6)', [command.gameId, command.token, command.expectedVersion, command.from, command.to, command.promotion ?? null]);
      throw new Error('isolated transaction rollback after mutation');
    }) });
    expect((await broken(new Request('https://isolated.test',{method:'POST',body:JSON.stringify({game_id:id,player_token:A,expected_version:2,from:'e2',to:'e4'})}))).status).toBe(503);
    expect((await q('select hits from online_security.buckets where key=$1',['move:'+id+':w']))[0].hits).toBe(2);
    expect((await q('select moves from public.online_games where id=$1',[id]))[0].moves).toEqual([]);
    expect((await q('select version from public.online_games where id=$1',[id]))[0].version).toBe(2);
  });
  it('rejects malformed/coercion payloads without calling the limiter', async () => {
    const b = { ...backend(), admit: vi.fn() };
    const handler = createOnlineApiHandler(b, verify);
    const good = { action: 'create', game_id: crypto.randomUUID(), player_token: A, color_choice: 'white' };
    for (const changes of [{ action: { toString: 'create' } }, { color_choice: { toString: 'white' } }, { player_token: [] }, { color_choice: ['white'] }, { unexpected: true }]) {
      expect((await handler(new Request('https://isolated.test', { method: 'POST', body: JSON.stringify({ ...good, ...changes }) }))).status).toBe(400);
    }
    expect((await handler(new Request('https://isolated.test', { method: 'POST', body: 'x'.repeat(HTTP_POLICY.maxBodyBytes + 1) }))).status).toBe(400);
    expect(b.admit).not.toHaveBeenCalled();
  });
  it('bounds unknown IDs/tokens without storing attacker-controlled limiter keys', async () => {
    const id = await create();
    for (let i=0;i<15;i++) {
      await request('read',crypto.randomUUID(),null);
      await d.rpc('online_api_admit',{p_operation:'move',p_id:id,p_token:crypto.randomUUID().replaceAll('-','').repeat(2)},'service_role');
    }
    const rows = await q('select key,game_id from online_security.buckets');
    expect(rows.length).toBeLessThanOrEqual(6); expect(rows.every(r=>r.game_id===null)).toBe(true);
    expect(await q('select * from online_security.move_bursts')).toEqual([]);
  });
  it('isolates player reads from spectators and bad-token reads', async () => {
    const id = await create(); await join(id); await policy('spectator_reads_minute=1,player_reads_minute=2');
    expect((await request('read',id,null)).status).toBe(200);
    expect((await request('read',id,X)).status).toBe(429);
    expect((await request('read',id,A)).status).toBe(200);
    expect((await request('read',id,A)).status).toBe(200);
    expect((await request('read',id,A)).status).toBe(429);
    expect((await request('read',id,B)).status).toBe(200);
  });
  it('charges idempotent join/create responses to the same verified-seat read quota', async () => {
    const id = await create(); await join(id); await policy('player_reads_minute=2');
    expect((await request('read', id, A)).status).toBe(200);
    expect((await request('create', id, A, { color_choice: 'white' })).status).toBe(200);
    expect((await request('join', id, A)).status).toBe(429);
    expect((await request('create', id, A, { color_choice: 'white' })).status).toBe(429);
    expect((await join(id)).status).toBe(200);
    expect((await request('read', id, B)).status).toBe(200);
    expect((await join(id)).status).toBe(429);
  });
  it('counts failed CAPTCHA/provider attempts but never creates a game or spends successful-create quotas', async () => {
    for (const failure of ['CAPTCHA_REQUIRED', 'CAPTCHA_INVALID', 'UNAVAILABLE'] as const) {
      const id = crypto.randomUUID();
      const b = { ...backend(), create: vi.fn(), join: vi.fn() };
      const handler = createOnlineApiHandler(b, async () => failure);
      const response = await handler(new Request('https://isolated.test', { method: 'POST', body: JSON.stringify({ action: 'create', game_id: id, player_token: A, color_choice: 'white', turnstile_token: 'proof' }) }));
      expect(response.status).toBe(failure === 'UNAVAILABLE' ? 503 : 400);
      expect(b.create).not.toHaveBeenCalled();
      expect(await q('select id from public.online_games where id=$1', [id])).toEqual([]);
    }
    expect((await q("select hits from online_security.buckets where key='attempt:create'"))[0].hits).toBe(3);
    expect(await q("select key from online_security.buckets where key like 'created:%'")).toEqual([]);
  });
  it('does not derive quota identity from spoofable IP or browser headers', async () => {
    await policy('create_attempts_minute=1');
    const handler = createOnlineApiHandler(backend(), async () => 'CAPTCHA_INVALID');
    const call = (ip: string, browser: string) => handler(new Request('https://isolated.test', { method: 'POST', headers: { 'x-forwarded-for': ip, 'cf-connecting-ip': ip, 'x-browser-id': browser }, body: JSON.stringify({ action: 'create', game_id: crypto.randomUUID(), player_token: A, color_choice: 'white', turnstile_token: 'proof' }) }));
    expect((await call('192.0.2.1', 'one')).status).toBe(400);
    expect((await call('192.0.2.2', 'two')).status).toBe(429);
    expect(await q('select key from online_security.buckets')).toEqual([{ key: 'attempt:create' }]);
  });
  it('enforces move burst and minute limits and resets only expired windows', async () => {
    const id = await create(); await join(id);
    const rows = await q("select public.online_api_admit('move',$1,$2) as result from generate_series(1,5)",[id,A]);
    expect(rows.slice(0,4).every(r=>r.result.code==='OK')).toBe(true); expect(rows[4].result.code).toBe('RATE_LIMITED');
    await d.db.query('update online_security.move_bursts set tokens=0,refilled_at=statement_timestamp()-interval \'2 seconds\' where game_id=$1',[id]);
    expect((await d.rpc('online_api_admit',{p_operation:'move',p_id:id,p_token:A},'service_role')).code).toBe('OK');
    await policy('moves_minute=1'); expect((await move(id)).status).toBe(429);
    await d.db.query("update online_security.buckets set window_start=window_start-interval '1 day' where key=$1",['move:'+id+':w']);
    await d.db.query("update online_security.move_bursts set refilled_at=statement_timestamp()-interval '1 minute' where game_id=$1",[id]);
    expect((await move(id)).status).toBe(200);
  });
  it('preserves fractional burst credit across denied attempts', async () => {
    const id = await create(); await join(id);
    await d.db.query('insert into online_security.move_bursts values($1,\'w\',0.5,clock_timestamp())', [id]);
    expect((await d.rpc('online_api_admit', { p_operation: 'move', p_id: id, p_token: A }, 'service_role')).code).toBe('RATE_LIMITED');
    const [bucket] = await q('select tokens from online_security.move_bursts where game_id=$1', [id]);
    expect(bucket.tokens).toBeGreaterThanOrEqual(0.5); expect(bucket.tokens).toBeLessThan(1);
  });
  it('separates creation floods from ongoing games and join is idempotent', async () => {
    const id = await create(); await join(id); const version=(await (await request('read',id,A)).json()).session.game.version;
    await policy('create_attempts_minute=1'); await request('create',crypto.randomUUID(),A,{color_choice:'white',turnstile_token:'proof'});
    expect((await request('create',crypto.randomUUID(),A,{color_choice:'white',turnstile_token:'proof'})).status).toBe(429);
    expect((await join(id)).status).toBe(200); expect((await (await request('read',id,A)).json()).session.game.version).toBe(version);
    expect((await move(id)).status).toBe(200);
  });
  it('limits failed joins per existing game without starving recognized players', async () => {
    const id = await create(); await join(id); await policy('joins_minute=1');
    await d.db.query('delete from online_security.buckets where key=$1', ['join:' + id]);
    expect((await request('join', id, X)).status).toBe(409);
    expect((await request('join', id, 'd'.repeat(64))).status).toBe(429);
    expect((await join(id)).status).toBe(200);
    expect((await request('read', id, A)).status).toBe(200);
  });
  it('expires waiting/joined games without extending lifetime on reads or idempotent joins', async () => {
    const id = await create(); const [waiting]=await q('select expires_at-created_at as ttl,extract(epoch from expires_at-created_at)::int as seconds,expires_at from public.online_games where id=$1',[id]);
    expect(waiting.seconds).toBe(86400); await join(id);
    const [joined]=await q('select extract(epoch from expires_at-updated_at)::int as seconds,expires_at from public.online_games where id=$1',[id]);expect(joined.seconds).toBe(604800);
    await request('read',id,null); await join(id); expect((await q('select expires_at from public.online_games where id=$1',[id]))[0].expires_at).toEqual(joined.expires_at);
    await d.db.query("update public.online_games set expires_at=statement_timestamp()-interval '1 second' where id=$1",[id]);
    expect((await request('read',id,A)).status).toBe(410); expect((await join(id)).status).toBe(410); expect((await move(id)).status).toBe(410);
  });
  it('refreshes lifetime only on confirmed moves, retains 4C minimal payload', async () => {
    const id = await create(); await join(id); await d.db.query("update public.online_games set expires_at=statement_timestamp()+interval '1 hour' where id=$1",[id]);
    expect((await move(id)).status).toBe(200);
    expect((await q('select extract(epoch from expires_at-updated_at)::int as seconds from public.online_games where id=$1',[id]))[0].seconds).toBe(604800);
    const rows=await q('select payload from realtime.test_outbox where topic=$1',['online-game:'+id]);expect(rows.length).toBe(3);for(const row of rows)expect(Object.keys(row.payload).sort()).toEqual(['game_id','id','version']);
  });
  it('offers only bounded dry-run cleanup, preserves data, UUID and existing tokens', async () => {
    const before=(await q('select count(*)::int as n from public.online_games'))[0].n;
    const r=await d.db.query<any>('select public.online_cleanup_preview(2) as result');expect(r.rows[0].result.dry_run).toBe(true);expect(r.rows[0].result.sample_ids.length).toBeLessThanOrEqual(2);
    expect((await q('select count(*)::int as n from public.online_games'))[0].n).toBe(before);
    expect((await q('select expires_at>statement_timestamp() as live from public.online_games where id=$1',[d.legacyId]))[0].live).toBe(true);
    expect((await q("select to_regclass('cron.job') as cron"))[0].cron).toBeNull();
  });
  it('fails closed for unavailable/malformed limiter and never leaks errors or credentials', async () => {
    const log=vi.spyOn(console,'log'),error=vi.spyOn(console,'error');
    for(const result of [null,{}, {code:'UNEXPECTED'}, {code:'RATE_LIMITED',retry_after:0}, {code:'OK',existing_session:'invalid'}]) {
      const bad={...backend(),admit:vi.fn(async()=>result),create:vi.fn(),join:vi.fn(),commitMove:vi.fn()};
      const handler=createOnlineApiHandler(bad,verify);const r=await handler(new Request('https://isolated.test',{method:'POST',body:JSON.stringify({action:'create',game_id:crypto.randomUUID(),player_token:A,color_choice:'white',turnstile_token:'secret-proof'})}));
      expect(r.status).toBe(503);expect(r.headers.get('retry-after')).toBe('5');const text=await r.text();expect(text).not.toContain(A);expect(text).not.toContain('secret-proof');expect(bad.create).not.toHaveBeenCalled();
    }
    expect(log).not.toHaveBeenCalled();expect(error).not.toHaveBeenCalled();log.mockRestore();error.mockRestore();
  });
  it('sets 429 Retry-After/no-store and never invokes mutation after limiter denial',async()=>{
    const b={...backend(),admit:vi.fn(async()=>({code:'RATE_LIMITED',retry_after:9})),create:vi.fn(),join:vi.fn(),commitMove:vi.fn()};
    const r=await createSubmitMoveHandler(b)(new Request('https://isolated.test',{method:'POST',body:JSON.stringify({game_id:crypto.randomUUID(),player_token:A,expected_version:1,from:'e2',to:'e4'})}));
    expect(r.status).toBe(429);expect(r.headers.get('retry-after')).toBe('9');expect(r.headers.get('cache-control')).toBe('no-store');expect(b.commitMove).not.toHaveBeenCalled();
  });
  it('returns a generic 503 from both APIs if the limiter database fails', async () => {
    const b = { ...backend(), admit: vi.fn(async () => { throw new Error('private ' + A); }), create: vi.fn(), join: vi.fn(), commitMove: vi.fn() };
    const input = { game_id: crypto.randomUUID(), player_token: A };
    const responses = [
      await createOnlineApiHandler(b, verify)(new Request('https://isolated.test', { method: 'POST', body: JSON.stringify({ ...input, action: 'join' }) })),
      await createSubmitMoveHandler(b)(new Request('https://isolated.test', { method: 'POST', body: JSON.stringify({ ...input, expected_version: 2, from: 'e2', to: 'e4' }) })),
    ];
    for (const response of responses) { expect(response.status).toBe(503); expect(await response.json()).toEqual({ code: 'UNAVAILABLE', retry_after: 5 }); }
    expect(b.create).not.toHaveBeenCalled(); expect(b.join).not.toHaveBeenCalled(); expect(b.commitMove).not.toHaveBeenCalled();
  });
});
describe('Turnstile: server verification only',()=>{
  it.each([
    {success:false,'error-codes':['timeout-or-duplicate']},
    {success:true,hostname:'evil.test',action:'create_game'},
    {success:true,hostname:'chess.test',action:'other'},
  ])('rejects invalid/replayed proof, hostname or action: %j',async body=>{
    const fetcher=vi.fn(async()=>new Response(JSON.stringify(body)));const verify=createTurnstileVerifier('server-secret',['chess.test'],fetcher as typeof fetch);expect(await verify('proof')).toBe('CAPTCHA_INVALID');
  });
  it('requires configuration/proof and fails closed on provider/network failures',async()=>{
    const fetcher=vi.fn(async()=>{throw new Error('secret must not escape');});
    expect(await createTurnstileVerifier(undefined,['chess.test'],fetcher)('proof')).toBe('UNAVAILABLE');
    const verify=createTurnstileVerifier('secret',['chess.test'],fetcher);expect(await verify(undefined)).toBe('CAPTCHA_REQUIRED');expect(await verify('x'.repeat(2049))).toBe('CAPTCHA_INVALID');expect(await verify('proof')).toBe('UNAVAILABLE');
  });
  it('sends secret only to fixed Siteverify endpoint, never sends raw IP',async()=>{
    const fetcher=vi.fn(async()=>new Response(JSON.stringify({success:true,hostname:'chess.test',action:'create_game'})));
    expect(await createTurnstileVerifier('secret',['chess.test'],fetcher as typeof fetch)('proof')).toBe('OK');
    const [url,options]=fetcher.mock.calls[0] as unknown as [string,RequestInit];expect(url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');expect(JSON.parse(String(options.body))).toEqual({secret:'secret',response:'proof'});
  });
  it('rejects a slow request body without accessing limiter',async()=>{
    vi.useFakeTimers();const b={...backend(),admit:vi.fn()};const handler=createOnlineApiHandler(b,verify);
    const pending=handler(new Request('https://isolated.test',{method:'POST',body:new ReadableStream(),duplex:'half'} as RequestInit));await vi.advanceTimersByTimeAsync(HTTP_POLICY.bodyTimeoutMs);expect((await pending).status).toBe(400);expect(b.admit).not.toHaveBeenCalled();vi.useRealTimers();
  });
});
