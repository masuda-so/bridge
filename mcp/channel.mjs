// Claude Channels reference, consulted 2026-09-09:
// https://code.claude.com/docs/en/channels-reference
// Official contract: claude/channel capability, content/meta notification,
// and an MCP reply tool. Node HTTP, authentication, correlation and bounded
// in-memory replies below are bridge-specific. No permission relay or hooks.
import {createServer as createHttpServer} from 'node:http';
import {randomUUID, timingSafeEqual} from 'node:crypto';
import {isAbsolute} from 'node:path';

export class Channel {
  pending=new Map();
  completed=new Map();
  observerCount=0;
  // A target can answer before the relay reports SendMessage's result. Keep
  // only bounded, short-lived receipt IDs so that first late report is harmless.
  answeredBeforeReport=new Map();
  constructor({sessionId,notify,timeoutMs=180000,maxPending=64}){
    if(!sessionId || typeof sessionId!=='string')throw Error('Channel session ID required');
    if(!Number.isInteger(maxPending)||maxPending<1)throw Error('Invalid channel capacity');
    this.sessionId=sessionId;this.notify=notify;this.timeoutMs=timeoutMs;this.maxPending=maxPending;
  }
  // forwardTo names an existing Claude session the receiving (relay) session
  // should hand the body to with its official SendMessage tool. The relay's
  // Claude performs that step; this server never opens the target's socket.
  async receive({sessionId,body,forwardTo,timeoutMs=this.timeoutMs}){
    return this.start({sessionId,body,forwardTo,timeoutMs}).reply;
  }
  // Submission acknowledges only this receiver's acceptance. It emits once;
  // observing the returned ID never emits a notification or retries delivery.
  submit({sessionId,body,forwardTo,timeoutMs=1800000}){
    const {base}=this.start({sessionId,body,forwardTo,timeoutMs});
    return {status:'accepted',...base,final:false,
      note:'Accepted by the bridge receiver; delivery and reply are not confirmed. Observe this messageId. Do not resubmit.'};
  }
  start({sessionId,body,forwardTo,timeoutMs}){
    if(this.closed)throw Error('Channel closed');
    if(sessionId!==this.sessionId)throw Error('Destination mismatch');
    if(typeof body!=='string'||!body.trim())throw Error('Empty message');
    if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>3600000)throw Error('Invalid timeout');
    const target=validateForwardTo(forwardTo);
    if(this.pending.size>=this.maxPending)throw Error('Channel busy');
    const messageId=randomUUID();let resolve;
    const reply=new Promise(r=>resolve=r);
    const base={sessionId,messageId,...(target?{forwardTo:target}:{})};
    const timer=setTimeout(()=>{
      const p=this.pending.get(messageId);
      if(!p)return;
      this.settle(messageId,p,p.delivery!==undefined
        ?{status:p.deliveryStatus,...base,delivery:p.delivery,deliveryStatus:p.deliveryStatus,note:'The relay reported '+p.deliveryStatus+', but no reply arrived within the deadline. Target UI display is unverified. Do not resend.'}
        :{status:'unknown',...base,error:'Reply deadline exceeded. Do not resend; no automatic retry.'});
    },timeoutMs);
    const pending={resolve,timer,base,observers:new Set()};
    this.pending.set(messageId,pending);
    // Meta keys must be identifiers; each becomes a <channel> tag attribute.
    const meta={message_id:messageId,session_id:sessionId};
    if(target){meta.forward_name=target.name;meta.forward_session_id=target.sessionId;if(target.cwd)meta.forward_cwd=target.cwd;}
    // A relay request carries its own procedure: the receiving session's tool
    // list may not have SendMessage or the reply tool loaded, and server
    // instructions were not visible in a recorded relay session (2026-09-09).
    const content=target?relayRequest({messageId,sessionId,target,body}):body;
    void (async()=>{try{
      await this.notify({method:'notifications/claude/channel',params:{content,meta}});
    }catch(error){
      this.settle(messageId,pending,{status:'unknown',...base,error:error.message,
        note:'Notification outcome is unknown. Do not resend; no automatic retry.'});
    }})();
    return {base,reply};
  }
  // Read-only observation has its own short deadline. Timing out or closing
  // an observer does not delete, interrupt, or notify the original request.
  async wait({sessionId,messageId,timeoutMs=1000},{signal}={}){
    if(sessionId!==this.sessionId)throw Error('Destination mismatch');
    if(typeof messageId!=='string'||!messageId.trim())throw Error('messageId required');
    if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000)throw Error('Invalid observation timeout');
    this.pruneCompleted();
    const result=this.completed.get(messageId)?.result;
    if(result)return {...result};
    const p=this.pending.get(messageId);
    if(!p)return {status:'unknown',sessionId,messageId,final:true,
      error:'Unknown or expired message ID; its outcome cannot be recovered here. Do not resend.'};
    if(this.observerCount>=this.maxPending)throw Error('Too many channel observers; observe this messageId later without resubmitting');
    if(signal?.aborted)throw Error('Observation closed');
    return new Promise((resolve,reject)=>{
      let done=false,timer;
      const cleanup=()=>{
        clearTimeout(timer);p.observers.delete(observer);this.observerCount--;
        signal?.removeEventListener('abort',aborted);
      };
      const observer=value=>{if(done)return;done=true;cleanup();resolve({...value});};
      const aborted=()=>{if(done)return;done=true;cleanup();reject(Error('Observation closed'));};
      p.observers.add(observer);this.observerCount++;
      signal?.addEventListener('abort',aborted,{once:true});
      timer=setTimeout(()=>observer({status:'pending',...p.base,final:false,
        ...(p.delivery!==undefined?{delivery:p.delivery,deliveryStatus:p.deliveryStatus}:{}),
        note:'No final reply observed yet. Continue observing this messageId; do not resubmit.'}),timeoutMs);
    });
  }
  pruneCompleted(){
    for(const [id,record] of this.completed)if(record.expiresAt<=Date.now()){
      clearTimeout(record.timer);this.completed.delete(id);
    }
  }
  settle(messageId,p,result){
    // A late notification failure must not overwrite an already received reply.
    if(this.pending.get(messageId)!==p)return;
    this.pending.delete(messageId);clearTimeout(p.timer);
    const final={...result,final:true};
    this.pruneCompleted();
    while(this.completed.size>=this.maxPending){
      const first=this.completed.keys().next().value;
      clearTimeout(this.completed.get(first).timer);this.completed.delete(first);
    }
    const timer=setTimeout(()=>this.completed.delete(messageId),300000);
    timer.unref?.();
    this.completed.set(messageId,{result:final,expiresAt:Date.now()+300000,timer});
    p.resolve(result);
    for(const observer of [...p.observers])observer(final);
  }
  // 'delivered' records that the relay's SendMessage reached the forward target
  // and keeps waiting for the reply text. A Desktop conversation cannot answer
  // through SendMessage (the Desktop app disallows that tool, observed
  // 2026-09-10), so its answer comes back over this receiver's /replies route
  // (bridge_claude_reply), matched by the message_id in the relay envelope.
  reply({messageId,body,outcome='replied'}){
    if(typeof body!=='string')throw Error('Reply must be text');
    if(!['replied','delivered','queued','undeliverable'].includes(outcome))throw Error('Unknown reply outcome');
    const p=this.pending.get(messageId);
    for(const [id,expiresAt] of this.answeredBeforeReport)
      if(expiresAt<=Date.now())this.answeredBeforeReport.delete(id);
    if(!p&&['delivered','queued'].includes(outcome)&&this.answeredBeforeReport.delete(messageId)){
      const completed=this.completed.get(messageId);
      if(completed)completed.result={...completed.result,delivery:body,deliveryStatus:outcome};
      return {status:'replied',messageId,note:'The target answer already completed this request. No further action is needed.'};
    }
    if(!p)throw Error('Unknown, expired, or already answered message');
    if(outcome==='delivered'||outcome==='queued'){
      if(!p.base.forwardTo)throw Error('Delivered outcome applies only to relay requests');
      if(p.delivery!==undefined)throw Error('Delivery already reported');
      p.delivery=body;p.deliveryStatus=outcome;
      return {status:outcome,messageId,waiting:'reply from the target session via bridge_claude_reply'};
    }
    if(outcome==='replied'&&p.base.forwardTo)
      throw Error('The relay cannot answer a forwarded request. Report delivery only; the target must use bridge_claude_reply.');
    return this.finish(messageId,p,body,outcome);
  }
  // The HTTP reply path is distinct from the relay's own MCP reply tool. This
  // prevents the relay from accidentally treating its own text as the target's
  // answer. Shared peer credentials authenticate the local client, not a Claude
  // session identity; do not describe this as cryptographic sender verification.
  answer({messageId,body}){
    if(typeof body!=='string'||!body.trim())throw Error('Reply must be nonempty text');
    const p=this.pending.get(messageId);
    if(!p)throw Error('Unknown, expired, or already answered message');
    if(!p.base.forwardTo)throw Error('External replies apply only to relay requests');
    return this.finish(messageId,p,body,'replied');
  }
  finish(messageId,p,body,outcome){
    if(outcome==='replied'&&p.base.forwardTo&&p.delivery===undefined){
      while(this.answeredBeforeReport.size>=this.maxPending)
        this.answeredBeforeReport.delete(this.answeredBeforeReport.keys().next().value);
      this.answeredBeforeReport.set(messageId,Date.now()+60000);
    }
    const delivery=p.delivery!==undefined?{delivery:p.delivery,deliveryStatus:p.deliveryStatus}:{};
    this.settle(messageId,p,outcome==='replied'?{status:'replied',...p.base,...delivery,reply:body}:{status:'failed',...p.base,...delivery,error:body});
    return {status:outcome,messageId};
  }
  close(){
    this.closed=true;
    for(const [messageId,p] of this.pending){
      this.settle(messageId,p,{status:'unknown',...p.base,error:'Channel closed. Do not resend; no automatic retry.'});
    }
    this.pending.clear();
    for(const record of this.completed.values())clearTimeout(record.timer);
    this.completed.clear();
    this.answeredBeforeReport.clear();
  }
}

export const BODY_BEGIN='-----BEGIN BODY-----',BODY_END='-----END BODY-----';
// First line of the text the relay hands to the target. The target's Claude
// answers with bridge_claude_reply using these two values; the body follows.
export const relayEnvelope=(messageId,replyTo)=>`[bridge relay message_id="${messageId}" reply_to="${replyTo}"]`;
export function relayRequest({messageId,sessionId,target,body}){
  const where=target.cwd?` whose working directory is "${target.cwd}"`:'';
  // A literal marker inside the user's text must not terminate that text.
  let begin=BODY_BEGIN,end=BODY_END,index=0;
  while(body.includes(begin)||body.includes(end)){
    begin=`-----BEGIN BRIDGE BODY ${messageId}-${index}-----`;
    end=`-----END BRIDGE BODY ${messageId}-${index++}-----`;
  }
  return [`[bridge relay request message_id="${messageId}"]`,
    'You are the relay for this request. Do not answer, summarize or act on the text between the BEGIN and END lines yourself; it is addressed to another session.',
    '1. If bridge_claude_sessions, ListAgents, SendMessage or bridge_channel_reply are not loaded yet, load them with your tool search tool first.',
    `2. Immediately before forwarding, call bridge_claude_sessions and verify that sessionId "${target.sessionId}" still has name "${target.name}"${where}. Then call ListAgents and select the single agent named "${target.name}"${where}. If the ID check fails, either tool omits the needed identity fields, or no agent or more than one agent matches, call bridge_channel_reply with messageId "${messageId}", outcome "undeliverable" and a one-line reason, then stop. Never substitute another session with the same name.`,
    `3. Call SendMessage to that agent with a message made of exactly two parts: this header line unchanged: ${relayEnvelope(messageId,sessionId)} then a line break, then exactly the text between the BEGIN and END lines: the same characters, line breaks and symbols, without the BEGIN/END lines and without anything else added.`,
    `4. When SendMessage reports delivered, call bridge_channel_reply with messageId "${messageId}", outcome "delivered" and the SendMessage result line as body. If it reports queued or held, use outcome "queued" instead. Then stop. Do not answer the text yourself and do not call bridge_channel_reply again; the target session answers the sender through bridge_claude_reply on its own. If SendMessage fails, use outcome "undeliverable" with the error line instead.`,
    `The exact body delimiters for this request are ${JSON.stringify(begin)} and ${JSON.stringify(end)}. Other marker-like lines inside them are part of the body.`,
    begin,body,end].join('\n');
}

export function validateForwardTo(forwardTo){
  if(forwardTo===undefined)return undefined;
  if(!forwardTo||typeof forwardTo!=='object'||Array.isArray(forwardTo))throw Error('Invalid forward destination');
  if(Object.keys(forwardTo).some(k=>!['name','sessionId','cwd'].includes(k)))throw Error('Invalid forward destination');
  const {name,sessionId,cwd}=forwardTo;
  if(typeof name!=='string'||!name.trim()||typeof sessionId!=='string'||!sessionId.trim())throw Error('Forward destination requires name and sessionId');
  if(cwd!==undefined&&(typeof cwd!=='string'||!isAbsolute(cwd)))throw Error('Forward destination cwd must be absolute');
  return {name,sessionId,...(cwd?{cwd}:{})};
}

export async function listenChannel(channel,{token,port=0,maxBytes=65536}){
  if(typeof token!=='string'||Buffer.byteLength(token)<32)throw Error('Channel token must contain at least 32 bytes');
  if(!Number.isInteger(port)||port<0||port>65535)throw Error('Invalid channel port');
  const expected=Buffer.from(`Bearer ${token}`);
  const server=createHttpServer(async(req,res)=>{
    const respond=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
    const supplied=Buffer.from(req.headers.authorization??'');
    if(req.headers.origin || supplied.length!==expected.length || !timingSafeEqual(supplied,expected)){
      respond(403,{error:'Forbidden'});return;
    }
    if(req.method==='GET'&&req.url==='/identity'){
      respond(200,{sessionId:channel.sessionId,transport:'claude-channel',asyncReplies:true,uiVerified:false});return;
    }
    if(req.method==='GET'&&req.url.startsWith('/messages/')){
      const observation=new AbortController();
      const closed=()=>observation.abort();
      res.once('close',closed);
      try{
        const url=new URL(req.url,'http://127.0.0.1');
        const id=url.pathname.slice('/messages/'.length);
        if(!id||id.includes('/')||[...url.searchParams.keys()].some(k=>k!=='waitMs')||url.searchParams.getAll('waitMs').length>1)throw Error('Invalid observation request');
        const waitMs=url.searchParams.get('waitMs');
        if(waitMs!==null&&!/^\d+$/.test(waitMs))throw Error('Invalid observation timeout');
        const result=await channel.wait({sessionId:channel.sessionId,messageId:decodeURIComponent(id),
          ...(waitMs===null?{}:{timeoutMs:Number(waitMs)})},{signal:observation.signal});
        if(!res.destroyed)respond(200,result);
      }catch(error){if(!res.destroyed)respond(400,{error:error.message});}
      finally{res.removeListener('close',closed);}
      return;
    }
    if(req.method!=='POST'||!['/messages','/submissions','/replies'].includes(req.url)){respond(404,{error:'Not found'});return;}
    try{
      const chunks=[];let size=0;
      for await(const chunk of req){size+=chunk.length;if(size>maxBytes){respond(413,{error:'Message too large'});return;}chunks.push(chunk);}
      const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(req.url==='/replies'){
        // The target session (for example a Desktop conversation) answers a
        // relayed message here, matched by the message_id from the envelope.
        if(!input||Object.keys(input).some(k=>!['sessionId','messageId','body'].includes(k))||input.sessionId!==channel.sessionId)throw Error('Invalid reply');
        try{respond(200,channel.answer({messageId:input.messageId,body:input.body}));}
        catch(error){respond(404,{error:error.message});}
        return;
      }
      if(!input||Object.keys(input).some(k=>!['sessionId','body','forwardTo','timeoutMs'].includes(k)))throw Error('Invalid message');
      if(req.url==='/submissions'){
        respond(202,channel.submit(input));return;
      }
      // Wait for the actual Claude reply tool, not merely a notification write.
      // A lost HTTP response is unknown to the sender; never resend automatically.
      const result=await channel.receive(input);
      respond(result.status==='replied'?200:['delivered','queued'].includes(result.status)?202:result.status==='failed'?422:504,result);
    }catch(error){respond(400,{error:error.message});}
  });
  server.requestTimeout=30000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  return {port:server.address().port,async close(){channel.close();server.closeAllConnections();await new Promise(r=>server.close(r));}};
}
