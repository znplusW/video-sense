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
const subtitles={
  '/zh.srt':{format:'srt',text:'1\n00:00:00,000 --> 00:00:03,000\n  点击 <b>保存</b> 按钮。\n保留第二行\n\n2\n00:00:02,000 --> 00:00:04,000\n另一个合法重叠字幕。\n'},
  '/en.vtt':{format:'vtt',text:'WEBVTT\nLanguage: en\n\ncue-a\n00:01.000 --> 00:02.000\n<v Alice>Original &amp; unchanged.</v>\n'},
  '/late.srt':{format:'srt',text:'1\n00:10:00,000 --> 00:10:03,000\nFirst source cue\n\n2\n00:10:02,000 --> 00:10:04,000\nSecond overlapping cue\n'},
  '/full.vtt':{format:'vtt',text:'WEBVTT\n\n00:00.000 --> 00:12.000\nThis source subtitle spans the requested interval.\n'}
};
const media={'/clip.mp4':await readFile(clip),'/long.mp4':await readFile(long)};
const requests=[];
const web=http.createServer((req,res)=>{
  requests.push(req.url);
  if(subtitles[req.url]){res.end(subtitles[req.url].text);return;}
  const data=media[req.url];if(!data){res.writeHead(404);res.end();return;}
  const range=/bytes=(\d+)-(\d*)/.exec(req.headers.range??''),start=range?Number(range[1]):0,end=range?.[2]?Math.min(Number(range[2]),data.length-1):data.length-1;
  if(start>=data.length){res.writeHead(416,{'content-range':`bytes */${data.length}`});res.end();return;}
  const headers={'content-type':'video/mp4','content-length':end-start+1,'accept-ranges':'bytes'};
  if(range)headers['content-range']=`bytes ${start}-${end}/${data.length}`;
  res.writeHead(range?206:200,headers);res.end(data.subarray(start,end+1));
});
await new Promise(r=>web.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${web.address().port}`;
const priorOrigin=process.env.AGENT_VIDEO_TEST_NETWORK_ORIGIN,originalAsr=process.env.AGENT_VIDEO_ASR_CONFIG;
const missingConfig=path.join(root,'intentionally-missing-asr-config.json');
process.env.AGENT_VIDEO_TEST_NETWORK_ORIGIN=origin;process.env.AGENT_VIDEO_ASR_CONFIG=missingConfig;
test.after(()=>{
  web.closeAllConnections();web.close();
  if(priorOrigin===undefined)delete process.env.AGENT_VIDEO_TEST_NETWORK_ORIGIN;else process.env.AGENT_VIDEO_TEST_NETWORK_ORIGIN=priorOrigin;
  if(originalAsr===undefined)delete process.env.AGENT_VIDEO_ASR_CONFIG;else process.env.AGENT_VIDEO_ASR_CONFIG=originalAsr;
});
const pngMagic='89504e470d0a1a0a';
function noSemanticFields(value){
  if(!value||typeof value!=='object')return;
  for(const [key,item] of Object.entries(value)){
    assert.ok(!['description','event_summary','action_result','causal_explanation'].includes(key),`unexpected semantic field ${key}`);
    noSemanticFields(item);
  }
}
async function completed(service,args={}){
  const job=await service.startUrl({url:origin+'/clip.mp4',scene:true,...args});const result=await service.status(job.id,20);
  assert.equal(result.status,'complete',JSON.stringify(result));return result;
}
async function sourceTrack(service,j,pathname,extra={}){
  // Stub only the resolver's private resource catalog for this controlled source.
  // The production subtitle start/fetch/parser/persistence pipeline still runs.
  const internal=await service.job(j.id),trackId='manual:'+pathname;
  internal.resolved.resources.subtitles=[{id:trackId,language:'zh',category:'manual',format:subtitles[pathname].format,url:origin+pathname,headers:{},...extra}];
  const list=await service.text.start({id:j.id,mode:'subtitles'});assert.equal(list.status,'selection_required');
  assert.equal(list.availableTracks[0].id,trackId);assert.equal(list.availableTracks[0].url,undefined);
  const t=await service.text.start({id:j.id,mode:'subtitles',trackId});
  let result;do{result=await service.text.read({id:j.id,trackId:t.id,waitSeconds:20});}while(['starting','running'].includes(result.status));
  assert.equal(result.status,'complete',JSON.stringify(result));return result;
}
console.log(`Evidence validation artifacts: ${root}`);

test('same-source HTTP SRT/VTT tracks preserve original text, provenance and independent states',async()=>{
  const service=new VideoService({dataDir:path.join(root,'source-subtitles')});
  try{
    const j=await completed(service);assert.equal(j.statuses.transcript,'not_enabled');assert.equal(service.text.import,undefined);
    const first=await sourceTrack(service,j,'/zh.srt');
    assert.equal(first.source.type,'subtitle');assert.equal(first.source.language,'zh');assert.equal(first.source.subtitleKind,'manual');
    assert.equal(first.segments.length,2);assert.equal(first.segments[0].text,'  点击 <b>保存</b> 按钮。\n保留第二行');
    assert.equal(first.segments[1].start,2);assert.equal(first.binding.syncVerified,false);assert.match(first.binding.basis,/same resolved source/);
    const second=await sourceTrack(service,j,'/en.vtt',{language:'en',category:'automatic'});
    assert.equal(second.source.language,'en');assert.equal(second.source.subtitleKind,'automatic');
    assert.equal(second.segments[0].text,'<v Alice>Original &amp; unchanged.</v>');
    assert.ok(requests.includes('/zh.srt')&&requests.includes('/en.vtt'));
    assert.deepEqual((await service.status(j.id)).statuses,{visual:'complete',transcript:'complete'});
    assert.equal((await service.sheet(j.id,0,'png')).data.subarray(0,8).toString('hex'),pngMagic);
  }finally{await service.close();}
});

test('unavailable source subtitle selection errors without blocking already generated images',async()=>{
  const service=new VideoService({dataDir:path.join(root,'wrong-track')});
  try{
    const j=await completed(service);
    const list=await service.text.start({id:j.id,mode:'subtitles'});assert.equal(list.status,'no_tracks');
    const t=await service.text.start({id:j.id,mode:'subtitles',trackId:'unrelated:track'});
    let result;do{result=await service.text.read({id:j.id,trackId:t.id,waitSeconds:20});}while(['starting','running'].includes(result.status));
    assert.equal(result.status,'error');assert.match(result.error,/Subtitle track unavailable/);
    assert.equal((await service.sheet(j.id,0,'png')).data.subarray(0,8).toString('hex'),pngMagic);
  }finally{await service.close();}
});

test('source second 600 retains source subtitle times and mechanical many-to-many relations',async()=>{
  const service=new VideoService({dataDir:path.join(root,'late-source')});
  try{
    const j=await completed(service,{url:origin+'/long.mp4',start:600,end:604});
    const read=await sourceTrack(service,j,'/late.srt');
    assert.equal(read.segments[0].start,600);assert.equal(read.segments[0].end,603);assert.equal(read.segments[0].originalStart,600);
    const evidence=await service.text.evidence({id:j.id,start:600,end:604,imageLimit:4,format:'png'});
    assert.ok(evidence.images.length>0);assert.equal(evidence.images[0].data.subarray(0,8).toString('hex'),pngMagic);
    assert.ok(evidence.info.frames.every(f=>f.t>=600&&f.t<604));assert.match(evidence.info.timestampAccuracy,/not exact source PTS/);
    assert.match(evidence.info.relationMeaning,/Time interval intersection only/);
    assert.ok(evidence.info.relations.find(r=>r.time===600)?.segments.some(s=>s.segmentId===read.segments[0].id));
    assert.equal(evidence.info.relations.find(r=>r.time===602)?.segments.length,2);
    assert.ok(evidence.info.relations.filter(r=>r.segments.some(s=>s.segmentId===read.segments[0].id)).length>=2);
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
  }finally{await service.close();}
});

test('visual overview gaps remain gaps even when same-source subtitle spans the full range',async()=>{
  const service=new VideoService({dataDir:path.join(root,'overview')});
  try{
    const j=await completed(service,{url:origin+'/long.mp4',analysis:'overview',samples:2,start:0,end:12});
    assert.equal(j.visualCoverage.completeTimeline,false);assert.deepEqual(j.visualCoverage.completedRanges,[{start:0,end:2},{start:10,end:12}]);
    await sourceTrack(service,j,'/full.vtt');
    const evidence=await service.text.evidence({id:j.id,start:3,end:9});
    assert.equal(evidence.images.length,0);assert.deepEqual(evidence.info.frames,[]);assert.equal(evidence.info.transcripts[0].segments.length,1);
    assert.equal((await service.status(j.id)).visualCoverage.completeTimeline,false);noSemanticFields(evidence.info);
  }finally{await service.close();}
});

test('standalone MCP exposes media-only inputs and usable visuals without a Skill or language backend',async()=>{
  const client=new Client({name:'mcp-only-evidence-test',version:'1.0.0'});
  const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../src/server.mjs',import.meta.url))],
    env:{...process.env,AGENT_VIDEO_DATA_DIR:path.join(root,'mcp-only'),AGENT_VIDEO_FFMPEG:FFMPEG,AGENT_VIDEO_FFPROBE:FFPROBE,AGENT_VIDEO_ASR_CONFIG:missingConfig},stderr:'pipe'});
  try{
    await client.connect(transport);assert.equal(client.getServerVersion().version,'0.9.0');
    assert.match(client.getInstructions(),/no Skill is required/i);assert.match(client.getInstructions(),/evidence ONLY/i);
    const list=await client.listTools();assert.equal(list.tools.length,18);assert.ok(!list.tools.some(t=>t.name==='transcript_import'));
    for(const name of ['transcript_start','transcript_read','video_evidence','video_help'])assert.ok(list.tools.some(t=>t.name===name));
    assert.equal(list.tools.find(t=>t.name==='video_review').inputSchema.properties.textTrackIds,undefined);
    const call=async(name,args={})=>{const r=await client.callTool({name,arguments:args});assert.ok(!r.isError,JSON.stringify(r));return r;};
    const help=await call('video_help');assert.ok(help.content.some(x=>x.type==='text'&&x.text.length>500));
    const j=JSON.parse((await call('video_start',{file:clip,scene:true})).content[0].text),id=j.id;
    assert.equal(JSON.parse((await call('video_status',{id,waitSeconds:20})).content[0].text).status,'complete');
    const evidence=await call('video_evidence',{id,start:0,end:6,imageLimit:1,format:'png'});
    const info=JSON.parse(evidence.content[0].text),image=evidence.content.find(x=>x.type==='image');
    assert.ok(image);assert.equal(Buffer.from(image.data,'base64').subarray(0,8).toString('hex'),pngMagic);
    assert.ok(info.frames.length>0);assert.deepEqual(info.transcripts,[]);assert.notEqual(info.nextSheet,null);noSemanticFields(info);
  }finally{await client.close();}
});
