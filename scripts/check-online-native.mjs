import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
// Requires an explicitly provisioned disposable fixture, never a real Supabase.
const configFile=resolve(process.argv[2] ?? (()=>{throw new Error('Pass the private disposable fixture config path');})());
const root=dirname(configFile);
const config=JSON.parse(readFileSync(configFile));
assert.equal(config.isolated,true,'An explicit isolated fixture is required');
assert.equal(config.pg.database,'chess_native');
assert.match(config.pg.host,/^172\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
const base=new URL(config.url);
assert.equal(base.hostname,'127.0.0.1');assert.equal(base.protocol,'http:');
for(const port of [config.apiPort,config.movePort])assert.ok(Number.isInteger(port)&&port>1024&&port<65536);
const {Pool}=createRequire(configFile)('pg');
const pool=new Pool(config.pg);
const marker=(await pool.query('select fixture_id::text from online_security.native_test_fixture')).rows;
assert.deepEqual(marker,[{fixture_id:config.fixtureId}],'Native database fixture marker mismatch');
assert.equal((await (await fetch(config.url+'/health')).json()).fixtureId,config.fixtureId,'Routing fixture marker mismatch');
const initialDeadlocks=Number((await pool.query('select deadlocks from pg_stat_database where datname=current_database()')).rows[0].deadlocks);

const q=async(text,params=[]) => (await pool.query(text,params)).rows;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const token=()=>randomBytes(32).toString('hex');
const results=[];
const post=async(port,body)=>{
  const r=await fetch(`http://127.0.0.1:${port}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(12000)});
  return {status:r.status,body:await r.json(),retry:r.headers.get('retry-after'),cache:r.headers.get('cache-control')};
};
const api=(action,id,t=null,extra={})=>post(config.apiPort,{action,game_id:id,player_token:t,...extra});
const create=(id=randomUUID(),a=token())=>api('create',id,a,{color_choice:'white',turnstile_token:'native-valid-proof:'+randomUUID()});
const move=(g,extra={})=>post(config.movePort,{game_id:g.id,player_token:g.a,expected_version:2,from:'e2',to:'e4',...extra});
const game=async(joined=true)=>{
  const g={id:randomUUID(),a:token(),b:token()};
  assert.equal((await create(g.id,g.a)).status,200);
  if(joined) assert.equal((await api('join',g.id,g.b)).status,200);
  return g;
};
const policy=async(values)=>{
  for(const [name,value]of Object.entries(values)){assert.ok(name in config.defaults);await pool.query(`update online_security.policy set ${name}=$1`,[value]);}
};
const reset=async()=>{
  await pool.query('truncate public.online_games cascade; truncate online_security.buckets,online_security.move_bursts,online_security.turnstile_uses,realtime.test_outbox;');
  const {singleton,...values}=config.defaults;await policy(values);
};
const waitFor=async(fn,label,timeout=3000)=>{const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await sleep(20);}throw new Error('Barrier timeout: '+label);};
const countCodes=responses=>responses.reduce((o,r)=>{const k=r.body.code;o[k]=(o[k]||0)+1;return o;},{});
const test=async(name,run)=>{
  await reset();const start=Date.now();
  try{const detail=await run();results.push({name,ok:true,ms:Date.now()-start,detail});console.log('PASS '+name+(detail?' '+JSON.stringify(detail):''));}
  catch(e){const safe={name,ok:false,code:e.code||e.name,message:String(e.message).slice(0,180)};results.push(safe);console.log('FAIL '+JSON.stringify(safe));}
};
await test('native servers, independent PostgreSQL backends and full gameplay',async()=>{
  const clients=await Promise.all(Array.from({length:4},()=>pool.connect()));
  const pids=await Promise.all(clients.map(c=>c.query('select pg_backend_pid() as pid')));clients.forEach(c=>c.release());
  assert.equal(new Set(pids.map(r=>r.rows[0].pid)).size,4);
  const g=await game();assert.equal((await api('read',g.id,null)).body.session.player_color,null);
  assert.equal((await move(g)).body.session.game.version,3);
  assert.equal((await move(g,{player_token:g.b,expected_version:3,from:'e7',to:'e5'})).body.session.game.version,4);
  const read=await api('read',g.id,g.a);assert.equal(read.body.session.player_color,'w');
  assert.ok(!JSON.stringify(read.body).includes(g.a));assert.ok(!JSON.stringify(read.body).includes('token_hash'));
  const old=await fetch(config.url+'/rest/v1/rpc/get_online_game_session',{method:'POST',headers:{authorization:'Bearer '+config.anonKey,'content-type':'application/json'},body:JSON.stringify({p_id:g.id,p_token:null})});
  assert.equal(old.status,200,'006 is intentionally not applied in this replay fixture');
  return {independentConnections:4,version:4,legacyRpcStillOpen:true};
});
await test('parallel create global minute quota',async()=>{
  await policy({create_minute:2});
  const r=await Promise.all(Array.from({length:6},()=>create()));
  assert.deepEqual(countCodes(r),{OK:2,RATE_LIMITED:4});
  assert.equal((await q('select count(*)::int as n from public.online_games'))[0].n,2);
  assert.equal((await q("select hits from online_security.buckets where key='created:minute'"))[0].hits,2);
  return countCodes(r);
});
await test('parallel duplicate create is idempotent',async()=>{
  const id=randomUUID(),a=token();const r=await Promise.all(Array.from({length:6},()=>create(id,a)));
  assert.ok(r.every(x=>x.status===200));assert.equal((await q('select count(*)::int as n from public.online_games'))[0].n,1);
  assert.equal((await q("select hits from online_security.buckets where key='created:day'"))[0].hits,1);
  return {requests:6,rows:1,creationCharges:1};
});
await test('parallel inventory cap',async()=>{
  await policy({stored_games:2});const r=await Promise.all(Array.from({length:6},()=>create()));
  assert.deepEqual(countCodes(r),{OK:2,CAPACITY_REACHED:4});return countCodes(r);
});
await test('atomic global admission; unknown IDs do not create records',async()=>{
  await policy({read_attempts_minute:3});const r=await Promise.all(Array.from({length:6},()=>api('read',randomUUID(),null)));
  assert.deepEqual(countCodes(r),{NOT_FOUND:3,RATE_LIMITED:3});
  const rows=await q('select key,hits from online_security.buckets');assert.deepEqual(rows,[{key:'attempt:read',hits:4}]);return countCodes(r);
});
await test('parallel player/spectator read quota isolation',async()=>{
  const g=await game();await policy({player_reads_minute:3,spectator_reads_minute:2});
  const out=[];
  for(const t of [g.a,g.b,null])out.push(countCodes(await Promise.all(Array.from({length:5},()=>api('read',g.id,t)))));
  assert.deepEqual(out,[{OK:3,RATE_LIMITED:2},{OK:3,RATE_LIMITED:2},{OK:2,RATE_LIMITED:3}]);return out;
});
await test('parallel move minute quota charges invalid moves',async()=>{
  const g=await game();await policy({moves_minute:3,move_burst:16});
  const r=await Promise.all(Array.from({length:5},()=>move(g,{to:'e5'})));
  assert.deepEqual(countCodes(r),{INVALID_MOVE:3,RATE_LIMITED:2});
  assert.equal((await q('select version from public.online_games where id=$1',[g.id]))[0].version,2);return countCodes(r);
});
await test('native token bucket burst of four',async()=>{
  const g=await game();const r=await Promise.all(Array.from({length:6},()=>move(g,{to:'e5'})));
  assert.deepEqual(countCodes(r),{INVALID_MOVE:4,RATE_LIMITED:2});return countCodes(r);
});
await test('parallel legal moves have one winner and CAS conflicts',async()=>{
  const g=await game();const moves=[['e2','e4'],['d2','d4'],['g1','f3'],['b1','c3']];
  const r=await Promise.all(moves.map(([from,to])=>move(g,{from,to})));
  assert.deepEqual(countCodes(r),{OK:1,VERSION_CONFLICT:3});
  const [row]=await q('select version,jsonb_array_length(moves) as n from public.online_games where id=$1',[g.id]);assert.deepEqual(row,{version:3,n:1});
  return countCodes(r);
});
await test('parallel competing joins allocate only one seat',async()=>{
  const g=await game(false);const r=await Promise.all(Array.from({length:6},()=>api('join',g.id,token())));
  assert.deepEqual(countCodes(r),{OK:1,GAME_FULL:5});assert.equal((await q('select version from public.online_games where id=$1',[g.id]))[0].version,2);return countCodes(r);
});
await test('limiter counters survive actual subsequent SQL rollback',async()=>{
  const g=await game();const before=(await q('select count(*)::int as n from realtime.test_outbox'))[0].n;
  await pool.query(`create function public.native_force_rollback() returns trigger language plpgsql as $$ begin raise exception 'Isolated forced rollback'; end; $$;
    create trigger zz_native_force_rollback after update of moves on public.online_games for each row execute function public.native_force_rollback();`);
  try{
    const r=await move(g);assert.equal(r.status,503);assert.deepEqual(r.body,{code:'UNAVAILABLE',retry_after:5});
    assert.equal((await q('select hits from online_security.buckets where key=$1',['move:'+g.id+':w']))[0].hits,1);
    assert.equal((await q('select version from public.online_games where id=$1',[g.id]))[0].version,2);
    assert.equal((await q('select count(*)::int as n from realtime.test_outbox'))[0].n,before);
  }finally{await pool.query('drop trigger zz_native_force_rollback on public.online_games;drop function public.native_force_rollback();');}
  assert.equal((await move(g)).status,200);return {rollback:true,attemptPreserved:true,outboxRolledBack:true};
});
await test('native limiter SQL permission error fails closed in both APIs',async()=>{
  const g=await game();await pool.query('revoke execute on function public.online_api_admit(text,uuid,text) from service_role');
  try{
    for(const r of [await api('read',g.id,g.a),await move(g)]){assert.equal(r.status,503);assert.equal(r.retry,'5');assert.deepEqual(r.body,{code:'UNAVAILABLE',retry_after:5});}
    assert.equal((await q('select version from public.online_games where id=$1',[g.id]))[0].version,2);
  }finally{await pool.query('grant execute on function public.online_api_admit(text,uuid,text) to service_role');}
  assert.equal((await move(g)).status,200);return {read:503,move:503,noMutation:true};
});
await test('native Turnstile verifier rejects provider failures without SQL mutation',async()=>{
  const r=[];for(const proof of ['native-invalid-proof','native-provider-down'])r.push(await api('create',randomUUID(),token(),{color_choice:'white',turnstile_token:proof}));
  assert.deepEqual(r.map(x=>x.status),[400,503]);assert.equal((await q('select count(*)::int as n from public.online_games'))[0].n,0);return {invalid:400,providerDown:503};
});
await test('concurrent already-expired read/join/move deny without renewal',async()=>{
  const g=await game();await pool.query("update public.online_games set expires_at=clock_timestamp()-interval '1 second' where id=$1",[g.id]);
  const r=await Promise.all([api('read',g.id,g.a),api('join',g.id,g.b),move(g)]);
  assert.ok(r.every(x=>x.status===410));assert.equal((await q('select version from public.online_games where id=$1',[g.id]))[0].version,2);return {denials:3};
});
async function queuedExpiry(operation){
  const g=await game(operation==='move');
  if(operation==='move'){
    await pool.query('select public.online_api_admit($1,$2,$3)',['move',g.id,g.a]);
  }else await pool.query('select online_security.take_window($1,60,60,$2)',['join:'+g.id,g.id]);
  await pool.query("update public.online_games set expires_at=clock_timestamp()+interval '1 second' where id=$1",[g.id]);
  const lock=await pool.connect();await lock.query('begin');await lock.query('select id from public.online_games where id=$1 for update',[g.id]);
  let pending;
  try{
    pending=operation==='move'?move(g):api('join',g.id,g.b);
    const name=operation==='move'?'online_api_commit_move':'online_api_join';
    await waitFor(async()=>Number((await q("select count(*)::int as n from pg_stat_activity where usename='authenticator' and state='active' and wait_event_type='Lock' and query like $1",['%'+name+'%']))[0].n)>0,'queued '+operation);
    await waitFor(async()=>(await q('select clock_timestamp()>expires_at as expired from public.online_games where id=$1',[g.id]))[0].expired,'expiry',2500);
    await lock.query('commit');
    const r=await pending;assert.equal(r.status,410,'Mutation waiting on a row lock must recheck expiry at execution time');
    assert.equal((await q('select version from public.online_games where id=$1',[g.id]))[0].version,operation==='move'?2:1);
    return {queuedOperation:operation,response:r.status};
  }finally{await lock.query('rollback').catch(()=>{});lock.release();if(pending)await pending.catch(()=>{});}
}
await test('join crossing expiry while waiting for a row lock',()=>queuedExpiry('join'));
await test('move crossing expiry while waiting for a row lock',()=>queuedExpiry('move'));
await test('idempotent join versus first player read has no FK lock cycle',async()=>{
  const g=await game();const key=912345;
  const original=(await q("select pg_get_functiondef('public.online_api_join(uuid,text)'::regprocedure) as sql"))[0].sql;
  const rowLock=/select \* into g from public\.online_games where id=p_id for (?:no key )?update;/i;
  assert.match(original,rowLock);
  await pool.query(original.replace(rowLock,m=>m+` perform pg_advisory_xact_lock(${key});`));
  const gate=await pool.connect(),joinClient=await pool.connect(),reader=await pool.connect();
  let jp,rp;
  try{
    await gate.query('select pg_advisory_lock($1)',[key]);
    jp=joinClient.query('select public.online_api_join($1,$2) as result',[g.id,g.b]);jp.catch(()=>{});
    await waitFor(async()=>(await q("select wait_event from pg_stat_activity where pid=$1",[joinClient.processID]))[0]?.wait_event==='advisory','join scheduling barrier');
    rp=reader.query("select public.online_api_admit('read',$1,$2) as result",[g.id,g.b]);rp.catch(()=>{});
    await waitFor(async()=>{const [r]=await q('select state,wait_event_type from pg_stat_activity where pid=$1',[reader.processID]);return r?.state==='idle'||r?.wait_event_type==='Lock';},'read scheduling barrier');
    await gate.query('select pg_advisory_unlock($1)',[key]);
    const out=await Promise.allSettled([jp,rp]);const failures=out.filter(x=>x.status==='rejected').map(x=>x.reason.code);
    assert.deepEqual(failures,[],'Native FK/row lock cycle: '+failures.join(','));return {deadlocks:0};
  }finally{
    await gate.query('select pg_advisory_unlock_all()');
    if(jp||rp)await Promise.allSettled([jp,rp]);
    gate.release();joinClient.release();reader.release();await pool.query(original);
  }
});
await test('fixed-window counter cannot rewind after delayed statement',async()=>{
  const c=await pool.connect();
  try{
    const now=Number((await q('select extract(epoch from clock_timestamp()) as now'))[0].now);
    await sleep((((0.8-now%1)+1)%1)*1000);
    const old=c.query("with delay as materialized(select pg_sleep(0.4)) select online_security.take_window('native:boundary',1,1) as wait from delay");
    await waitFor(async()=>(await q('select wait_event from pg_stat_activity where pid=$1',[c.processID]))[0]?.wait_event==='PgSleep','old statement started');
    const started=Number((await q('select extract(epoch from query_start) as started from pg_stat_activity where pid=$1',[c.processID]))[0].started);
    await sleep(Math.max(0,(Math.floor(started)+1.02-Date.now()/1000)*1000));
    assert.equal((await q("select online_security.take_window('native:boundary',1,1) as wait"))[0].wait,0);
    const late=await old;assert.ok(late.rows[0].wait>0,'A stale statement must not reset the new window');
    assert.equal((await q("select hits from online_security.buckets where key='native:boundary'"))[0].hits,2);
    return {newWindowCharged:true};
  }finally{c.release();}
});
await test('creation quota check uses current window after a delay',async()=>{
  const c=await pool.connect();
  try{
    const now=Number((await q('select extract(epoch from clock_timestamp()) as now'))[0].now);
    await sleep((((0.8-now%1)+1)%1)*1000);
    const old=c.query("with delay as materialized(select pg_sleep(0.4)) select online_security.check_window('native:check',1,1) as wait from delay");
    await waitFor(async()=>(await q('select wait_event from pg_stat_activity where pid=$1',[c.processID]))[0]?.wait_event==='PgSleep','old check statement started');
    const started=Number((await q('select extract(epoch from query_start) as started from pg_stat_activity where pid=$1',[c.processID]))[0].started);
    await sleep(Math.max(0,(Math.floor(started)+1.02-Date.now()/1000)*1000));
    await pool.query("select online_security.take_window('native:check',1,1)");
    assert.ok((await old).rows[0].wait>0,'Creation check must see the current occupied window');return {currentWindow:true};
  }finally{c.release();}
});
await test('mixed create retry/join/read/move operations do not deadlock',async()=>{
  for(let i=0;i<3;i++){
    const g=await game();
    const r=await Promise.all([move(g),api('read',g.id,g.a),api('read',g.id,g.b),api('join',g.id,g.b),create(g.id,g.a),api('read',g.id,null)]);
    assert.ok(r.every(x=>x.status===200));
    assert.equal((await api('read',g.id,g.a)).body.session.game.version,3);
  }
  return {rounds:3,parallelOperations:6};
});
await test('cleanup remains read-only under concurrent reads',async()=>{
  const g=await game();await pool.query("update public.online_games set expires_at=clock_timestamp()-interval '1 second' where id=$1",[g.id]);
  const previews=await Promise.all(Array.from({length:4},()=>q('select public.online_cleanup_preview(10) as result')));
  assert.ok(previews.every(r=>r[0].result.dry_run===true));assert.equal((await q('select count(*)::int as n from public.online_games'))[0].n,1);return {previews:4,rowsPreserved:1};
});

// Replay tests deliberately use a provider adapter that accepts every valid
// fixture proof repeatedly. Our database, not provider single-use, is authority.
await test('one provider-accepted proof, six independent concurrent games',async()=>{
  const proof='native-valid-proof:'+randomUUID();
  const responses=await Promise.all(Array.from({length:6},()=>api('create',randomUUID(),token(),{color_choice:'white',turnstile_token:proof})));
  assert.deepEqual(countCodes(responses),{OK:1,CAPTCHA_INVALID:5});
  assert.equal((await q('select count(*)::int as n from public.online_games'))[0].n,1);
  const rows=await q("select octet_length(token_hash) as hash_bytes,octet_length(player_token_hash) as player_bytes,consumed_at is not null as consumed from online_security.turnstile_uses");
  assert.deepEqual(rows,[{hash_bytes:32,player_bytes:32,consumed:true}]);
  assert.equal((await api('create',randomUUID(),token(),{color_choice:'white',turnstile_token:proof})).status,400);
  return {requests:6,games:1,replayDenied:true};
});
await test('concurrent replay registry capacity is a hard bound',async()=>{
  await policy({turnstile_capacity:2});
  const responses=await Promise.all(Array.from({length:6},()=>create()));
  assert.deepEqual(countCodes(responses),{OK:2,UNAVAILABLE:4});
  assert.equal((await q('select count(*)::int as n from online_security.turnstile_uses'))[0].n,2);
  return countCodes(responses);
});
await test('concurrent bounded cleanup never evicts live reservations or deletes games',async()=>{
  await policy({turnstile_capacity:3,turnstile_cleanup_batch:1});
  const games=await Promise.all(Array.from({length:3},()=>game(false)));
  await pool.query("update online_security.turnstile_uses set reserved_at=clock_timestamp()-interval '1200 seconds',expires_at=clock_timestamp()-interval '1 second'");
  const responses=await Promise.all(Array.from({length:6},()=>create()));
  assert.deepEqual(countCodes(responses),{OK:3,UNAVAILABLE:3});
  assert.equal((await q('select count(*)::int as n from online_security.turnstile_uses'))[0].n,3);
  assert.equal((await q('select count(*)::int as n from public.online_games'))[0].n,games.length+3);
  return {liveReservations:3,preservedGames:6};
});
await test('creation SQL rollback does not roll back previously committed proof burn',async()=>{
  const proof='native-valid-proof:'+randomUUID();
  await pool.query("create function public.native_replay_rollback() returns trigger language plpgsql as $$ begin raise exception 'Isolated rollback'; end; $$; create trigger zz_native_replay_rollback after insert on public.online_games for each row execute function public.native_replay_rollback();");
  try{assert.equal((await api('create',randomUUID(),token(),{color_choice:'white',turnstile_token:proof})).status,503);}
  finally{await pool.query('drop trigger zz_native_replay_rollback on public.online_games;drop function public.native_replay_rollback()');}
  assert.equal((await q('select count(*)::int as n from public.online_games'))[0].n,0);
  assert.deepEqual(await q('select consumed_at from online_security.turnstile_uses'),[{consumed_at:null}]);
  assert.equal((await api('create',randomUUID(),token(),{color_choice:'white',turnstile_token:proof})).status,400);
  assert.equal((await q("select hits from online_security.buckets where key='attempt:create'"))[0].hits,2);
  return {gameRolledBack:true,proofAndCountersPreserved:true};
});
await test('registry SQL permission failure fails closed',async()=>{
  await pool.query('revoke execute on function public.online_api_reserve_turnstile(text,uuid,text) from service_role');
  try{assert.equal((await create()).status,503);assert.equal((await q('select count(*)::int as n from public.online_games'))[0].n,0);}
  finally{await pool.query('grant execute on function public.online_api_reserve_turnstile(text,uuid,text) to service_role');}
  assert.equal((await create()).status,200);return {registryFailure:503};
});
await test('old server create RPC is fail closed while legacy cutover remains deferred',async()=>{
  const [r]=await q('select public.online_api_create($1,$2,$3) as result',[randomUUID(),'white',token()]);
  assert.deepEqual(r.result,{code:'UNAVAILABLE'});
  for(const role of ['anon','authenticated']){
    const [acl]=await q("select has_function_privilege($1,'public.create_online_game_with_seat(uuid,text,text)','execute') as legacy,has_function_privilege($1,'public.online_api_reserve_turnstile(text,uuid,text)','execute') as reserve,has_function_privilege($1,'public.online_api_create_reserved(uuid,text,text,uuid,timestamptz)','execute') as create",[role]);
    assert.deepEqual(acl,{legacy:true,reserve:false,create:false});
  }
  return {oldServerCreateDenied:true,migration006NotApplied:true};
});
await test('reservation finalization has one winner, binding and freshness checks',async()=>{
  const id=randomUUID(),a=token(),hash=randomBytes(32).toString('hex');
  const [{result:r}]=await q('select public.online_api_reserve_turnstile($1,$2,$3) as result',[hash,id,a]);assert.equal(r.code,'OK');
  const at=new Date().toISOString();
  const finalize=(gid=id,t=a,ts=at)=>q('select public.online_api_create_reserved($1,$2,$3,$4,$5) as result',[gid,'white',t,r.reservation_id,ts]);
  for(const result of [await finalize(randomUUID()),await finalize(id,token()),await finalize(id,a,new Date(Date.now()-241000).toISOString()),await finalize(id,a,new Date(Date.now()+31000).toISOString())])assert.equal(result[0].result.code,'CAPTCHA_INVALID');
  const responses=await Promise.all(Array.from({length:6},()=>finalize()));
  const codes=countCodes(responses.map(rows=>({body:rows[0].result})));
  assert.deepEqual(codes,{OK:1,CAPTCHA_INVALID:5});return codes;
});
await test('challenge crossing age limit inside creation rolls back game, retains burn',async()=>{
  await policy({turnstile_max_age_seconds:1});
  const key=17000702,gate=await pool.connect();let pending;
  await pool.query(`create function public.native_replay_wait() returns trigger language plpgsql as $$ begin perform pg_advisory_xact_lock(${key});return new;end;$$;create trigger zz_native_replay_wait after insert on public.online_games for each row execute function public.native_replay_wait();`);
  const proof='native-valid-proof:'+randomUUID();
  try{
    await gate.query('select pg_advisory_lock($1)',[key]);
    pending=api('create',randomUUID(),token(),{color_choice:'white',turnstile_token:proof});
    await waitFor(async()=>Number((await q("select count(*)::int as n from pg_stat_activity where usename='authenticator' and wait_event='advisory' and query like '%online_api_create_reserved%'"))[0].n)>0,'creation blocked inside trigger');
    await sleep(1300);await gate.query('select pg_advisory_unlock($1)',[key]);
    assert.equal((await pending).status,503);
    assert.equal((await q('select count(*)::int as n from public.online_games'))[0].n,0);
    assert.deepEqual(await q('select consumed_at from online_security.turnstile_uses'),[{consumed_at:null}]);
  }finally{
    await gate.query('select pg_advisory_unlock_all()');if(pending)await pending.catch(()=>{});gate.release();
    await pool.query('drop trigger zz_native_replay_wait on public.online_games;drop function public.native_replay_wait()');
  }
  assert.equal((await api('create',randomUUID(),token(),{color_choice:'white',turnstile_token:proof})).status,400);
  return {expiredDuringMutation:true,rolledBack:true,burnRetained:true};
});

await sleep(1100); // PostgreSQL statistics flush asynchronously.
await pool.query('select pg_stat_clear_snapshot()');
const finalDeadlocks=Number((await pool.query('select deadlocks from pg_stat_database where datname=current_database()')).rows[0].deadlocks);
await test('no new PostgreSQL deadlocks in the native test round',async()=>{
  assert.equal(finalDeadlocks-initialDeadlocks,0);return {newDeadlocks:0};
});
await pool.end();
writeFileSync(root+'/native-results.json',JSON.stringify(results,null,2));
console.log('Native scenarios: '+results.filter(x=>x.ok).length+'/'+results.length+' passed');
if(results.some(x=>!x.ok))process.exitCode=1;
