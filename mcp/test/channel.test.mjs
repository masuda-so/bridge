import test from 'node:test';
import assert from 'node:assert/strict';
import {Channel,listenChannel} from '../channel.mjs';
import {createServer} from '../tools.mjs';
import {Client} from '@modelcontextprotocol/client';
import {InMemoryTransport} from '@modelcontextprotocol/server';
import {z} from 'zod';

test('default plugin does not advertise or enable a Claude channel',async()=>{
 const server=createServer(),client=new Client({name:'disabled-channel-test',version:'1'});
 const [a,b]=InMemoryTransport.createLinkedPair();
 try{
  await server.connect(b);await client.connect(a);
  assert.equal(client.getServerCapabilities().experimental?.['claude/channel'],undefined);
  assert.ok(!(await client.listTools()).tools.some(t=>t.name==='bridge_channel_reply'));
 }finally{await client.close();await server.close();}
});

test('official channel notification and MCP reply preserve body and destination',async()=>{
 const channel=new Channel({sessionId:'claude-A',timeoutMs:1000});
 const server=createServer(undefined,{channel}),client=new Client({name:'channel-test',version:'1'});
 const [a,b]=InMemoryTransport.createLinkedPair();
 const body=' A/B・123\n日本語\n';let event;
 client.setNotificationHandler('notifications/claude/channel',{params:z.object({content:z.string(),meta:z.record(z.string(),z.string())})},async (_params,notification)=>{
  event=notification;
  await client.callTool({name:'bridge_channel_reply',arguments:{messageId:notification.params.meta.message_id,body}});
 });
 try{
  await server.connect(b);await client.connect(a);
  assert.deepEqual(client.getServerCapabilities().experimental,{'claude/channel':{}});
  const result=await channel.receive({sessionId:'claude-A',body});
  assert.equal(result.status,'replied');assert.equal(result.reply,body);
  assert.equal(event.params.content,body);assert.equal(event.params.meta.session_id,'claude-A');
  assert.throws(()=>channel.reply({messageId:result.messageId,body}),/already answered/);
 }finally{channel.close();await client.close();await server.close();}
});

test('unacknowledged, failed and blocked notification writes never report delivery',async()=>{
 for(const notify of [async()=>{},async()=>{throw Error('disconnected');},()=>new Promise(()=>{})]){
  const channel=new Channel({sessionId:'A',notify,timeoutMs:10});
  const result=await channel.receive({sessionId:'A',body:'hello'});
  assert.equal(result.status,'unknown');assert.equal(channel.pending.size,0);channel.close();
 }
});

test('channel rejects wrong targets and capacity overflow; close resolves pending requests',async()=>{
 const channel=new Channel({sessionId:'A',notify:async()=>{},maxPending:1});
 await assert.rejects(channel.receive({sessionId:'B',body:'hello'}),/mismatch/);
 const waiting=channel.receive({sessionId:'A',body:'hello'});
 await assert.rejects(channel.receive({sessionId:'A',body:'again'}),/busy/);
 channel.close();assert.equal((await waiting).status,'unknown');
 await assert.rejects(channel.receive({sessionId:'A',body:'again'}),/closed/);
});

test('local HTTP receiver authenticates, rejects origins and correlates replies',async()=>{
 const token='test-token-'.repeat(5);let emitted=0;
 const channel=new Channel({sessionId:'A',notify:async n=>{emitted++;channel.reply({messageId:n.params.meta.message_id,body:n.params.content});}});
 const listener=await listenChannel(channel,{token});const url=`http://127.0.0.1:${listener.port}`;
 try{
  assert.equal((await fetch(url+'/identity')).status,403);
  assert.equal((await fetch(url+'/identity',{headers:{Authorization:`Bearer ${token}`,Origin:'https://example.com'}})).status,403);
  const headers={Authorization:`Bearer ${token}`};
  assert.equal((await (await fetch(url+'/identity',{headers})).json()).sessionId,'A');
  const send=body=>fetch(url+'/messages',{method:'POST',headers,body:JSON.stringify(body)});
  assert.equal((await send({sessionId:'B',body:'wrong'})).status,400);assert.equal(emitted,0);
  const body=' A/B・123\n日本語\n';
  const reply=await (await send({sessionId:'A',body})).json();assert.equal(reply.reply,body);assert.equal(emitted,1);
 }finally{await listener.close();}
});
