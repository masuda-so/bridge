import test from 'node:test';
import assert from 'node:assert/strict';
import {listClaudeSessions} from '../claude-sessions.mjs';

test('Claude discovery preserves ambiguous candidates and never supplies a send route',async()=>{
 let calls=0;
 const result=await listClaudeSessions(async(command,args)=>{
  calls++;assert.equal(command,'claude');assert.deepEqual(args,['agents','--json']);
  return {stdout:JSON.stringify([
   {sessionId:'a',cwd:'/one',kind:'interactive',name:'same',pid:123,secret:'excluded'},
   {sessionId:'b',cwd:'/two',kind:'background',name:'same',status:'waiting',waitingFor:'permission prompt'},
   {id:'short-id-only',cwd:'/three',kind:'background'},
  ])};
 });
 assert.equal(calls,1);assert.deepEqual(result.sessions.map(x=>x.sessionId),['a','b']);
 assert.equal(result.omittedWithoutSessionId,1);
 assert.equal(result.sessions[1].waitingFor,'permission prompt');
 for(const row of result.sessions){assert.equal(row.delivery,'unverified');assert.equal(row.secret,undefined);assert.equal(row.routeId,undefined);}
});
test('empty Claude discovery does not certify that no sessions exist',async()=>{
 const result=await listClaudeSessions(async()=>({stdout:'[]'}));
 assert.deepEqual(result.sessions,[]);assert.match(result.limitation,/visibility restrictions/);
});
test('Claude listing errors are not retried or converted into an empty list',async()=>{
 for(const stdout of ['bad-json','{}','[{"sessionId":"a","cwd":"/a","kind":"unexpected"}]']){
  let calls=0;await assert.rejects(listClaudeSessions(async()=>{calls++;return {stdout};}));assert.equal(calls,1);
 }
 let calls=0;await assert.rejects(listClaudeSessions(async()=>{calls++;throw Error('timeout');}),/timeout/);assert.equal(calls,1);
});
