import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/client';
import {InMemoryTransport} from '@modelcontextprotocol/server';
import {z} from 'zod';
import {Channel,listenChannel,validateForwardTo,relayRequest,BODY_BEGIN,BODY_END} from '../channel.mjs';
import {ChannelPeers} from '../channel-peers.mjs';
import {createServer} from '../tools.mjs';

const listed={sessionId:'fb65e858',name:'bridge-62',cwd:'/Users/me/bridge',kind:'interactive'};

test('forward destination validation accepts name/sessionId/absolute cwd only',()=>{
 assert.equal(validateForwardTo(undefined),undefined);
 assert.deepEqual(validateForwardTo({name:'a',sessionId:'b'}),{name:'a',sessionId:'b'});
 for(const bad of [null,'x',[],{name:'a'},{sessionId:'b'},{name:'a',sessionId:'b',cwd:'relative'},{name:'a',sessionId:'b',extra:1}])
  assert.throws(()=>validateForwardTo(bad));
});

test('relay body delimiters avoid literal default and alternative markers without changing text',()=>{
 const messageId='marker-collision';
 const body=[' A/B・123',BODY_BEGIN,BODY_END,
  `-----BEGIN BRIDGE BODY ${messageId}-0-----`,
  `-----END BRIDGE BODY ${messageId}-1-----`,'二行目 ★'].join('\n')+'\n';
 const content=relayRequest({messageId,sessionId:'relay-1',target:listed,body});
 const end=content.slice(content.lastIndexOf('\n')+1),begin=end.replace('END','BEGIN');
 assert.notEqual(end,BODY_END);assert.notEqual(begin,BODY_BEGIN);
 assert.equal(body.includes(begin),false);assert.equal(body.includes(end),false);
 const opening='\n'+begin+'\n',closing='\n'+end;
 assert.equal(content.split(opening).length,2);assert.equal(content.split(closing).length,2);
 const recovered=content.slice(content.indexOf(opening)+opening.length,content.lastIndexOf(closing));
 assert.deepEqual(Buffer.from(recovered,'utf8'),Buffer.from(body,'utf8'));
 // This verifies unambiguous wire framing, not a Claude model's actual
 // extraction or native SendMessage behavior; those require live evidence.
});

test('relay event carries forward attributes and an undeliverable outcome fails the send',async()=>{
 const channel=new Channel({sessionId:'relay-1',timeoutMs:1000});
 const server=createServer(undefined,{channel}),client=new Client({name:'relay-test',version:'1'});
 const [a,b]=InMemoryTransport.createLinkedPair();
 const events=[];
 client.setNotificationHandler('notifications/claude/channel',{params:z.object({content:z.string(),meta:z.record(z.string(),z.string())})},async(_p,n)=>{
  events.push(n.params);
  const outcome=events.length===1?'replied':'undeliverable';
  if(outcome==='replied')channel.answer({messageId:n.params.meta.message_id,body:'answer ★\n2'});
  else await client.callTool({name:'bridge_channel_reply',arguments:{messageId:n.params.meta.message_id,body:'two agents named bridge-62',outcome}});
 });
 try{
  await server.connect(b);await client.connect(a);
  const forwardTo={name:'bridge-62',sessionId:'fb65e858',cwd:'/Users/me/bridge'};
  const ok=await channel.receive({sessionId:'relay-1',body:'hello\n世界',forwardTo});
  assert.equal(ok.status,'replied');assert.equal(ok.reply,'answer ★\n2');assert.deepEqual(ok.forwardTo,forwardTo);
  // A relay request embeds its procedure and the body between fixed markers.
  assert.ok(events[0].content.startsWith(`[bridge relay request message_id="${ok.messageId}"]`));
  assert.ok(events[0].content.endsWith(`${BODY_BEGIN}\nhello\n世界\n${BODY_END}`));
  assert.equal(events[0].meta.forward_name,'bridge-62');assert.equal(events[0].meta.forward_session_id,'fb65e858');assert.equal(events[0].meta.forward_cwd,'/Users/me/bridge');
  const failed=await channel.receive({sessionId:'relay-1',body:'again',forwardTo});
  assert.equal(failed.status,'failed');assert.match(failed.error,/two agents/);
  // 'delivered' keeps the request open for the target's answer; the deadline then reports delivered, not unknown.
  let relayedId;
  const relayed=new Channel({sessionId:'relay-1',timeoutMs:300,notify:async n=>{relayedId=n.params.meta.message_id;
   assert.equal(relayed.reply({messageId:relayedId,body:'delivered to bridge-62',outcome:'delivered'}).status,'delivered');
   assert.throws(()=>relayed.reply({messageId:relayedId,body:'again',outcome:'delivered'}),/already reported/);}});
  const delivered=await relayed.receive({sessionId:'relay-1',body:'x',forwardTo});
  assert.equal(delivered.status,'delivered');assert.equal(delivered.delivery,'delivered to bridge-62');assert.deepEqual(delivered.forwardTo,forwardTo);
  const answered=new Channel({sessionId:'relay-1',notify:async n=>{answered.reply({messageId:n.params.meta.message_id,body:'sent',outcome:'delivered'});
   setTimeout(()=>answered.answer({messageId:n.params.meta.message_id,body:'受信確認 ★\n2'}),20);}});
  const full=await answered.receive({sessionId:'relay-1',body:'x',forwardTo});
  assert.equal(full.status,'replied');assert.equal(full.reply,'受信確認 ★\n2');assert.equal(full.delivery,'sent');
  assert.ok(events[0].content.includes(`[bridge relay message_id="${ok.messageId}" reply_to="relay-1"]`));
  const plainOnly=new Channel({sessionId:'relay-1',notify:async n=>{assert.throws(()=>plainOnly.reply({messageId:n.params.meta.message_id,body:'x',outcome:'delivered'}),/relay requests/);plainOnly.reply({messageId:n.params.meta.message_id,body:'ok'});}});
  assert.equal((await plainOnly.receive({sessionId:'relay-1',body:'x'})).status,'replied');
  await assert.rejects(channel.receive({sessionId:'relay-1',body:'x',forwardTo:{name:'n'}}),/name and sessionId/);
  assert.equal((await channel.receive({sessionId:'relay-1',body:'no forward'})).status,'failed');
  assert.equal(events.length,3);assert.equal(events[2].meta.forward_name,undefined);assert.equal(events[2].content,'no forward');
  await assert.rejects(channel.receive({sessionId:'relay-1',body:'x',timeoutMs:0}),/timeout/);
  const slow=new Channel({sessionId:'relay-1',notify:async()=>{},timeoutMs:60000});
  const t=Date.now();assert.equal((await slow.receive({sessionId:'relay-1',body:'x',timeoutMs:20})).status,'unknown');assert.ok(Date.now()-t<5000);slow.close();
 }finally{channel.close();await client.close();await server.close();}
});

test('bridge_claude_send re-verifies the forward target against the official listing before relaying',async()=>{
 const token='relay-test-token'.repeat(3);const seen=[];
 // This fixture extracts the wire body mechanically. It does not simulate a
 // Claude model selecting a native agent or copying text into SendMessage.
 const extract=c=>{const i=c.indexOf(BODY_BEGIN+'\n');return i<0?c:c.slice(i+BODY_BEGIN.length+1,c.lastIndexOf('\n'+BODY_END));};
 const channel=new Channel({sessionId:'relay-1',notify:async n=>{seen.push(n.params);
  const input={messageId:n.params.meta.message_id,body:'reply:'+extract(n.params.content)};
  if(n.params.meta.forward_session_id)channel.answer(input);else channel.reply(input);
 }});
 const listener=await listenChannel(channel,{token});
 const peers=new ChannelPeers(async()=>[{id:'relay-1',sessionId:'relay-1',url:`http://127.0.0.1:${listener.port}`,token}]);
 const sessions=[listed];
 const server=createServer(undefined,{channelPeers:peers,listSessions:async()=>({sessions})});
 const client=new Client({name:'relay-send-test',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();
 const send=args=>client.callTool({name:'bridge_claude_send',arguments:{peerId:'relay-1',sessionId:'relay-1',body:'A/B・123\n二行目',...args}});
 try{
  await server.connect(b);await client.connect(a);
  const ok=JSON.parse((await send({forwardTo:{name:'bridge-62',sessionId:'fb65e858'}})).content[0].text);
  assert.equal(ok.status,'replied');assert.equal(ok.reply,'reply:A/B・123\n二行目');
  assert.deepEqual(ok.forwardTo,{name:'bridge-62',sessionId:'fb65e858',cwd:'/Users/me/bridge'});
  assert.equal(seen[0].meta.forward_cwd,'/Users/me/bridge');
  for(const forwardTo of [{name:'other',sessionId:'fb65e858'},{name:'bridge-62',sessionId:'missing'},{name:'bridge-62',sessionId:'fb65e858',cwd:'/elsewhere'}]){
   const r=await send({forwardTo});assert.equal(r.isError,true);assert.match(r.content[0].text,/not listed/);
  }
  sessions.push({...listed,cwd:'/Users/me/other'});
  const dup=await send({forwardTo:{name:'bridge-62',sessionId:'fb65e858'}});assert.equal(dup.isError,true);
  assert.equal(seen.length,1,'no relay send without a unique verified target');
  const direct=JSON.parse((await send({})).content[0].text);
  assert.equal(direct.status,'replied');assert.equal(direct.forwardTo,undefined);assert.equal(seen[1].meta.forward_name,undefined);
 }finally{await client.close();await server.close();await listener.close();}
});

test('HTTP receiver maps a relay failure to 422 with the relay reason',async()=>{
 const token='relay-http-token'.repeat(3);
 const channel=new Channel({sessionId:'relay-1',notify:async n=>channel.reply({messageId:n.params.meta.message_id,body:'target not listed',outcome:'undeliverable'})});
 const listener=await listenChannel(channel,{token});
 try{
  const response=await fetch(`http://127.0.0.1:${listener.port}/messages`,{method:'POST',headers:{Authorization:`Bearer ${token}`},
   body:JSON.stringify({sessionId:'relay-1',body:'x',forwardTo:{name:'n',sessionId:'s'}})});
  assert.equal(response.status,422);const r=await response.json();assert.equal(r.status,'failed');assert.equal(r.error,'target not listed');
  const peers=new ChannelPeers(async()=>[{id:'relay-1',sessionId:'relay-1',url:`http://127.0.0.1:${listener.port}`,token}]);
  const viaPeers=await peers.send({peerId:'relay-1',sessionId:'relay-1',body:'x',forwardTo:{name:'n',sessionId:'s'}});
  assert.equal(viaPeers.status,'failed');assert.equal(viaPeers.error,'target not listed');assert.deepEqual(viaPeers.forwardTo,{name:'n',sessionId:'s'});
 }finally{await listener.close();}
});

test('target session answers over /replies; without an answer the sender gets delivered at the deadline',async()=>{
 const token='relay-deliver-token'.repeat(3);let answer;
 const channel=new Channel({sessionId:'relay-1',notify:async n=>{channel.reply({messageId:n.params.meta.message_id,body:'SendMessage: delivered',outcome:'delivered'});answer?.(n.params.meta.message_id);}});
 const listener=await listenChannel(channel,{token});
 try{
  const peers=new ChannelPeers(async()=>[{id:'relay-1',sessionId:'relay-1',url:`http://127.0.0.1:${listener.port}`,token}]);
  const forwardTo={name:'n',sessionId:'s'};
  const r=await peers.send({peerId:'relay-1',sessionId:'relay-1',body:'x',forwardTo,timeoutMs:300});
  assert.equal(r.status,'delivered');assert.equal(r.delivery,'SendMessage: delivered');assert.equal(r.reply,undefined);assert.match(r.note,/no reply/);
  // The Desktop side replies with the message_id from the envelope; the sender receives that text.
  const replied=new Promise(resolve=>{answer=async id=>resolve(await peers.reply({peerId:'relay-1',sessionId:'relay-1',messageId:id,body:'受信確認:\nx'}));});
  const sent=await peers.send({peerId:'relay-1',sessionId:'relay-1',body:'x',forwardTo,timeoutMs:5000});
  assert.equal(sent.status,'replied');assert.equal(sent.reply,'受信確認:\nx');assert.equal(sent.delivery,'SendMessage: delivered');
  assert.equal((await replied).status,'replied');
  const stale=await peers.reply({peerId:'relay-1',sessionId:'relay-1',messageId:sent.messageId,body:'again'});
  assert.equal(stale.status,'failed');assert.match(stale.error,/already answered/);
  await assert.rejects(peers.reply({peerId:'relay-1',sessionId:'other',messageId:'m',body:'x'}),/changed destination/);
 }finally{await listener.close();}
});

test('relay MCP self-answer is rejected and only the HTTP reply tool completes a forwarded send',async()=>{
 const token='relay-reply-regression'.repeat(3),body=' A/B・123\n二行目 ★\n',reply='受信確認:\n'+body;
 const channel=new Channel({sessionId:'relay-1'});
 const listener=await listenChannel(channel,{token});
 const peers=new ChannelPeers(async()=>[{id:'relay-1',sessionId:'relay-1',url:`http://127.0.0.1:${listener.port}`,token}]);
 const servers=[createServer(undefined,{channel}),createServer(undefined,{channelPeers:peers}),
  createServer(undefined,{channelPeers:peers,listSessions:async()=>({sessions:[listed]})})];
 const clients=['relay','target','sender'].map(name=>new Client({name:name+'-regression',version:'1'}));
 const [relay,target,sender]=clients;
 let resolveEvent,rejectEvent,sendCompleted=false,eventCount=0;
 const eventDone=new Promise((resolve,reject)=>{resolveEvent=resolve;rejectEvent=reject;});
 const eventTimer=setTimeout(()=>rejectEvent(Error('Missing relay/target MCP exchange')),6000);
 // Attach a rejection handler immediately; the sender may still be waiting
 // when an assertion in the notification callback fails.
 eventDone.catch(()=>{});
 relay.setNotificationHandler('notifications/claude/channel',{params:z.object({content:z.string(),meta:z.record(z.string(),z.string())})},async(_p,n)=>{
  try{
   eventCount++;
   const messageId=n.params.meta.message_id;
   // Omitting outcome exercises the actual MCP default which previously let
   // the relay's own answer masquerade as a successful target reply.
   const rejected=await relay.callTool({name:'bridge_channel_reply',arguments:{messageId,body:'relay self-answer'}});
   assert.equal(rejected.isError,true);assert.match(rejected.content[0].text,/relay cannot answer/i);
   assert.equal(channel.pending.has(messageId),true);assert.equal(sendCompleted,false);
   const delivery=await relay.callTool({name:'bridge_channel_reply',arguments:{messageId,body:'SendMessage: delivered',outcome:'delivered'}});
   assert.equal(delivery.isError,undefined);assert.equal(JSON.parse(delivery.content[0].text).status,'delivered');
   assert.equal(channel.pending.has(messageId),true);
   // This is a separate MCP client and a real loopback /replies request. It
   // verifies tool/HTTP correlation, not the identity of a real Claude session.
   const accepted=await target.callTool({name:'bridge_claude_reply',arguments:{peerId:'relay-1',sessionId:'relay-1',messageId,body:reply}});
   assert.equal(accepted.isError,undefined);
   assert.deepEqual(JSON.parse(accepted.content[0].text),{status:'replied',peerId:'relay-1',sessionId:'relay-1',messageId});
   resolveEvent(messageId);
  }catch(error){rejectEvent(error);channel.close();}
 });
 try{
  for(let i=0;i<servers.length;i++){
   const [a,b]=InMemoryTransport.createLinkedPair();await servers[i].connect(b);await clients[i].connect(a);
  }
  const send=sender.callTool({name:'bridge_claude_send',arguments:{peerId:'relay-1',sessionId:'relay-1',body,
   forwardTo:{name:listed.name,sessionId:listed.sessionId,cwd:listed.cwd},timeoutMs:5000}}).then(result=>{sendCompleted=true;return result;});
  const [result,messageId]=await Promise.all([send,eventDone]);
  assert.equal(result.isError,undefined);
  const sent=JSON.parse(result.content[0].text);
  assert.equal(sent.status,'replied');assert.equal(sent.messageId,messageId);assert.equal(sent.reply,reply);
  assert.equal(sent.delivery,'SendMessage: delivered');assert.equal(sent.deliveryStatus,'delivered');
  assert.equal(eventCount,1);assert.equal(channel.pending.size,0);
  const duplicate=await target.callTool({name:'bridge_claude_reply',arguments:{peerId:'relay-1',sessionId:'relay-1',messageId,body:'duplicate'}});
  assert.equal(JSON.parse(duplicate.content[0].text).status,'failed');
 }finally{
  clearTimeout(eventTimer);channel.close();for(const client of clients)await client.close();for(const server of servers)await server.close();await listener.close();
 }
});

test('a queued relay report stays queued at the sender deadline and never claims delivery',async()=>{
 const token='relay-queued-regression'.repeat(3);let count=0;
 const channel=new Channel({sessionId:'relay-1',notify:async n=>{count++;
  channel.reply({messageId:n.params.meta.message_id,body:'SendMessage: queued pending approval',outcome:'queued'});
 }});
 const listener=await listenChannel(channel,{token});
 try{
  const peers=new ChannelPeers(async()=>[{id:'relay-1',sessionId:'relay-1',url:`http://127.0.0.1:${listener.port}`,token}]);
  const sent=await peers.send({peerId:'relay-1',sessionId:'relay-1',body:'x',forwardTo:{name:'target',sessionId:'target-id'},timeoutMs:30});
  assert.equal(sent.status,'queued');assert.equal(sent.delivery,'SendMessage: queued pending approval');
  assert.equal(sent.reply,undefined);assert.equal(sent.uiVerified,false);assert.match(sent.note,/unverified/i);
  assert.equal(count,1);assert.equal(channel.pending.size,0);
 }finally{await listener.close();}
});

test('a fast target answer permits one late relay acknowledgement without another answer',async()=>{
 let messageId,emitted=0;
 const channel=new Channel({sessionId:'relay-1',notify:async n=>{emitted++;messageId=n.params.meta.message_id;}});
 try{
  const waiting=channel.receive({sessionId:'relay-1',body:'x',forwardTo:{name:'target',sessionId:'target-id'},timeoutMs:1000});
  assert.equal(channel.answer({messageId,body:'target answer'}).status,'replied');
  const sent=await waiting;
  const late=channel.reply({messageId,body:'SendMessage: delivered',outcome:'delivered'});
  assert.equal(late.status,'replied');assert.equal(late.messageId,messageId);assert.equal(typeof late.note,'string');
  assert.equal(sent.status,'replied');assert.equal(sent.reply,'target answer');assert.equal(sent.delivery,undefined);
  assert.equal(channel.pending.size,0);assert.equal(emitted,1);
  assert.throws(()=>channel.reply({messageId,body:'duplicate',outcome:'delivered'}));
  assert.throws(()=>channel.answer({messageId,body:'second answer'}));
 }finally{channel.close();}
});
