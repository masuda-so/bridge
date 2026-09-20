// Product-specific delivery checks around the official Codex direct client.
import { SpawnedCodexAppServerClient } from "./vendor/app-server.mjs";

export async function execute(options, { body, clientFactory=(cwd) => new SpawnedCodexAppServerClient(cwd) }={}) {
  const {command,threadId,cwd,timeoutMs=180000}=options;
  if(command==='send' && (typeof body!=='string' || !body.trim())) throw Error('message body is empty');
  const client=clientFactory(cwd);
  let turnId=null, submitted=false, terminal=false, rpcRejected=false, stopped=false;
  // Promise.race does not cancel the losing operation. Guard every RPC boundary
  // so a late initialize/read/resume cannot submit after timeout or disconnect.
  const checkOpen=()=>{if(stopped)throw Error('delivery operation has ended');};
  let timer;
  const messages=new Map(), early=[];
  let resolveTurn, rejectTurn;
  const finished=new Promise((resolve,reject)=>{resolveTurn=resolve;rejectTurn=reject;});
  // A completion can arrive before the turn/start response; buffer until its ID is known.
  const consume=(message)=>{
    if(stopped)return;
    const p=message.params;
    if(!p || p.threadId!==threadId) return;
    if(!turnId) {early.push(message);return;}
    if(message.method==='item/completed' && p.turnId===turnId && p.item?.type==='agentMessage') {
      messages.set(p.item.id, p.item.text);
    }
    if(message.method==='turn/completed' && p.turn?.id===turnId) {
      terminal=true;
      if(p.turn.status!=='completed') rejectTurn(Error(`turn ${p.turn.status}: ${JSON.stringify(p.turn.error ?? null)}`));
      else resolveTurn({threadId,turnId,status:'completed',reply:[...messages.values()].join('\n')});
    }
  };
  client.setNotificationHandler(consume);
  // Attach handlers immediately, including when failure precedes awaiting finished.
  finished.catch(()=>{});
  const disconnected=client.exitPromise.then(()=>{stopped=true;throw client.exitError ?? Error('app-server disconnected');});
  const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{stopped=true;reject(Error('deadline exceeded'));},timeoutMs);});
  const operation=(async()=>{
    await client.initialize();
    checkOpen();
    if(command==='list') {
      const all=[];let cursor;
      do {checkOpen();const page=await client.request('thread/list',{...(options.allProjects?{}:{cwd}),limit:100,...(cursor?{cursor}:{})});checkOpen();all.push(...(page.data??[]));cursor=page.nextCursor;} while(cursor);
      return {status:'completed',threads:all};
    }
    const existing=await client.request('thread/read',{threadId,includeTurns:true});
    checkOpen();
    if(existing.thread?.id!==threadId) throw Error('thread/read returned a different thread');
    if(command==='read') return {status:'completed',thread:existing.thread};
    if(existing.thread.turns?.some(t=>t.status==='inProgress') || existing.thread.status?.type==='active') throw Error('target thread is active; send later');
    const resumed=await client.request('thread/resume',{threadId,cwd,approvalPolicy:'never',sandbox:'read-only'});
    checkOpen();
    if(resumed.thread?.id!==threadId) throw Error('thread/resume returned a different thread');
    submitted=true;
    let result;
    try {result=await client.request('turn/start',{threadId,input:[{type:'text',text:body,text_elements:[]}]});}
    catch(error){rpcRejected=error.rpcCode!==undefined;throw error;}
    turnId=result.turn?.id;
    if(!turnId) throw Error('turn/start returned no turn ID');
    for(const message of early) consume(message);
    early.length=0;
    return await finished;
  })();
  try {return await Promise.race([operation,disconnected,deadline]);}
  catch(error){
    error.delivery=submitted && !terminal && !rpcRejected ? 'unknown' : 'failed';
    error.threadId=threadId;error.turnId=turnId;
    if(!submitted && /already has an active writer/.test(error.message)) {
      error.code='host_owns_thread';
      error.action='The host already owns this task. No message was sent. Use host-native messaging when available; do not retry the direct transport automatically.';
    }
    throw error;
  } finally {stopped=true;clearTimeout(timer); await client.close();}
}
