import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir,writeFile,readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { VideoService } from '../src/service.mjs';
import { ReviewService } from '../src/review.mjs';
import { encodePng } from '../vendor/dsh-see-now/png.js';

const root=path.resolve(process.env.AGENT_VIDEO_TEST_DIR||'work/validation-review',randomUUID());
await mkdir(root,{recursive:true});
const pngs=Array.from({length:9},(_,i)=>encodePng(Buffer.from([20*i,200-15*i,40+i]),1,1));
async function fixture(count=9){
  const id=randomUUID(),mediaId='media_'+id,directory=path.join(root,id);await mkdir(directory);
  await writeFile(path.join(directory,'manifest.json'),JSON.stringify({id,mediaId,kind:'url',status:'complete',sheets:count,directory,
    source:'https://example.com/scenery.mp4',metadata:{duration:90},range:{start:0,end:90},settings:{analysis:'continuous'},
    coverage:{mode:'continuous',completeTimeline:true,completedRanges:[{start:0,end:90}]}}));
  for(let i=0;i<count;i++){
    const base=path.join(directory,`sheet-${String(i).padStart(6,'0')}`);
    await writeFile(base+'.png',pngs[i]);await writeFile(base+'.json',JSON.stringify({index:i,frames:[{t:i*10}],from:i*10,to:i*10,w:1,h:1}));
  }
  return {id,directory,mediaId};
}
async function client(){
  const c=new Client({name:'review-test',version:'1.0.0'});
  await c.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../src/server.mjs',import.meta.url))],
    env:{...process.env,AGENT_VIDEO_DATA_DIR:root},stderr:'pipe'}));return c;
}
async function call(c,name,args){
  const raw=await c.callTool({name,arguments:args});
  const txt=raw.content.find(i=>i.type==='text')?.text;
  let info;try{info=JSON.parse(txt);}catch{info={message:txt};}
  return {raw,info,images:raw.content.filter(i=>i.type==='image')};
}
const review=(c,id,action,extra={})=>call(c,'video_review',{id,action,...extra});

test('MCP refuses unread batch accumulation; restart+explicit reviewId replays lost images byte-for-byte',async()=>{
  const {id}=await fixture();let c=await client();let reviewId,batchId;
  try{
    await review(c,id,'plan',{visual:'all'});
    const first=await call(c,'video_read',{id,limit:4,format:'png'});assert.equal(first.images.length,4);
    ({reviewId}=first.info.visualReview);batchId=first.info.visualReview.pendingBatch.batchId;
    assert.equal(first.info.visualReview.acknowledgedSheets,0);
    const denied=await call(c,'video_read',{id,after:3});assert.equal(denied.raw.isError,true);assert.equal(denied.info.code,'IMAGE_BATCH_PENDING');assert.equal(denied.images.length,0);
    const premature=await review(c,id,'finish');assert.equal(premature.info.finished,false);
  }finally{await c.close();}
  c=await client();try{
    const resumed=await review(c,id,'status',{reviewId});assert.equal(resumed.info.visualReview.pendingBatch.batchId,batchId);
    const replay=await review(c,id,'replay');assert.equal(replay.images.length,4);
    replay.images.forEach((img,i)=>assert.deepEqual(Buffer.from(img.data,'base64'),pngs[i]));
    const invalid=await review(c,id,'ack',{batchId,viewedIndices:[8]});assert.equal(invalid.raw.isError,true);
    await review(c,id,'ack',{batchId,viewedIndices:[0,1,2,3]});
    let after=3;
    for(const expected of [4,1]){
      const page=await call(c,'video_read',{id,after,limit:4,format:'png'});assert.equal(page.images.length,expected);after=page.info.nextAfter;
      const batch=page.info.visualReview.pendingBatch;await review(c,id,'ack',{batchId:batch.batchId,viewedIndices:batch.indices});
    }
    const done=await review(c,id,'finish');assert.equal(done.info.finished,true);assert.equal(done.info.visualReview.acknowledgedSheets,9);
  }finally{await c.close();}
});

test('selected evidence can finish without reading all generated images; partial ack is not promoted to a full batch',async()=>{
  const {id}=await fixture(),c=await client();try{
    await review(c,id,'plan',{visual:'selected',indices:[0,8]});
    let page=await call(c,'video_read',{id,limit:4,format:'png'});let batch=page.info.visualReview.pendingBatch;
    await review(c,id,'ack',{batchId:batch.batchId,viewedIndices:[0]});
    assert.equal((await review(c,id,'finish')).info.finished,false);
    page=await call(c,'video_sheet',{id,index:8});batch=page.info.visualReview.pendingBatch;
    await review(c,id,'ack',{batchId:batch.batchId,viewedIndices:[8]});
    const done=await review(c,id,'finish');assert.equal(done.info.finished,true);assert.deepEqual(done.info.visualReview.acknowledgedIndices,[0,8]);
    assert.equal((await call(c,'video_status',{id})).info.visualDelivery.allDelivered,false);
  }finally{await c.close();}
});

test('text-only and zero-view release are valid host choices; cancellation is separate from cleanup',async()=>{
  const {id}=await fixture(),c=await client();try{
    const page=await call(c,'video_read',{id,limit:4,format:'png'}),batch=page.info.visualReview.pendingBatch;
    await call(c,'session_stop',{id});assert.equal((await review(c,id,'status')).info.visualReview.state,'reading');
    await review(c,id,'plan',{visual:'none'});
    assert.equal((await review(c,id,'finish')).info.finished,false,'pending receipt still needs explicit disposition');
    await review(c,id,'ack',{batchId:batch.batchId,viewedIndices:[]});
    const done=await review(c,id,'finish');assert.equal(done.info.finished,true);assert.equal(done.info.visualReview.acknowledgedSheets,0);
    const other=await fixture();await review(c,other.id,'plan',{visual:'all'});
    await call(c,'session_stop',{id:other.id,reason:'user_cancelled'});
    assert.equal((await review(c,other.id,'status')).info.visualReview.state,'cancelled');
    assert.deepEqual((await call(c,'video_guard',{})).info,{});
  }finally{await c.close();}
});

test('guard prompts continuation only for this connection and is bounded when no progress occurs',async()=>{
  const {id}=await fixture(),c=await client(),independent=await client();try{
    await review(c,id,'plan',{visual:'selected',indices:[8]});
    assert.deepEqual((await call(independent,'video_guard',{})).info,{});
    for(let i=0;i<3;i++)assert.equal((await call(c,'video_guard',{})).info.decision,'block');
    assert.deepEqual((await call(c,'video_guard',{})).info,{});
  }finally{await c.close();await independent.close();}
});

test('chosen text pages must be read; unrelated text failures do not force ASR or block a visual-only plan',async()=>{
  const {id,directory}=await fixture(),s=new VideoService({dataDir:root}),r=new ReviewService(s);
  try{
    const j=await s.job(id),trackId=randomUUID();
    j.transcriptTracks=[{id:trackId,status:'complete',eventCount:2}];
    await r.action({id,action:'plan',visual:'none',textTrackIds:[trackId]});
    await r.textResponse(id,{id:trackId,segments:[{sequence:2,text:'last cue'}]});
    assert.equal((await r.action({id,action:'finish'})).info.finished,false,'jumping to last cue cannot hide a missed first page');
    await r.textResponse(id,{id:trackId,segments:[{sequence:1,text:'first cue'}]});
    assert.equal((await r.action({id,action:'finish'})).info.finished,true);
    j.transcriptTracks.push({id:randomUUID(),status:'error',eventCount:0});
    await r.action({id,action:'plan',visual:'none'});
    assert.equal((await r.action({id,action:'finish'})).info.finished,true);
    j.resolved={resources:{subtitles:[]}};
    const noTracks=await s.text.start({id,mode:'subtitles'});assert.equal(noTracks.status,'no_tracks');assert.deepEqual(noTracks.availableTracks,[]);
  }finally{await s.close();}
});

test('byte budget reduces page count without skipping the next image',async()=>{
  const {id}=await fixture(),s=new VideoService({dataDir:root});try{
    s.readSheet=async(j,index)=>({info:{index},data:Buffer.alloc(3*1024**2,index),mimeType:'image/jpeg'});
    const a=await s.readImages({id});assert.equal(a.images.length,2);assert.equal(a.info.nextAfter,1);assert.equal(a.info.hasMore,true);
    const b=await s.readImages({id,after:a.info.nextAfter});assert.deepEqual(b.images.map(i=>i.info.index),[2,3]);
  }finally{await s.close();}
});
