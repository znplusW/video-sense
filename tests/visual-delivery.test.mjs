import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir,writeFile,readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { VideoService } from '../src/service.mjs';
import { encodePng } from '../vendor/dsh-see-now/png.js';

const root=path.resolve(process.env.AGENT_VIDEO_TEST_DIR||'work/validation-visual-delivery',randomUUID());
const png=encodePng(Buffer.from([25,80,200]),1,1);
const services=[];
test.after(async()=>{await Promise.all(services.map(service=>service.close()));});
function service(dataDir=path.join(root,randomUUID())){const value=new VideoService({dataDir});services.push(value);return value;}
async function addSheet(job,index,{image=true}={}){
  const base=path.join(job.directory,`sheet-${String(index).padStart(6,'0')}`);
  await writeFile(base+'.json',JSON.stringify({index,from:index,to:index,frames:[{t:index}],w:1,h:1}));
  if(image)await writeFile(base+'.png',png);
}
async function fixture(owner,{count=5,status='complete',kind='file',mode='continuous',missing=[]}={}){
  const id=randomUUID(),directory=path.join(owner.root,id);await mkdir(directory,{recursive:true});
  const j={id,directory,kind,status,sheets:count,mediaId:'media_'+id,worker:null,persist:Promise.resolve(),
    metadata:{duration:20},range:{start:0,end:20},requestedRange:{start:0,end:20},
    coverage:{mode,completeTimeline:status==='complete'&&mode==='continuous',completedRanges:[],plannedRanges:[{start:0,end:20}]},transcriptTracks:[]};
  owner.jobs.set(id,j);await Promise.all(Array.from({length:count},(_,i)=>addSheet(j,i,{image:!missing.includes(i)})));return j;
}
const info=async(s,j)=>(await s.status(j.id)).visualDelivery;

test('finished visual generation and ASR do not count as any image delivery',async()=>{
  const s=service(),j=await fixture(s);
  j.transcriptTracks=[{id:randomUUID(),status:'complete',source:{type:'asr'},processedRanges:[{start:0,end:20}]}];
  const st=await s.status(j.id);assert.deepEqual(st.statuses,{visual:'complete',transcript:'complete'});
  const d=st.visualDelivery;assert.equal(d.productionComplete,true);assert.equal(d.deliveredSheets,0);
  assert.equal(d.allDelivered,false);assert.equal(d.nextUndeliveredIndex,0);assert.equal(d.remainingSheets,5);
  assert.deepEqual(d.missingIndexRanges,[{start:0,end:4}]);assert.equal(d.continuousCoverageComplete,true);
});

test('batch pages deliver all PNGs and metadata in order including a terminal tail page',async()=>{
  const s=service(),j=await fixture(s,{count:9});const indexes=[];let after=-1,pages=0;
  while(true){
    const page=await s.readImages({id:j.id,after,waitSeconds:0,limit:4,format:'png'});pages++;
    assert.ok(page.images.length<=4);assert.equal(page.images.length,page.info.images.length);
    for(const image of page.images){assert.deepEqual(image.data,png);indexes.push(image.info.index);}
    after=page.info.nextAfter;
    if(!page.info.hasMore){assert.equal(page.info.exhausted,true);assert.equal(page.info.visualDelivery.allDelivered,true);break;}
    assert.equal(page.info.visualDelivery.allDelivered,false);
  }
  assert.equal(pages,3);assert.deepEqual(indexes,[0,1,2,3,4,5,6,7,8]);
  const empty=await s.readImages({id:j.id,after,waitSeconds:0,limit:4,format:'png'});assert.equal(empty.images.length,0);assert.equal(empty.info.nextAfter,8);
});

test('out-of-order reads expose exact holes; duplicate reads do not inflate delivery counts',async()=>{
  const s=service(),j=await fixture(s,{count:6});
  await s.sheet(j.id,0);await s.sheet(j.id,5);await s.sheet(j.id,5);
  let d=await info(s,j);assert.equal(d.deliveredSheets,2);assert.deepEqual(d.missingIndexRanges,[{start:1,end:4}]);
  const skipped=await s.readImages({id:j.id,after:5,waitSeconds:0});assert.equal(skipped.info.exhausted,true);assert.equal(skipped.info.visualDelivery.allDelivered,false);
  const next=await s.nextSaved(j.id,0,0);assert.equal(next.info.index,1);assert.equal(next.info.visualDelivery.deliveredSheets,3);
  await s.sheet(j.id,3);d=await info(s,j);assert.deepEqual(d.missingIndexRanges,[{start:2,end:2},{start:4,end:4}]);
  await s.readImages({id:j.id,after:1,limit:3,waitSeconds:0});assert.equal((await info(s,j)).allDelivered,true);
});

test('a drained running producer stays unfinished and resumes from the same cursor',async()=>{
  const s=service(),j=await fixture(s,{count:0,status:'running'});
  let page=await s.readImages({id:j.id,waitSeconds:0});assert.equal(page.info.nextAfter,-1);assert.equal(page.info.hasMore,true);
  assert.equal(page.info.exhausted,false);assert.equal(page.info.visualDelivery.allDelivered,false);
  const producing=(async()=>{await new Promise(r=>setTimeout(r,40));await addSheet(j,0);j.sheets=1;})();
  page=await s.readImages({id:j.id,waitSeconds:1});await producing;
  assert.equal(page.images.length,1);assert.equal(page.info.nextAfter,0);assert.equal(page.info.hasMore,true);
  assert.equal(page.info.visualDelivery.allGeneratedDelivered,true);assert.equal(page.info.visualDelivery.allDelivered,false);
  await addSheet(j,1);await addSheet(j,2);j.sheets=3;j.status='complete';j.coverage.completeTimeline=true;
  page=await s.readImages({id:j.id,after:page.info.nextAfter,waitSeconds:0});
  assert.deepEqual(page.images.map(v=>v.info.index),[1,2]);assert.equal(page.info.visualDelivery.allDelivered,true);
});

test('failed, stopped and interrupted jobs can drain partial images without claiming completion',async()=>{
  for(const status of ['error','stopped','interrupted']){
    const s=service(),j=await fixture(s,{count:2,status});
    const page=await s.readImages({id:j.id,waitSeconds:0});
    assert.equal(page.info.exhausted,true);assert.equal(page.info.productionTerminal,true);assert.equal(page.info.productionComplete,false);
    assert.equal(page.info.visualDelivery.allGeneratedDelivered,true);assert.equal(page.info.visualDelivery.allDelivered,false);
    assert.equal(page.info.visualDelivery.continuousCoverageComplete,false);
  }
});

test('all overview windows delivered do not become complete continuous coverage',async()=>{
  const s=service(),j=await fixture(s,{count:2,kind:'url',mode:'overview'});
  const page=await s.readImages({id:j.id,waitSeconds:0});assert.equal(page.info.visualDelivery.allDelivered,true);
  assert.equal(page.info.visualDelivery.continuousCoverageComplete,false);
});

test('failed batch and failed individual file reads do not mark unavailable images as delivered',async()=>{
  const s=service(),j=await fixture(s,{count:3,missing:[1]});
  await assert.rejects(()=>s.readImages({id:j.id,waitSeconds:0}),/ENOENT/);assert.equal((await info(s,j)).deliveredSheets,0);
  await assert.rejects(()=>s.sheet(j.id,1),/ENOENT/);assert.equal((await info(s,j)).deliveredSheets,0);
  await addSheet(j,1);await s.readImages({id:j.id,waitSeconds:0});assert.equal((await info(s,j)).allDelivered,true);
});

test('server restart ignores saved counts and starts conservative delivery accounting',async()=>{
  const s=service(),j=await fixture(s,{count:2});await s.readImages({id:j.id,waitSeconds:0});await s.save(j);
  const saved=JSON.parse(await readFile(path.join(j.directory,'manifest.json'),'utf8'));assert.equal(saved.visualDelivery.allDelivered,true);
  const reloaded=service(s.root);let d=(await reloaded.status(j.id)).visualDelivery;
  assert.equal(d.deliveredSheets,0);assert.equal(d.allDelivered,false);assert.deepEqual(d.missingIndexRanges,[{start:0,end:1}]);
  await reloaded.sheet(j.id,1);d=(await reloaded.status(j.id)).visualDelivery;assert.equal(d.deliveredSheets,1);assert.equal(d.nextUndeliveredIndex,0);
});

test('bounded arguments and non-video sources fail without altering delivery state',async()=>{
  const s=service(),j=await fixture(s,{count:1});
  for(const args of [{after:-2},{after:1.5},{limit:0},{limit:13},{waitSeconds:21},{waitSeconds:NaN}])
    await assert.rejects(()=>s.readImages({id:j.id,...args}));
  assert.equal((await info(s,j)).deliveredSheets,0);
  for(const kind of ['audio']){
    const other=await fixture(s,{count:0,kind});assert.equal(s.delivery(other),undefined);
    await assert.rejects(()=>s.readImages({id:other.id,waitSeconds:0}),/requires a saved file\/URL/);
    assert.equal((await s.status(other.id)).visualDelivery,undefined);
  }
});

test('canceling an image wait returns promptly without claiming images or source completion',async()=>{
  const s=service(),j=await fixture(s,{count:0,status:'running'}),controller=new AbortController();
  const pending=s.readImages({id:j.id,waitSeconds:20},controller.signal);setTimeout(()=>controller.abort(),40);
  await assert.rejects(()=>pending,/cancelled/);assert.equal((await info(s,j)).deliveredSheets,0);assert.equal(j.status,'running');
});

test('evidence image reads contribute delivery but metadata-only status never does',async()=>{
  const s=service(),j=await fixture(s,{count:3});await s.status(j.id);assert.equal((await info(s,j)).deliveredSheets,0);
  const page=await s.text.evidence({id:j.id,start:0,end:20,imageLimit:2});assert.equal(page.images.length,2);
  assert.equal((await info(s,j)).deliveredSheets,2);assert.equal((await info(s,j)).nextUndeliveredIndex,2);
  const empty=await s.nextSaved(j.id,2,0);assert.equal(empty.info.newImage,false);assert.equal(empty.info.visualDelivery.allDelivered,false);
});
