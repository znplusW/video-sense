import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import {JpegEncoder} from '../src/jpeg-encoder.mjs';

function fakeSpawn({autoCloseKilled=true}={}){
  const children=[];const invocations=[];
  const spawnProcess=(command,args,options)=>{
    invocations.push({command,args,options});
    const child=new EventEmitter();child.stdin=new PassThrough();child.stdin.resume();
    child.stdout=new PassThrough();child.stderr=new PassThrough();child.kills=[];
    child.finish=(code=0)=>{if(child.closed)return;child.closed=true;child.stdout.end();child.stderr.end();child.emit('close',code,code===null?'SIGKILL':null);};
    child.kill=signal=>{child.kills.push(signal);if(autoCloseKilled)queueMicrotask(()=>child.finish(null));return true;};
    children.push(child);return child;
  };
  return {children,invocations,spawnProcess};
}
const data=Buffer.from('fixture');
const turn=()=>delay(0);

test('one encoder shares a two-process limit across concurrent callers and drains in order',async()=>{
  const fake=fakeSpawn(),encoder=new JpegEncoder({spawnProcess:fake.spawnProcess,concurrency:2});
  const promises=Array.from({length:6},()=>encoder.encode(data));
  assert.equal(fake.children.length,2);assert.equal(encoder.snapshot().queued,4);
  for(let offset=0;offset<6;offset+=2){
    for(const child of fake.children.slice(offset,offset+2)){child.stdout.write(Buffer.from('JPEG'));child.finish();}
    await turn();assert(encoder.snapshot().active<=2);
  }
  assert.equal((await Promise.all(promises)).length,6);assert.equal(encoder.snapshot().active,0);assert.equal(encoder.snapshot().queued,0);
  const {args,options}=fake.invocations[0];assert(args.includes('yuvj444p'));assert(args.includes('-threads'));assert.equal(options.windowsHide,true);
  await encoder.close();
});

test('queue is bounded; queued abort removes only that request and never spawns it',async()=>{
  const fake=fakeSpawn(),encoder=new JpegEncoder({spawnProcess:fake.spawnProcess,concurrency:1,maxQueued:1});
  const active=encoder.encode(data),abort=new AbortController(),queued=encoder.encode(data,{signal:abort.signal});
  await assert.rejects(encoder.encode(data),e=>e.code==='JPEG_BUSY');
  const rejected=assert.rejects(queued,e=>e.code==='JPEG_ABORTED');abort.abort();await rejected;
  assert.equal(encoder.snapshot().queued,0);assert.equal(fake.children.length,1);assert.equal(fake.children[0].kills.length,0);
  fake.children[0].stdout.write(Buffer.from('JPEG'));fake.children[0].finish();await active;await encoder.close();
});

test('active cancellation kills its child and holds concurrency until close',async()=>{
  const fake=fakeSpawn({autoCloseKilled:false}),encoder=new JpegEncoder({spawnProcess:fake.spawnProcess,concurrency:1});
  const controller=new AbortController(),first=encoder.encode(data,{signal:controller.signal});
  const rejected=assert.rejects(first,e=>e.code==='JPEG_ABORTED');const second=encoder.encode(data);
  controller.abort();await turn();assert.deepEqual(fake.children[0].kills,['SIGKILL']);assert.equal(fake.children.length,1);
  assert.equal(encoder.snapshot().active,1);fake.children[0].finish(null);await rejected;
  assert.equal(fake.children.length,2);fake.children[1].stdout.write(Buffer.from('next'));fake.children[1].finish();assert.equal((await second).toString(),'next');
  await encoder.close();
});

test('execution timeout kills encoder, waits for close, then releases its slot',async()=>{
  const fake=fakeSpawn({autoCloseKilled:false}),encoder=new JpegEncoder({spawnProcess:fake.spawnProcess,timeoutMs:20});
  const rejected=assert.rejects(encoder.encode(data),e=>e.code==='JPEG_TIMEOUT');
  await delay(35);assert.equal(fake.children[0].kills.length,1);assert.equal(encoder.snapshot().active,1);
  fake.children[0].finish(null);await rejected;assert.equal(encoder.snapshot().active,0);await encoder.close();
});

test('queued request has its own bounded wait, without killing another caller',async()=>{
  const fake=fakeSpawn(),encoder=new JpegEncoder({spawnProcess:fake.spawnProcess,concurrency:1,queueTimeoutMs:20});
  const active=encoder.encode(data);const rejected=assert.rejects(encoder.encode(data),e=>e.code==='JPEG_QUEUE_TIMEOUT');
  await rejected;assert.equal(fake.children.length,1);assert.equal(fake.children[0].kills.length,0);
  fake.children[0].stdout.write(Buffer.from('JPEG'));fake.children[0].finish();await active;await encoder.close();
});

test('oversized stdout kills owned encoder and drains close without accepting partial JPEG',async()=>{
  const fake=fakeSpawn(),encoder=new JpegEncoder({spawnProcess:fake.spawnProcess,maxOutputBytes:4});
  const rejected=assert.rejects(encoder.encode(data),e=>e.code==='JPEG_OUTPUT_LIMIT');
  fake.children[0].stdout.write(Buffer.from('12345'));await rejected;
  assert.equal(fake.children[0].kills.length,1);assert.equal(encoder.snapshot().active,0);await encoder.close();
});

test('stderr is continuously drained but only a bounded tail is returned on nonzero exit',async()=>{
  const fake=fakeSpawn(),encoder=new JpegEncoder({spawnProcess:fake.spawnProcess,stderrBytes:128});
  const rejected=assert.rejects(encoder.encode(data),e=>e.code==='JPEG_FAILED'&&e.message.length<200&&e.message.includes('tail-marker'));
  fake.children[0].stderr.write(Buffer.from('a'.repeat(100000)+'tail-marker'));fake.children[0].finish(1);await rejected;await encoder.close();
});

test('spawn throws, asynchronous spawn error, pipe error and empty success cannot leak slots',async()=>{
  const throwing=new JpegEncoder({spawnProcess:()=>{throw new Error('missing exe');}});
  await assert.rejects(throwing.encode(data),e=>e.code==='JPEG_SPAWN_FAILED');assert.equal(throwing.snapshot().active,0);await throwing.close();
  for(const kind of ['spawn','pipe','empty']){
    const fake=fakeSpawn(),encoder=new JpegEncoder({spawnProcess:fake.spawnProcess});
    const rejected=assert.rejects(encoder.encode(data));
    if(kind==='spawn')fake.children[0].emit('error',new Error('ENOENT'));
    if(kind==='pipe')fake.children[0].stdout.emit('error',new Error('read failure'));
    if(kind==='empty')fake.children[0].finish(0);
    await rejected;assert.equal(encoder.snapshot().active,0);await encoder.close();
  }
});

test('shutdown cancels active and queued work; pre-aborted/new work cannot spawn',async()=>{
  const fake=fakeSpawn(),encoder=new JpegEncoder({spawnProcess:fake.spawnProcess,concurrency:1});
  const controller=new AbortController();controller.abort();
  await assert.rejects(encoder.encode(data,{signal:controller.signal}),e=>e.code==='JPEG_ABORTED');assert.equal(fake.children.length,0);
  const running=assert.rejects(encoder.encode(data),e=>e.code==='JPEG_CLOSED');
  const queued=assert.rejects(encoder.encode(data),e=>e.code==='JPEG_CLOSED');await encoder.close();await Promise.all([running,queued]);
  assert.equal(fake.children.length,1);assert.equal(encoder.snapshot().active,0);assert.equal(encoder.snapshot().queued,0);
  await assert.rejects(encoder.encode(data),e=>e.code==='JPEG_CLOSED');
});
