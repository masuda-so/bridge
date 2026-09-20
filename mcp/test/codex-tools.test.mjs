import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/client';
import {InMemoryTransport} from '@modelcontextprotocol/server';
import {createServer as createNetServer} from 'node:net';
import {createServer} from '../tools.mjs';
import {registerCodexTools} from '../codex-tools.mjs';
import {CodexInbox} from '../codex-inbox.mjs';

async function setup(run){
  const reserve=createNetServer();
  await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));
  const port=reserve.address().port;
  await new Promise(resolve=>reserve.close(resolve));
  const peers=[{id:'codex-relay-1',sessionId:'codex-relay-1',protocol:'bridge-codex-inbox-v1',
    url:`http://127.0.0.1:${port}`,token:'codex-inbox-test-fixture-only-'.repeat(3)}];
  const server=createServer(run,{codexOptions:{loadPeers:async()=>peers}});
  const client=new Client({name:'codex-inbox-tools-test',version:'1'});
  const [a,b]=InMemoryTransport.createLinkedPair();
  await server.connect(b);await client.connect(a);
  // The relay and helper have separate MCP instances, as in the real host.
  const helperServer=createServer(run,{codexOptions:{loadPeers:async()=>peers}});
  const helperClient=new Client({name:'codex-helper-tools-test',version:'1'});
  const [c,d]=InMemoryTransport.createLinkedPair();
  await helperServer.connect(d);await helperClient.connect(c);
  const raw=(name,args,options)=>client.callTool({name,arguments:args},options);
  const call=async(name,args)=>{
    const response=await raw(name,args);
    assert.equal(response.isError,undefined,JSON.stringify(response));
    return JSON.parse(response.content[0].text);
  };
  const ready=async()=>{
    for(let i=0;i<100;i++){
      const discovered=await call('bridge_codex_discover',{});
      if(discovered.candidates.some(p=>p.ready))return;
      await new Promise(resolve=>setTimeout(resolve,5));
    }
    throw Error('Receiver did not become ready');
  };
  const reply=async args=>{
    const response=await helperClient.callTool({name:'bridge_codex_reply',arguments:args});
    assert.equal(response.isError,undefined,JSON.stringify(response));return JSON.parse(response.content[0].text);
  };
  return {call,raw,reply,ready,peers,close:async()=>{
    await client.close();await server.close();await server.closeCodexReceiver();
    await helperClient.close();await helperServer.close();await helperServer.closeCodexReceiver();
  }};
}
const route={peerId:'codex-relay-1',sessionId:'codex-relay-1'};
const target={threadId:'existing-helper',cwd:'/tmp',title:'Existing helper'};

test('MCP receive/submit/report/reply round trip preserves one busy-target request and exact answer',async()=>{
  let reads=0;
  const app=await setup(async args=>{
    assert.equal(args.command,'read','MCP server must never start a host turn');reads++;
    return {thread:{id:target.threadId,cwd:target.cwd,status:{type:'active'}}};
  });
  try{
    const receiving=app.call('bridge_codex_receive',{peerId:route.peerId,relayThreadId:'relay-task',timeoutMs:5000});
    await app.ready();
    const body='BRIDGE-CODEX-INBOX\n二行目 ★ A/B・123\n三行目';
    const accepted=await app.call('bridge_codex_submit',{...route,target,body,timeoutMs:5000});
    assert.equal(accepted.status,'accepted');assert.equal(reads,1);
    const received=await receiving;
    assert.equal(received.messageId,accepted.messageId);
    assert.equal(received.body,undefined,'the request text must appear only once in the model response');
    assert.equal(received.forwardBody,`[bridge codex message_id="${accepted.messageId}" reply_to="codex-relay-1"]\n${body}`);
    assert.equal(received.target.threadId,target.threadId);
    const receipt={...route,messageId:accepted.messageId};
    const pending=await app.call('bridge_codex_wait',{...receipt,timeoutMs:1});
    assert.equal(pending.status,'pending');
    await app.call('bridge_codex_report',{messageId:accepted.messageId,outcome:'queued',body:'Native host accepted this message into its queue'});
    const queued=await app.call('bridge_codex_wait',{...receipt,timeoutMs:1});
    assert.equal(queued.status,'pending');assert.equal(queued.deliveryStatus,'queued');
    const reply='受信確認:\n'+body;
    const selfAnswer=await app.raw('bridge_codex_reply',{...receipt,body:'the relay must not answer'});
    assert.equal(selfAnswer.isError,true);
    assert.equal((await app.call('bridge_codex_wait',{...receipt,timeoutMs:1})).status,'pending');
    await app.reply({...receipt,body:reply});
    const final=await app.call('bridge_codex_wait',receipt);
    assert.equal(final.reply,reply);assert.equal(final.status,'replied');
    assert.equal(final.final,true);assert.equal(final.uiVerified,false);
    const other=await app.call('bridge_codex_wait',{...receipt,messageId:'another-request'});
    assert.equal(other.status,'unknown');assert.equal(other.reply,undefined);
    assert.equal((await app.call('bridge_codex_discover',{})).candidates[0].ready,false);
  }finally{await app.close();}
});

test('MCP refuses changed destinations before submission and refuses relay self-targeting',async()=>{
  let cwd='/elsewhere';
  const app=await setup(async args=>({thread:{id:args.threadId,cwd}}));
  try{
    const receiving=app.call('bridge_codex_receive',{peerId:route.peerId,relayThreadId:'relay-task',timeoutMs:5000});
    await app.ready();
    const changed=await app.raw('bridge_codex_submit',{...route,target,body:'must not be sent'});
    assert.equal(changed.isError,true);
    assert.equal((await app.call('bridge_codex_discover',{})).candidates[0].ready,true);
    cwd='/tmp';
    const accepted=await app.call('bridge_codex_submit',{...route,target:{threadId:'relay-task',cwd},body:'self-target',timeoutMs:5000});
    const refused=await receiving;
    assert.equal(refused.status,'refused');assert.equal(refused.forwardBody,undefined);
    const result=await app.call('bridge_codex_wait',{...route,messageId:accepted.messageId});
    assert.equal(result.status,'failed');assert.equal(result.reply,undefined);
  }finally{await app.close();}
});

test('MCP receiver times out once and does not reopen its inbox automatically',async()=>{
  const app=await setup(async()=>({thread:{id:target.threadId,cwd:target.cwd}}));
  try{
    const result=await app.call('bridge_codex_receive',{peerId:route.peerId,relayThreadId:'relay-task',timeoutMs:1});
    assert.equal(result.status,'idle');
    const unavailable=await app.call('bridge_codex_submit',{...route,target,body:'no automatic restart'});
    assert.equal(unavailable.status,'unavailable');assert.equal(unavailable.messageId,undefined);
  }finally{await app.close();}
});

test('MCP client cancellation propagates through the SDK and ends the live receive window',async()=>{
 const app=await setup(async()=>({thread:{id:target.threadId,cwd:target.cwd}}));
 try{
  const abort=new AbortController();
  const receiving=app.raw('bridge_codex_receive',{peerId:route.peerId,relayThreadId:'relay-task',timeoutMs:600000},{signal:abort.signal});
  const rejected=assert.rejects(receiving);await app.ready();abort.abort();await rejected;
  let ready=true;
  for(let i=0;i<100&&ready;i++){
   ready=(await app.call('bridge_codex_discover',{})).candidates.some(p=>p.ready);
   if(ready)await new Promise(resolve=>setTimeout(resolve,5));
  }
  assert.equal(ready,false);
  assert.equal((await app.call('bridge_codex_submit',{...route,target,body:'cancelled receiver must refuse'})).status,'unavailable');
 }finally{await app.close();}
});

// These fixtures exercise lifecycle races without binding sockets or calling a
// model. The inbox is real; only slow configuration and listener opening vary.
function registry({load,listen,makeInbox}={}){
  const handlers=new Map(),inboxes=[],listeners=[],listenCalls=[];
  let peers=[{id:route.peerId,sessionId:route.sessionId,protocol:'bridge-codex-inbox-v1',
    url:'http://127.0.0.1:8791',token:'private-registry-fixture-token-'.repeat(3)}];
  const server={server:{},registerTool(name,definition,handler){handlers.set(name,handler);}};
  const control=registerCodexTools(server,{
    loadPeers:()=>load?load():Promise.resolve(peers),readTarget:async args=>({thread:{id:args.threadId,cwd:args.cwd}}),
    createInbox:options=>{const inbox=makeInbox?makeInbox(options):new CodexInbox(options);inboxes.push(inbox);return inbox;},
    listen:async(inbox,options)=>{
      listenCalls.push(options);const inner=await listen?.(inbox,options);
      const listener={port:options.port,closed:false,async close(){
        if(this.closed)return;this.closed=true;inbox.close();await inner?.close?.();
      }};
      listeners.push(listener);return listener;
    },
  });
  return {control,inboxes,listeners,listenCalls,
    get peers(){return peers;},set peers(value){peers=value;},
    call:(name,args={},signal)=>handlers.get(name)(args,{signal}),
    receive:(args={},signal)=>handlers.get('bridge_codex_receive')({peerId:route.peerId,relayThreadId:'relay-task',timeoutMs:1,...args},{signal}),
  };
}
const value=response=>JSON.parse(response.content[0].text);
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('changing a bound peer session, URL or token retires the old listener and never silently replaces it',async t=>{
 for(const [field,replacement] of [['sessionId','new-session'],['url','http://127.0.0.1:8792'],['token','replacement-token-'.repeat(4)]]){
  const app=registry();t.after(()=>app.control.close());
  assert.equal(value(await app.receive()).status,'idle');
  const old=app.peers[0];app.peers=[{...old,[field]:replacement}];
  const changed=await app.receive();assert.equal(changed.isError,true);assert.match(value(changed).error,/configuration changed/);
  assert.equal(app.listeners[0].closed,true);assert.equal(app.inboxes[0].ready,false);assert.equal(app.listenCalls.length,1);
  app.peers=[old];assert.equal((await app.receive()).isError,true,'restoring a file must not revive an invalidated receiver');
  assert.equal(app.listenCalls.length,1);assert.equal(JSON.stringify(changed).includes(old.token),false);
 }
 const removed=registry();t.after(()=>removed.control.close());await removed.receive();removed.peers=[];
 assert.equal((await removed.receive()).isError,true);assert.equal(removed.listeners[0].closed,true);
});

test('a different claimed relay thread cannot overwrite an existing process binding',async t=>{
 const app=registry();t.after(()=>app.control.close());await app.receive();
 const other=await app.receive({relayThreadId:'another-task'});
 assert.equal(other.isError,true);assert.match(value(other).error,/another receiving task/);
 assert.equal(app.control.state.relayThreadId,'relay-task');assert.equal(app.listenCalls.length,1);
});

test('close waits for an opening listener to be cleaned up and concurrent receive cannot open a second listener',async()=>{
 let release,entered;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);
 const app=registry({listen:async()=>{entered();await gate;}});
 const receiving=app.receive({timeoutMs:600000});await started;
 const concurrent=await app.receive();assert.equal(concurrent.isError,true);assert.equal(app.listenCalls.length,1);
 let closed=false;const closing=app.control.close().then(()=>{closed=true;});
 try{
  await tick();assert.equal(closed,false,'close must wait until the new listener has been disposed');
  release();await closing;const result=await receiving;
  assert.equal(result.isError,true);assert.equal(app.listeners[0].closed,true);assert.equal(app.inboxes[0].ready,false);
  assert.equal(app.control.state,undefined);
 }finally{release();await receiving;await app.control.close();}
});

test('close during peer lookup prevents any later listener startup',async()=>{
 let release,entered;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);
 let app;app=registry({load:async()=>{entered();await gate;return app.peers;}});
 const receiving=app.receive();await started;await app.control.close();release();
 assert.equal((await receiving).isError,true);assert.equal(app.listenCalls.length,0);assert.equal(app.inboxes.length,0);
});

test('cancellation during opening or an active receive clears readiness and does not reopen automatically',async t=>{
 let release,entered;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);
 const app=registry({listen:async()=>{entered();await gate;}});t.after(()=>app.control.close());
 const abort=new AbortController(),receiving=app.receive({timeoutMs:600000},abort.signal);
 await started;abort.abort();release();assert.equal((await receiving).isError,true);
 assert.equal(app.listeners[0].closed,true);assert.equal(app.inboxes[0].ready,false);assert.equal(app.control.state,undefined);
 const active=registry();t.after(()=>active.control.close());const nextAbort=new AbortController();
 const waiting=active.receive({timeoutMs:600000},nextAbort.signal);
 while(!active.inboxes[0]?.ready)await tick();
 nextAbort.abort();assert.equal((await waiting).isError,true);
 assert.equal(active.inboxes[0].ready,false);assert.equal(active.listenCalls.length,1);
 await tick();assert.equal(active.inboxes[0].ready,false);
});

test('an expired claimed request exposes no forwardBody and raw dependency errors expose no token',async t=>{
 const app=registry({makeInbox:options=>{
  const inbox=new CodexInbox(options);
  inbox.receive=async()=>({status:'received',sessionId:route.sessionId,messageId:'expired-id',target,
    body:'must never be forwarded',expiresAt:Date.now()-1});return inbox;
 }});t.after(()=>app.control.close());
 const expired=value(await app.receive());assert.equal(expired.status,'expired');assert.equal(expired.forwardBody,undefined);
 const privateToken='DO-NOT-DISPLAY-FIXTURE-TOKEN';
 const broken=registry({load:async()=>{throw Error('private config '+privateToken);}});t.after(()=>broken.control.close());
 const failed=await broken.receive();assert.equal(failed.isError,true);assert.equal(JSON.stringify(failed).includes(privateToken),false);
});
