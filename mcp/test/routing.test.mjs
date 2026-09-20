import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/client';
import {InMemoryTransport} from '@modelcontextprotocol/server';
import {candidates,Routes} from '../routing.mjs';
import {createServer} from '../tools.mjs';
import {tmpdir} from 'node:os';

test('discovery preserves ambiguous candidates and excludes self',()=>{
 const threads=[{id:'a',name:'Weave',cwd:'/one',preview:'review',updatedAt:1},{id:'b',name:'Weave',cwd:'/two',preview:'review',updatedAt:2}];
 assert.equal(candidates(threads,{query:'Weave review'}).length,2);
 assert.deepEqual(candidates(threads,{excludeThreadId:'a'}).map(t=>t.threadId),['b']);
 assert.equal(candidates(threads,{query:'missing'}).length,0);
});
test('route cannot change through caller mutation and expires',()=>{
 let now=0;const routes=new Routes({now:()=>now,ttlMs:10});
 const route=routes.bind({threadId:'a'});route.threadId='b';
 assert.equal(routes.get(route.routeId).threadId,'a');
 now=10;assert.throws(()=>routes.get(route.routeId),/expired/);
});
test('MCP discovery, binding and repeated messages retain exact destination and body',async()=>{
 const calls=[];
 const run=async(o,input)=>{
  calls.push({o,input});
  if(o.command==='list')return {threads:[{id:'target',name:'Review',cwd:tmpdir()}]};
  if(o.command==='read')return {thread:{id:o.threadId,cwd:tmpdir()}};
  return {threadId:o.threadId,turnId:'turn',reply:input.body,status:'completed'};
 };
 const server=createServer(run),client=new Client({name:'test',version:'1'});
 const [a,b]=InMemoryTransport.createLinkedPair();
 await server.connect(b);await client.connect(a);
 const call=async(name,args)=>JSON.parse((await client.callTool({name,arguments:args})).content[0].text);
 try{
  const found=await call('bridge_discover',{query:'Review'});
  assert.equal(found.candidates[0].threadId,'target');assert.equal(calls[0].o.allProjects,true);
  const bound=await call('bridge_bind',{cwd:tmpdir(),threadId:'target'});
  const body=' A/B・123\n二行目\n';
  for(let i=0;i<2;i++)assert.equal((await call('bridge_continue',{routeId:bound.routeId,body})).reply,body);
  assert.deepEqual(calls.filter(c=>c.o.command==='send').map(c=>c.o.threadId),['target','target']);
  const before=calls.length;
  assert.match((await call('bridge_continue',{routeId:'unknown',body})).error,/unknown/);
  assert.equal(calls.length,before);
  assert.match((await call('bridge_bind',{cwd:'/mismatch',threadId:'target'})).error,/directory differs/);
 }finally{await client.close();await server.close();}
});
