import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir,readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { audioBlocks,mapAsrSegments } from '../src/audio.mjs';
import { exec,FFMPEG } from '../src/media.mjs';
import { VideoService } from '../src/service.mjs';
import { createNetworkProxy } from '../src/network.mjs';
const root=path.resolve(process.env.AGENT_VIDEO_TEST_DIR||'work/validation',`audio-${randomUUID()}`);
await mkdir(root,{recursive:true});
async function finishedText(service,id,trackId){let t,after=0;do{t=await service.text.read({id,trackId,after,waitSeconds:20});after=t.nextAfter;}while(['starting','running'].includes(t.status));return service.text.read({id,trackId});}

test('continuous PCM acquisition has sample-traceable overlap and 600-second origin',async()=>{
  const file=path.join(root,'timeline.mkv');
  await exec(FFMPEG,['-v','error','-n','-f','lavfi','-i','color=c=blue:s=64x36:r=2:d=609','-f','lavfi','-i','sine=frequency=440:sample_rate=16000:duration=609',
    '-c:v','libx264','-preset','ultrafast','-c:a','pcm_s16le',file],{windowsHide:true,timeout:20000});
  const blocks=[];
  for await(const b of audioBlocks({file,start:600,end:609,directory:root,chunkSeconds:4,contextSeconds:1}))blocks.push(b);
  assert.equal(blocks.length,3);assert.deepEqual(blocks.map(b=>[b.start,b.end,b.coreStart,b.coreEnd]),[[600,605,600,604],[603,609,604,608],[607,609,608,609]]);
  for(const b of blocks){const buf=await readFile(b.file);assert.equal(buf.length,44+b.sampleCount*2);assert.equal(buf.readUInt32LE(24),16000);}
  const a=mapAsrSegments({segments:[{start:3.5,end:4.2,text:'overlap',final:true}]},blocks[0],'track');
  const b=mapAsrSegments({segments:[{start:0.6,end:1.3,text:'overlap',final:true}]},blocks[1],'track',a);
  assert.equal(a.length,1);assert.equal(b.length,0,'midpoint outside the second core must not be repeated');
  const revised=mapAsrSegments({segments:[{start:0.8,end:1.4,text:'overlap',final:true}]},blocks[1],'track',a);
  assert.equal(revised[0].id,a[0].id);assert.equal(revised[0].revision,2);assert.equal(revised[0].start,603.8);
  const first=mapAsrSegments({segments:[{start:2,end:5,text:' hello world',words:[{start:2,end:3,word:' hello'},{start:4,end:5,word:' world'}]}]},blocks[0],'words');
  assert.equal(first[0].text,' hello');
  const second=mapAsrSegments({segments:[{start:1,end:2,text:' world',words:[{start:1,end:2,word:' world'}]}]},blocks[1],'words',first);
  assert.equal(second[0].text,' world');assert.equal(second[0].start,604);
});

test('real ASR maps a 600s video range; first image independent; completed text cache reused',
  {skip:process.env.AGENT_VIDEO_TEST_ASR!=='1',timeout:90000},async()=>{
  const sample=process.env.AGENT_VIDEO_ASR_SAMPLE;if(!sample)throw new Error('Set AGENT_VIDEO_ASR_SAMPLE to the referenced speech fixture.');
  const file=path.join(root,'speech-at-600.mkv');
  await exec(FFMPEG,['-v','error','-n','-f','lavfi','-i','color=c=blue:s=64x36:r=2:d=611','-i',sample,
    '-filter_complex','[1:a]adelay=600000:all=1[a]','-map','0:v','-map','[a]','-c:v','libx264','-preset','ultrafast','-c:a','flac',file],{windowsHide:true,timeout:20000});
  const service=new VideoService({dataDir:path.join(root,'real')});
  try{
    const j=await service.startVideo({file,start:600,end:611});
    const track=await service.text.start({id:j.id,mode:'asr',language:'en'});
    const first=await service.nextSaved(j.id,-1,5);assert.ok(first.data?.length);assert.equal((await service.text.read({id:j.id})).status,'running');
    const t=await finishedText(service,j.id,track.id);
    assert.equal(t.status,'complete',JSON.stringify(t));assert.ok(t.segments.some(s=>/country/i.test(s.text)));assert.ok(t.segments.every(s=>s.start>=600&&s.end<=611));
    assert.equal(t.source.backend,'faster-whisper');assert.ok(t.source.model);assert.equal(t.speechStatus,'recognized');
    const cache=await service.text.start({id:j.id,mode:'asr',language:'en'});assert.equal(cache.cached,true);assert.equal(cache.id,track.id);
    assert.equal((await service.status(j.id)).statuses.visual,'complete');
    console.log(JSON.stringify({benchmark:'real ASR unified pipeline',requestToFirstFinalTextMs:t.requestToFirstFinalTextMs,totalMs:t.totalMs,source:t.source,range:t.requestedRange}));
    const silence=await service.text.start({id:j.id,mode:'asr',start:0,end:2,language:'en'});
    const silent=await finishedText(service,j.id,silence.id);
    assert.equal(silent.status,'complete',JSON.stringify(silent));assert.equal(silent.speechStatus,'no_speech');assert.equal(silent.segments.length,0);
  }finally{await service.close();}
});

test('network subtitle retrieval and audio extraction reuse same resolved entry; cancellation preserves pictures',
  {timeout:30000},async()=>{
  const file=path.join(root,'av.mp4');
  await exec(FFMPEG,['-v','error','-n','-f','lavfi','-i','testsrc2=s=128x72:r=12:d=6','-f','lavfi','-i','sine=frequency=440:duration=6','-c:v','libx264','-preset','ultrafast','-c:a','aac','-movflags','+faststart',file],{windowsHide:true,timeout:20000});
  const data=await readFile(file),requests=[];
  const web=http.createServer((req,res)=>{
    requests.push(req.url);
    if(req.url==='/caption.vtt'){res.end('WEBVTT\n\n00:00.500 --> 00:02.500\nOriginal words\n\n00:04.000 --> 00:05.000\nLater words\n');return;}
    const match=/bytes=(\d+)-(\d*)/.exec(req.headers.range??''),start=match?Number(match[1]):0,end=match?.[2]?Number(match[2]):data.length-1;
    res.writeHead(match?206:200,{'content-type':'video/mp4','accept-ranges':'bytes','content-length':end-start+1,...(match?{'content-range':`bytes ${start}-${end}/${data.length}`}:{})});res.end(data.subarray(start,end+1));
  });
  await new Promise(r=>web.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${web.address().port}`;
  const old=process.env.AGENT_VIDEO_TEST_NETWORK_ORIGIN;process.env.AGENT_VIDEO_TEST_NETWORK_ORIGIN=origin;
  const service=new VideoService({dataDir:path.join(root,'network')});
  try{
    const j=await service.startUrl({url:origin+'/av.mp4',start:1,end:3});assert.equal((await service.status(j.id,10)).status,'complete');
    const internal=await service.job(j.id);assert.ok(internal.resolved.resources.audio);
    const proxy=await createNetworkProxy({allowOrigin:[origin]});
    const audioDirectory=path.join(root,'network-audio');await mkdir(audioDirectory);
    try{const blocks=[];for await(const b of audioBlocks({input:{...internal.resolved.resources.audio,proxy},start:1,end:3,directory:audioDirectory}))blocks.push(b);
      assert.equal(blocks.length,1);assert.equal(blocks[0].sampleCount,32000);assert.ok(proxy.stats.receivedBytes>0);
    }finally{proxy.close();}
    internal.resolved.resources.subtitles=[{id:'manual:en',language:'en',category:'manual',format:'vtt',url:origin+'/caption.vtt',headers:{}}];
    const choices=await service.text.start({id:j.id,mode:'subtitles'});assert.equal(choices.status,'selection_required');assert.ok(!JSON.stringify(choices).includes('caption.vtt'));
    const track=await service.text.start({id:j.id,mode:'subtitles',trackId:'manual:en'});
    const t=await finishedText(service,j.id,track.id);
    assert.equal(t.status,'complete',JSON.stringify(t));assert.equal(t.segments.length,1);assert.equal(t.segments[0].text,'Original words');assert.ok(requests.includes('/caption.vtt'));
    assert.ok((await service.sheet(j.id,0)).data);assert.equal((await service.status(j.id)).audioAnalyzed,false);
    if(process.env.AGENT_VIDEO_TEST_ASR==='1'){
      const asr=await service.text.start({id:j.id,mode:'asr',language:'en'}),recognized=await finishedText(service,j.id,asr.id);
      assert.equal(recognized.status,'complete',JSON.stringify(recognized));assert.deepEqual(recognized.processedRanges,[{start:1,end:3}]);
      assert.equal(recognized.audioSource.kind,'muxed-or-unknown');assert.ok(recognized.network.receivedBytes>0);
      assert.equal((await service.status(j.id)).statuses.visual,'complete');
    }
  }finally{await service.close();web.closeAllConnections();web.close();if(old===undefined)delete process.env.AGENT_VIDEO_TEST_NETWORK_ORIGIN;else process.env.AGENT_VIDEO_TEST_NETWORK_ORIGIN=old;}
});
