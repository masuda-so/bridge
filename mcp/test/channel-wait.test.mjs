import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {Channel,listenChannel} from '../channel.mjs';
import {ChannelPeers} from '../channel-peers.mjs';

const target={name:'target',sessionId:'target-id',cwd:'/fixture/bridge'};
const token='channel-wait-fixture-token-'.repeat(3);
const request={sessionId:'relay-1',body:' A/B・123\n二行目 ★\n',forwardTo:target};
const observation=(receipt,timeoutMs=20)=>({sessionId:receipt.sessionId,messageId:receipt.messageId,timeoutMs});

test('submit accepts immediately and observer timeouts never resend or remove the request',async t=>{
 const events=[];
 const channel=new Channel({sessionId:'relay-1',notify:n=>{events.push(n);return new Promise(()=>{});}});
 t.after(()=>channel.close());
 const receipt=channel.submit(request);
 assert.equal(receipt.status,'accepted');assert.equal(receipt.final,false);
 assert.deepEqual(receipt.forwardTo,target);assert.match(receipt.note,/not confirmed/);
 for(let i=0;i<2;i++){
  const waiting=await channel.wait(observation(receipt));
  assert.equal(waiting.status,'pending');assert.equal(waiting.final,false);
  assert.equal(channel.pending.has(receipt.messageId),true);
 }
 assert.equal(events.length,1);
 assert.equal(events[0].params.meta.message_id,receipt.messageId);
 assert.equal(channel.observerCount,0);
});

test('queued is progress only; a late target answer survives repeated observation with exact text',async t=>{
 let emitted=0;
 const channel=new Channel({sessionId:'relay-1',notify:()=>{emitted++;}});
 t.after(()=>channel.close());
 const receipt=channel.submit(request);
 channel.reply({messageId:receipt.messageId,body:'SendMessage: queued while target works',outcome:'queued'});
 const pending=await channel.wait(observation(receipt));
 assert.equal(pending.status,'pending');assert.equal(pending.final,false);
 assert.equal(pending.deliveryStatus,'queued');assert.equal(pending.delivery,'SendMessage: queued while target works');
 const waiting=channel.wait(observation(receipt,1000));
 const reply='受信確認:\n'+request.body;
 channel.answer({messageId:receipt.messageId,body:reply});
 const final=await waiting;
 assert.equal(final.status,'replied');assert.equal(final.final,true);
 assert.equal(final.reply,reply);assert.equal(final.deliveryStatus,'queued');
 assert.deepEqual(await channel.wait(observation(receipt)),final);
 assert.equal(emitted,1);assert.equal(channel.pending.size,0);assert.equal(channel.observerCount,0);
});

test('each observation follows its own message ID and checks the session again',async t=>{
 let emitted=0;
 const channel=new Channel({sessionId:'relay-1',notify:()=>{emitted++;}});
 t.after(()=>channel.close());
 const first=channel.submit(request),second=channel.submit(request);
 assert.notEqual(first.messageId,second.messageId);
 channel.answer({messageId:second.messageId,body:'second answer'});
 assert.equal((await channel.wait(observation(second))).reply,'second answer');
 assert.equal((await channel.wait(observation(first))).status,'pending');
 await assert.rejects(channel.wait({...observation(first),sessionId:'another-session'}),/Destination/);
 const unknown=await channel.wait({sessionId:'relay-1',messageId:'unregistered-id'});
 assert.equal(unknown.status,'unknown');assert.equal(unknown.final,true);assert.match(unknown.error,/Do not resend/);
 channel.answer({messageId:first.messageId,body:'first answer'});
 assert.equal((await channel.wait(observation(first))).reply,'first answer');
 assert.equal(emitted,2);
});

test('request expiry is final, unlike an observation timeout, and preserves a delivery report',async t=>{
 const channel=new Channel({sessionId:'relay-1',notify:()=>{}});
 t.after(()=>channel.close());
 const expired=channel.submit({...request,timeoutMs:20});
 const known=channel.submit({...request,timeoutMs:20});
 channel.reply({messageId:known.messageId,body:'SendMessage: delivered',outcome:'delivered'});
 const [missing,delivered]=await Promise.all([channel.wait(observation(expired,1000)),channel.wait(observation(known,1000))]);
 assert.equal(missing.status,'unknown');assert.equal(missing.final,true);assert.match(missing.error,/deadline/);
 assert.equal(delivered.status,'delivered');assert.equal(delivered.final,true);assert.equal(delivered.deliveryStatus,'delivered');
 assert.equal(delivered.reply,undefined);assert.match(delivered.note,/Do not resend/);
 assert.equal(channel.pending.size,0);assert.throws(()=>channel.answer({messageId:expired.messageId,body:'too late'}));
 assert.deepEqual(await channel.wait(observation(known)),delivered);
});

test('observers are bounded and cancellation or shutdown cleans them without another notification',async t=>{
 let emitted=0;
 const channel=new Channel({sessionId:'relay-1',maxPending:1,notify:()=>{emitted++;}});
 t.after(()=>channel.close());
 const receipt=channel.submit(request),abort=new AbortController();
 const waiting=channel.wait(observation(receipt,60000),{signal:abort.signal});
 const rejected=assert.rejects(waiting,/Observation closed/);
 await assert.rejects(channel.wait(observation(receipt)),/Too many/);
 assert.throws(()=>channel.submit(request),/busy/);
 abort.abort();await rejected;
 assert.equal(channel.observerCount,0);assert.equal(channel.pending.size,1);
 const closing=channel.wait(observation(receipt,60000));
 channel.close();
 const final=await closing;
 assert.equal(final.status,'unknown');assert.equal(final.final,true);assert.match(final.error,/closed/);
 assert.equal(channel.observerCount,0);assert.equal(channel.pending.size,0);assert.equal(channel.completed.size,0);
 assert.equal(emitted,1);
});

test('completed receipts are bounded and cease to be observable after five minutes',async t=>{
 let now=Date.now();t.mock.method(Date,'now',()=>now);
 const channel=new Channel({sessionId:'relay-1',maxPending:2,notify:()=>{}});
 t.after(()=>channel.close());
 const receipts=[];
 for(let i=0;i<3;i++){
  const receipt=channel.submit(request);receipts.push(receipt);
  channel.answer({messageId:receipt.messageId,body:'answer '+i});
 }
 assert.equal(channel.completed.size,2);
 assert.equal((await channel.wait(observation(receipts[0]))).status,'unknown');
 now+=299999;
 assert.equal((await channel.wait(observation(receipts[2]))).reply,'answer 2');
 now+=1;
 assert.equal((await channel.wait(observation(receipts[2]))).status,'unknown');
 assert.equal(channel.completed.size,0);
});

test('late notification rejection cannot replace a reply and a late delivery report enriches its receipt once',async t=>{
 let rejectNotify;
 const channel=new Channel({sessionId:'relay-1',notify:()=>new Promise((_,reject)=>{rejectNotify=reject;})});
 t.after(()=>channel.close());
 const receipt=channel.submit(request);
 channel.answer({messageId:receipt.messageId,body:'target answer'});
 rejectNotify(Error('late notification failure'));await new Promise(r=>setImmediate(r));
 channel.reply({messageId:receipt.messageId,body:'SendMessage: delivered',outcome:'delivered'});
 const final=await channel.wait(observation(receipt));
 assert.equal(final.status,'replied');assert.equal(final.reply,'target answer');assert.equal(final.deliveryStatus,'delivered');
 assert.throws(()=>channel.reply({messageId:receipt.messageId,body:'duplicate',outcome:'delivered'}));
});

test('submit and wait reject invalid deadlines without creating extra requests or observers',async t=>{
 let emitted=0;
 const channel=new Channel({sessionId:'relay-1',notify:()=>{emitted++;}});
 t.after(()=>channel.close());
 for(const timeoutMs of [0,-1,3600001,1.5,NaN])assert.throws(()=>channel.submit({...request,timeoutMs}),/timeout/);
 const receipt=channel.submit(request);
 for(const timeoutMs of [0,-1,60001,1.5,NaN])await assert.rejects(channel.wait(observation(receipt,timeoutMs)),/timeout/);
 assert.equal(emitted,1);assert.equal(channel.observerCount,0);
});

test('HTTP submit, repeated GET observation and separate reply preserve the same request end to end',async t=>{
 let emitted=0;
 const channel=new Channel({sessionId:'relay-1',notify:()=>{emitted++;}});
 t.after(()=>channel.close());
 const listener=await listenChannel(channel,{token});t.after(()=>listener.close());
 const configured={id:'relay-peer',sessionId:'relay-1',url:`http://127.0.0.1:${listener.port}`,token};
 const peers=new ChannelPeers(async()=>[configured]);
 assert.equal((await peers.discover()).candidates[0].asyncReplies,true);
 const receipt=await peers.submit({peerId:'relay-peer',...request,timeoutMs:3000});
 assert.equal(receipt.status,'accepted');assert.equal(receipt.final,false);assert.equal(receipt.uiVerified,false);
 const args={peerId:'relay-peer',...observation(receipt)};
 assert.equal((await peers.wait(args)).status,'pending');
 channel.reply({messageId:receipt.messageId,body:'SendMessage: queued',outcome:'queued'});
 const queued=await peers.wait(args);
 assert.equal(queued.final,false);assert.equal(queued.deliveryStatus,'queued');
 const answer='受信確認:\n'+request.body;
 const accepted=await peers.reply({...args,body:answer});assert.equal(accepted.status,'replied');
 const final=await peers.wait(args);
 assert.equal(final.status,'replied');assert.equal(final.final,true);assert.equal(final.reply,answer);
 assert.equal(final.messageId,receipt.messageId);assert.deepEqual(final.forwardTo,target);
 assert.deepEqual(await peers.wait(args),final);assert.equal(emitted,1);
 await assert.rejects(peers.wait({...args,sessionId:'other'}),/changed destination/);
 const unknown=await peers.wait({...args,messageId:'unknown-id'});assert.equal(unknown.final,true);assert.equal(unknown.status,'unknown');
});

test('HTTP observation requires authentication and rejects browser origins or ambiguous queries',async t=>{
 const channel=new Channel({sessionId:'relay-1',notify:()=>{}});t.after(()=>channel.close());
 const listener=await listenChannel(channel,{token});t.after(()=>listener.close());
 const url=`http://127.0.0.1:${listener.port}/messages/unknown-id`;
 assert.equal((await fetch(url)).status,403);
 assert.equal((await fetch(url,{headers:{Authorization:`Bearer ${token}`,Origin:'https://example.com'}})).status,403);
 for(const query of ['?waitMs=0','?waitMs=60001','?waitMs=1&waitMs=2','?waitMs=no','?extra=1'])
  assert.equal((await fetch(url+query,{headers:{Authorization:`Bearer ${token}`}})).status,400);
 assert.equal(channel.observerCount,0);
});

test('disconnecting an HTTP observer releases its waiter while leaving the submitted message alive',async t=>{
 const channel=new Channel({sessionId:'relay-1',notify:()=>{}});t.after(()=>channel.close());
 const listener=await listenChannel(channel,{token});t.after(()=>listener.close());
 const receipt=channel.submit(request),abort=new AbortController();
 let entered,finished;
 const started=new Promise(r=>{entered=r;}),ended=new Promise(r=>{finished=r;});
 const wait=channel.wait.bind(channel);
 channel.wait=(...args)=>{const result=wait(...args);entered();return result.finally(finished);};
 const get=fetch(`http://127.0.0.1:${listener.port}/messages/${receipt.messageId}?waitMs=60000`,{
  headers:{Authorization:`Bearer ${token}`},signal:abort.signal});
 const rejected=assert.rejects(get);
 await started;assert.equal(channel.observerCount,1);
 abort.abort();await rejected;await ended;
 assert.equal(channel.observerCount,0);assert.equal(channel.pending.has(receipt.messageId),true);
 channel.answer({messageId:receipt.messageId,body:'answer after disconnect'});
 assert.equal((await wait(observation(receipt))).reply,'answer after disconnect');
});

test('lost submit response never retries; failed or mismatched GET observations can be repeated using the same ID',async t=>{
 const calls=[];let mode='drop-submit';
 const server=createServer(async(req,res)=>{
  calls.push([req.method,req.url]);
  const json=value=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
  if(req.url==='/identity')return json({sessionId:'relay-1',transport:'claude-channel',asyncReplies:true});
  if(req.url==='/submissions'){
   for await(const _ of req){}req.socket.destroy();return;
  }
  if(mode==='redirect'){
   res.writeHead(302,{Location:'/unexpected'});res.end();return;
  }
  if(mode==='drop-wait'){req.socket.destroy();return;}
  json({sessionId:'relay-1',messageId:mode==='mismatched'?'another-id':'known-id',status:'pending',final:false});
 });
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 const peers=new ChannelPeers(async()=>[{id:'p',sessionId:'relay-1',url:`http://127.0.0.1:${server.address().port}`,token}]);
 const submitted=await peers.submit({peerId:'p',...request});
 assert.equal(submitted.status,'unknown');assert.equal(submitted.final,true);assert.equal(submitted.messageId,undefined);
 assert.equal(calls.filter(([,path])=>path==='/submissions').length,1);
 const args={peerId:'p',sessionId:'relay-1',messageId:'known-id',timeoutMs:10};
 for(mode of ['mismatched','drop-wait','redirect']){
  const result=await peers.wait(args);
  assert.equal(result.status,'unknown');assert.equal(result.final,false);assert.equal(result.messageId,'known-id');
 }
 mode='pending';assert.equal((await peers.wait(args)).status,'pending');
 assert.equal(calls.filter(([,path])=>path==='/submissions').length,1);
 assert.equal(calls.some(([,path])=>path==='/unexpected'),false);
 assert.equal(calls.filter(([method,path])=>path.startsWith('/messages/')).every(([method])=>method==='GET'),true);
});

test('an older receiver without async reply support is rejected before any POST',async t=>{
 let asyncReplies;const calls=[];
 const server=createServer((req,res)=>{
  calls.push([req.method,req.url]);
  if(req.url==='/identity'){
   res.writeHead(200,{'Content-Type':'application/json'});
   res.end(JSON.stringify({sessionId:'relay-1',transport:'claude-channel',asyncReplies}));return;
  }
  res.writeHead(404);res.end();
 });
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 const peers=new ChannelPeers(async()=>[{id:'old',sessionId:'relay-1',url:`http://127.0.0.1:${server.address().port}`,token}]);
 for(asyncReplies of [undefined,false]){
  await assert.rejects(peers.submit({peerId:'old',...request}),/receiver must be reconnected.*No submission sent/i);
  assert.equal((await peers.discover()).candidates[0].asyncReplies,undefined);
 }
 assert.equal(calls.some(([method])=>method==='POST'),false);
});
