// Official CLI JSON contract, Claude Code 2.1.263, consulted 2026-09-09:
// https://code.claude.com/docs/en/agent-view#list-sessions-as-json
// Bridge-owned adapter: select documented fields without treating a listed
// session as a deliverable channel. No internal registry or socket parsing.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute=promisify(execFile);

export async function listClaudeSessions(run=execute){
  const {stdout}=await run('claude',['agents','--json'],{
    timeout:5000,killSignal:'SIGKILL',maxBuffer:1048576,encoding:'utf8',
  });
  const rows=JSON.parse(stdout);
  if(!Array.isArray(rows))throw Error('Claude session listing must be an array');
  const sessions=[];
  for(const row of rows){
    if(!row || typeof row.sessionId!=='string' || !row.sessionId)continue;
    if(typeof row.cwd!=='string' || !['interactive','background'].includes(row.kind))
      throw Error('Invalid Claude session listing');
    const item={sessionId:row.sessionId,cwd:row.cwd,kind:row.kind,
      delivery:'unverified',source:'claude agents --json'};
    for(const key of ['name','status','state','waitingFor'])
      if(typeof row[key]==='string')item[key]=row[key];
    if(Number.isSafeInteger(row.pid)&&row.pid>0)item.pid=row.pid;
    if(Number.isFinite(row.startedAt))item.startedAt=row.startedAt;
    sessions.push(item);
  }
  return {sessions,omittedWithoutSessionId:rows.length-sessions.length,
    limitation:'Listing does not establish a send route. An empty result may reflect process visibility restrictions, not absence of Desktop sessions. Never resume or create a session to make it discoverable.'};
}
