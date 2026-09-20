import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,chmod,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Channel,listenChannel} from '../channel.mjs';
import {ChannelPeers,loadChannelPeers} from '../channel-peers.mjs';

test('two available sessions are discovered and repeated replies stay with the selected session',async()=>{
 const endpoints=[],calls=[];const token='local-test-token'.repeat(3);
 try{
  for(const sessionId of ['A','B']){
   const channel=new Channel({sessionId,notify:async n=>{
    calls.push(sessionId);channel.reply({messageId:n.params.meta.message_id,body:n.params.content});
   }});
   const listener=await listenChannel(channel,{token});
   endpoints.push({channel,listener,peer:{id:sessionId,sessionId,title:'same title',url:`http://127.0.0.1:${listener.port}`,token}});
  }
  const peers=new ChannelPeers(async()=>endpoints.map(e=>e.peer));
  const found=await peers.discover();assert.equal(found.candidates.length,2);
  assert.ok(!JSON.stringify(found).includes(token));
  const body=' A/B・123\n二行目\n';
  for(let i=0;i<2;i++){
   const reply=await peers.send({peerId:'B',sessionId:'B',body});
   assert.equal(reply.reply,body);assert.equal(reply.sessionId,'B');
  }
  assert.deepEqual(calls,['B','B']);
  await assert.rejects(peers.send({peerId:'B',sessionId:'A',body}),/changed destination/);
  endpoints[1].peer.sessionId='changed';
  await assert.rejects(peers.send({peerId:'B',sessionId:'changed',body}),/identity mismatch/);
  assert.deepEqual(calls,['B','B']);
 }finally{for(const e of endpoints)await e.listener.close();}
});

test('channel send timeout is unknown and emits only once',async()=>{
 let count=0;const token='local-test-token'.repeat(3);
 const channel=new Channel({sessionId:'A',notify:async()=>{count++;},timeoutMs:1000});
 const listener=await listenChannel(channel,{token});
 try{
  const peers=new ChannelPeers(async()=>[{id:'A',sessionId:'A',url:`http://127.0.0.1:${listener.port}`,token}]);
  const reply=await peers.send({peerId:'A',sessionId:'A',body:'hello',timeoutMs:100});
  assert.equal(reply.status,'unknown');assert.equal(count,1);
 }finally{await listener.close();}
});

test('private peer configuration rejects public credentials and nonlocal origins',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bridge-peers-')),path=join(dir,'peers.json');
 const peer={id:'A',sessionId:'A',url:'http://127.0.0.1:1234',token:'x'.repeat(32)};
 try{
  await writeFile(path,JSON.stringify([peer]),{mode:0o600});assert.equal((await loadChannelPeers(path))[0].id,'A');
  await chmod(path,0o644);await assert.rejects(loadChannelPeers(path),/private/);await chmod(path,0o600);
  for(const url of ['http://example.com','http://localhost','http://127.0.0.1/path','http://user:pass@127.0.0.1']){
   await writeFile(path,JSON.stringify([{...peer,url}]));await assert.rejects(loadChannelPeers(path));
  }
  await assert.rejects(loadChannelPeers(join(dir,'missing.json')),{code:'ENOENT'});
  assert.deepEqual(await loadChannelPeers(''),[]);
 }finally{await rm(dir,{recursive:true,force:true});}
});
