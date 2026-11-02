import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,readdir} from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {exec,FFMPEG,decode} from '../src/media.mjs';
import {createNetworkProxy,downloadNetworkFile} from '../src/network.mjs';
import {downloadVideo,processVideoRanges,videoAcquisitionError} from '../src/video-acquisition.mjs';

const root=path.resolve(process.env.AGENT_VIDEO_TEST_DIR||'work/validation',`video-fallback-${randomUUID()}`);await mkdir(root,{recursive:true});
const clip=path.join(root,'clip.mp4'),short=path.join(root,'short.mp4');
for(const [file,duration]of [[clip,6],[short,2]])await exec(FFMPEG,['-v','error','-n','-f','lavfi','-i',`testsrc2=s=160x90:r=12:d=${duration}`,
  '-c:v','libx264','-preset','ultrafast','-g','12','-movflags','+faststart',file],{windowsHide:true,timeout:20000});
await exec(FFMPEG,['-v','error','-n','-i',clip,'-c','copy','-hls_time','2','-hls_playlist_type','vod','-hls_segment_filename',path.join(root,'video-%d.ts'),path.join(root,'video.m3u8')],{windowsHide:true,timeout:20000});
await exec(FFMPEG,['-v','error','-n','-i',clip,'-c','copy','-f','dash','-seg_duration','2','video.mpd'],{windowsHide:true,timeout:20000,cwd:root});
const files=new Map();for(const file of await readdir(root))files.set('/'+file,await readFile(path.join(root,file)));
const requests=[];let slowActive=0,rangePasses=0;
const web=http.createServer((req,res)=>{
  const route=new URL(req.url,'http://fixture').pathname;requests.push({route,range:req.headers.range});
  if(route==='/private.mp4'){res.writeHead(302,{location:'http://127.0.0.1:9/private'});res.end();return;}
  if(route==='/rejected.mp4'){res.writeHead(403);res.end();return;}
  let data=files.get(route);
  if(route==='/fallback.mp4'){
    // The first range request belongs to probe; subsequent streaming requests
    // receive a shorter valid file. A complete GET still returns the full video.
    if(req.headers.range)rangePasses++;
    data=files.get(req.headers.range&&rangePasses>1?'/short.mp4':'/clip.mp4');
  }
  if(route==='/slow.mp4')data=files.get('/clip.mp4');
  if(!data){res.writeHead(404);res.end();return;}
  const match=/bytes=(\d+)-(\d*)/.exec(req.headers.range??''),start=Number(match?.[1]??0),end=match?.[2]?Math.min(Number(match[2]),data.length-1):data.length-1;
  if(start>=data.length){res.writeHead(416);res.end();return;}
  const type=route.endsWith('m3u8')?'application/vnd.apple.mpegurl':route.endsWith('mpd')?'application/dash+xml':'application/octet-stream';
  res.writeHead(match?206:200,{'content-length':end-start+1,'accept-ranges':'bytes','content-type':type,...(match?{'content-range':`bytes ${start}-${end}/${data.length}`}:{})});
  if(route!=='/slow.mp4'){res.end(data.subarray(start,end+1));return;}
  slowActive++;let at=start;
  const timer=setInterval(()=>{if(at>end){res.end();return;}const next=Math.min(end+1,at+512);res.write(data.subarray(at,next));at=next;},10);
  res.on('close',()=>{clearInterval(timer);slowActive--;});
});
await new Promise(r=>web.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${web.address().port}`;
test.after(()=>{web.closeAllConnections();web.close();});
console.log(`Video fallback artifacts: ${root}`);
async function context(name,route='/clip.mp4'){
  const directory=path.join(root,name);await mkdir(directory);
  const proxy=await createNetworkProxy({allowOrigin:[origin],upstream:null});return {directory,proxy,input:{url:origin+route,headers:{},proxy},expectedDuration:6};
}

test('stream success and source retry do not download',async()=>{
  for(const fails of [0,1]){
    let calls=0,downloads=0;const transfers=[],completed=[];
    await processVideoRanges({ranges:[{start:0,end:6}],videoFallback:'on_failure',runRange:async()=>{if(calls++<fails)throw videoAcquisitionError('Network connection reset');},
      download:async()=>{downloads++;},onRangeComplete:r=>completed.push(r),onTransfer:t=>transfers.push(t)});
    assert.equal(calls,fails+1);assert.equal(downloads,0);assert.deepEqual(completed,[{start:0,end:6}]);
    assert.equal(transfers.at(-1).mode,'stream');assert.equal(transfers.at(-1).status,'complete');
  }
});

test('two stream failures precede one full download; unfinished and subsequent ranges decode locally',async()=>{
  const ctx=await context('orchestration'),passes=[],transfers=[],completed=[],before=requests.length;
  try{
    await processVideoRanges({...ctx,ranges:[{start:1,end:3},{start:4,end:6}],onTransfer:t=>transfers.push(t),onRangeComplete:r=>completed.push(r),
      runRange:async p=>{passes.push(p);if(p.mode==='stream')throw videoAcquisitionError('Network media ended early');
        const run=await decode({mode:'file',file:p.file,...p.range,quality:'low',canvas:[160,90]},()=>{});const result=await run.done;assert.equal(result.code,0);assert.equal(result.frames,24);}});
    assert.deepEqual(passes.map(p=>p.mode),['stream','stream','local_download','local_download']);
    assert.equal(transfers.filter(t=>t.status==='download_complete').length,1);
    assert.equal(requests.slice(before).filter(r=>r.route==='/clip.mp4'&&!r.range).length,1);
    assert.deepEqual(completed,[{start:1,end:3},{start:4,end:6}]);
    assert.equal(transfers.at(-1).duration,6);assert.equal(transfers.at(-1).status,'complete');
  }finally{ctx.proxy.close();}
});

test('never, source rejection, output errors and cancellation do not trigger download',async()=>{
  for(const [message,policy,code]of [['Network connection lost','never','VIDEO_ACQUISITION_FAILED'],['HTTP 403 Forbidden','on_failure',undefined],['ENOSPC output','on_failure',undefined],['Network byte limit reached','on_failure',undefined]]){
    let downloads=0;const error=videoAcquisitionError(message);assert.equal(error.code,code);
    await assert.rejects(()=>processVideoRanges({ranges:[{start:0,end:6}],videoFallback:policy,runRange:async()=>{throw error;},download:async()=>{downloads++;}}));assert.equal(downloads,0);
  }
  const controller=new AbortController();controller.abort();let attempts=0;
  await assert.rejects(()=>processVideoRanges({ranges:[{start:0,end:6}],signal:controller.signal,runRange:async()=>{attempts++;}}),/cancel/);assert.equal(attempts,0);
});

test('full download enforces duration, byte limit, redirects and no overwrite',async()=>{
  const ctx=await context('validation');try{
    await assert.rejects(()=>downloadVideo({...ctx.input,url:origin+'/short.mp4'},ctx.directory,{expectedDuration:6}),/shorter/);
    await assert.rejects(()=>downloadVideo(ctx.input,ctx.directory,{expectedDuration:6,maxBytes:1000}),/limit/);
    await assert.rejects(()=>downloadVideo({...ctx.input,url:origin+'/private.mp4'},ctx.directory,{expectedDuration:6}),/public Internet/);
    const a=await downloadVideo(ctx.input,ctx.directory,{expectedDuration:6}),b=await downloadVideo(ctx.input,ctx.directory,{expectedDuration:6});
    assert.notEqual(a.file,b.file);assert.deepEqual(await readFile(a.file),files.get('/clip.mp4'));assert.equal(a.duration,6);
  }finally{ctx.proxy.close();}
});

test('HLS and DASH fallback materialize complete local video and decode offline',async()=>{
  const ctx=await context('manifests');try{for(const route of ['/video.m3u8','/video.mpd']){
    const result=await downloadVideo({...ctx.input,url:origin+route},ctx.directory,{expectedDuration:6});
    assert.equal(result.method,'complete_video_track_remux');assert.ok(result.duration>=5.9);
    const run=await decode({mode:'file',file:result.file,start:0,end:6,quality:'low',canvas:[160,90]},()=>{});const decoded=await run.done;
    assert.equal(decoded.code,0);assert.equal(decoded.frames,72);
  }}finally{ctx.proxy.close();}
});

test('cancelling full download closes connection and keeps partial evidence',async()=>{
  const ctx=await context('cancel','/slow.mp4'),controller=new AbortController();try{
    await assert.rejects(()=>downloadVideo(ctx.input,ctx.directory,{signal:controller.signal,expectedDuration:6,onProgress:()=>controller.abort()}),/cancel|abort/i);
    const deadline=Date.now()+1000;while(slowActive&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20));assert.equal(slowActive,0);
    assert.ok((await readdir(ctx.directory)).length>0);
  }finally{ctx.proxy.close();}
});

test('worker recovers truncated streams by full download, preserves partial sheets, and completes requested coverage',{timeout:45000},async()=>{
  rangePasses=0;const directory=path.join(root,'worker');await mkdir(directory);const messages=[];
  const worker=fork(fileURLToPath(new URL('../src/network-worker.mjs',import.meta.url)),[],{stdio:['ignore','ignore','pipe','ipc'],windowsHide:true,
    env:{...process.env,AGENT_VIDEO_TEST_NETWORK_ORIGIN:origin}});
  let stderr='';worker.stderr.on('data',b=>stderr+=b);worker.on('message',m=>messages.push(m));
  const done=new Promise((resolve,reject)=>{worker.once('exit',resolve);worker.once('error',reject);});
  worker.send({type:'start',spec:{mode:'url',url:origin+'/fallback.mp4',sourceType:'direct',analysis:'continuous',videoFallback:'on_failure',start:0,end:6,
    quality:'low',pace:'normal',scene:false,videoIndex:1,directory,maxRunSeconds:30,maxSheets:5000,maxBytes:2*1024**3,maxNetworkBytes:1024**3}});
  await done;
  const end=messages.findLast(m=>m.type==='end');assert.equal(end.status,'complete',JSON.stringify({end,stderr}));
  assert.equal(end.videoTransfer.mode,'download_fallback');assert.equal(end.videoTransfer.status,'complete');
  assert.deepEqual(end.completedRanges,[{start:0,end:6}]);
  const sheets=messages.filter(m=>m.type==='sheet');assert.ok(sheets.some(s=>s.info.sourcePass.mode==='stream'));assert.ok(sheets.some(s=>s.info.sourcePass.mode==='local_download'));
  assert.deepEqual(sheets.map(s=>s.info.index),Array.from({length:sheets.length},(_,i)=>i));
  const local=sheets.filter(s=>s.info.sourcePass.mode==='local_download');assert.equal(local[0].info.frames[0].t,0);assert.ok(local.at(-1).info.to>=5);
});
