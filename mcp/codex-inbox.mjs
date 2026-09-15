// A one-shot inbox for an already waiting Codex host agent. This module never
// starts a model, sends a host message, resumes a task, or claims UI delivery.
import {createServer} from 'node:http';
import {randomUUID, timingSafeEqual} from 'node:crypto';
import {isAbsolute} from 'node:path';

const MAX_BYTES=128*1024, RETAIN_MS=5*60*1000;
const failure=(message,code='invalid')=>Object.assign(Error(message),{code});
const record=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const keys=(value,allowed)=>record(value)&&Object.keys(value).every(k=>allowed.includes(k));
const identifier=value=>typeof value==='string'&&/^[A-Za-z0-9._-]{1,256}$/.test(value);
const text=value=>typeof value==='string'&&!!value.trim()&&Buffer.byteLength(value)<=MAX_BYTES;
const duration=(value,max)=>Number.isInteger(value)&&value>=1&&value<=max;
const copy=value=>({...value,...(value.target?{target:{...value.target}}:{})});

function validateTarget(target){
  if(!keys(target,['threadId','cwd','title'])||!identifier(target.threadId)
    ||typeof target.cwd!=='string'||!isAbsolute(target.cwd)||target.cwd.length>4096
    ||(target.title!==undefined&&(typeof target.title!=='string'||!target.title.trim()||target.title.length>1024)))
    throw failure('Invalid target');
  return {threadId:target.threadId,cwd:target.cwd,...(target.title!==undefined?{title:target.title}:{})};
}

export class CodexInbox {
  pending=new Map();
  completed=new Map();
  observerCount=0;
  receiver=undefined;
  closed=false;
  constructor({sessionId,maxPending=16}){
    if(!identifier(sessionId))throw failure('Invalid inbox session ID');
    if(!Number.isInteger(maxPending)||maxPending<1||maxPending>16)throw failure('Invalid inbox capacity');
    this.sessionId=sessionId;this.maxPending=maxPending;
  }
  get ready(){return !this.closed&&!!this.receiver&&this.receiver.expiresAt>Date.now()&&this.pending.size===0;}
  identity(){return {sessionId:this.sessionId,protocol:'bridge-codex-inbox-v1',ready:this.ready,asyncReplies:true,uiVerified:false};}
  // Only this live call advertises readiness. There is no queued request and
  // at most one receive call; returning a claimed item never re-enqueues it.
  async receive(input={}, {signal}={}){
    if(!keys(input,['timeoutMs']))throw failure('Invalid receive request');
    const {timeoutMs=600000}=input;
    if(!duration(timeoutMs,3600000))throw failure('Invalid receive timeout');
    if(this.closed)throw failure('Inbox closed','closed');
    this.expireActive();
    if(this.receiver||this.pending.size)throw failure('Inbox is already waiting or processing a request','unavailable');
    if(signal?.aborted)throw failure('Receive cancelled','cancelled');
    return new Promise((resolve,reject)=>{
      let done=false,timer;
      const cleanup=()=>{
        clearTimeout(timer);signal?.removeEventListener('abort',aborted);
        if(this.receiver===receiver)this.receiver=undefined;
      };
      const receiver={expiresAt:Date.now()+timeoutMs,finish:value=>{if(done)return;done=true;cleanup();resolve(copy(value));},
        cancel:()=>{if(done)return;done=true;cleanup();reject(failure('Receive cancelled','cancelled'));}};
      const aborted=()=>receiver.cancel();
      this.receiver=receiver;
      signal?.addEventListener('abort',aborted,{once:true});
      timer=setTimeout(()=>receiver.finish({status:'idle',sessionId:this.sessionId,uiVerified:false}),timeoutMs);
    });
  }
  submit(input,{receiver=this.receiver}={}){
    if(!keys(input,['sessionId','body','target','timeoutMs']))throw failure('Invalid submission');
    const {sessionId,body,timeoutMs=1800000}=input;
    if(sessionId!==this.sessionId)throw failure('Destination mismatch');
    if(!text(body))throw failure('Message must be nonempty text within the size limit');
    if(!duration(timeoutMs,3600000))throw failure('Invalid reply deadline');
    const target=validateTarget(input.target);
    if(!this.ready||receiver!==this.receiver)
      throw failure('Receiver is not waiting. No submission accepted.','unavailable');
    const messageId=randomUUID(),expiresAt=Date.now()+timeoutMs;
    const base={sessionId,messageId,target,uiVerified:false};
    const p={base,expiresAt,observers:new Set()};
    p.timer=setTimeout(()=>this.expire(messageId,p),timeoutMs);
    this.pending.set(messageId,p);
    // No await between the readiness check, pending insertion and claim.
    receiver.finish({status:'received',...base,body,expiresAt});
    return copy({status:'accepted',...base,final:false,
      note:'Accepted by the waiting relay only; target delivery and reply are not confirmed. Observe this messageId; do not resubmit.'});
  }
  expire(messageId,p){
    const delivery=p.delivery!==undefined?{delivery:p.delivery,deliveryStatus:p.deliveryStatus}:{};
    this.settle(messageId,p,{status:p.deliveryStatus??'unknown',...p.base,...delivery,
      note:'The reply deadline expired. No target reply is confirmed. Do not resend.'});
  }
  expireActive(){
    for(const [id,p] of this.pending)if(p.expiresAt<=Date.now())this.expire(id,p);
  }
  async wait(input,{signal}={}){
    if(!keys(input,['sessionId','messageId','timeoutMs']))throw failure('Invalid observation');
    const {sessionId,messageId,timeoutMs=1000}=input;
    if(sessionId!==this.sessionId)throw failure('Destination mismatch');
    if(!identifier(messageId)||!duration(timeoutMs,60000))throw failure('Invalid observation');
    this.expireActive();this.pruneCompleted();
    const completed=this.completed.get(messageId);
    if(completed)return copy(completed.result);
    const p=this.pending.get(messageId);
    if(!p)return {status:'unknown',sessionId,messageId,final:true,uiVerified:false,
      error:'Unknown or expired message ID. Do not resend.'};
    if(this.observerCount>=this.maxPending)throw failure('Too many observers; observe the same messageId later without resubmitting','unavailable');
    if(signal?.aborted)throw failure('Observation cancelled','cancelled');
    return new Promise((resolve,reject)=>{
      let done=false,timer;
      const cleanup=()=>{
        clearTimeout(timer);p.observers.delete(observer);this.observerCount--;
        signal?.removeEventListener('abort',aborted);
      };
      const observer=value=>{if(done)return;done=true;cleanup();resolve(copy(value));};
      const aborted=()=>{if(done)return;done=true;cleanup();reject(failure('Observation cancelled','cancelled'));};
      p.observers.add(observer);this.observerCount++;
      signal?.addEventListener('abort',aborted,{once:true});
      timer=setTimeout(()=>observer({status:'pending',...p.base,final:false,
        ...(p.delivery!==undefined?{delivery:p.delivery,deliveryStatus:p.deliveryStatus}:{}),
        note:'Keep observing this messageId; no reply is confirmed and no resubmission is needed.'}),timeoutMs);
    });
  }
  // The host relay can report its native send result, but cannot present its
  // own text as a target answer. Replies use the independently authenticated
  // HTTP endpoint. The shared token authenticates a client, not a task identity.
  report(input){
    if(!keys(input,['messageId','outcome','body']))throw failure('Invalid delivery report');
    const {messageId,outcome,body}=input;
    if(!identifier(messageId)||!text(body)||!['delivered','queued','undeliverable'].includes(outcome))
      throw failure('Invalid delivery report');
    this.expireActive();this.pruneCompleted();
    const p=this.pending.get(messageId);
    if(!p){
      const completed=this.completed.get(messageId);
      if(completed?.result.status==='replied'&&completed.result.delivery===undefined&&['delivered','queued'].includes(outcome)){
        completed.result={...completed.result,delivery:body,deliveryStatus:outcome};
        return {status:'replied',sessionId:this.sessionId,messageId,uiVerified:false,note:'The target already replied. Delivery report recorded; no further action is needed.'};
      }
      throw failure('Unknown, expired, or already reported message','not_found');
    }
    if(p.delivery!==undefined)throw failure('Delivery already reported','conflict');
    if(outcome==='undeliverable'){
      this.settle(messageId,p,{status:'failed',...p.base,error:body});
      return {status:'failed',sessionId:this.sessionId,messageId,uiVerified:false};
    }
    p.delivery=body;p.deliveryStatus=outcome;
    return {status:outcome,sessionId:this.sessionId,messageId,uiVerified:false,waiting:'reply from the target'};
  }
  answer(input){
    if(!keys(input,['sessionId','messageId','body']))throw failure('Invalid reply');
    const {sessionId,messageId,body}=input;
    if(sessionId!==this.sessionId)throw failure('Destination mismatch');
    if(!identifier(messageId)||!text(body))throw failure('Invalid reply');
    this.expireActive();
    const p=this.pending.get(messageId);
    if(!p)throw failure('Unknown, expired, or already answered message','not_found');
    this.settle(messageId,p,{status:'replied',...p.base,reply:body,
      ...(p.delivery!==undefined?{delivery:p.delivery,deliveryStatus:p.deliveryStatus}:{})});
    return {status:'replied',sessionId:this.sessionId,messageId,uiVerified:false};
  }
  pruneCompleted(){
    for(const [id,p] of this.completed)if(p.expiresAt<=Date.now()){
      clearTimeout(p.timer);this.completed.delete(id);
    }
  }
  settle(messageId,p,value){
    if(this.pending.get(messageId)!==p)return;
    this.pending.delete(messageId);clearTimeout(p.timer);
    const result={...value,final:true};
    this.pruneCompleted();
    while(this.completed.size>=this.maxPending){
      const id=this.completed.keys().next().value;
      clearTimeout(this.completed.get(id).timer);this.completed.delete(id);
    }
    const timer=setTimeout(()=>this.completed.delete(messageId),RETAIN_MS);timer.unref?.();
    this.completed.set(messageId,{result,expiresAt:Date.now()+RETAIN_MS,timer});
    for(const observer of [...p.observers])observer(result);
  }
  close(){
    this.closed=true;
    this.receiver?.finish({status:'closed',sessionId:this.sessionId,uiVerified:false});
    for(const [id,p] of this.pending)this.settle(id,p,{status:'unknown',...p.base,
      ...(p.delivery!==undefined?{delivery:p.delivery,deliveryStatus:p.deliveryStatus}:{}),
      error:'Inbox closed. Do not resend.'});
    for(const p of this.completed.values())clearTimeout(p.timer);
    this.completed.clear();
  }
}

export async function listenCodexInbox(inbox,{token,port=0}){
  if(typeof token!=='string'||Buffer.byteLength(token)<32||Buffer.byteLength(token)>4096)
    throw failure('Inbox token must contain between 32 and 4096 bytes');
  if(!Number.isInteger(port)||port<0||port>65535)throw failure('Invalid inbox port');
  const expected=Buffer.from('Bearer '+token);
  const server=createServer(async(req,res)=>{
    const respond=(status,value)=>{
      if(res.destroyed||res.writableEnded)return;
      res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));
    };
    const reject=(status,message)=>respond(status,{status:'failed',error:message,uiVerified:false});
    const supplied=Buffer.from(typeof req.headers.authorization==='string'?req.headers.authorization:'');
    if(req.headers.origin!==undefined||supplied.length!==expected.length||!timingSafeEqual(supplied,expected)){
      reject(403,'Forbidden');req.resume();return;
    }
    if(req.method==='GET'&&req.url==='/identity'){respond(200,inbox.identity());return;}
    if(req.method==='GET'&&req.url?.startsWith('/messages/')){
      const observation=new AbortController(),closed=()=>observation.abort();
      res.once('close',closed);
      try{
        const match=/^\/messages\/([A-Za-z0-9._-]{1,256})(?:\?waitMs=([0-9]+))?$/.exec(req.url);
        if(!match)throw failure('Invalid observation');
        const result=await inbox.wait({sessionId:inbox.sessionId,messageId:match[1],
          ...(match[2]!==undefined?{timeoutMs:Number(match[2])}:{})},{signal:observation.signal});
        respond(200,result);
      }catch(error){reject(error.code==='unavailable'?503:400,'Observation unavailable; keep the same messageId and do not resubmit');}
      finally{res.removeListener('close',closed);}
      return;
    }
    if(req.method!=='POST'||!['/submissions','/replies'].includes(req.url)){
      reject(404,'Not found');req.resume();return;
    }
    if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type']??'')){
      reject(415,'Content-Type must be application/json');req.resume();return;
    }
    const unavailable=()=>respond(503,{status:'unavailable',sessionId:inbox.sessionId,final:true,uiVerified:false,
      error:'Receiver is not waiting. No submission accepted.'});
    const receiver=inbox.receiver;
    if(req.url==='/submissions'&&!inbox.ready){unavailable();req.resume();return;}
    try{
      const chunks=[];let size=0;
      for await(const chunk of req){
        size+=chunk.length;
        if(size>MAX_BYTES){reject(413,'Request exceeds size limit');req.resume();return;}
        chunks.push(chunk);
      }
      if(res.destroyed)return;
      const input=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
      if(req.url==='/submissions')respond(202,inbox.submit(input,{receiver}));
      else respond(200,inbox.answer(input));
    }catch(error){
      if(error.code==='unavailable'&&req.url==='/submissions')unavailable();
      else reject(error.code==='not_found'?404:400,'Request rejected');
    }
  });
  server.maxConnections=32;server.requestTimeout=30000;server.headersTimeout=10000;server.keepAliveTimeout=5000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  return {port:server.address().port,async close(){
    inbox.close();
    const closed=new Promise(resolve=>server.close(resolve));server.closeAllConnections();await closed;
  }};
}
