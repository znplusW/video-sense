import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir,writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { encodePng } from '../vendor/dsh-see-now/png.js';

// Saved fixtures exercise actual JSON-RPC/stdin/stdout image delivery. No source
// decoding, network resolution, screen capture, model loading or ASR is invoked.
const root=path.resolve(process.env.AGENT_VIDEO_TEST_DIR||'work/validation-visual-delivery-mcp',randomUUID());
const pngs=Array.from({length:9},(_,i)=>encodePng(Buffer.from([i*25,255-i*20,i*15]),1,1));
const transfer={mode:'download_fallback',status:'complete',reason:'Controlled saved fixture',streamAttempts:2,file:path.join(root,'fixture-video.mp4')};
async function fixture({count=9,kind='url',status='complete',mode='continuous',missingTrack=false}={}){
  const id=randomUUID(),mediaId='media_'+id,directory=path.join(root,id),trackId=randomUUID();await mkdir(path.join(directory,'transcripts'),{recursive:true});
  const segments=Array.from({length:3},(_,i)=>({id:'cue-'+i,start:i*3,end:(i+1)*3,text:['第一段原文','第二段原文','最后一段原文'][i],final:true,revision:1,sourceType:'subtitle'}));
  const track={id:trackId,mediaId,schemaVersion:'1',status:'complete',source:{type:'subtitle',subtitleKind:'manual'},
    timeBase:'source_media_seconds',timeUnit:'seconds',binding:{basis:'Controlled saved fixture',syncVerified:false},mapping:{offsetSeconds:0},
    requestedRange:{start:0,end:9},processedRanges:[{start:0,end:9}],alignment:'aligned',segments,events:segments.map((s,i)=>({sequence:i+1,...s}))};
  const {segments:unusedSegments,events:unusedEvents,...trackSummary}=track;
  const manifest={id,kind,sourceType:'url',source:'https://example.com/control-fixture',mediaId,directory,status,sheets:count,metadata:{duration:9},
    requestedRange:{start:0,end:9},range:{start:0,end:9},settings:{analysis:mode},
    coverage:{mode,plannedRanges:[{start:0,end:9}],completedRanges:status==='complete'?[{start:0,end:9}]:[],completeTimeline:status==='complete'&&mode==='continuous'},
    transcriptTracks:[trackSummary],videoTransfer:kind==='url'?transfer:undefined,
    // A restarted server must not trust another process's delivery claims.
    visualDelivery:{allDelivered:true,deliveredSheets:count,generatedSheets:count}};
  await writeFile(path.join(directory,'manifest.json'),JSON.stringify(manifest));
  if(!missingTrack)await writeFile(path.join(directory,'transcripts',trackId+'.json'),JSON.stringify(track));
  for(let index=0;index<count;index++){
    const base=path.join(directory,`sheet-${String(index).padStart(6,'0')}`);
    await writeFile(base+'.png',pngs[index]);
    await writeFile(base+'.json',JSON.stringify({index,from:index,to:index,frames:[{t:index}],w:1,h:1}));
  }
  return {id,mediaId,trackId,directory,track};
}
const normal=await fixture(),holes=await fixture(),failed=await fixture({count:2,status:'error'}),overview=await fixture({count:2,mode:'overview'}),
  audio=await fixture({count:0,kind:'audio',status:'ready'}),cancel=await fixture({count:3}),
  noImages=await fixture({count:0}),imported=await fixture({count:2}),brokenEvidence=await fixture({count:3,missingTrack:true});
const subtitleFile=path.join(root,'supplied.srt');await writeFile(subtitleFile,'1\n00:00:00,000 --> 00:00:09,000\n外部提供的字幕原文。\n');
let client;
test.before(async()=>{
  client=new Client({name:'visual-delivery-stdio-test',version:'1.0.0'});
  await client.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../src/server.mjs',import.meta.url))],
    env:{...process.env,AGENT_VIDEO_DATA_DIR:root,AGENT_VIDEO_ASR_CONFIG:path.join(root,'not-installed-asr.json')},stderr:'pipe'}));
});
test.after(async()=>{await client?.close();});
async function call(name,args){
  if(['video_read','video_evidence','video_sheet','video_next'].includes(name))args={format:'png',...args};
  if(name==='video_read')args={limit:4,...args};
  const result=await client.callTool({name,arguments:args});assert.ok(!result.isError,JSON.stringify(result));
  const info=JSON.parse(result.content.find(c=>c.type==='text').text),images=result.content.filter(c=>c.type==='image');
  // Test harness receipts exercise transport bookkeeping, not model inspection.
  const batch=info.visualReview?.pendingBatch;
  if(images.length&&batch){const ack=await client.callTool({name:'video_review',arguments:{id:args.id,action:'ack',batchId:batch.batchId,viewedIndices:batch.indices}});assert.ok(!ack.isError,JSON.stringify(ack));}
  return {raw:result,info,images};
}

test('standalone MCP exposes the registered batch tool and bounded schema',async()=>{
  assert.equal(client.getServerVersion().version,'0.8.0');
  const list=await client.listTools(),schema=list.tools.find(t=>t.name==='video_read').inputSchema;
  assert.equal(list.tools.length,19);assert.equal(schema.properties.limit.minimum,1);assert.equal(schema.properties.limit.maximum,12);
  assert.equal(schema.properties.after.minimum,-1);assert.equal(schema.properties.waitSeconds.maximum,20);assert.deepEqual(schema.required,['id']);
});

test('completed transcript responses expose remaining visual evidence and preserve all text pages',async()=>{
  let text=await call('transcript_read',{id:normal.id,limit:1});
  assert.equal(text.images.length,0);assert.equal(text.info.status,'complete');assert.equal(text.info.more,true);
  assert.equal(text.info.visualStatus,'complete');assert.equal(text.info.visualDelivery.deliveredSheets,0);
  assert.equal(text.info.visualDelivery.allDelivered,false);assert.equal(text.info.visualDelivery.remainingSheets,9);
  const words=[text.info.segments[0].text];let after=text.info.nextAfter;
  do{text=await call('transcript_read',{id:normal.id,after,limit:1});after=text.info.nextAfter;words.push(...text.info.segments.map(s=>s.text));}while(text.info.more);
  assert.deepEqual(words,['第一段原文','第二段原文','最后一段原文']);
  assert.equal(text.info.visualDelivery.allDelivered,false);assert.equal(text.info.nextAfter,3);
});

test('all nine original PNG image content blocks survive stdio batching and terminal tail pagination',async()=>{
  const indices=[];let after=-1;
  for(const expectedCount of [4,4,1]){
    const page=await call('video_read',{id:normal.id,after,waitSeconds:0});
    assert.equal(page.images.length,expectedCount);assert.equal(page.info.images.length,expectedCount);
    for(let i=0;i<expectedCount;i++){
      const index=page.info.images[i].index;indices.push(index);
      assert.equal(page.images[i].mimeType,'image/png');assert.deepEqual(Buffer.from(page.images[i].data,'base64'),pngs[index]);
    }
    after=page.info.nextAfter;assert.equal(after,indices.at(-1));assert.equal(page.info.productionComplete,true);
    assert.equal(page.info.hasMore,indices.length<9);assert.equal(page.info.exhausted,indices.length===9);
    assert.equal(page.info.visualDelivery.allDelivered,indices.length===9);assert.deepEqual(page.info.videoTransfer,transfer);
  }
  assert.deepEqual(indices,[0,1,2,3,4,5,6,7,8]);
  const st=await call('video_status',{id:normal.id});assert.equal(st.info.visualDelivery.allDelivered,true);
  assert.equal(st.info.visualDelivery.continuousCoverageComplete,true);assert.deepEqual(st.info.videoTransfer,transfer);
  const end=await call('video_read',{id:normal.id,after,waitSeconds:0});assert.equal(end.images.length,0);assert.equal(end.info.nextAfter,8);assert.equal(end.info.exhausted,true);
});

test('jumping to the final sheet cannot satisfy delivery; recovery and legacy next both count exact indices',async()=>{
  let page=await call('video_sheet',{id:holes.id,index:8});assert.equal(page.images.length,1);
  assert.equal(page.info.visualDelivery.deliveredSheets,1);assert.deepEqual(page.info.visualDelivery.missingIndexRanges,[{start:0,end:7}]);
  page=await call('video_read',{id:holes.id,after:8,waitSeconds:0});assert.equal(page.info.exhausted,true);assert.equal(page.info.visualDelivery.allDelivered,false);
  page=await call('video_next',{id:holes.id,after:-1,waitSeconds:0});assert.equal(page.info.index,0);assert.equal(page.info.visualDelivery.deliveredSheets,2);
  page=await call('video_read',{id:holes.id,after:page.info.visualDelivery.nextUndeliveredIndex-1,waitSeconds:0});assert.deepEqual(page.info.images.map(i=>i.index),[1,2,3,4]);
  page=await call('video_read',{id:holes.id,after:page.info.nextAfter,waitSeconds:0});assert.deepEqual(page.info.images.map(i=>i.index),[5,6,7,8]);assert.equal(page.info.visualDelivery.deliveredSheets,9);assert.equal(page.info.visualDelivery.allDelivered,true);
});

test('error/overview/no-image results cannot become complete continuous video evidence',async()=>{
  const partial=await call('video_read',{id:failed.id,waitSeconds:0});assert.equal(partial.images.length,2);
  assert.equal(partial.info.exhausted,true);assert.equal(partial.info.productionComplete,false);assert.equal(partial.info.visualDelivery.allDelivered,false);
  const preview=await call('video_read',{id:overview.id,waitSeconds:0});assert.equal(preview.info.visualDelivery.allDelivered,true);assert.equal(preview.info.visualDelivery.continuousCoverageComplete,false);
  const empty=await call('video_read',{id:noImages.id,waitSeconds:0});assert.equal(empty.images.length,0);assert.equal(empty.info.visualDelivery.allDelivered,false);
});

test('subtitle import and combined evidence return visual progress without describing image content',async()=>{
  const added=await call('transcript_import',{id:imported.id,mediaId:imported.mediaId,file:subtitleFile,bindingBasis:'Controlled fixture for this test media.'});
  assert.equal(added.info.status,'complete');assert.equal(added.info.visualDelivery.deliveredSheets,0);
  const evidence=await call('video_evidence',{id:imported.id,start:0,end:9,imageLimit:1});assert.equal(evidence.images.length,1);
  assert.equal(evidence.info.visualDelivery.deliveredSheets,1);assert.equal(evidence.info.visualDelivery.allDelivered,false);
  assert.ok(evidence.info.transcripts.some(t=>t.segments.some(s=>s.text==='外部提供的字幕原文。')));
  assert.deepEqual(Buffer.from(evidence.images[0].data,'base64'),pngs[0]);
});

test('failed combined evidence preserves prior delivery counts until the complete response is prepared',async()=>{
  await call('video_sheet',{id:brokenEvidence.id,index:2});
  const failure=await client.callTool({name:'video_evidence',arguments:{id:brokenEvidence.id,start:0,end:9,imageLimit:2}});
  assert.equal(failure.isError,true);assert.match(failure.content[0].text,/ENOENT/);assert.equal(failure.content.filter(c=>c.type==='image').length,0);
  const state=await call('video_status',{id:brokenEvidence.id});assert.equal(state.info.visualDelivery.deliveredSheets,1);
  assert.deepEqual(state.info.visualDelivery.missingIndexRanges,[{start:0,end:1}]);assert.equal(state.info.visualDelivery.allDelivered,false);
  await writeFile(path.join(brokenEvidence.directory,'transcripts',brokenEvidence.trackId+'.json'),JSON.stringify(brokenEvidence.track));
  const repaired=await call('video_evidence',{id:brokenEvidence.id,start:0,end:9,imageLimit:2});
  assert.equal(repaired.images.length,2);assert.deepEqual(Buffer.from(repaired.images[0].data,'base64'),pngs[0]);assert.deepEqual(Buffer.from(repaired.images[1].data,'base64'),pngs[1]);
  assert.equal(repaired.info.visualDelivery.deliveredSheets,3);assert.equal(repaired.info.visualDelivery.allDelivered,true);
});

test('pure audio workflows do not acquire video-delivery requirements',async()=>{
  const a=await call('audio_status',{id:audio.id});assert.equal(a.info.statuses.visual,'not_applicable');assert.equal(a.info.visualDelivery,undefined);
  const t=await call('transcript_read',{id:audio.id});assert.equal(t.info.status,'complete');assert.equal(t.images.length,0);
  assert.equal(t.info.visualStatus,undefined);assert.equal(t.info.visualDelivery,undefined);assert.equal(t.info.videoWorkflow,undefined);
  const aImport=await call('transcript_import',{id:audio.id,mediaId:audio.mediaId,file:subtitleFile,bindingBasis:'Controlled audio fixture.'});assert.equal(aImport.info.visualDelivery,undefined);
  const denied=await client.callTool({name:'video_read',arguments:{id:audio.id,waitSeconds:0}});assert.equal(denied.isError,true);
});

test('session cancellation remains available with undelivered images and retains partial evidence',async()=>{
  const stopped=await call('session_stop',{id:cancel.id});assert.equal(stopped.info.visualDelivery.deliveredSheets,0);
  assert.equal(stopped.info.visualDelivery.remainingSheets,3);assert.equal(stopped.info.visualDelivery.allDelivered,false);
  const saved=await call('video_read',{id:cancel.id,waitSeconds:0});assert.equal(saved.images.length,3);assert.equal(saved.info.visualDelivery.allDelivered,true);
});
