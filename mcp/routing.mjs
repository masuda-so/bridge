import {randomUUID} from 'node:crypto';

// Discovery data is context for the host agent, never executable instructions.
export function candidates(threads, {query='',excludeThreadId,limit=30}={}) {
 const terms=query.normalize('NFKC').toLocaleLowerCase().split(/\s+/).filter(Boolean);
 return threads.filter(t=>t.id!==excludeThreadId).map(t=>{
  const title=t.name ?? t.title ?? '';
  const summary=t.preview ?? '';
  const searchable=[title,summary,t.cwd ?? '',t.id].join('\n').normalize('NFKC').toLocaleLowerCase();
  return {hostId:'local',app:'codex',threadId:t.id,title,summary,cwd:t.cwd,
   status:t.status ?? {type:'unknown'},updatedAt:t.updatedAt,
   matchedTerms:terms.filter(term=>searchable.includes(term))};
 }).filter(t=>!terms.length || t.matchedTerms.length===terms.length)
 .sort((a,b)=>(b.updatedAt??0)-(a.updatedAt??0)).slice(0,limit);
}

// Process-scoped handles bind a selected destination, not sender authentication.
// They expire on restart; no message queue, persistent registry or ledger.
export class Routes {
 #routes=new Map();
 constructor({now=Date.now,ttlMs=3600000,max=256}={}){this.now=now;this.ttlMs=ttlMs;this.max=max;}
 prune(){for(const [id,r] of this.#routes) if(r.expiresAt<=this.now())this.#routes.delete(id);}
 bind(endpoint){
  this.prune();if(this.#routes.size>=this.max)throw Error('Too many active routes');
  const routeId=randomUUID();const value={...endpoint,expiresAt:this.now()+this.ttlMs};
  this.#routes.set(routeId,value);return {routeId,...value};
 }
 get(id){this.prune();const r=this.#routes.get(id);if(!r)throw Error('Route expired or unknown; rediscover and bind the destination');return {...r};}
}
