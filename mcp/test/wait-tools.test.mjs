import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/client';
import {InMemoryTransport} from '@modelcontextprotocol/server';
import {createServer} from '../tools.mjs';
import {ChannelPeers} from '../channel-peers.mjs';

test('MCP submits once to the selected busy target and observes its reply without resending',async()=>{
 const target={sessionId:'target-id',name:'target',cwd:'/tmp',status:'working'};
 const identity={peerId:'relay-1',sessionId:'relay-1',messageId:'request-1'};
 let submits=0,waits=0,listingError=false;
 const channelPeers={
  async submit(args){submits++;assert.deepEqual(args.forwardTo,{name:target.name,sessionId:target.sessionId,cwd:target.cwd});
   return {status:'accepted',final:false,...identity,forwardTo:args.forwardTo};},
  async wait(args){waits++;assert.equal(args.messageId,identity.messageId);
   return {status:waits===1?'pending':'replied',final:waits!==1,...identity,
    forwardTo:{name:target.name,sessionId:target.sessionId,cwd:target.cwd},
    deliveryStatus:'queued',...(waits===1?{}:{reply:'返答 ★\nA/B・123'})};}
 };
 const server=createServer(undefined,{channelPeers,listSessions:async()=>{
  if(listingError)throw Error('temporary listing failure');
  return {sessions:[{sessionId:'other-id',name:'other',cwd:'/tmp',status:'idle'},target]};
 }});
 const client=new Client({name:'waiting-tools-test',version:'1'});
 const [a,b]=InMemoryTransport.createLinkedPair();
 const call=async(name,args)=>{
  const result=await client.callTool({name,arguments:args});
  assert.equal(result.isError,undefined);return JSON.parse(result.content[0].text);
 };
 try{
  await server.connect(b);await client.connect(a);
  const tools=(await client.listTools()).tools;
  assert.equal(tools.find(t=>t.name==='bridge_claude_wait').annotations.readOnlyHint,true);
  const listed=await call('bridge_claude_sessions',{});
  assert.equal(listed.sessions[1].status,'working');
  const accepted=await call('bridge_claude_submit',{peerId:identity.peerId,sessionId:identity.sessionId,
   body:'一回だけ送る ★\nA/B・123',forwardTo:{name:target.name,sessionId:target.sessionId}});
  assert.equal(accepted.status,'accepted');assert.equal(accepted.final,false);
  const waiting=await call('bridge_claude_wait',identity);
  assert.equal(waiting.status,'pending');assert.equal(waiting.final,false);
  assert.equal(waiting.deliveryStatus,'queued');assert.equal(waiting.sessionObservation.state,'working');
  delete target.status;
  const replied=await call('bridge_claude_wait',identity);
  assert.equal(replied.reply,'返答 ★\nA/B・123');assert.equal(replied.final,true);
  assert.equal(replied.sessionObservation.state,'unknown');
  listingError=true;
  const observedAgain=await call('bridge_claude_wait',identity);
  assert.equal(observedAgain.reply,replied.reply);assert.equal(observedAgain.sessionObservation.state,'unknown');
  assert.equal(submits,1);assert.equal(waits,3);
 }finally{await client.close();await server.close();}
});

test('asynchronous submission still refuses changed targets before any send',async()=>{
 let submits=0;
 const server=createServer(undefined,{channelPeers:{async submit(){submits++;}},
  listSessions:async()=>({sessions:[{sessionId:'target-id',name:'renamed',cwd:'/tmp',status:'working'}]})});
 const client=new Client({name:'waiting-target-test',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
 try{
  await server.connect(b);await client.connect(a);
  const result=await client.callTool({name:'bridge_claude_submit',arguments:{peerId:'relay-1',sessionId:'relay-1',
   body:'do not send to a changed target',forwardTo:{sessionId:'target-id',name:'original',cwd:'/tmp'}}});
  assert.equal(result.isError,true);assert.equal(submits,0);
 }finally{await client.close();await server.close();}
});

test('MCP observation keeps the receipt when configuration cannot be read or changes',async()=>{
 let unavailable=true,networkCalls=0;
 const channelPeers=new ChannelPeers(async()=>{
  if(unavailable)throw Error('Peer configuration temporarily unavailable');
  return [{id:'relay-1',sessionId:'a-different-session'}];
 });
 channelPeers.identity=async()=>{networkCalls++;throw Error('Must not connect to a changed destination');};
 const server=createServer(undefined,{channelPeers});
 const client=new Client({name:'waiting-configuration-test',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
 const receipt={peerId:'relay-1',sessionId:'relay-1',messageId:'accepted-request'};
 try{
  await server.connect(b);await client.connect(a);
  for(const missing of [true,false]){
   unavailable=missing;
   const result=await client.callTool({name:'bridge_claude_wait',arguments:receipt});
   assert.equal(result.isError,undefined);
   const value=JSON.parse(result.content[0].text);
   assert.equal(value.status,'unknown');assert.equal(value.final,false);
   for(const key of Object.keys(receipt))assert.equal(value[key],receipt[key]);
   assert.match(value.error,/Do not resubmit or switch destinations/);
  }
  assert.equal(networkCalls,0);
 }finally{await client.close();await server.close();}
});
