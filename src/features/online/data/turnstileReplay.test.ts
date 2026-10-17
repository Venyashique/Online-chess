// @vitest-environment node
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { createOnlineTestDatabase } from '../../../test/onlineDatabase';
import { createOnlineBackend } from '../../../../supabase/functions/_shared/backend';
import { createOnlineApiHandler } from '../../../../supabase/functions/online-api/handler';
import { createTurnstileVerifier, hashTurnstileToken, freshChallengeTimestamp } from '../../../../supabase/functions/_shared/turnstile';
let d: Awaited<ReturnType<typeof createOnlineTestDatabase>>;
const player = 'a'.repeat(64), other = 'b'.repeat(64);
const backend = () => createOnlineBackend({ rpc: async (name, args) => ({ data: await d.rpc(name, args, 'service_role'), error: null }) });
const q = async (sql: string, args: unknown[] = []) => (await d.db.query<any>(sql, args)).rows;
const proof = () => crypto.randomUUID();
const provider = vi.fn(async () => ({ code: 'OK' as const, challengeTs: new Date().toISOString() }));
const body = (token: string | undefined, id = crypto.randomUUID(), playerToken = player) => ({ action: 'create', game_id: id, color_choice: 'white', player_token: playerToken, ...(token === undefined ? {} : { turnstile_token: token }) });
const request = (input: unknown, b = backend(), verify = provider) => createOnlineApiHandler(b, verify)(new Request('http://isolated.test', { method: 'POST', body: JSON.stringify(input) }));
const reserve = async (token: string, id = crypto.randomUUID(), p = player) => d.rpc('online_api_reserve_turnstile', { p_hash: await hashTurnstileToken(token), p_id: id, p_token: p }, 'service_role');
const createReserved = (id: string, reservation: string, p = player, at = new Date().toISOString()) => d.rpc('online_api_create_reserved', { p_id: id, p_color_choice: 'white', p_token: p, p_reservation: reservation, p_challenge_ts: at }, 'service_role');
beforeAll(async () => { d = await createOnlineTestDatabase(); }, 30000);
beforeEach(async () => {
  provider.mockClear();
  await d.db.exec('truncate online_security.turnstile_uses,online_security.buckets; truncate public.online_games cascade; update online_security.policy set turnstile_capacity=2048,turnstile_cleanup_batch=128,turnstile_max_age_seconds=240');
});
afterAll(async () => { await d?.db.close(); });
describe('Durable server-side Turnstile replay protection', () => {
  it('hashes exact bytes with SHA-256', async () => {
    expect(await hashTurnstileToken('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(await hashTurnstileToken(' abc')).not.toBe(await hashTurnstileToken('abc'));
  });
  it('creates only one game even when Siteverify would accept the same token twice', async () => {
    const token = proof();
    expect((await request(body(token))).status).toBe(200);
    const replay = await request(body(token));
    expect(replay.status).toBe(400); expect(await replay.json()).toEqual({ code: 'CAPTCHA_INVALID' });
    expect(provider).toHaveBeenCalledTimes(1);
    expect((await q('select count(*)::int as n from public.online_games'))[0].n).toBe(1);
    const [stored] = await q("select encode(token_hash,'hex') as hash,encode(player_token_hash,'hex') as player_hash,extract(epoch from expires_at-reserved_at)::int as ttl,consumed_at from online_security.turnstile_uses");
    expect(stored.hash).toBe(await hashTurnstileToken(token)); expect(stored.player_hash).toBe(await hashTurnstileToken(player));
    expect(stored.ttl).toBe(600); expect(stored.consumed_at).not.toBeNull();
    expect(JSON.stringify(stored)).not.toContain(token); expect(JSON.stringify(stored)).not.toContain(player);
  });
  it('admits one concurrent replay, accepts independent proofs and restores an existing owner session', async () => {
    const token = proof(), id = crypto.randomUUID();
    const responses = await Promise.all([request(body(token, id)), request(body(token))]);
    expect(responses.map(r => r.status).sort()).toEqual([200,400]);
    expect((await request(body(proof()))).status).toBe(200);
    expect((await request(body(undefined, id))).status).toBe(200);
    expect(provider).toHaveBeenCalledTimes(2);
  });
  it('commits reservation before verification and keeps it on provider failure', async () => {
    const token = proof();
    const verify = vi.fn(async () => {
      expect((await q('select count(*)::int as n from online_security.turnstile_uses'))[0].n).toBe(1);
      return 'UNAVAILABLE' as const;
    });
    const r = await createOnlineApiHandler(backend(), verify)(new Request('http://isolated.test', { method: 'POST', body: JSON.stringify(body(token)) }));
    expect(r.status).toBe(503); expect((await request(body(token))).status).toBe(400);
    expect(provider).not.toHaveBeenCalled(); expect(await q('select id from public.online_games')).toEqual([]);
  });
  it('preserves burn and attempt counters after a real SQL rollback of creation', async () => {
    await d.db.exec("create function public.replay_force_rollback() returns trigger language plpgsql as $$ begin raise exception 'Isolated rollback'; end; $$; create trigger replay_force_rollback after insert on public.online_games for each row execute function public.replay_force_rollback();");
    const token = proof();
    try { expect((await request(body(token))).status).toBe(503); }
    finally { await d.db.exec('drop trigger replay_force_rollback on public.online_games; drop function public.replay_force_rollback()'); }
    expect(await q('select id from public.online_games')).toEqual([]);
    expect((await q('select consumed_at from online_security.turnstile_uses'))).toEqual([{ consumed_at: null }]);
    expect((await request(body(token))).status).toBe(400);
    expect((await q("select hits from online_security.buckets where key='attempt:create'"))[0].hits).toBe(2);
  });
  it('fails closed on registry capacity and cleans only a bounded expired batch', async () => {
    await d.db.exec('update online_security.policy set turnstile_capacity=2,turnstile_cleanup_batch=1');
    expect((await reserve(proof())).code).toBe('OK'); expect((await reserve(proof())).code).toBe('OK');
    expect((await request(body(proof()))).status).toBe(503); expect(provider).not.toHaveBeenCalled();
    await d.db.exec("update online_security.turnstile_uses set reserved_at=clock_timestamp()-interval '1200 seconds',expires_at=clock_timestamp()-interval '1 second'");
    expect((await reserve(proof())).code).toBe('OK');
    expect((await q('select count(*)::int as n from online_security.turnstile_uses'))[0].n).toBe(2);
    expect((await q('select count(*)::int as n from online_security.turnstile_uses where expires_at<=clock_timestamp()'))[0].n).toBe(1);
  });
  it('cannot use expired, consumed, unknown or differently bound reservations', async () => {
    const id = crypto.randomUUID(), r = await reserve(proof(), id);
    expect((await createReserved(crypto.randomUUID(), r.reservation_id)).code).toBe('CAPTCHA_INVALID');
    expect((await createReserved(id, r.reservation_id, other)).code).toBe('CAPTCHA_INVALID');
    expect((await createReserved(id, crypto.randomUUID())).code).toBe('CAPTCHA_INVALID');
    expect((await createReserved(id, r.reservation_id, player, new Date(Date.now() - 241000).toISOString())).code).toBe('CAPTCHA_INVALID');
    expect((await createReserved(id, r.reservation_id, player, new Date(Date.now() + 31000).toISOString())).code).toBe('CAPTCHA_INVALID');
    expect((await createReserved(id, r.reservation_id, player, 'infinity')).code).toBe('CAPTCHA_INVALID');
    expect((await createReserved(id, r.reservation_id)).code).toBe('OK');
    expect((await createReserved(id, r.reservation_id)).code).toBe('CAPTCHA_INVALID');
    const id2 = crypto.randomUUID(), r2 = await reserve(proof(), id2);
    await d.db.query("update online_security.turnstile_uses set reserved_at=clock_timestamp()-interval '1200 seconds',expires_at=clock_timestamp()-interval '1 second' where reservation_id=$1", [r2.reservation_id]);
    expect((await createReserved(id2, r2.reservation_id)).code).toBe('CAPTCHA_INVALID');
  });
  it('rejects stale proof even after its registry hash has been cleaned', async () => {
    const token = proof(); await reserve(token);
    await d.db.exec("update online_security.turnstile_uses set reserved_at=clock_timestamp()-interval '1200 seconds',expires_at=clock_timestamp()-interval '1 second'");
    const old = createTurnstileVerifier('local-placeholder', ['chess.test'], async () => new Response(JSON.stringify({ success: true, hostname: 'chess.test', action: 'create_game', challenge_ts: new Date(Date.now()-601000).toISOString() })));
    const r = await createOnlineApiHandler(backend(), old)(new Request('http://isolated.test', { method: 'POST', body: JSON.stringify(body(token)) }));
    expect(r.status).toBe(400); expect(await q('select id from public.online_games')).toEqual([]);
  });
  it('closes the old RPC and denies browser roles registry/unchecked access', async () => {
    expect(await d.rpc('online_api_create', { p_id: crypto.randomUUID(), p_color_choice: 'white', p_token: player }, 'service_role')).toEqual({ code: 'UNAVAILABLE' });
    for (const role of ['anon','authenticated','service_role']) {
      await expect(d.db.transaction(async tx => { await tx.exec('set local role '+role); await tx.exec('select * from online_security.turnstile_uses'); })).rejects.toMatchObject({ code:'42501' });
      expect((await q("select has_function_privilege($1,'online_security.create_game_unchecked(uuid,text,text)','execute') as allowed",[role]))[0].allowed).toBe(false);
    }
    for (const role of ['anon','authenticated'] as const) {
      await expect(d.rpc('online_api_reserve_turnstile', { p_hash: await hashTurnstileToken(proof()), p_id: crypto.randomUUID(), p_token: player }, role)).rejects.toMatchObject({ code: '42501' });
      await expect(d.rpc('online_api_create_reserved', { p_id:crypto.randomUUID(),p_color_choice:'white',p_token:player,p_reservation:crypto.randomUUID(),p_challenge_ts:new Date().toISOString() },role)).rejects.toMatchObject({code:'42501'});
    }
    expect((await q("select bool_and(proconfig @> array['search_path=\"\"']) as safe from pg_proc where proname in ('online_api_reserve_turnstile','online_api_create_reserved')"))[0].safe).toBe(true);
  });
  it.each([null, {}, {code:'OK'}, {code:'OK',reservation_id:'bad'}, {code:'OTHER'}, {code:'UNAVAILABLE'}])('fails closed on malformed reservation response %j', async response => {
    const b = { ...backend(), reserveTurnstile: vi.fn(async () => response), create: vi.fn() };
    const r = await request(body(proof()), b);
    expect(r.status).toBe(503); expect(provider).not.toHaveBeenCalled(); expect(b.create).not.toHaveBeenCalled();
  });
  it('fails closed on registry exceptions without leaking credentials', async () => {
    const token = proof(), b = { ...backend(), reserveTurnstile: async () => { throw new Error(token+player); }, create: vi.fn() };
    const r = await request(body(token), b); expect(r.status).toBe(503);
    expect(await r.text()).not.toContain(token); expect(provider).not.toHaveBeenCalled(); expect(b.create).not.toHaveBeenCalled();
  });
  it('game deletion cannot release the consumed proof', async () => {
    const token = proof(), id = crypto.randomUUID();
    expect((await request(body(token,id))).status).toBe(200);
    await d.db.query('delete from public.online_games where id=$1',[id]);
    expect((await q('select count(*)::int as n from online_security.turnstile_uses'))[0].n).toBe(1);
    expect((await request(body(token))).status).toBe(400);
    expect(provider).toHaveBeenCalledTimes(1);
  });
  it('does not allow unsafe TTL or freshness policy configuration', async () => {
    for (const change of ['turnstile_ttl_seconds=599','turnstile_max_age_seconds=241','turnstile_future_skew_seconds=31','turnstile_cleanup_batch=0','turnstile_capacity=0']) {
      await expect(d.db.exec('update online_security.policy set '+change)).rejects.toMatchObject({code:'23514'});
    }
  });
  it('missing proof creates no registry record', async () => {
    expect((await request(body(undefined))).status).toBe(400); expect(await q('select * from online_security.turnstile_uses')).toEqual([]);
  });
});
describe('Siteverify timestamps', () => {
  it.each([undefined, null, 123, '', 'invalid', '2026-02-30T00:00:00Z', 'old','future'])('rejects invalid/stale/future timestamp %j', async at => {
    at = at === 'old' ? new Date(Date.now()-241000).toISOString() : at === 'future' ? new Date(Date.now()+31000).toISOString() : at;
    const v = createTurnstileVerifier('local-placeholder',['chess.test'],async () => new Response(JSON.stringify({success:true,hostname:'chess.test',action:'create_game',challenge_ts:at})));
    expect(await v('local-proof')).toBe('CAPTCHA_INVALID');
  });
  it('rejects calendar normalization even when the parsed time would be fresh', () => {
    expect(freshChallengeTimestamp('2026-02-30T00:00:00Z', Date.parse('2026-03-02T00:00:00Z'))).toBe(false);
  });
  it('checks conservative timestamp boundaries', () => {
    const now = Date.now(); expect(freshChallengeTimestamp(new Date(now-240000).toISOString(), now)).toBe(true);
    expect(freshChallengeTimestamp(new Date(now+30000).toISOString(), now)).toBe(true);
    expect(freshChallengeTimestamp(new Date(now-240001).toISOString(), now)).toBe(false);
    expect(freshChallengeTimestamp(new Date(now+30001).toISOString(), now)).toBe(false);
  });
});
