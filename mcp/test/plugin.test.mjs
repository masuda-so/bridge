import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {mkdtemp,cp,rm,mkdir,writeFile,readFile} from 'node:fs/promises';
import {createServer as createNetServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

test('installed bundle exposes tools without node_modules and rejects unsupported delivery', async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bridge-plugin-'));
 await cp('dist',join(dir,'dist'),{recursive:true});
 const client=new Client({name:'bridge-test',version:'1.0.0'});
 const transport=new StdioClientTransport({command:process.execPath,args:[join(dir,'dist/server.mjs')],cwd:tmpdir(),stderr:'inherit'});
 try {
  await client.connect(transport);
  const {tools}=await client.listTools();
  assert.deepEqual(tools.map(t=>t.name).sort(),['bridge_bind','bridge_capabilities','bridge_claude_discover','bridge_claude_reply','bridge_claude_send','bridge_claude_sessions','bridge_claude_submit','bridge_claude_wait','bridge_codex_discover','bridge_codex_receive','bridge_codex_reply','bridge_codex_report','bridge_codex_submit','bridge_codex_wait','bridge_continue','bridge_discover','bridge_list','bridge_read','bridge_send']);
  assert.ok(tools.find(t=>t.name==='bridge_send').inputSchema.required.includes('body'));
  const result=await client.callTool({name:'bridge_send',arguments:{to:'claude',cwd:tmpdir(),threadId:'example',body:'A/B・123\n二行目'}});
  assert.equal(result.isError,true);assert.match(result.content[0].text,/未対応/);
  const capabilities=await client.callTool({name:'bridge_capabilities',arguments:{}});
  assert.match(JSON.parse(capabilities.content[0].text).claude.externalDesktopDelivery,/^relay_via_channel_session/);
  assert.ok(tools.find(t=>t.name==='bridge_claude_send').inputSchema.properties.forwardTo);
  const invalid=await client.callTool({name:'bridge_read',arguments:{cwd:'relative',threadId:'example'}});
  assert.equal(invalid.isError,true);
 } finally {await client.close();await rm(dir,{recursive:true,force:true});}
});

test('packaged relay starts from its shared private file without exported credentials',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bridge-relay-startup-'));
 const reserve=createNetServer();
 await new Promise((resolve,reject)=>{reserve.once('error',reject);reserve.listen(0,'127.0.0.1',resolve);});
 const port=reserve.address().port;
 await new Promise(resolve=>reserve.close(resolve));
 const token='private-startup-fixture-'.repeat(3);
 const configDir=join(dir,'.config','bridge');
 await mkdir(configDir,{recursive:true});
 await writeFile(join(configDir,'peers.json'),JSON.stringify([{id:'relay-1',sessionId:'file-relay',
  url:`http://127.0.0.1:${port}`,token}]),{mode:0o600});
 await cp('dist',join(dir,'dist'),{recursive:true});
 const relay=JSON.parse(await readFile('relay/mcp.relay.json','utf8')).mcpServers.bridge;
 const client=new Client({name:'relay-startup-test',version:'1'});
 const transport=new StdioClientTransport({command:process.execPath,args:[join(dir,'dist/server.mjs')],cwd:dir,
  env:{HOME:dir,...relay.env,BRIDGE_CHANNEL_TOKEN:'${BRIDGE_CHANNEL_TOKEN}'},stderr:'pipe'});
 let stderr='',timer;
 try{
  const connected=client.connect(transport);
  const listening=new Promise((resolve,reject)=>{
   timer=setTimeout(()=>reject(Error('Relay did not open its receiver')),5000);
   transport.stderr.on('data',chunk=>{stderr+=String(chunk);if(stderr.includes(`127.0.0.1:${port}`))resolve();});
  });
  await Promise.all([connected,listening]);
  assert.deepEqual(client.getServerCapabilities().experimental,{'claude/channel':{}});
  assert.ok((await client.listTools()).tools.some(t=>t.name==='bridge_channel_reply'));
  const capabilities=JSON.parse((await client.callTool({name:'bridge_capabilities',arguments:{}})).content[0].text);
  assert.equal(capabilities.buildRevision,'2026-09-11-codex-inbox-1');
  const url=`http://127.0.0.1:${port}/identity`;
  assert.equal((await fetch(url)).status,403);
  const identity=await (await fetch(url,{headers:{Authorization:`Bearer ${token}`}})).json();
  assert.equal(identity.sessionId,'file-relay');
  assert.ok(!stderr.includes(token),'startup diagnostics must not disclose credentials');
 }finally{clearTimeout(timer);await client.close();await rm(dir,{recursive:true,force:true});}
});
