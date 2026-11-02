import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readdir,stat} from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {audioBlocks,wav} from '../src/audio.mjs';
import {createNetworkProxy} from '../src/network.mjs';

const root=path.resolve(process.env.AGENT_VIDEO_TEST_DIR||'work/validation',`audio-spool-${randomUUID()}`);await mkdir(root,{recursive:true});
const full=wav(Buffer.alloc(120*32000));
const truncated=Buffer.from(full.subarray(0,44+30*32000));
let active=0,finished=0;
const web=http.createServer((req,res)=>{
  const data=req.url==='/short.wav'?truncated:full;
  const match=/bytes=(\d+)-(\d*)/.exec(req.headers.range??''),start=Number(match?.[1]??0),end=match?.[2]?Math.min(Number(match[2]),data.length-1):data.length-1;
  if(start>=data.length){res.writeHead(416);res.end();return;}
  res.writeHead(match?206:200,{'content-type':'audio/wav','accept-ranges':'bytes','content-length':end-start+1,...(match?{'content-range':`bytes ${start}-${end}/${data.length}`}:{})});
  if(req.url!=='/slow.wav'){res.end(data.subarray(start,end+1));finished++;return;}
  active++;let at=start;
  const timer=setInterval(()=>{
    if(at>end){res.end();finished++;return;}
    const next=Math.min(at+16384,end+1);res.write(data.subarray(at,next));at=next;
  },10);
  res.on('close',()=>{clearInterval(timer);active--;});
});
await new Promise(r=>web.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${web.address().port}`;
test.after(()=>{web.closeAllConnections();web.close();});
async function until(fn,timeout=5000){const end=Date.now()+timeout;while(!fn()&&Date.now()<end)await new Promise(r=>setTimeout(r,20));assert.ok(fn(),'condition did not complete within bounded time');}
async function setup(name,url='/full.wav'){
  const directory=path.join(root,name);await mkdir(directory);
  const proxy=await createNetworkProxy({allowOrigin:[origin],upstream:null});
  return {directory,proxy,input:{url:origin+url,headers:{},proxy}};
}

test('decoder/spool completes while its ASR consumer is deliberately suspended; source times remain contiguous',async()=>{
  const ctx=await setup('slow-consumer'),states=[];let pid;
  const iterator=audioBlocks({...ctx,start:0,end:120,onPid:value=>{if(value)pid=value;},onAcquisition:state=>states.push(state)});
  try{
    const first=await iterator.next();assert.equal(first.value.coreStart,0);assert.equal(first.value.coreEnd,20);
    // Do not request the second block: this represents a blocked/slow ASR call.
    await until(()=>states.at(-1)?.status==='complete');
    const saved=await readdir(ctx.directory);assert.equal(saved.filter(x=>x.endsWith('.wav')).length,6);
    assert.equal(states.at(-1).queueDepth,5);assert.equal(states.at(-1).decodedThrough,120);assert.ok(finished>0);
    assert.ok(states.at(-1).spooledBytes<=states.at(-1).maxSpoolBytes);assert.throws(()=>process.kill(pid,0));
    const blocks=[first.value];for await(const block of iterator)blocks.push(block);
    assert.deepEqual(blocks.map(b=>[b.coreStart,b.coreEnd]),[[0,20],[20,40],[40,60],[60,80],[80,100],[100,120]]);
    for(const b of blocks)assert.equal((await stat(b.file)).size,44+b.sampleCount*2);
  }finally{await iterator.return();ctx.proxy.close();}
});

test('early EOF retains actual blocks and acquisition error; it never becomes complete',async()=>{
  const ctx=await setup('early-eof','/short.wav'),states=[],blocks=[];
  try{
    await assert.rejects(async()=>{for await(const b of audioBlocks({...ctx,start:0,end:120,onAcquisition:s=>states.push(s)}))blocks.push(b);},/ended before|decoder failed/);
    assert.equal(states.at(-1).status,'error');assert.ok(!states.some(s=>s.status==='complete'));
    assert.ok(states.at(-1).decodedThrough<120);assert.ok(blocks.every(b=>b.coreEnd<=30.001));
  }finally{ctx.proxy.close();}
});

test('WAV spool enforces a disk cap, propagates failure and closes its decoder',async()=>{
  const ctx=await setup('cap'),states=[];let pid;
  try{
    await assert.rejects(async()=>{for await(const b of audioBlocks({...ctx,start:0,end:120,maxSpoolBytes:800000,onPid:p=>{if(p)pid=p;},onAcquisition:s=>states.push(s)})){}},/spool limit/);
    assert.ok(states.at(-1).spooledBytes<=800000);assert.equal(states.at(-1).status,'error');
    const files=await readdir(ctx.directory);let bytes=0;for(const f of files)bytes+=(await stat(path.join(ctx.directory,f))).size;
    assert.ok(bytes<=800000);assert.throws(()=>process.kill(pid,0));
  }finally{ctx.proxy.close();}
});

test('cancelling during suspended consumption stops the producer/decoder and network connections',async()=>{
  const ctx=await setup('cancel','/slow.wav'),controller=new AbortController(),states=[];let pid;
  const iterator=audioBlocks({...ctx,start:0,end:120,signal:controller.signal,onPid:p=>{if(p)pid=p;},onAcquisition:s=>states.push(s)});
  try{
    assert.equal((await iterator.next()).value.coreEnd,20);assert.ok(active>0);
    controller.abort();await iterator.return();ctx.proxy.close();await until(()=>active===0);
    assert.equal(states.at(-1).status,'stopped');assert.throws(()=>process.kill(pid,0));
  }finally{await iterator.return();ctx.proxy.close();}
});
