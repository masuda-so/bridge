import test from 'node:test';
import assert from 'node:assert/strict';
import {request as httpRequest} from 'node:http';
import {CodexInbox,listenCodexInbox} from '../codex-inbox.mjs';

const token='codex-inbox-fixture-token-'.repeat(3);
const target={threadId:'existing-target',cwd:'/fixture/bridge',title:'Existing task'};
const submission={sessionId:'relay-codex',body:' 一行目 ★\nA/B・123\n',target,timeoutMs:10000};
const observe=(receipt,timeoutMs=10)=>({sessionId:receipt.sessionId,messageId:receipt.messageId,timeoutMs});
const reply=(receipt,body='受信確認:\n'+submission.body)=>({sessionId:receipt.sessionId,messageId:receipt.messageId,body});
const fixture=t=>{const inbox=new CodexInbox({sessionId:submission.sessionId});t.after(()=>inbox.close());return inbox;};
const accepted=(inbox,input=submission)=>{
 const claim=inbox.receive({timeoutMs:1000});const receipt=inbox.submit(input);return {claim,receipt};
};
const headers={Authorization:'Bearer '+token,'Content-Type':'application/json'};
async function httpFixture(t){
 const inbox=fixture(t),listener=await listenCodexInbox(inbox,{token});t.after(()=>listener.close());
 const url='http://127.0.0.1:'+listener.port;
 const post=(path,body,extra={})=>fetch(url+path,{method:'POST',headers,body:JSON.stringify(body),...extra});
 return {inbox,listener,url,post};
}

test('registration is not readiness; only one live receive atomically claims one submission',async t=>{
 const inbox=fixture(t);
 assert.equal(inbox.identity().ready,false);
 assert.throws(()=>inbox.submit(submission),e=>e.code==='unavailable');
 const claim=inbox.receive({timeoutMs:1000});
 assert.equal(inbox.ready,true);assert.equal(inbox.identity().uiVerified,false);
 await assert.rejects(inbox.receive({timeoutMs:1000}),/already waiting/);
 const first=inbox.submit(submission);
 assert.equal(first.status,'accepted');assert.equal(first.final,false);assert.equal(first.uiVerified,false);
 assert.match(first.note,/not confirmed/);assert.equal(inbox.ready,false);
 assert.throws(()=>inbox.submit(submission),e=>e.code==='unavailable');
 const received=await claim;
 assert.equal(received.status,'received');assert.equal(received.messageId,first.messageId);
 assert.equal(received.body,submission.body);assert.deepEqual(received.target,target);
 assert.equal(inbox.pending.size,1);assert.ok(received.expiresAt>Date.now());
 await assert.rejects(inbox.receive(),/processing/);
 received.target.cwd='/mutated';first.target.threadId='mutated';
 assert.deepEqual((await inbox.wait(observe(first))).target,target);
 inbox.answer(reply(first));
 assert.equal(inbox.ready,false,'finishing a request must not automatically begin another receive');
});

test('receive expiry and cancellation remove readiness without starting a polling loop',async t=>{
 const inbox=fixture(t);
 assert.equal((await inbox.receive({timeoutMs:5})).status,'idle');assert.equal(inbox.ready,false);
 const abort=new AbortController(),waiting=inbox.receive({timeoutMs:3600000},{signal:abort.signal});
 const rejected=assert.rejects(waiting,/cancelled/);
 assert.equal(inbox.ready,true);abort.abort();await rejected;
 assert.equal(inbox.ready,false);assert.equal(inbox.receiver,undefined);
 assert.throws(()=>inbox.submit(submission),/not waiting/);
 await assert.rejects(inbox.receive({}, {signal:abort.signal}),/cancelled/);
 for(const timeoutMs of [0,3600001,NaN,1.5])await assert.rejects(inbox.receive({timeoutMs}),/timeout/);
 const defaultAbort=new AbortController(),defaultWait=inbox.receive({}, {signal:defaultAbort.signal});
 assert.ok(inbox.receiver.expiresAt-Date.now()>590000);
 const defaultRejected=assert.rejects(defaultWait,/cancelled/);defaultAbort.abort();await defaultRejected;
});

test('a cancelled receiver cannot be replaced underneath a slow submission and a claimed request is never reoffered',async t=>{
 const inbox=fixture(t),abort=new AbortController();
 const waiting=inbox.receive({timeoutMs:1000},{signal:abort.signal}),previous=inbox.receiver;
 const rejected=assert.rejects(waiting,/cancelled/);abort.abort();await rejected;
 const nextAbort=new AbortController(),next=inbox.receive({timeoutMs:1000},{signal:nextAbort.signal});
 assert.throws(()=>inbox.submit(submission,{receiver:previous}),/not waiting/);
 assert.equal(inbox.ready,true);
 const receipt=inbox.submit(submission);const got=await next;
 nextAbort.abort();assert.equal(got.messageId,receipt.messageId);assert.equal(inbox.pending.size,1);
 await assert.rejects(inbox.receive(),/processing/);
});

test('delivery reports never impersonate the target answer and exact replies survive observation timeouts',async t=>{
 const inbox=fixture(t),{claim,receipt}=accepted(inbox);await claim;
 assert.throws(()=>inbox.report({messageId:receipt.messageId,outcome:'replied',body:'fake answer'}),/Invalid/);
 inbox.report({messageId:receipt.messageId,outcome:'queued',body:'Host accepted a queued turn'});
 for(let i=0;i<2;i++){
  const result=await inbox.wait(observe(receipt));
  assert.equal(result.status,'pending');assert.equal(result.final,false);
  assert.equal(result.deliveryStatus,'queued');assert.equal(result.reply,undefined);assert.equal(result.uiVerified,false);
 }
 assert.throws(()=>inbox.report({messageId:receipt.messageId,outcome:'delivered',body:'another report'}),/already reported/);
 const waiting=inbox.wait(observe(receipt,1000));const ack=inbox.answer(reply(receipt));
 assert.equal(ack.status,'replied');assert.equal(ack.sessionId,submission.sessionId);
 const result=await waiting;
 assert.equal(result.reply,reply(receipt).body);assert.equal(result.status,'replied');assert.equal(result.final,true);
 assert.equal(result.uiVerified,false);assert.equal(result.deliveryStatus,'queued');
 assert.deepEqual(await inbox.wait(observe(receipt)),result);
 assert.throws(()=>inbox.answer(reply(receipt)),/already answered/);
 assert.equal(inbox.observerCount,0);assert.equal(inbox.pending.size,0);
});

test('an early target answer accepts only the first late delivered or queued report',async t=>{
 const inbox=fixture(t),{claim,receipt}=accepted(inbox);await claim;
 inbox.answer(reply(receipt));
 assert.throws(()=>inbox.report({messageId:receipt.messageId,outcome:'undeliverable',body:'too late'}));
 const report=inbox.report({messageId:receipt.messageId,outcome:'delivered',body:'Host send completed'});
 assert.equal(report.status,'replied');
 const result=await inbox.wait(observe(receipt));
 assert.equal(result.reply,reply(receipt).body);assert.equal(result.deliveryStatus,'delivered');
 assert.throws(()=>inbox.report({messageId:receipt.messageId,outcome:'queued',body:'duplicate'}));
});

test('request deadline is final; undeliverable closes the request without allowing a later answer',async t=>{
 const inbox=fixture(t);
 for(const report of [undefined,'delivered','queued']){
  const {claim,receipt}=accepted(inbox,{...submission,timeoutMs:15});await claim;
  if(report)inbox.report({messageId:receipt.messageId,outcome:report,body:'Host result'});
  const result=await inbox.wait(observe(receipt,1000));
  assert.equal(result.status,report??'unknown');assert.equal(result.final,true);assert.equal(result.reply,undefined);
  assert.match(result.note,/Do not resend/);assert.equal(inbox.ready,false);
  assert.throws(()=>inbox.answer(reply(receipt)),/expired/);
 }
 const {claim,receipt}=accepted(inbox);await claim;
 inbox.report({messageId:receipt.messageId,outcome:'undeliverable',body:'Target mismatch; no host send'});
 const failed=await inbox.wait(observe(receipt));assert.equal(failed.status,'failed');assert.equal(failed.final,true);
 assert.throws(()=>inbox.answer(reply(receipt)));assert.equal(inbox.pending.size,0);
});

test('expired wall-clock deadlines cannot accept a reply or submit while timer callbacks are delayed',async t=>{
 let now=Date.now();t.mock.method(Date,'now',()=>now);
 const inbox=fixture(t),waiting=inbox.receive({timeoutMs:1000});
 now+=1001;assert.equal(inbox.ready,false);assert.throws(()=>inbox.submit(submission),/not waiting/);
 inbox.close();assert.equal((await waiting).status,'closed');
 const other=fixture(t),{claim,receipt}=accepted(other);await claim;
 now+=10001;assert.throws(()=>other.answer(reply(receipt)),/expired/);
 const expired=await other.wait(observe(receipt));assert.equal(expired.status,'unknown');assert.equal(expired.final,true);
});

test('receipt identity, target validation and invalid payloads cannot consume a waiting receiver',async t=>{
 const inbox=fixture(t),waiting=inbox.receive({timeoutMs:1000});
 const invalid=[null,[],{...submission,sessionId:'another'}, {...submission,extra:true},
  {...submission,body:' '},{...submission,body:'x'.repeat(128*1024+1)},
  {...submission,timeoutMs:3600001},{...submission,target:{...target,cwd:'relative'}},
  {...submission,target:{...target,extra:true}},{...submission,target:{...target,threadId:'\ninvalid'}},
  {...submission,target:{...target,title:5}}];
 for(const input of invalid){assert.throws(()=>inbox.submit(input));assert.equal(inbox.ready,true);}
 const receipt=inbox.submit(submission);await waiting;
 await assert.rejects(inbox.wait({...observe(receipt),sessionId:'other'}),/Destination/);
 await assert.rejects(inbox.wait({...observe(receipt),timeoutMs:60001}),/Invalid/);
 assert.throws(()=>inbox.answer({...reply(receipt),sessionId:'other'}),/Destination/);
 assert.throws(()=>inbox.answer({...reply(receipt),messageId:'wrong-id'}));
 assert.throws(()=>inbox.report({messageId:'wrong-id',outcome:'delivered',body:'wrong'}));
 const unknown=await inbox.wait({...observe(receipt),messageId:'wrong-id'});
 assert.equal(unknown.status,'unknown');assert.equal(unknown.final,true);assert.match(unknown.error,/Do not resend/);
 assert.equal((await inbox.wait(observe(receipt))).status,'pending');
});

test('observers and completed receipts are bounded and close releases every timer and waiter',async t=>{
 let now=Date.now();t.mock.method(Date,'now',()=>now);
 const inbox=new CodexInbox({sessionId:submission.sessionId,maxPending:1});t.after(()=>inbox.close());
 const {claim,receipt}=accepted(inbox);await claim;
 const abort=new AbortController(),waiting=inbox.wait(observe(receipt,60000),{signal:abort.signal});
 const rejected=assert.rejects(waiting,/cancelled/);
 await assert.rejects(inbox.wait(observe(receipt)),/Too many observers/);
 abort.abort();await rejected;assert.equal(inbox.observerCount,0);
 inbox.answer(reply(receipt));
 const next=accepted(inbox);await next.claim;inbox.answer(reply(next.receipt,'second'));
 assert.equal(inbox.completed.size,1);assert.equal((await inbox.wait(observe(receipt))).status,'unknown');
 now+=300000;assert.equal((await inbox.wait(observe(next.receipt))).status,'unknown');assert.equal(inbox.completed.size,0);
 const last=accepted(inbox);await last.claim;
 const closing=inbox.wait(observe(last.receipt,60000));inbox.close();
 const closed=await closing;assert.equal(closed.status,'unknown');assert.match(closed.error,/closed/);
 assert.equal(inbox.ready,false);assert.equal(inbox.observerCount,0);assert.equal(inbox.pending.size,0);assert.equal(inbox.completed.size,0);
 const idle=fixture(t),receiving=idle.receive();idle.close();assert.equal((await receiving).status,'closed');
});

test('HTTP rejects an idle relay, claims only one concurrent submission, and retains the exact separate reply',async t=>{
 const {inbox,url,post}=await httpFixture(t);
 assert.equal((await (await fetch(url+'/identity',{headers})).json()).ready,false);
 const unavailable=await post('/submissions',submission);assert.equal(unavailable.status,503);
 const refusal=await unavailable.json();assert.equal(refusal.status,'unavailable');assert.equal(refusal.messageId,undefined);
 const claim=inbox.receive({timeoutMs:1000});
 assert.equal((await (await fetch(url+'/identity',{headers})).json()).ready,true);
 const responses=await Promise.all([post('/submissions',submission),post('/submissions',submission)]);
 assert.deepEqual(responses.map(r=>r.status).sort(),[202,503]);
 const receipt=await responses.find(r=>r.status===202).json();await responses.find(r=>r.status===503).json();
 const got=await claim;assert.equal(got.messageId,receipt.messageId);assert.equal(got.body,submission.body);
 assert.equal((await (await fetch(url+'/identity',{headers})).json()).ready,false);
 const pending=await (await fetch(url+'/messages/'+receipt.messageId+'?waitMs=5',{headers})).json();
 assert.equal(pending.status,'pending');assert.equal(pending.final,false);
 const answered=await post('/replies',reply(receipt));assert.equal(answered.status,200);
 const ack=await answered.json();assert.equal(ack.messageId,receipt.messageId);assert.equal(ack.sessionId,receipt.sessionId);
 const result=await (await fetch(url+'/messages/'+receipt.messageId,{headers})).json();
 assert.equal(result.reply,reply(receipt).body);assert.equal(result.final,true);assert.equal(result.uiVerified,false);
 assert.equal((await post('/replies',reply(receipt))).status,404);
});

test('HTTP authentication, Origin, content type, size, path and malformed input checks reveal no secrets',async t=>{
 const {inbox,url,post}=await httpFixture(t);
 for(const extra of [{},{Authorization:'Bearer '+token.slice(1)},{Authorization:'Bearer '+token,Origin:''}]){
  const response=await fetch(url+'/identity',{headers:extra});assert.equal(response.status,403);
  assert.equal((await response.text()).includes(token),false);
 }
 assert.equal((await post('/submissions',submission,{headers:{Authorization:'Bearer '+token}})).status,415);
 for(const path of ['/identity?x=1','/messages/id/extra','/messages/id?waitMs=0','/messages/id?waitMs=60001',
  '/messages/id?waitMs=1&waitMs=2','/messages/id?x=1','/messages/%2fid','/submissions?x=1']){
  assert.ok((await fetch(url+path,{headers})).status>=400);
 }
 const claim=inbox.receive({timeoutMs:1000});
 const malformed=await fetch(url+'/submissions',{method:'POST',headers,body:'{"secret":"'+token});
 assert.equal(malformed.status,400);assert.equal((await malformed.text()).includes(token),false);assert.equal(inbox.ready,true);
 const tooBig=await post('/submissions',{...submission,body:'x'.repeat(128*1024)});
 assert.equal(tooBig.status,413);assert.equal(inbox.ready,true);
 const wrong=await post('/replies',{...reply({sessionId:'wrong',messageId:'wrong'}),extra:token});
 assert.equal(wrong.status,400);assert.equal((await wrong.text()).includes(token),false);
 inbox.close();await claim;
});

test('HTTP observer disconnection releases only the observer and leaves the accepted request unchanged',async t=>{
 const {inbox,url,post}=await httpFixture(t),{claim,receipt}=accepted(inbox);await claim;
 let enter,finish;const entered=new Promise(r=>enter=r),finished=new Promise(r=>finish=r);
 const wait=inbox.wait.bind(inbox);inbox.wait=(...args)=>{const result=wait(...args);enter();return result.finally(finish);};
 const abort=new AbortController();
 const observation=fetch(url+'/messages/'+receipt.messageId+'?waitMs=60000',{headers,signal:abort.signal});
 const rejected=assert.rejects(observation);await entered;assert.equal(inbox.observerCount,1);
 abort.abort();await rejected;await finished;
 assert.equal(inbox.observerCount,0);assert.equal(inbox.pending.size,1);assert.equal(inbox.ready,false);
 assert.equal((await post('/replies',reply(receipt))).status,200);
 assert.equal((await wait(observe(receipt))).reply,reply(receipt).body);
});

test('losing a submit response cannot requeue an already claimed request',async t=>{
 const {inbox,url}=await httpFixture(t),claim=inbox.receive({timeoutMs:1000});
 let client;
 const original=inbox.submit.bind(inbox);
 inbox.submit=(...args)=>{const receipt=original(...args);client.destroy();return receipt;};
 const ended=new Promise(resolve=>{
  client=httpRequest(url+'/submissions',{method:'POST',headers},res=>{res.resume();res.on('end',resolve);});
  client.once('error',resolve);client.end(JSON.stringify(submission));
 });
 const received=await claim;await ended;
 assert.equal(inbox.pending.size,1);assert.equal(inbox.ready,false);
 assert.throws(()=>inbox.submit(submission),/not waiting/);
 await assert.rejects(inbox.receive(),/processing/);
 inbox.answer(reply(received));
 assert.equal((await inbox.wait(observe(received))).reply,reply(received).body);
});
