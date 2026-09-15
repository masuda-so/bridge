import test from 'node:test';
import assert from 'node:assert/strict';
import {chmod,mkdtemp,rm,symlink,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {runLauncher} from '../../relay/start-relay.mjs';
import {loadChannelPeers} from '../channel-peers.mjs';

const testPeer={id:'relay-1',sessionId:'relay-channel',url:'http://127.0.0.1:8790',token:'launcher-fixture-token-'.repeat(3)};
const response=(value,ok=true)=>({ok,json:async()=>value});

async function fixture(t,peers=[testPeer]){
 const root=await mkdtemp(join(tmpdir(),'bridge-launcher-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const path=join(root,'peers.json');
 await writeFile(path,JSON.stringify(peers),{mode:0o600});
 const h={root,path,operations:[],sessions:[],started:false,clock:0};
 h.session={name:'relay-1',sessionId:'actual-relay-session',cwd:root,kind:'background',state:'working'};
 h.dependencies={root,env:{BRIDGE_CHANNEL_PEERS_FILE:path},loadPeers:loadChannelPeers,bundleExists:()=>true,
  now:()=>h.clock,sleep:async ms=>{h.clock+=ms;},
  run:async(_command,args)=>{
   h.operations.push({type:'cli',args});
   assert.deepEqual(args,['agents','--json'],'launcher must never stop or remove a session');
   if(h.listError)throw Error('synthetic discovery error');
   return {stdout:JSON.stringify(h.started?[h.session]:h.sessions)};
  },
  launch:async(command)=>{
   h.operations.push({type:'launch',command});h.started=true;
   assert.equal(command.includes('--bg'),true);
   assert.equal(command.join(' ').includes(testPeer.token),false);
   return {code:0,stdout:'backgrounded · abc123'};
  },
  portListening:async()=>{h.operations.push({type:'port'});return false;},
  fetch:async(url,options)=>{
   const request={type:'http',path:url.pathname,method:options.method};h.operations.push(request);
   assert.equal(options.headers.Authorization,'Bearer '+testPeer.token);
   assert.equal(options.redirect,'error');
   if(options.method==='GET'){
    assert.equal(url.pathname,'/identity');
    if(h.identityError)throw Error('synthetic '+testPeer.token);
    return response({sessionId:h.identitySessionId??testPeer.sessionId,transport:'claude-channel'});
   }
   assert.equal(options.method,'POST');assert.equal(url.pathname,'/messages');
   request.body=JSON.parse(options.body);
   if(h.probeError)throw Error('synthetic timeout '+testPeer.token);
   return response(h.probeResult??{sessionId:testPeer.sessionId,messageId:'probe-id',status:'replied',reply:'PONG'},h.probeHttpOk??true);
  }};
 return h;
}

test('passive check keeps working and approval-waiting sessions live without POST or process mutation',async t=>{
 for(const state of ['working','waiting_for_permission']){
  const h=await fixture(t);h.sessions=[{...h.session,state,waitingFor:'tool approval'}];
  const {exitCode,output}=await runLauncher(['--check'],h.dependencies);
  assert.equal(exitCode,0);assert.equal(output.status,'live');assert.equal(output.state,state);
  assert.equal(output.waitingFor,'tool approval');assert.equal(output.sessionId,h.session.sessionId);
  assert.equal(output.channel,'unconfirmed');assert.equal(output.messageSent,false);assert.equal(output.receiverIdentified,true);
  assert.deepEqual(h.operations.map(o=>o.type).sort(),['cli','http']);
  assert.equal(h.operations.find(o=>o.type==='http').method,'GET');
  assert.equal(JSON.stringify(output).includes(testPeer.token),false);
 }
});

test('passive check reports unavailable observations as unknown, never dead or channel-unregistered',async t=>{
 for(const failure of ['identityError','listError','missing','ambiguous']){
  const h=await fixture(t);h.sessions=[h.session];
  if(failure==='missing')h.sessions=[];
  else if(failure==='ambiguous')h.sessions.push({...h.session,sessionId:'other-session'});
  else h[failure]=true;
  const {output}=await runLauncher(['--check'],h.dependencies);
  assert.equal(output.status,'unknown');assert.equal(output.messageSent,false);assert.equal(output.channel,'unconfirmed');
  assert.equal(h.operations.some(o=>o.type==='launch'||o.type==='port'||o.method==='POST'),false);
  assert.equal(JSON.stringify(output).includes(testPeer.token),false);
 }
});

test('dry-run combined with check performs no subprocess or network operations',async t=>{
 const h=await fixture(t);
 const {output}=await runLauncher(['--check','--dry-run'],h.dependencies);
 assert.equal(output.status,'dry-run');assert.equal(h.operations.length,0);
 assert.equal(output.command.includes('<mcp-config json>'),true);
 assert.equal(JSON.stringify(output).includes(testPeer.token),false);
});

test('launcher uses shared private-file, duplicate-ID and loopback validation before any operation',async t=>{
 for(const failure of ['permissions','symlink','duplicate','remote','invalid-json']){
  const h=await fixture(t);
  if(failure==='permissions')await chmod(h.path,0o644);
  if(failure==='symlink'){
   const link=join(h.root,'link.json');await symlink(h.path,link);h.dependencies.env.BRIDGE_CHANNEL_PEERS_FILE=link;
  }
  if(failure==='duplicate')await writeFile(h.path,JSON.stringify([testPeer,{...testPeer,sessionId:'other'}]));
  if(failure==='remote')await writeFile(h.path,JSON.stringify([{...testPeer,url:'https://example.test:8790'}]));
  if(failure==='invalid-json')await writeFile(h.path,'not json '+testPeer.token);
  const {output}=await runLauncher(['--check'],h.dependencies);
  assert.equal(output.status,'failed');assert.equal(h.operations.length,0);
  assert.equal(JSON.stringify(output).includes(testPeer.token),false);
 }
});

test('one startup probe timeout preserves the live session and never stops, removes or retries',async t=>{
 const h=await fixture(t);h.probeError=true;
 const {output}=await runLauncher([],h.dependencies);
 assert.equal(output.status,'unknown');assert.equal(output.channel,'unconfirmed');
 assert.equal(output.sessionId,h.session.sessionId);assert.match(output.note,/not stopped or removed/);
 assert.equal(h.operations.filter(o=>o.type==='launch').length,1);
 assert.equal(h.operations.filter(o=>o.method==='POST').length,1);
 assert.ok(h.operations.filter(o=>o.type==='cli').every(o=>o.args[0]==='agents'));
 assert.equal(JSON.stringify(output).includes(testPeer.token),false);
});

test('startup cannot probe a receiver with the wrong configured identity',async t=>{
 const h=await fixture(t);h.identitySessionId='different-channel';
 const {output}=await runLauncher([],h.dependencies);
 assert.equal(output.status,'unknown');assert.equal(output.receiverIdentified,false);
 assert.equal(h.operations.filter(o=>o.type==='launch').length,1);
 assert.equal(h.operations.filter(o=>o.method==='POST').length,0);
 assert.ok(h.operations.filter(o=>o.type==='cli').every(o=>o.args[0]==='agents'));
});

test('startup requires matching probe session, message ID and exact PONG before reporting success',async t=>{
 for(const probeResult of [
  {sessionId:'different',messageId:'id',status:'replied',reply:'PONG'},
  {sessionId:testPeer.sessionId,status:'replied',reply:'PONG'},
  {sessionId:testPeer.sessionId,messageId:'id',status:'replied',reply:'not PONG'},
  {sessionId:testPeer.sessionId,messageId:'id',status:'unknown'}]){
  const h=await fixture(t);h.probeResult=probeResult;
  const {output}=await runLauncher([],h.dependencies);
  assert.equal(output.status,'unknown');assert.equal(output.channel,'unconfirmed');
  assert.equal(h.operations.filter(o=>o.method==='POST').length,1);
  assert.equal(h.operations.filter(o=>o.type==='launch').length,1);
 }
 const h=await fixture(t);
 const {output}=await runLauncher([],h.dependencies);
 assert.equal(output.status,'started');assert.equal(output.probeReply,'PONG');assert.equal(output.channel,'registered');
 assert.equal(h.operations.filter(o=>o.method==='POST').length,1);
});

test('known relay and invalid options cannot cause a replacement launch',async t=>{
 const h=await fixture(t);h.sessions=[h.session];
 assert.equal((await runLauncher([],h.dependencies)).output.status,'failed');
 assert.equal(h.operations.some(o=>o.type==='launch'||o.method==='POST'),false);
 for(const args of [['--checkk'],['--peer'],['--peer','--check']]){
  const invalid=await fixture(t);
  assert.equal((await runLauncher(args,invalid.dependencies)).output.status,'failed');assert.equal(invalid.operations.length,0);
 }
});
