import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readdir,readFile,writeFile} from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {wav} from '../src/audio.mjs';
import {resilientAudioBlocks,downloadAudio} from '../src/audio-acquisition.mjs';
import {createNetworkProxy,downloadNetworkFile} from '../src/network.mjs';
import {exec,FFMPEG} from '../src/media.mjs';
import {VideoService} from '../src/service.mjs';

const root=path.resolve(process.env.AGENT_VIDEO_TEST_DIR||'work/validation',`audio-fallback-${randomUUID()}`);await mkdir(root,{recursive:true});
const full=wav(Buffer.alloc(6*32000)),short=full.subarray(0,44+3*32000),requests=[];
const av=path.join(root,'av.mp4');await exec(FFMPEG,['-v','error','-n','-f','lavfi','-i','color=c=red:s=64x36:r=2:d=6','-f','lavfi','-i','sine=duration=6','-c:v','libx264','-c:a','aac','-movflags','+faststart',av],{windowsHide:true,timeout:20000});
const mp4=await readFile(av);
await exec(FFMPEG,['-v','error','-n','-i',av,'-map','0:a:0','-c:a','copy','-hls_playlist_type','vod','-hls_flags','temp_file','-hls_time','2','-hls_segment_filename',path.join(root,'audio-%d.ts'),path.join(root,'audio.m3u8')],{windowsHide:true,timeout:20000});
const assets=new Map();for(const name of await readdir(root))if(/\.(ts|m3u8)$/.test(name))assets.set('/'+name,await readFile(path.join(root,name)));
let activeDownloads=0;
let rangedRetry=0;
let limitControlled=false;
const web=http.createServer((req,res)=>{
  requests.push({path:req.url,range:req.headers.range??null});
  if(assets.has(req.url)){const data=assets.get(req.url);res.writeHead(200,{'content-length':data.length,'content-type':req.url.endsWith('.m3u8')?'application/vnd.apple.mpegurl':'application/octet-stream'});res.end(data);return;}
  if(req.url==='/slowdownload.wav'){
    activeDownloads++;res.writeHead(200,{'content-length':full.length,'content-type':'audio/wav'});let at=0;
    const timer=setInterval(()=>{if(at>=full.length){res.end();return;}const next=Math.min(at+16384,full.length);res.write(full.subarray(at,next));at=next;},20);
    res.on('close',()=>{clearInterval(timer);activeDownloads--;});return;
  }
  if(req.url==='/rejected.wav'){res.writeHead(403);res.end();return;}
  if(req.url==='/private.wav'){res.writeHead(302,{location:'http://127.0.0.1:9/secret'});res.end();return;}
  const hasRange=!!req.headers.range;
  if(req.url==='/retry.wav'&&hasRange)rangedRetry++;
  const limited=req.url==='/controlled.wav'?limitControlled&&hasRange:req.url==='/always-short.wav'?hasRange:req.url==='/retry.wav'?rangedRetry===1:req.url==='/broken.wav';
  const data=req.url==='/av.mp4'?mp4:limited?short:full;
  const m=/bytes=(\d+)-(\d*)/.exec(req.headers.range??''),start=Number(m?.[1]??0),end=m?.[2]?Math.min(Number(m[2]),data.length-1):data.length-1;
  if(start>=data.length){res.writeHead(416);res.end();return;}
  res.writeHead(m?206:200,{'content-type':req.url==='/av.mp4'?'video/mp4':'audio/wav','accept-ranges':'bytes','content-length':end-start+1,...(m?{'content-range':`bytes ${start}-${end}/${data.length}`}:{})});
  res.end(data.subarray(start,end+1));
});
await new Promise(r=>web.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${web.address().port}`;
test.after(()=>{web.closeAllConnections();web.close();});
async function context(name,route){const directory=path.join(root,name);await mkdir(directory);const proxy=await createNetworkProxy({allowOrigin:[origin],upstream:null});return {directory,input:{url:origin+route,headers:{},kind:'audio-only',proxy},proxy};}
async function collect(ctx,extra={}){
  const transfers=[],blocks=[];
  for await(const b of resilientAudioBlocks({...ctx,start:0,end:6,chunkSeconds:2,contextSeconds:0,expectedDuration:6,onTransfer:state=>transfers.push({...state}),...extra}))blocks.push(b);
  return {transfers,blocks};
}
function contiguous(blocks){let at=0;for(const b of blocks){assert.equal(b.coreStart,at);at=b.coreEnd;}assert.equal(at,6);assert.equal(new Set(blocks.map(b=>b.index)).size,blocks.length);}

test('healthy streaming never downloads; interrupted streaming retries before fallback',async()=>{
  for(const [name,route] of [['healthy','/full.wav'],['retry','/retry.wav']]){
    const ctx=await context(name,route);try{
      const {blocks,transfers}=await collect(ctx);contiguous(blocks);assert.ok(transfers.every(t=>t.mode==='stream'));
      if(name==='retry')assert.ok(requests.filter(r=>r.path===route).length>1,'HTTP-level or source-level streaming retry must precede any download');
      assert.ok(!requests.some(r=>r.path===route&&!r.range),'complete GET must not run when streaming succeeds');
    }finally{ctx.proxy.close();}
  }
});

test('complete-audio download only follows two failed streams; local decode resumes with no gaps or reused IDs',async()=>{
  const ctx=await context('fallback','/always-short.wav');try{
    const {blocks,transfers}=await collect(ctx);contiguous(blocks);
    assert.ok(transfers.some(t=>t.streamAttempt===2));assert.ok(transfers.some(t=>t.mode==='download_fallback'&&t.status==='downloading'));
    assert.equal(transfers.at(-1).status,'complete');assert.equal(transfers.at(-1).mode,'download_fallback');
    const downloaded=transfers.find(t=>t.status==='download_complete');assert.equal(downloaded.bytes,full.length);assert.equal(downloaded.duration,6);
    assert.ok(requests.some(r=>r.path==='/always-short.wav'&&!r.range));assert.equal(blocks.at(-1).coreEnd,6);
  }finally{ctx.proxy.close();}
});

test('fallback=never, source rejection and spool limits do not download',async()=>{
  for(const [name,route,options,pattern] of [['never','/always-short.wav',{audioFallback:'never'},/samples|ended|decoder/],['auth','/rejected.wav',{},/403/],['cap','/full.wav',{maxSpoolBytes:1000},/spool/]]){
    const before=requests.length,ctx=await context(name,route),transfers=[];try{
      await assert.rejects(()=>collect(ctx,{...options,onTransfer:s=>transfers.push({...s})}),pattern);
      assert.ok(transfers.every(t=>t.mode==='stream'));assert.ok(!requests.slice(before).some(r=>!r.range));
    }finally{ctx.proxy.close();}
  }
});

test('an ASR consumer failure/cancellation does not cause a download or second stream',async()=>{
  const ctx=await context('consumer','/full.wav'),transfers=[];try{
    await assert.rejects(async()=>{for await(const b of resilientAudioBlocks({...ctx,start:0,end:6,onTransfer:s=>transfers.push(s)}))throw new Error('ASR backend failed');},/ASR backend/);
    assert.equal(transfers.length,1);assert.ok(transfers.every(t=>t.mode==='stream'));
    const abort=new AbortController();abort.abort();
    await assert.rejects(()=>collect({...ctx,directory:path.join(ctx.directory,'cancel')},{signal:abort.signal}),/cancel|abort/i);
  }finally{ctx.proxy.close();}
});

test('download validates completeness/size and every redirected address; no partial download is marked complete',async()=>{
  const ctx=await context('download-validation','/broken.wav');try{
    await assert.rejects(()=>downloadAudio(ctx.input,path.join(ctx.directory,'short'),{expectedDuration:6,requiredEnd:6}),/shorter/);
    await assert.rejects(()=>downloadNetworkFile({...ctx.input,url:origin+'/full.wav'},path.join(ctx.directory,'capped.audio'),{maxBytes:1000}),/limit/);
    await assert.rejects(()=>downloadNetworkFile({...ctx.input,url:origin+'/private.wav'},path.join(ctx.directory,'private.audio')),/public Internet/);
    assert.ok(!(await readdir(ctx.directory)).includes('private.audio'));
  }finally{ctx.proxy.close();}
});

test('fallback from a muxed source stores audio only',async()=>{
  const ctx=await context('muxed','/av.mp4');try{
    const result=await downloadAudio({...ctx.input,kind:'muxed'},path.join(ctx.directory,'download'),{expectedDuration:6,requiredEnd:6});
    assert.equal(result.method,'complete_audio_remux');
    const {stdout}=await exec(process.env.AGENT_VIDEO_FFPROBE||'ffprobe',['-v','error','-show_entries','stream=codec_type','-of','json',result.file],{windowsHide:true});
    const streams=JSON.parse(stdout).streams;assert.ok(streams.some(s=>s.codec_type==='audio'));assert.ok(!streams.some(s=>s.codec_type==='video'));
  }finally{ctx.proxy.close();}
});

test('manifest fallback materializes only its audio and validates duration',async()=>{
  const ctx=await context('manifest','/audio.m3u8');try{
    const result=await downloadAudio({...ctx.input,protocol:'m3u8_native'},path.join(ctx.directory,'download'),{expectedDuration:6,requiredEnd:6});
    assert.equal(result.method,'complete_audio_remux');assert.ok(result.duration>5.5);assert.ok(result.bytes>0);
  }finally{ctx.proxy.close();}
});

test('cancelling the full download stops the connection and never starts local decoding',async()=>{
  const ctx=await context('cancel-download','/slowdownload.wav'),controller=new AbortController();
  try{
    await assert.rejects(()=>downloadAudio(ctx.input,path.join(ctx.directory,'download'),{signal:controller.signal,expectedDuration:6,requiredEnd:6,onProgress:()=>controller.abort()}),/abort|cancel/i);
    const end=Date.now()+1000;while(activeDownloads&&Date.now()<end)await new Promise(r=>setTimeout(r,20));assert.equal(activeDownloads,0);
    assert.ok(!(await readdir(ctx.directory)).includes('download-decode'));
  }finally{ctx.proxy.close();}
});

test('transcript service exposes fallback provenance and source coverage; never policy preserves partial status',
  {skip:process.env.AGENT_VIDEO_TEST_ASR!=='1',timeout:30000},async()=>{
  const prior=process.env.AGENT_VIDEO_TEST_NETWORK_ORIGIN;process.env.AGENT_VIDEO_TEST_NETWORK_ORIGIN=origin;
  const service=new VideoService({dataDir:path.join(root,'service')});
  const finished=async(id,trackId)=>{let t,after=0;do{t=await service.text.read({id,trackId,after,waitSeconds:20});after=t.nextAfter;}while(['starting','running'].includes(t.status));return t;};
  try{
    limitControlled=false;const j=await service.audio.start({url:origin+'/controlled.wav'},true);
    assert.equal((await service.audio.status(j.id,20)).status,'ready');limitControlled=true;
    const track=await service.text.start({id:j.id,mode:'asr',audioFallback:'on_failure'}),text=await finished(j.id,track.id);
    assert.equal(text.status,'complete',JSON.stringify({status:text.status,error:text.error}));assert.equal(text.audioTransfer.mode,'download_fallback');
    assert.equal(text.audioTransfer.status,'complete');assert.equal(text.speechStatus,'no_speech');assert.equal(text.processedRanges.at(-1).end,6);
    const before=requests.length,disabled=await service.text.start({id:j.id,mode:'asr',audioFallback:'never',force:true});
    const partial=await finished(j.id,disabled.id);assert.equal(partial.status,'error');assert.ok(partial.processedRanges.at(-1).end<6);
    assert.ok(!requests.slice(before).some(r=>!r.range));
  }finally{limitControlled=false;await service.close();if(prior===undefined)delete process.env.AGENT_VIDEO_TEST_NETWORK_ORIGIN;else process.env.AGENT_VIDEO_TEST_NETWORK_ORIGIN=prior;}
});
