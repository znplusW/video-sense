import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import jpeg from 'jpeg-js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {encodePng} from '../vendor/dsh-see-now/png.js';
import {encodeImage,readImage,imageHash,assertImageBudget} from '../src/image-delivery.mjs';
import {VideoService} from '../src/service.mjs';

const root=path.resolve(process.env.AGENT_VIDEO_TEST_DIR||'work/validation-image-delivery',randomUUID());
await mkdir(root,{recursive:true});
const colors=Array.from({length:13},(_,i)=>[12+i*15,210-i*10,50+i*9]);
const pngs=colors.map(rgb=>encodePng(Buffer.from(Array.from({length:32*16},()=>rgb).flat()),32,16));
async function fixture(){
  const id=randomUUID(),directory=path.join(root,id);await mkdir(directory);
  await writeFile(path.join(directory,'manifest.json'),JSON.stringify({id,mediaId:'media_'+id,kind:'file',status:'complete',sheets:13,
    source:'saved controlled fixture',range:{start:0,end:13},metadata:{duration:13},settings:{},
    coverage:{mode:'continuous',completeTimeline:true,completedRanges:[{start:0,end:13}]},transcriptTracks:[]}));
  for(let i=0;i<13;i++){
    const base=path.join(directory,`sheet-${String(i).padStart(6,'0')}`);
    await writeFile(base+'.png',pngs[i]);await writeFile(base+'.json',JSON.stringify({index:i,from:i,to:i,w:32,h:16,frames:[{t:i}]}));
  }
  return {id,directory};
}
async function client(){
  const c=new Client({name:'jpeg-delivery-test',version:'1.0'});
  await c.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../src/server.mjs',import.meta.url))],
    env:{...process.env,AGENT_VIDEO_DATA_DIR:root,AGENT_VIDEO_ASR_CONFIG:path.join(root,'not-installed.json')},stderr:'pipe'}));return c;
}
async function call(c,name,args){
  const raw=await c.callTool({name,arguments:args});assert.ok(!raw.isError,JSON.stringify(raw));
  return {info:JSON.parse(raw.content.find(v=>v.type==='text').text),images:raw.content.filter(v=>v.type==='image')};
}
async function ack(c,id,page){
  const batch=page.info.visualReview.pendingBatch;
  // Synthetic receipt assertions verify protocol only, never claim model understanding.
  return call(c,'video_review',{id,action:'ack',batchId:batch.batchId,viewedIndices:batch.indices});
}
function assertJpeg(image,index){
  assert.equal(image.mimeType,'image/jpeg');const bytes=Buffer.from(image.data,'base64');
  assert.equal(bytes.subarray(0,2).toString('hex'),'ffd8');
  const decoded=jpeg.decode(bytes,{useTArray:true});assert.equal(decoded.width,32);assert.equal(decoded.height,16);
  for(let c=0;c<3;c++)assert.ok(Math.abs(decoded.data[c]-colors[index][c])<8,'flat-color fixture survives encoding');
}

test('JPEG encoding preserves dimensions; explicit PNG keeps exact original bytes',async()=>{
  const encoded=await encodeImage(pngs[0]);assertJpeg({mimeType:encoded.mimeType,data:encoded.data.toString('base64')},0);
  const original=await encodeImage(pngs[0],'png');assert.equal(original.mimeType,'image/png');assert.deepEqual(original.data,pngs[0]);
  await assert.rejects(async()=>encodeImage(pngs[0],'webp'),/format|jpeg|png/i);
});

test('JPEG cache is stable across reads and follows PNG content changes without overwriting originals',async()=>{
  const file=path.join(root,'cache-source.png');await writeFile(file,pngs[0]);
  const first=await readImage(file),again=await readImage(file);
  assert.equal(first.mimeType,'image/jpeg');assert.deepEqual(first.data,again.data);assert.equal(first.path,again.path);
  assert.deepEqual(await readFile(file),pngs[0]);assert.deepEqual((await readImage(file,'png')).data,pngs[0]);
  await writeFile(file,pngs[1]);const changed=await readImage(file);
  assert.notDeepEqual(changed.data,first.data);assert.deepEqual(await readFile(file),pngs[1]);
  assertJpeg({mimeType:changed.mimeType,data:changed.data.toString('base64')},1);
});

test('legacy jpeg-js receipts replay their exact cache; missing, replaced and foreign paths are rejected',async()=>{
  const file=path.join(root,'legacy-source.png');await writeFile(file,pngs[0]);
  const raw=Buffer.from(Array.from({length:32*16},()=>[...colors[0],255]).flat());
  const data=jpeg.encode({data:raw,width:32,height:16},85).data;
  const cache=path.join(root,`legacy-source.jpeg-js-044-q85-444.${imageHash(pngs[0])}.jpg`);await writeFile(cache,data);
  const replay={path:cache,format:'jpeg',sha256:imageHash(data)};
  const result=await readImage(file,'jpeg',{replay});assert.deepEqual(result.data,data);assert.equal(result.encodingProfile,'jpeg-js-044-q85-444');
  const current=await readImage(file);assert.notEqual(current.path,cache);assert.equal(current.encodingProfile,'ffmpeg-mjpeg-q4-444-t1-v1');
  await assert.rejects(()=>readImage(file,'jpeg',{replay:{...replay,path:path.join(root,'..',path.basename(cache))}}),/path|changed/);
  const missing=path.join(root,'legacy-missing.png');await writeFile(missing,pngs[0]);
  await assert.rejects(()=>readImage(missing,'jpeg',{replay:{path:path.join(root,`legacy-missing.jpeg-js-044-q85-444.${imageHash(pngs[0])}.jpg`)}}),/missing/);
  await writeFile(file,pngs[1]);await assert.rejects(()=>readImage(file,'jpeg',{replay}),/changed/);
});

test('cancelled cached reads and PNG encodes give no output; budgets include PNG and grouped buffers',async()=>{
  const file=path.join(root,'cancel-source.png');await writeFile(file,pngs[0]);await readImage(file);
  const controller=new AbortController();controller.abort();
  await assert.rejects(()=>readImage(file,'jpeg',{signal:controller.signal}),/cancelled/);
  await assert.rejects(()=>encodeImage(pngs[0],'png',{signal:controller.signal}),/cancelled/);
  const large=Buffer.alloc(8*1024**2+1);pngs[0].copy(large);
  await assert.rejects(()=>encodeImage(large,'png'),/8 MiB/);
  assert.throws(()=>assertImageBudget([{data:Buffer.alloc(5*1024**2)},Buffer.alloc(4*1024**2)]),/8 MiB/);
});

test('MCP default JPEG batch12, explicit PNG and restart replay retain bytes, order and receipts',async()=>{
  const {id,directory}=await fixture();let c=await client(),first,reviewId;
  try{
    const list=await c.listTools();assert.equal(list.tools.length,19);
    assert.ok(!list.tools.some(t=>['screen_start','screen_next'].includes(t.name)));
    const schema=list.tools.find(t=>t.name==='video_read').inputSchema;
    assert.equal(schema.properties.limit.maximum,12);assert.deepEqual(schema.properties.format.enum,['jpeg','png']);
    await call(c,'video_review',{id,action:'plan',visual:'all'});
    first=await call(c,'video_read',{id});assert.equal(first.images.length,12);
    assert.deepEqual(first.info.images.map(s=>s.index),Array.from({length:12},(_,i)=>i));
    first.images.forEach(assertJpeg);assert.ok(first.info.imageBytes<=8*1024**2);assert.equal(first.info.nextAfter,11);
    reviewId=first.info.visualReview.reviewId;
    const pending=await c.callTool({name:'video_read',arguments:{id,after:11}});assert.equal(pending.isError,true);
    const tooMany=await c.callTool({name:'video_review',arguments:{id,action:'ack',batchId:first.info.visualReview.pendingBatch.batchId,viewedIndices:Array.from({length:13},(_,i)=>i)}});
    assert.equal(tooMany.isError,true);
  }finally{await c.close();}
  c=await client();try{
    await call(c,'video_review',{id,action:'status',reviewId});
    const replay=await call(c,'video_review',{id,action:'replay'});
    assert.deepEqual(replay.images,first.images);await ack(c,id,replay);
    const tail=await call(c,'video_read',{id,after:11,format:'png'});assert.equal(tail.images.length,1);
    assert.equal(tail.images[0].mimeType,'image/png');assert.deepEqual(Buffer.from(tail.images[0].data,'base64'),pngs[12]);
    assert.equal(tail.info.nextAfter,12);assert.equal(tail.info.exhausted,true);
    assert.deepEqual((await call(c,'video_review',{id,action:'replay'})).images,tail.images);
    await ack(c,id,tail);const done=await call(c,'video_review',{id,action:'finish'});
    assert.equal(done.info.finished,true);assert.equal(done.info.visualReview.acknowledgedSheets,13);
    for(let i=0;i<13;i++)assert.deepEqual(await readFile(path.join(directory,`sheet-${String(i).padStart(6,'0')}.png`)),pngs[i]);
    const original=await call(c,'video_sheet',{id,index:0,format:'png'});
    assert.deepEqual(Buffer.from(original.images[0].data,'base64'),pngs[0]);await ack(c,id,original);
    const next=await call(c,'video_next',{id,after:0,waitSeconds:0});assertJpeg(next.images[0],1);await ack(c,id,next);
    const evidence=await call(c,'video_evidence',{id,start:0,end:13,imageLimit:12});
    assert.equal(evidence.images.length,12);evidence.images.forEach(assertJpeg);assert.equal(evidence.info.nextSheet,12);await ack(c,id,evidence);
    const exactEvidence=await call(c,'video_evidence',{id,start:0,end:1,format:'png'});
    assert.deepEqual(Buffer.from(exactEvidence.images[0].data,'base64'),pngs[0]);await ack(c,id,exactEvidence);
  }finally{await c.close();}
});

test('oversized encoded image is rejected without delivery credit or skipped cursor',async()=>{
  const {id}=await fixture(),s=new VideoService({dataDir:root});try{
    s.readSheet=async(j,index)=>({data:Buffer.alloc(8*1024**2+1),mimeType:'image/jpeg',info:{index}});
    await assert.rejects(()=>s.readImages({id}),/8 MiB/);
    assert.equal((await s.status(id)).visualDelivery.deliveredSheets,0);
  }finally{await s.close();}
});

test('pre-format saved reviews replay their original PNG instead of adopting the new JPEG default',async()=>{
  const {id,directory}=await fixture();let c=await client(),reviewId;
  try{
    const page=await call(c,'video_read',{id,limit:2,format:'png'});reviewId=page.info.visualReview.reviewId;
  }finally{await c.close();}
  const file=path.join(directory,'reviews',reviewId+'.json'),legacy=JSON.parse(await readFile(file,'utf8'));
  for(const info of legacy.pending.imageInfo){delete info.format;delete info.sha256;}
  await writeFile(file,JSON.stringify(legacy));
  c=await client();try{
    await call(c,'video_review',{id,action:'status',reviewId});
    const replay=await call(c,'video_review',{id,action:'replay'});assert.equal(replay.images.length,2);
    replay.images.forEach((image,i)=>{assert.equal(image.mimeType,'image/png');assert.deepEqual(Buffer.from(image.data,'base64'),pngs[i]);});
    await ack(c,id,replay);
  }finally{await c.close();}
});

test('changed pending source cannot silently replace a previously delivered JPEG during replay',async()=>{
  const {id,directory}=await fixture(),c=await client();try{
    const first=await call(c,'video_sheet',{id,index:0});assertJpeg(first.images[0],0);
    const batch=first.info.visualReview.pendingBatch;
    await writeFile(path.join(directory,'sheet-000000.png'),pngs[1]);
    const replay=await c.callTool({name:'video_review',arguments:{id,action:'replay'}});
    assert.equal(replay.isError,true);assert.match(replay.content[0].text,/changed/i);
    const state=await call(c,'video_review',{id,action:'status'});
    assert.equal(state.info.visualReview.pendingBatch.batchId,batch.batchId);
    assert.equal(state.info.visualReview.acknowledgedSheets,0);
    await call(c,'video_review',{id,action:'ack',batchId:batch.batchId,viewedIndices:[]});
  }finally{await c.close();}
});
