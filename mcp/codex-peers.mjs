// Clients for a Codex conversation that explicitly waits through the bridge
// MCP inbox. HTTP acceptance is not native task delivery or a model answer.
import {isAbsolute} from 'node:path';
import {loadChannelPeers,validateChannelPeers} from './channel-peers.mjs';

export const CODEX_INBOX_PROTOCOL='bridge-codex-inbox-v1';
const noRetry='Do not automatically resend.';
const identifier=value=>typeof value==='string'&&/^[A-Za-z0-9._-]{1,256}$/.test(value);

export async function loadCodexPeers(path){
  let peers;
  try{peers=await loadChannelPeers(path);}
  catch{throw Error('Codex peers configuration could not be loaded or validated. Use a private owner-only file with unique IDs and loopback origins.');}
  return peers.filter(p=>p.protocol===CODEX_INBOX_PROTOCOL).map(p=>validatePeer(p,p.sessionId));
}

function validatePeer(peer,sessionId){
  validateChannelPeers([peer]);
  if(peer.protocol!==CODEX_INBOX_PROTOCOL)throw Error('Not a Codex inbox peer');
  if(!identifier(peer.id)||!identifier(peer.sessionId))
    throw Error('Codex peer and session IDs must contain only letters, digits, dots, underscores or hyphens');
  if(sessionId!==peer.sessionId)throw Error('Unknown or changed destination');
  return peer;
}

function validateTarget(target){
  if(!target||!identifier(target.threadId)||
    typeof target.cwd!=='string'||!isAbsolute(target.cwd)||target.cwd.length>4096||target.cwd.includes('\0')||
    (target.title!==undefined&&(typeof target.title!=='string'||!target.title.trim()||target.title.length>1024)))
    throw Error('An exact target threadId and absolute cwd are required');
  return {threadId:target.threadId,cwd:target.cwd,...(target.title!==undefined?{title:target.title}:{})};
}

function validateTimeout(timeoutMs,max){
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>max)throw Error('Invalid timeout');
}

function validateMessageId(messageId){
  if(typeof messageId!=='string'||!messageId.trim())throw Error('messageId required');
}

function validateBody(body){
  if(typeof body!=='string'||!body.trim())throw Error('Nonempty text required');
}

async function identity(peer,timeoutMs=3000){
  let response,data;
  try{
    response=await fetch(new URL('/identity',peer.url),{
      headers:{Authorization:`Bearer ${peer.token}`},redirect:'error',signal:AbortSignal.timeout(timeoutMs)});
    data=await response.json();
  }catch{throw Error('Codex inbox identity unavailable');}
  if(!response.ok)throw Error('Codex inbox identity unavailable');
  if(data?.sessionId!==peer.sessionId||data.protocol!==CODEX_INBOX_PROTOCOL||
    typeof data.ready!=='boolean'||data.asyncReplies!==true)throw Error('Codex inbox identity mismatch');
  return {peerId:peer.id,sessionId:peer.sessionId,title:peer.title??peer.sessionId,
    app:'codex',protocol:CODEX_INBOX_PROTOCOL,ready:data.ready,asyncReplies:true,uiVerified:false};
}

export async function discoverCodexPeers(peers){
  validateChannelPeers(peers);
  const selected=peers.filter(p=>p.protocol===CODEX_INBOX_PROTOCOL).map(p=>validatePeer(p,p.sessionId));
  const results=await Promise.allSettled(selected.map(p=>identity(p)));
  return {candidates:results.flatMap(r=>r.status==='fulfilled'?[r.value]:[]),
    unavailable:results.flatMap((r,i)=>r.status==='rejected'?[{peerId:selected[i].id,error:r.reason.message}]:[]),
    selectionRequired:true,configured:selected.length>0};
}

export async function submitCodexToPeer(peer,{sessionId,body,target,timeoutMs=1800000}){
  validatePeer(peer,sessionId);validateBody(body);validateTimeout(timeoutMs,3600000);
  const destination=validateTarget(target);
  const echo={peerId:peer.id,sessionId,target:destination,uiVerified:false,noAutomaticRetry:true};
  let receiver;
  try{receiver=await identity(peer);}
  catch{return {status:'unavailable',...echo,final:true,error:'Codex inbox identity could not be verified. No submission sent.'};}
  if(!receiver.ready)return {status:'unavailable',...echo,final:true,
    error:'The Codex receiver is not waiting. No submission sent.'};
  // No redirect, retry, alternate peer or native-host fallback is permitted.
  try{
    const response=await fetch(new URL('/submissions',peer.url),{method:'POST',
      headers:{Authorization:`Bearer ${peer.token}`,'Content-Type':'application/json'},
      body:JSON.stringify({sessionId,body,target:destination,timeoutMs}),redirect:'error',signal:AbortSignal.timeout(10000)});
    const result=await response.json();
    if(response.status===503&&result?.status==='unavailable'&&result.sessionId===sessionId&&
      result.final===true&&result.messageId===undefined)return {status:'unavailable',...echo,final:true,
        error:'The Codex receiver stopped waiting before accepting this request. '+noRetry};
    if([400,403,413,429].includes(response.status))return {status:'failed',...echo,final:true,
      error:`Codex inbox rejected submission (HTTP ${response.status}). ${noRetry}`};
    const acceptedTarget=validateTarget(result?.target);
    if(response.status!==202||result.status!=='accepted'||result.final!==false||result.sessionId!==sessionId||
      typeof result.messageId!=='string'||!result.messageId.trim()||
      acceptedTarget.threadId!==destination.threadId||acceptedTarget.cwd!==destination.cwd||
      acceptedTarget.title!==destination.title)throw Error('Invalid Codex inbox receipt');
    return {status:'accepted',...echo,messageId:result.messageId,final:false,
      note:'Accepted by the Codex inbox; target delivery and reply are unconfirmed. Observe this messageId. '+noRetry};
  }catch{
    // An unverified receipt cannot be used for further requests. Never guess
    // a message ID or repeat the POST after a lost acceptance response.
    return {status:'unknown',...echo,final:true,
      error:'Submission response lost or invalid; acceptance is unknown and no receipt ID is confirmed. '+noRetry};
  }
}

export async function waitCodexReply(peer,{sessionId,messageId,timeoutMs=30000}){
  validatePeer(peer,sessionId);validateMessageId(messageId);validateTimeout(timeoutMs,60000);
  const echo={peerId:peer.id,sessionId,messageId,uiVerified:false,noAutomaticRetry:true};
  try{
    // A finished receive call makes ready false, but does not invalidate a
    // previously accepted request. Only session/protocol identity is needed.
    await identity(peer);
    const url=new URL('/messages/'+encodeURIComponent(messageId),peer.url);
    url.searchParams.set('waitMs',String(timeoutMs));
    const response=await fetch(url,{headers:{Authorization:`Bearer ${peer.token}`},
      redirect:'error',signal:AbortSignal.timeout(timeoutMs+5000)});
    const result=await response.json();
    const final=result?.final===true&&['replied','delivered','queued','failed','unknown'].includes(result.status);
    const pending=result?.final===false&&result.status==='pending';
    if(!response.ok||result?.sessionId!==sessionId||result.messageId!==messageId||(!final&&!pending)||
      (result.status==='replied'&&typeof result.reply!=='string'))throw Error('Invalid Codex inbox observation');
    return {status:result.status,...echo,final:result.final,
      ...(result.target!==undefined?{target:validateTarget(result.target)}:{}),
      ...(['delivered','queued'].includes(result.deliveryStatus)?{deliveryStatus:result.deliveryStatus}:{}),
      ...(result.status==='replied'?{reply:result.reply}:{}),
      note:result.status==='replied'?'Reply received.':
        result.final?'Observation ended; a reply has not been confirmed. '+noRetry:
          'This request remains pending. Observe this same messageId. '+noRetry};
  }catch{
    return {status:'unknown',...echo,final:false,
      error:'Observation response lost or invalid. The original request may still be pending; observe this same messageId again. '+noRetry};
  }
}

export async function replyToCodexPeer(peer,{sessionId,messageId,body,timeoutMs=10000}){
  validatePeer(peer,sessionId);validateMessageId(messageId);validateBody(body);validateTimeout(timeoutMs,60000);
  const echo={peerId:peer.id,sessionId,messageId,uiVerified:false,noAutomaticRetry:true};
  try{await identity(peer,Math.min(timeoutMs,3000));}
  catch{return {status:'failed',...echo,error:'Codex inbox identity could not be verified. No reply sent.'};}
  try{
    const response=await fetch(new URL('/replies',peer.url),{method:'POST',
      headers:{Authorization:`Bearer ${peer.token}`,'Content-Type':'application/json'},
      body:JSON.stringify({sessionId,messageId,body}),redirect:'error',signal:AbortSignal.timeout(timeoutMs)});
    const result=await response.json();
    if(response.status===200&&result?.status==='replied'&&result.sessionId===sessionId&&result.messageId===messageId)
      return {status:'replied',...echo};
    if([400,403,404,409,413,422,429].includes(response.status))return {status:'failed',...echo,
      error:`Codex inbox rejected reply (HTTP ${response.status}). ${noRetry}`};
    throw Error('Invalid Codex inbox reply receipt');
  }catch{
    return {status:'unknown',...echo,error:'Reply response lost or invalid. '+noRetry};
  }
}
