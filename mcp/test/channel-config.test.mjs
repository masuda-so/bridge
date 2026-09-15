import test from 'node:test';
import assert from 'node:assert/strict';
import {chmod,mkdtemp,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadChannelConfig} from '../channel-config.mjs';

const peer={id:'relay-1',sessionId:'saved-relay-session',url:'http://127.0.0.1:8790',token:'fixture-private-token-'.repeat(3)};

async function fixture(t,peers=[peer]){
 const dir=await mkdtemp(join(tmpdir(),'bridge-channel-config-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const path=join(dir,'peers.json');
 await writeFile(path,JSON.stringify(peers),{mode:0o600});
 return {dir,path,env:{BRIDGE_CLAUDE_CHANNEL:'1',BRIDGE_CHANNEL_PEER_ID:'relay-1',BRIDGE_CHANNEL_PEERS_FILE:path}};
}

test('relay credentials and fixed port come from the same private peer file used by senders',async t=>{
 const {env}=await fixture(t,[{...peer,id:'other-relay',sessionId:'other',url:'http://127.0.0.1:8791'},peer]);
 // MCP hosts can preserve these placeholders literally. Explicit peer mode
 // must not depend on expansion or stale shell credentials.
 const config=await loadChannelConfig({...env,
  BRIDGE_CHANNEL_SESSION_ID:'stale-session',BRIDGE_CHANNEL_TOKEN:'${BRIDGE_CHANNEL_TOKEN}',
  BRIDGE_CHANNEL_PORT:'${BRIDGE_CHANNEL_PORT}'});
 assert.deepEqual(config,{sessionId:peer.sessionId,token:peer.token,port:8790});
});

test('disabled receiver does not try to read a configured peers file',async t=>{
 const {dir,env}=await fixture(t);
 for(const enabled of [undefined,'0','false']){
  assert.equal(await loadChannelConfig({...env,BRIDGE_CLAUDE_CHANNEL:enabled,
   BRIDGE_CHANNEL_PEERS_FILE:join(dir,'does-not-exist.json')}),undefined);
 }
});

test('legacy environment configuration works when no peer id was selected',async t=>{
 const {dir}=await fixture(t);
 const env={BRIDGE_CLAUDE_CHANNEL:'1',BRIDGE_CHANNEL_SESSION_ID:'legacy-session',
  BRIDGE_CHANNEL_TOKEN:'legacy-fixture-token-'.repeat(3),BRIDGE_CHANNEL_PORT:'8792',
  BRIDGE_CHANNEL_PEERS_FILE:join(dir,'does-not-exist.json')};
 assert.deepEqual(await loadChannelConfig(env),{sessionId:'legacy-session',token:env.BRIDGE_CHANNEL_TOKEN,port:8792});
 delete env.BRIDGE_CHANNEL_PORT;
 assert.deepEqual(await loadChannelConfig(env),{sessionId:'legacy-session',token:env.BRIDGE_CHANNEL_TOKEN,port:0});
});

test('peer mode rejects files readable by other users',async t=>{
 const {path,env}=await fixture(t);
 await chmod(path,0o644);
 await assert.rejects(loadChannelConfig(env),/private|owned/i);
 await chmod(path,0o600);
 assert.equal((await loadChannelConfig(env)).sessionId,peer.sessionId);
});

test('peer mode refuses a symlink even when its target is private',async t=>{
 const {dir,path,env}=await fixture(t);
 const link=join(dir,'linked-peers.json');
 await symlink(path,link);
 await assert.rejects(loadChannelConfig({...env,BRIDGE_CHANNEL_PEERS_FILE:link}));
});

test('duplicate peer ids cannot choose an arbitrary receiver',async t=>{
 const {env}=await fixture(t,[peer,{...peer,token:'different-fixture-token-'.repeat(3)}]);
 await assert.rejects(loadChannelConfig(env),/duplicate|peer/i);
});

test('an empty or unregistered peer id fails instead of using legacy credentials',async t=>{
 const {env}=await fixture(t);
 for(const id of ['', 'missing-relay']){
  await assert.rejects(loadChannelConfig({...env,BRIDGE_CHANNEL_PEER_ID:id,
   BRIDGE_CHANNEL_SESSION_ID:'legacy-session',BRIDGE_CHANNEL_TOKEN:'legacy-fixture-token-'.repeat(3),
   BRIDGE_CHANNEL_PORT:'8792'}));
 }
});

test('peer mode rejects port zero because senders need a stable receiver address',async t=>{
 const {env}=await fixture(t,[{...peer,url:'http://127.0.0.1:0'}]);
 await assert.rejects(loadChannelConfig(env),/port/i);
});
