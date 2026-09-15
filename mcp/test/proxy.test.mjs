import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,chmod,readFile,rm} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {execute} from '../bridge.mjs';
import {SpawnedCodexAppServerClient} from '../vendor/app-server.mjs';

test('proxy uses only the explicit socket via the official CLI and closes its client',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bridge-proxy-'));
 const socket=join(dir,'host.sock'),argsFile=join(dir,'args.json');
 const host=createServer();
 try{
  await new Promise((resolve,reject)=>{host.once('error',reject);host.listen(socket,resolve);});
  const binary=join(dir,'codex');
  await writeFile(binary,`#!${process.execPath}\nimport readline from 'node:readline';
import {writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(argsFile)},JSON.stringify(process.argv.slice(2)));
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(!m.id)return;
 process.stdout.write(JSON.stringify({id:m.id,result:m.method==='initialize'?{}:{thread:{id:'target'}}})+'\\n');
});\n`);
  await chmod(binary,0o755);
  const client=new SpawnedCodexAppServerClient(dir,{env:{...process.env,
   PATH:dir+':'+dirname(process.execPath),BRIDGE_CODEX_PROXY_SOCKET:socket}});
  const result=await execute({command:'read',threadId:'target',cwd:dir,timeoutMs:2000},{clientFactory:()=>client});
  assert.equal(result.thread.id,'target');
  assert.deepEqual(JSON.parse(await readFile(argsFile,'utf8')),['app-server','proxy','--sock',socket]);
  assert.ok(client.proc.exitCode!==null || client.proc.signalCode);
 }finally{await new Promise(r=>host.close(r));await rm(dir,{recursive:true,force:true});}
});

test('invalid proxy target never spawns or falls back',async()=>{
 for(const proxySocket of ['relative',tmpdir(),join(tmpdir(),'bridge-missing-proxy.sock')]){
  const client=new SpawnedCodexAppServerClient(tmpdir(),{proxySocket});
  await assert.rejects(execute({command:'read',threadId:'target',cwd:tmpdir(),timeoutMs:200},{clientFactory:()=>client}));
  assert.equal(client.proc,undefined);assert.equal(client.closed,true);
 }
});
