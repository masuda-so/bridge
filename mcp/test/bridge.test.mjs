import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,chmod,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {execute} from '../bridge.mjs';
import {SpawnedCodexAppServerClient} from '../vendor/app-server.mjs';

class Fake {
  calls=[];closed=false;
  constructor(mode='ok'){this.mode=mode;this.exitPromise=new Promise(r=>this.exit=r);}
  setNotificationHandler(fn){this.handler=fn;}
  async initialize(){}
  async close(){this.closed=true;this.exit();}
  item(threadId,turnId,text,id='answer'){this.handler({method:'item/completed',params:{threadId,turnId,item:{id,type:'agentMessage',text}}});}
  done(id='turn',status='completed'){this.handler({method:'turn/completed',params:{threadId:'target',turn:{id,status}}});}
  async request(method,params){
    this.calls.push({method,params});
    if(method==='thread/read') return {thread:{id:this.mode==='wrong'?'other':'target',turns:this.mode==='active'?[{status:'inProgress'}]:[]}};
    if(method==='thread/resume') {
      if(this.mode==='writer') throw Error('thread target already has an active writer');
      if(this.mode==='archived') throw Error('session is archived');
      return {thread:{id:'target'}};
    }
    if(method==='turn/start') {
      if(this.mode==='rpc'){const e=Error('rejected');e.rpcCode=-32000;throw e;}
      if(this.mode==='disconnect'){this.exit();return new Promise(()=>{});}
      if(this.mode==='timeout') return new Promise(()=>{});
      this.item('other','turn','WRONG');this.item('target','other','WRONG');this.done('other');
      this.item('target','turn','A/B・123\n日本語');
      this.item('target','turn','A/B・123\n日本語');
      this.done('turn',this.mode==='failed'?'failed':'completed');
      return {turn:{id:'turn'}};
    }
    if(method==='thread/list') return params.cursor?{data:[{id:'two'}]}:{data:[{id:'one'}],nextCursor:'next'};
  }
}
const options={command:'send',threadId:'target',cwd:tmpdir(),timeoutMs:100};
const body=' R2\nClaude Code → Codex\n改行と記号「A/B・123」を保持。\n';

test('preserves body, matches thread/turn even before response, deduplicates items',async()=>{
 const client=new Fake();
 const result=await execute(options,{body,clientFactory:()=>client});
 assert.equal(result.reply,'A/B・123\n日本語');assert.equal(result.turnId,'turn');
 assert.deepEqual(client.calls.map(c=>c.method),['thread/read','thread/resume','turn/start']);
 assert.equal(client.calls[2].params.input[0].text,body);assert.equal(client.closed,true);
});
for(const mode of ['wrong','active','writer','archived','rpc','disconnect','timeout','failed']) {
 test(`handles ${mode} without retry and closes`,async()=>{
  const client=new Fake(mode);
  await assert.rejects(execute({...options,timeoutMs:20},{body,clientFactory:()=>client}),e=>{
   assert.equal(e.delivery,['disconnect','timeout'].includes(mode)?'unknown':'failed');return true;
  });
  assert.equal(client.closed,true);
  if(mode==='writer') assert.ok(!client.calls.some(c=>c.method==='turn/start'));
  assert.ok(client.calls.filter(c=>c.method==='turn/start').length<=1);
  assert.ok(!client.calls.some(c=>['thread/start','thread/unarchive'].includes(c.method)));
 });
}
test('read does not resume; list paginates and filters cwd',async()=>{
 const c=new Fake();await execute({...options,command:'read'},{clientFactory:()=>c});
 assert.deepEqual(c.calls.map(c=>c.method),['thread/read']);
 const l=new Fake();const r=await execute({...options,command:'list'},{clientFactory:()=>l});
 assert.equal(r.threads.length,2);assert.equal(l.calls[0].params.cwd,tmpdir());
});
test('rejects empty body',async()=>{
 await assert.rejects(execute(options,{body:' \n'}),/empty/);
});

for(const stage of ['initialize','thread/read','thread/resume','thread/list']) {
 for(const end of ['timeout','disconnect']) test(`late ${stage} after ${end} cannot issue another RPC`,async()=>{
  const client=new Fake();let release,entered;
  const waiting=new Promise(r=>entered=r);
  const pause=()=>new Promise(r=>{release=r;entered();});
  const request=client.request.bind(client);
  if(stage==='initialize')client.initialize=pause;
  else client.request=async(method,params)=>{
   const result=await request(method,params);
   if(method===stage)await pause();
   return result;
  };
  const work=execute({...options,command:stage==='thread/list'?'list':'send',timeoutMs:30},{body,clientFactory:()=>client});
  const rejected=assert.rejects(work,e=>e.delivery==='failed');
  await waiting;
  if(end==='disconnect')client.exit();
  await rejected;
  const count=client.calls.length;
  release();await new Promise(r=>setImmediate(r));
  assert.equal(client.calls.length,count);
  assert.ok(!client.calls.some(c=>c.method==='turn/start'));
  assert.equal(client.closed,true);
 });
}

// Real JSONL transport with a local fixture process: no model or account access.
for(const mode of ['normal','bad-json','hang']) test(`process transport ${mode}`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bridge-test-'));
 const binary=join(dir,'codex');
 await writeFile(binary,`#!${process.execPath}\nimport readline from 'node:readline';
process.stderr.write('fixture diagnostic\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(!m.id)return;
 if(${JSON.stringify(mode)}==='bad-json'){process.stdout.write('invalid JSON\\n');return;}
 if(${JSON.stringify(mode)}==='hang')return;
 const thread={id:'target',turns:[]};
 let result=m.method==='initialize'?{}:{thread};
 process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');
});
`);
 await chmod(binary,0o755);
 let client;let diagnostics='';
 const clientFactory=cwd=>(client=new SpawnedCodexAppServerClient(cwd,{env:{...process.env,PATH:dir+':'+dirname(process.execPath)},onStderr:t=>diagnostics+=t}));
 try {
  const work=execute({...options,command:'read',timeoutMs:2000},{clientFactory});
  if(mode==='normal') assert.equal((await work).thread.id,'target');
  else await assert.rejects(work);
  assert.match(diagnostics,/fixture diagnostic/);
  assert.ok(client.proc.exitCode!==null || client.proc.signalCode);
 } finally {await rm(dir,{recursive:true,force:true});}
});
