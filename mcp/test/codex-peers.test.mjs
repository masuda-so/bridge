import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,chmod,symlink,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {CODEX_INBOX_PROTOCOL,loadCodexPeers,discoverCodexPeers,submitCodexToPeer,
  waitCodexReply,replyToCodexPeer} from '../codex-peers.mjs';

// These fixtures test HTTP/client behavior only. They do not start a Codex or
// Claude conversation, call native task messaging, or prove native UI delivery.
const token='synthetic-test-credential-'.repeat(2);
const target={threadId:'existing-codex-task',cwd:'/workspace/bridge',title:'補助会話'};
const body='  BRIDGE-CODEX-TEST\n二行目 ★ A/B・123\n三行目\n';
function json(res,status,value){res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));}

async function fixture(t,handler=(_req,res)=>json(res,404,{})){
  const calls=[];
  const state={sessionId:'codex-receiver',protocol:CODEX_INBOX_PROTOCOL,ready:true,asyncReplies:true};
  const server=createServer((req,res)=>{void (async()=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const call={method:req.method,url:req.url,raw,authorization:req.headers.authorization,contentType:req.headers['content-type']};
    calls.push(call);
    if(req.headers.authorization!==`Bearer ${token}`){json(res,403,{});return;}
    if(req.method==='GET'&&req.url==='/identity'){json(res,200,state);return;}
    await handler(req,res,raw?JSON.parse(raw):undefined,call);
  })().catch(()=>{if(!res.destroyed)json(res,500,{});});});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const peer={id:'codex-relay-1',sessionId:state.sessionId,protocol:CODEX_INBOX_PROTOCOL,
    url:`http://127.0.0.1:${server.address().port}`,token,title:'Codex receiver'};
  return {peer,state,calls};
}

test('Codex discovery filters the shared Claude peer and validates readiness without exposing credentials',async t=>{
  const ready=await fixture(t),idle=await fixture(t),wrong=await fixture(t);
  idle.peer.id='idle';idle.state.ready=false;wrong.peer.id='wrong';wrong.state.sessionId='other-session';
  const claude={...ready.peer,id:'relay-1',protocol:undefined};
  const result=await discoverCodexPeers([claude,ready.peer,idle.peer,wrong.peer]);
  assert.deepEqual(result.candidates.map(p=>[p.peerId,p.ready]),[['codex-relay-1',true],['idle',false]]);
  assert.deepEqual(result.unavailable,[{peerId:'wrong',error:'Codex inbox identity mismatch'}]);
  assert.equal(result.configured,true);assert.equal(result.selectionRequired,true);
  assert.equal(ready.calls.length,1,'the Claude peer must not be probed');
  assert.ok(!JSON.stringify(result).includes(token));
  assert.ok(result.candidates.every(p=>!('url' in p)&&!('token' in p)&&p.uiVerified===false));
  for(const change of [{protocol:'claude-channel'},{ready:'true'},{asyncReplies:false}]){
    const saved={...ready.state};Object.assign(ready.state,change);
    const bad=await discoverCodexPeers([ready.peer]);assert.equal(bad.candidates.length,0);assert.equal(bad.unavailable.length,1);
    Object.assign(ready.state,saved);
  }
  assert.deepEqual(await discoverCodexPeers([claude]),{candidates:[],unavailable:[],selectionRequired:true,configured:false});
});

test('Codex peers share the owner-only loader and reject unsafe files, duplicate IDs and remote origins',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'bridge-codex-peers-')),path=join(dir,'peers.json');
  const codex={id:'codex-relay-1',sessionId:'codex',url:'http://127.0.0.1:9876',token,protocol:CODEX_INBOX_PROTOCOL};
  const claude={id:'relay-1',sessionId:'claude',url:'http://127.0.0.1:9877',token};
  try{
    await writeFile(path,JSON.stringify([claude,codex]),{mode:0o600});
    assert.deepEqual(await loadCodexPeers(path),[codex]);
    await chmod(path,0o644);await assert.rejects(loadCodexPeers(path),/private/);await chmod(path,0o600);
    const link=join(dir,'link.json');await symlink(path,link);await assert.rejects(loadCodexPeers(link));
    await writeFile(path,JSON.stringify([codex,codex]));await assert.rejects(loadCodexPeers(path),/unique IDs/);
    await writeFile(path,JSON.stringify([{...codex,url:'http://example.com'}]));await assert.rejects(loadCodexPeers(path),/loopback/);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('Codex envelope IDs reject delimiters before any HTTP request and load errors omit arbitrary paths',async t=>{
  const f=await fixture(t);
  for(const id of ['bad"id','bad id','bad\nid','bad/id']){
    await assert.rejects(discoverCodexPeers([{...f.peer,id}]),/IDs must contain/);
    await assert.rejects(submitCodexToPeer({...f.peer,sessionId:id},{sessionId:id,body,target}),/IDs must contain/);
  }
  assert.equal(f.calls.length,0);
  const dir=await mkdtemp(join(tmpdir(),'bridge-codex-load-'));
  try{
    await assert.rejects(loadCodexPeers(join(dir,token)),error=>{
      assert.ok(!error.message.includes(token));assert.ok(!error.message.includes(dir));return true;
    });
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('submission sends the exact body and chosen target once and returns only a verified receipt',async t=>{
  const f=await fixture(t,(req,res,input)=>{
    assert.equal(req.method,'POST');assert.equal(req.url,'/submissions');
    assert.deepEqual(input,{sessionId:'codex-receiver',body,target,timeoutMs:3600000});
    json(res,202,{status:'accepted',sessionId:input.sessionId,messageId:'receipt-1',target:input.target,final:false,
      token,url:'private detail'});
  });
  const result=await submitCodexToPeer(f.peer,{sessionId:f.peer.sessionId,body,target,timeoutMs:3600000});
  assert.equal(result.status,'accepted');assert.equal(result.messageId,'receipt-1');assert.equal(result.final,false);
  assert.deepEqual(result.target,target);assert.equal(result.noAutomaticRetry,true);
  assert.deepEqual(f.calls.map(c=>[c.method,c.url]),[['GET','/identity'],['POST','/submissions']]);
  assert.equal(f.calls[1].contentType,'application/json');
  assert.deepEqual(Buffer.from(JSON.parse(f.calls[1].raw).body),Buffer.from(body));
  assert.ok(!JSON.stringify(result).includes(token));assert.ok(!('url' in result));
});

test('unready, mismatched and invalid destinations never receive a submission',async t=>{
  const f=await fixture(t);const args={sessionId:f.peer.sessionId,body,target};
  f.state.ready=false;
  assert.equal((await submitCodexToPeer(f.peer,args)).status,'unavailable');
  f.state.ready=true;f.state.protocol='wrong-protocol';
  assert.equal((await submitCodexToPeer(f.peer,args)).status,'unavailable');
  f.state.protocol=CODEX_INBOX_PROTOCOL;f.state.sessionId='changed';
  assert.equal((await submitCodexToPeer(f.peer,args)).status,'unavailable');
  for(const change of [{sessionId:'wrong'},{sessionId:undefined},{target:{...target,cwd:'relative'}},
    {target:{...target,threadId:''}},{target:{...target,threadId:'task\nother'}},
    {timeoutMs:0},{timeoutMs:3600001},{timeoutMs:1.5}]){
    await assert.rejects(submitCodexToPeer(f.peer,{...args,...change}));
  }
  await assert.rejects(submitCodexToPeer({...f.peer,url:'http://example.com'},args),/loopback/);
  await assert.rejects(submitCodexToPeer({...f.peer,protocol:'other'},args),/Codex inbox peer/);
  assert.equal(f.calls.length,3);assert.ok(f.calls.every(c=>c.method==='GET'));
});

test('a lost submission response remains unknown without an invented receipt or retry',async t=>{
  const f=await fixture(t,(req,_res,input)=>{
    assert.equal(input.body,body);req.socket.destroy();
  });
  const result=await submitCodexToPeer(f.peer,{sessionId:f.peer.sessionId,body,target});
  assert.equal(result.status,'unknown');assert.equal(result.final,true);assert.ok(!('messageId' in result));
  assert.equal(result.noAutomaticRetry,true);assert.match(result.error,/Do not automatically resend/);
  assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
});

test('invalid acceptance identities and target receipts are unknown and are never retried',async t=>{
  let changed={};
  const f=await fixture(t,(_req,res,input)=>json(res,202,
    {status:'accepted',sessionId:input.sessionId,messageId:'receipt-1',target:input.target,final:false,...changed}));
  for(const change of [{sessionId:'other'},{messageId:''},{target:{...target,threadId:'other'}},
    {target:{...target,cwd:'/other'}},{target:{...target,title:'other'}},{final:true}]){
    changed=change;
    const result=await submitCodexToPeer(f.peer,{sessionId:f.peer.sessionId,body,target});
    assert.equal(result.status,'unknown');assert.ok(!('messageId' in result));
  }
  assert.equal(f.calls.filter(c=>c.method==='POST').length,6);
});

test('readiness lost after preflight is unavailable only for a matching explicit rejection',async t=>{
  let rejection={status:'unavailable',sessionId:'codex-receiver',final:true};
  const f=await fixture(t,(_req,res)=>json(res,503,rejection));
  const args={sessionId:f.peer.sessionId,body,target};
  assert.equal((await submitCodexToPeer(f.peer,args)).status,'unavailable');
  rejection={...rejection,sessionId:'other'};
  assert.equal((await submitCodexToPeer(f.peer,args)).status,'unknown');
  assert.equal(f.calls.filter(c=>c.method==='POST').length,2);
});

test('observations use only GET on the same receipt and preserve an exact reply after a transient failure',async t=>{
  const messageId='receipt /★?';let observation=0;
  const f=await fixture(t,(req,res)=>{
    assert.equal(req.method,'GET');
    assert.equal(req.url,'/messages/'+encodeURIComponent(messageId)+'?waitMs=17');
    observation++;
    if(observation===2){json(res,500,{error:token});return;}
    json(res,200,{status:observation===1?'pending':'replied',sessionId:'codex-receiver',messageId,target,
      final:observation!==1,deliveryStatus:'queued',reply:body,token});
  });
  f.state.ready=false;
  const args={sessionId:f.peer.sessionId,messageId,timeoutMs:17};
  const pending=await waitCodexReply(f.peer,args);assert.equal(pending.status,'pending');assert.equal(pending.final,false);
  assert.equal(pending.deliveryStatus,'queued');assert.ok(!('reply' in pending));
  const failed=await waitCodexReply(f.peer,args);assert.equal(failed.status,'unknown');assert.equal(failed.final,false);
  assert.equal(failed.messageId,messageId);assert.equal(failed.sessionId,f.peer.sessionId);assert.ok(!JSON.stringify(failed).includes(token));
  const replied=await waitCodexReply(f.peer,args);assert.equal(replied.status,'replied');assert.equal(replied.final,true);
  assert.deepEqual(Buffer.from(replied.reply),Buffer.from(body));assert.ok(!JSON.stringify(replied).includes(token));
  assert.equal(f.calls.length,6);assert.ok(f.calls.every(c=>c.method==='GET'));
});

test('mismatched observation receipts stay unknown and retain the requested identity',async t=>{
  let changed={};
  const f=await fixture(t,(_req,res)=>json(res,200,
    {status:'replied',sessionId:'codex-receiver',messageId:'receipt-1',reply:body,final:true,...changed}));
  const args={sessionId:f.peer.sessionId,messageId:'receipt-1',timeoutMs:10};
  for(const change of [{sessionId:'other'},{messageId:'other'},{reply:null},{final:false},{status:'accepted'}]){
    changed=change;const result=await waitCodexReply(f.peer,args);
    assert.equal(result.status,'unknown');assert.equal(result.final,false);assert.equal(result.messageId,args.messageId);
    assert.equal(result.sessionId,args.sessionId);assert.ok(!('reply' in result));
  }
  for(const timeoutMs of [0,60001,1.5])await assert.rejects(waitCodexReply(f.peer,{...args,timeoutMs}),/timeout/);
  assert.ok(f.calls.every(c=>c.method==='GET'));assert.equal(f.calls.length,10);
});

test('reply posts exact text once even when receive is no longer waiting and verifies both receipt IDs',async t=>{
  let changed={};
  const f=await fixture(t,(req,res,input)=>{
    assert.equal(req.method,'POST');assert.equal(req.url,'/replies');
    assert.deepEqual(input,{sessionId:'codex-receiver',messageId:'receipt-1',body});
    json(res,200,{status:'replied',sessionId:input.sessionId,messageId:input.messageId,token,...changed});
  });
  f.state.ready=false;
  const args={sessionId:f.peer.sessionId,messageId:'receipt-1',body};
  const replied=await replyToCodexPeer(f.peer,args);
  assert.equal(replied.status,'replied');assert.ok(!JSON.stringify(replied).includes(token));
  changed={sessionId:'other'};assert.equal((await replyToCodexPeer(f.peer,args)).status,'unknown');
  changed={messageId:'other'};assert.equal((await replyToCodexPeer(f.peer,args)).status,'unknown');
  assert.equal(f.calls.filter(c=>c.method==='POST').length,3);
  for(const timeoutMs of [0,60001])await assert.rejects(replyToCodexPeer(f.peer,{...args,timeoutMs}),/timeout/);
});

test('reply loss and rejection do not trigger a retry or expose server error details',async t=>{
  let lose=true;
  const f=await fixture(t,(req,res)=>{if(lose)req.socket.destroy();else json(res,409,{error:token});});
  const args={sessionId:f.peer.sessionId,messageId:'receipt-1',body};
  const lost=await replyToCodexPeer(f.peer,args);assert.equal(lost.status,'unknown');assert.equal(lost.noAutomaticRetry,true);
  lose=false;const rejected=await replyToCodexPeer(f.peer,args);assert.equal(rejected.status,'failed');
  assert.ok(!JSON.stringify(rejected).includes(token));assert.equal(f.calls.filter(c=>c.method==='POST').length,2);
});

test('a submission redirect is not followed and cannot send credentials or text to another endpoint',async t=>{
  const destination=await fixture(t);
  const source=await fixture(t,(_req,res)=>{res.writeHead(307,{Location:destination.peer.url+'/submissions'});res.end();});
  const result=await submitCodexToPeer(source.peer,{sessionId:source.peer.sessionId,body,target});
  assert.equal(result.status,'unknown');assert.equal(source.calls.filter(c=>c.method==='POST').length,1);
  assert.equal(destination.calls.length,0);
});
