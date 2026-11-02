import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { mkdir,writeFile,readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { VideoService } from '../src/service.mjs';
import { exec,FFMPEG,FFPROBE } from '../src/media.mjs';

const root=path.resolve(process.env.AGENT_VIDEO_TEST_DIR||'work/validation-0.4.0',`evidence-${randomUUID()}`);
await mkdir(root,{recursive:true});
const clip=path.join(root,'three colors.mp4'),long=path.join(root,'source 606 seconds.mp4');
await exec(FFMPEG,['-v','error','-n',
  '-f','lavfi','-i','color=c=red:s=160x90:r=12:d=2','-f','lavfi','-i','color=c=blue:s=160x90:r=12:d=2','-f','lavfi','-i','color=c=green:s=160x90:r=12:d=2',
  '-filter_complex','[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]','-map','[v]','-c:v','libx264','-preset','ultrafast','-movflags','+faststart',clip],{windowsHide:true,timeout:20000});
await exec(FFMPEG,['-v','error','-n',
  '-f','lavfi','-i','color=c=red:s=160x90:r=12:d=600','-f','lavfi','-i','color=c=blue:s=160x90:r=12:d=2','-f','lavfi','-i','color=c=green:s=160x90:r=12:d=4',
  '-filter_complex','[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]','-map','[v]','-c:v','libx264','-preset','ultrafast','-g','24','-movflags','+faststart',long],{windowsHide:true,timeout:20000});
const srt=path.join(root,'human zh.srt'),vtt=path.join(root,'automatic en.vtt'),json=path.join(root,'external asr.json'),untimed=path.join(root,'untimed.json');
await writeFile(srt,'1\n00:00:00,000 --> 00:00:03,000\n  点击 <b>保存</b> 按钮。\n保留第二行\n\n2\n00:00:02,000 --> 00:00:04,000\n另一个合法重叠字幕。\n');
await writeFile(vtt,'WEBVTT\nLanguage: en\n\ncue-a\n00:01.000 --> 00:02.000\n<v Alice>Original &amp; unchanged.</v>\n');
await writeFile(json,JSON.stringify({timeBase:'source_media_seconds',source:{type:'asr',backend:'external-whisper',model:'external-model',language:'zh'},segments:[{id:'stable-external',start:4,end:5,text:'外部工具原转写',final:true}]}));
await writeFile(untimed,JSON.stringify({text:'全文没有逐句时间，不能伪造时间。'}));
const originalAsr=process.env.AGENT_VIDEO_ASR_CONFIG;
const missingConfig=path.join(root,'intentionally-missing-asr-config.json');
process.env.AGENT_VIDEO_ASR_CONFIG=missingConfig;
test.after(()=>{if(originalAsr===undefined)delete process.env.AGENT_VIDEO_ASR_CONFIG;else process.env.AGENT_VIDEO_ASR_CONFIG=originalAsr;});
const pngMagic='89504e470d0a1a0a';
function noSemanticFields(value){
  if(!value||typeof value!=='object')return;
  for(const [key,item] of Object.entries(value)){
    assert.ok(!['description','event_summary','action_result','causal_explanation'].includes(key),`unexpected semantic field ${key}`);
    noSemanticFields(item);
  }
}
async function completed(service,args={}){
  const job=await service.startVideo({file:clip,scene:true,...args});const result=await service.status(job.id,20);
  assert.equal(result.status,'complete',JSON.stringify(result));return result;
}
const importArgs=(job,file,extra={})=>({id:job.id,file,mediaId:job.mediaId,bindingBasis:'Controlled fixture generated for this exact video version.',...extra});
console.log(`Evidence validation artifacts: ${root}`);

test('SRT, VTT and external JSON import preserve source text and independent visual/text states',async()=>{
  const service=new VideoService({dataDir:path.join(root,'imports')});
  try{
    const j=await completed(service);assert.equal(j.statuses.transcript,'not_enabled');
    const first=await service.text.import(importArgs(j,srt,{language:'zh',subtitleKind:'manual'}));
    const second=await service.text.import(importArgs(j,vtt,{subtitleKind:'automatic'}));
    const third=await service.text.import(importArgs(j,json));
    const read=await service.text.read({id:j.id,trackId:first.id});
    assert.equal(read.source.type,'subtitle');assert.equal(read.source.language,'zh');assert.equal(read.source.subtitleKind,'manual');
    assert.equal(read.segments.length,2);assert.equal(read.segments[0].text,'  点击 <b>保存</b> 按钮。\n保留第二行');
    assert.equal(read.segments[1].start,2);assert.equal(read.binding.syncVerified,false);assert.equal(read.status,'complete');
    const vr=await service.text.read({id:j.id,trackId:second.id});assert.equal(vr.source.language,'en');assert.equal(vr.segments[0].text,'<v Alice>Original &amp; unchanged.</v>');
    const jr=await service.text.read({id:j.id,trackId:third.id});assert.equal(jr.source.type,'asr');assert.equal(jr.source.backend,'external-whisper');assert.equal(jr.source.model,'external-model');
    assert.equal(jr.segments[0].text,'外部工具原转写');
    const st=await service.status(j.id);assert.deepEqual(st.statuses,{visual:'complete',transcript:'complete'});
    const untouched=await service.sheet(j.id,0,'png');assert.equal(untouched.data.subarray(0,8).toString('hex'),pngMagic);
  }finally{await service.close();}
});

test('wrong media binding, invalid times and out-of-range offsets fail; untimed text remains unaligned',async()=>{
  const service=new VideoService({dataDir:path.join(root,'validation')});
  try{
    const j=await completed(service);
    await assert.rejects(()=>service.text.import(importArgs(j,srt,{mediaId:'media_another_video'})),/mediaId/);
    const bound=path.join(root,'wrong-media.json');await writeFile(bound,JSON.stringify({mediaId:'wrong-episode',segments:[{start:0,end:1,text:'wrong episode'}]}));
    await assert.rejects(()=>service.text.import(importArgs(j,bound)),/mediaId/);
    const invalid=path.join(root,'invalid-time.json');await writeFile(invalid,JSON.stringify({segments:[{start:null,end:1,text:'no time'}]}));
    await assert.rejects(()=>service.text.import(importArgs(j,invalid)),/finite/);
    await assert.rejects(()=>service.text.import(importArgs(j,srt,{offsetSeconds:600})),/outside/);
    const t=await service.text.import(importArgs(j,untimed));assert.equal(t.alignment,'unaligned');
    const read=await service.text.read({id:j.id,trackId:t.id});assert.deepEqual(read.segments,[]);assert.equal(read.unalignedText,'全文没有逐句时间，不能伪造时间。');
    const e=await service.text.evidence({id:j.id,start:0,end:6});assert.equal(e.info.transcripts[0].alignment,'unaligned');
    assert.ok(e.info.relations.every(r=>r.segments.length===0));
  }finally{await service.close();}
});

test('source second 600 offset yields actual PNG plus many-to-many mechanical relations and source timing caveat',async()=>{
  const service=new VideoService({dataDir:path.join(root,'offset')});
  try{
    const j=await completed(service,{file:long,start:600,end:604});
    const t=await service.text.import(importArgs(j,srt,{offsetSeconds:600,subtitleKind:'manual'}));
    const read=await service.text.read({id:j.id,trackId:t.id,start:600,end:604});
    assert.equal(read.segments[0].start,600);assert.equal(read.segments[0].end,603);assert.equal(read.segments[0].originalStart,0);
    assert.equal(read.segments[1].start,602);assert.equal(read.segments[1].originalStart,2);assert.equal(read.mapping.offsetSeconds,600);
    const evidence=await service.text.evidence({id:j.id,start:600,end:604,imageLimit:4,format:'png'});
    assert.ok(evidence.images.length>0);assert.equal(evidence.images[0].data.subarray(0,8).toString('hex'),pngMagic);
    assert.ok(evidence.info.frames.every(f=>f.t>=600&&f.t<604));assert.match(evidence.info.timestampAccuracy,/not exact source PTS/);
    assert.match(evidence.info.relationMeaning,/Time interval intersection only/);
    const first=evidence.info.relations.find(r=>r.time===600);assert.ok(first?.segments.some(s=>s.trackId===t.id&&s.segmentId===read.segments[0].id));
    assert.equal(evidence.info.relations.find(r=>r.time===602)?.segments.length,2,'one selected frame intersects two legitimate overlapping cues');
    assert.ok(evidence.info.relations.filter(r=>r.segments.some(s=>s.segmentId===read.segments[0].id)).length>=2,'one cue intersects multiple selected frames');
    const firstPng=path.join(root,'source-second-600.png');await writeFile(firstPng,evidence.images[0].data);
    const pixels=await exec(FFMPEG,['-v','error','-i',firstPng,'-f','rawvideo','-pix_fmt','rgb24','pipe:1'],{encoding:'buffer',windowsHide:true,maxBuffer:2*1024**2});
    const center=(225*800+400)*3;assert.ok(pixels.stdout[center+2]>200&&pixels.stdout[center]<10,'source second 600 is blue; source zero is red');
    assert.equal(evidence.info.mediaId,j.mediaId);noSemanticFields(evidence.info);
  }finally{await service.close();}
});

test('missing ASR configuration is reported while pure visual images remain usable',async()=>{
  const service=new VideoService({dataDir:path.join(root,'no-asr')});
  try{
    const j=await service.startVideo({file:clip,scene:true});
    await assert.rejects(()=>service.text.start({id:j.id,mode:'asr'}),/ASR configuration/);
    const image=await service.nextSaved(j.id,-1,10);assert.ok(image.data?.length>100);
    const st=await service.status(j.id,20);assert.equal(st.status,'complete');assert.equal(st.statuses.transcript,'not_enabled');
    const doctor=await service.doctor();assert.equal(doctor.ffmpeg.ok,true);assert.equal(doctor.asr.available,false);assert.equal(doctor.asr.visualIndependent,true);
    assert.equal((await service.sheet(j.id,0,'png')).data.subarray(0,8).toString('hex'),pngMagic);
  }finally{await service.close();}
});

test('controlled network visual overview gaps remain gaps with a full-range imported transcript',{timeout:30000},async()=>{
  const data=await readFile(long);
  const web=http.createServer((req,res)=>{
    const range=/bytes=(\d+)-(\d*)/.exec(req.headers.range??''),start=range?Number(range[1]):0,end=range?.[2]?Math.min(Number(range[2]),data.length-1):data.length-1;
    if(start>=data.length){res.writeHead(416,{'content-range':`bytes */${data.length}`});res.end();return;}
    const h={'content-type':'video/mp4','content-length':end-start+1,'accept-ranges':'bytes'};
    if(range)h['content-range']=`bytes ${start}-${end}/${data.length}`;res.writeHead(range?206:200,h);res.end(data.subarray(start,end+1));
  });
  await new Promise(r=>web.listen(0,'127.0.0.1',r));
  const origin=`http://127.0.0.1:${web.address().port}`,prior=process.env.AGENT_VIDEO_TEST_NETWORK_ORIGIN;
  process.env.AGENT_VIDEO_TEST_NETWORK_ORIGIN=origin;
  const service=new VideoService({dataDir:path.join(root,'overview')});
  try{
    const j=await service.startUrl({url:origin+'/clip.mp4',analysis:'overview',samples:2,start:0,end:12});const done=await service.status(j.id,20);
    assert.equal(done.status,'complete',JSON.stringify(done));assert.equal(done.visualCoverage.completeTimeline,false);
    assert.deepEqual(done.visualCoverage.completedRanges,[{start:0,end:2},{start:10,end:12}]);
    const full=path.join(root,'full-range.json');await writeFile(full,JSON.stringify({segments:[{start:0,end:12,text:'This supplied text spans the whole requested interval.'}]}));
    const t=await service.text.import(importArgs(done,full));const evidence=await service.text.evidence({id:j.id,start:3,end:9});
    assert.equal(evidence.images.length,0);assert.deepEqual(evidence.info.frames,[]);assert.equal(evidence.info.transcripts[0].segments.length,1);
    const final=await service.status(j.id);assert.equal(final.visualCoverage.completeTimeline,false);
    assert.deepEqual(final.transcriptTracks.find(x=>x.id===t.id).processedRanges,[{start:0,end:12}]);
    noSemanticFields(evidence.info);
  }finally{
    await service.close();web.closeAllConnections();web.close();
    if(prior===undefined)delete process.env.AGENT_VIDEO_TEST_NETWORK_ORIGIN;else process.env.AGENT_VIDEO_TEST_NETWORK_ORIGIN=prior;
  }
});

test('standalone MCP initialize/schema/help delivers real image and source text without loading a Skill',{timeout:30000},async()=>{
  const client=new Client({name:'mcp-only-evidence-test',version:'1.0.0'});
  const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../src/server.mjs',import.meta.url))],
    env:{...process.env,AGENT_VIDEO_DATA_DIR:path.join(root,'mcp-only'),AGENT_VIDEO_FFMPEG:FFMPEG,AGENT_VIDEO_FFPROBE:FFPROBE,AGENT_VIDEO_ASR_CONFIG:missingConfig},stderr:'pipe'});
  try{
    await client.connect(transport);assert.equal(client.getServerVersion().version,'0.8.0');
    const instructions=client.getInstructions();assert.match(instructions,/no Skill is required/i);assert.match(instructions,/evidence ONLY/i);
    const list=await client.listTools();assert.equal(list.tools.length,19);
    for(const name of ['transcript_import','transcript_start','transcript_read','video_evidence','video_help'])assert.ok(list.tools.some(t=>t.name===name),name);
    const schema=list.tools.find(t=>t.name==='transcript_import').inputSchema;
    assert.ok(schema.required.includes('mediaId'));assert.ok(schema.required.includes('bindingBasis'));
    const call=(name,args={})=>client.callTool({name,arguments:args});
    const help=await call('video_help');assert.ok(!help.isError,JSON.stringify(help));assert.ok(help.content.some(x=>x.type==='text'&&x.text.length>500));
    const started=await call('video_start',{file:clip,scene:true});assert.ok(!started.isError,JSON.stringify(started));const id=JSON.parse(started.content[0].text).id;
    const st=await call('video_status',{id,waitSeconds:20});const j=JSON.parse(st.content[0].text);assert.equal(j.status,'complete');
    const imported=await call('transcript_import',importArgs(j,srt,{subtitleKind:'manual'}));assert.ok(!imported.isError,JSON.stringify(imported));
    const track=JSON.parse(imported.content[0].text);
    const read=await call('transcript_read',{id,trackId:track.id,start:2,end:3,limit:1});const page=JSON.parse(read.content[0].text);assert.equal(page.segments.length,1);assert.equal(page.more,true);
    const evidence=await call('video_evidence',{id,start:0,end:6,imageLimit:1,textLimit:10,format:'png'});assert.ok(!evidence.isError,JSON.stringify(evidence));
    const info=JSON.parse(evidence.content[0].text);const image=evidence.content.find(x=>x.type==='image');
    assert.ok(image);assert.equal(image.mimeType,'image/png');assert.equal(Buffer.from(image.data,'base64').subarray(0,8).toString('hex'),pngMagic);
    assert.ok(info.frames.length>0);assert.ok(info.transcripts[0].segments.some(s=>s.text.includes('点击')));assert.ok(info.relations.some(r=>r.segments.length));
    assert.notEqual(info.nextSheet,null,'image pagination exposes remaining matching sheets');noSemanticFields(info);
  }finally{await client.close();}
});
