import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,readdir,appendFile} from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {VideoService} from '../src/service.mjs';
import {exec,FFMPEG} from '../src/media.mjs';
import {wav} from '../src/audio.mjs';
import {audioSourceRange} from '../src/audio-service.mjs';

const root=path.resolve(process.env.AGENT_VIDEO_TEST_DIR||'work/validation',`audio-input-${randomUUID()}`);
await mkdir(root,{recursive:true});
const fixtures={};
for(const [extension,codec] of [['wav','pcm_s16le'],['mp3','libmp3lame'],['flac','flac'],['m4a','aac'],['ogg','libvorbis'],['opus','libopus']]){
  const file=path.join(root,'tone.'+extension);
  await exec(FFMPEG,['-v','error','-n','-f','lavfi','-i','sine=frequency=440:sample_rate=16000:duration=6','-c:a',codec,file],{windowsHide:true,timeout:15000});
  fixtures['/tone.'+extension]=await readFile(file);
}
const captions=path.join(root,'words.srt'),external=path.join(root,'external.json'),untimed=path.join(root,'untimed.json');
await writeFile(captions,'1\n00:00:00,000 --> 00:00:01,000\nOutside\n\n2\n00:00:02,000 --> 00:00:04,000\nOriginal supplied words\n\n3\n00:00:05,000 --> 00:00:06,000\nLater\n');
await writeFile(external,JSON.stringify({timeBase:'clip_relative_seconds',segments:[{start:0,end:1,text:'External original'}]}));
await writeFile(untimed,JSON.stringify({text:'Original untimed full text'}));
const slow=wav(Buffer.alloc(180*32000));
const unknown=wav(Buffer.alloc(6*32000));unknown.writeUInt32LE(0xffffffff,4);unknown.writeUInt32LE(0xffffffff,40);
let slowBytes=0,fullTransfers=0,slowActive=0;
const requests=[];
const web=http.createServer((req,res)=>{
  requests.push(req.url);
  if(req.url==='/unknown.wav'){res.setHeader('content-type','audio/wav');res.end(unknown);return;}
  if(req.url==='/audio-page'){
    res.setHeader('content-type','text/html');res.end('<html><head><title>Audio only fixture</title></head><body><audio controls src="/tone.mp3"></audio></body></html>');return;
  }
  if(req.url==='/caption.vtt'){res.end('WEBVTT\n\n00:02.000 --> 00:04.000\nOriginal network words\n');return;}
  if(req.url==='/redirect.wav'){res.writeHead(302,{location:'http://127.0.0.1:9/private.wav'});res.end();return;}
  const data=req.url==='/slow.wav'?slow:fixtures[new URL(req.url,'http://fixture').pathname];
  if(!data){res.writeHead(404);res.end();return;}
  const range=/bytes=(\d+)-(\d*)/.exec(req.headers.range??''),start=Number(range?.[1]??0),end=range?.[2]?Math.min(Number(range[2]),data.length-1):data.length-1;
  if(start>=data.length){res.writeHead(416);res.end();return;}
  res.writeHead(range?206:200,{'content-type':req.url.includes('.wav')?'audio/wav':'audio/mpeg','accept-ranges':'bytes','content-length':end-start+1,...(range?{'content-range':`bytes ${start}-${end}/${data.length}`}:{})});
  if(req.method==='HEAD'){res.end();return;}
  if(req.url!=='/slow.wav'){res.end(data.subarray(start,end+1));return;}
  slowActive++;let offset=start;
  const timer=setInterval(()=>{
    if(offset>end){if(start===0&&end===data.length-1)fullTransfers++;res.end();return;}
    const next=Math.min(offset+16384,end+1);res.write(data.subarray(offset,next));slowBytes+=next-offset;offset=next;
  },20);
  res.on('close',()=>{clearInterval(timer);slowActive--;});
});
await new Promise(r=>web.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${web.address().port}`;
const priorOrigin=process.env.AGENT_VIDEO_TEST_NETWORK_ORIGIN;process.env.AGENT_VIDEO_TEST_NETWORK_ORIGIN=origin;
test.after(()=>{web.closeAllConnections();web.close();if(priorOrigin===undefined)delete process.env.AGENT_VIDEO_TEST_NETWORK_ORIGIN;else process.env.AGENT_VIDEO_TEST_NETWORK_ORIGIN=priorOrigin;});
console.log('Audio-only validation artifacts: '+root);
const bind=(j,file,extra={})=>({id:j.id,mediaId:j.mediaId,file,bindingBasis:'Generated for this exact source fixture.',...extra});
async function ready(service,j){const st=await service.audio.status(j.id,20);assert.equal(st.status,'ready',JSON.stringify(st));return st;}
async function finished(service,id,trackId){let after=0,t;do{t=await service.text.read({id,trackId,after,waitSeconds:20});after=t.nextAfter;}while(['starting','running'].includes(t.status));return service.text.read({id,trackId,limit:500});}
async function noImages(j){const files=await readdir(j.directory,{recursive:true});assert.ok(!files.some(f=>/\.png$|sheet-/.test(f)),files.join(','));assert.equal(j.worker,null);assert.equal(j.kind,'audio');}

test('common local audio formats register without video workers, images or automatic ASR',async()=>{
  const service=new VideoService({dataDir:path.join(root,'formats')});
  try{
    for(const ext of ['wav','mp3','flac','m4a','ogg','opus']){
      const j=await ready(service,await service.audio.start({file:path.join(root,'tone.'+ext)}));
      assert.equal(j.statuses.visual,'not_applicable');assert.equal(j.statuses.transcript,'not_enabled');assert.equal(j.audioAnalyzed,false);
      assert.ok(j.metadata.hasAudio);assert.ok(j.range.end>5.9);assert.equal(j.timeBase,'source_media_seconds');
      await noImages(await service.job(j.id));
    }
    await assert.rejects(()=>service.audio.start({file:path.join(root,'tone.wav'),start:4,end:3}),/range/);
    const invalid=await service.audio.start({file:path.join(root,'tone.wav'),end:30});assert.equal((await service.audio.status(invalid.id,20)).status,'error');
  }finally{await service.close();}
});

test('audio-bound subtitles/JSON preserve source/offset, range coverage and unaligned text without ASR',async()=>{
  const service=new VideoService({dataDir:path.join(root,'imports')});
  try{
    const j=await ready(service,await service.audio.start({file:path.join(root,'tone.wav'),start:2,end:4}));
    await assert.rejects(()=>service.text.import(bind(j,captions,{mediaId:'wrong'})),/mediaId/);
    const track=await service.text.import(bind(j,captions));const text=await service.text.read({id:j.id,trackId:track.id});
    assert.equal(text.segments.length,1);assert.equal(text.segments[0].text,'Original supplied words');assert.equal(text.binding.syncVerified,false);
    assert.deepEqual(text.processedRanges,[{start:2,end:4}]);assert.equal(text.source.type,'subtitle');
    const other=await service.text.import(bind(j,external,{offsetSeconds:2,sourceType:'external_transcript'}));
    const mapped=await service.text.read({id:j.id,trackId:other.id});assert.equal(mapped.segments[0].start,2);assert.equal(mapped.segments[0].originalStart,0);
    const full=await service.text.import(bind(j,untimed));const raw=await service.text.read({id:j.id,trackId:full.id});assert.equal(raw.alignment,'unaligned');assert.equal(raw.unalignedText,'Original untimed full text');assert.deepEqual(raw.segments,[]);
    await assert.rejects(()=>service.sheet(j.id,0),/no images/);await assert.rejects(()=>service.nextSaved(j.id),/no images/);
    await assert.rejects(()=>service.text.evidence({id:j.id,start:2,end:4}),/transcript_read/);
    await noImages(await service.job(j.id));
  }finally{await service.close();}
});

test('HTTP direct and real yt-dlp audio page open independently; network subtitles reuse the selected source',async()=>{
  const service=new VideoService({dataDir:path.join(root,'urls')});
  try{
    for(const args of [{url:origin+'/tone.mp3'},{url:origin+'/tone.flac?token=not-persisted'},{url:origin+'/tone.wav',sourceType:'direct'},{url:origin+'/audio-page',sourceType:'page'}]){
      const j=await ready(service,await service.audio.start({...args,start:2,end:4},true));
      assert.ok(j.network.receivedBytes>0);assert.equal(j.range.start,2);assert.equal(j.source.includes('token='),false);
      assert.ok(!(await readFile(j.manifest,'utf8')).includes('not-persisted'));
      if(args.sourceType==='page')assert.equal(j.metadata.resolver,'yt-dlp');
      const internal=await service.job(j.id);assert.ok(internal.resolved.resources.audio);
      internal.resolved.resources.subtitles=[{id:'manual:en',language:'en',category:'manual',format:'vtt',url:origin+'/caption.vtt',headers:{}}];
      const list=await service.text.start({id:j.id,mode:'subtitles'});assert.equal(list.availableTracks.length,1);assert.ok(!JSON.stringify(list).includes('caption.vtt'));
      const track=await service.text.start({id:j.id,mode:'subtitles',trackId:'manual:en'});const text=await finished(service,j.id,track.id);
      assert.equal(text.status,'complete',JSON.stringify(text));assert.equal(text.segments[0].text,'Original network words');await noImages(internal);
    }
    const denied=await service.audio.start({url:origin+'/redirect.wav'},true);assert.equal((await service.audio.status(denied.id,20)).status,'error');
  }finally{await service.close();}
});

test('source preparation cancellation closes slow HTTP connections and survives restart',async()=>{
  const directory=path.join(root,'cancel-source'),service=new VideoService({dataDir:directory});
  let id;
  try{
    const j=await service.audio.start({url:origin+'/slow.wav'},true);id=j.id;
    const deadline=Date.now()+5000;while(slowActive===0&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20));
    assert.ok(slowActive>0,'cancel after a real probe connection has started');
    const stopped=await service.stop(id);assert.equal(stopped.status,'stopped');
    await new Promise(r=>setTimeout(r,100));assert.equal(slowActive,0);assert.equal(service.audio.running.size,0);await noImages(await service.job(id));
  }finally{await service.close();}
  const restored=new VideoService({dataDir:directory});try{assert.equal((await restored.audio.status(id)).status,'stopped');}finally{await restored.close();}
});

test('missing audio duration needs an explicit finite range; chunked audio may reveal its actual duration at EOF',async()=>{
  assert.throws(()=>audioSourceRange({start:0},null),/finite duration|explicit end/);
  assert.deepEqual(audioSourceRange({start:1,end:3},null),{start:1,end:3});
  assert.throws(()=>audioSourceRange({start:1,end:Infinity},null),/finite duration/);
  const service=new VideoService({dataDir:path.join(root,'unknown-duration')});
  try{
    const missing=await service.audio.start({url:origin+'/unknown.wav'},true);
    const detected=await ready(service,missing);assert.equal(detected.metadata.duration,6,'FFprobe determined this finite fixture duration, rather than leaving it unknown');
    const j=await ready(service,await service.audio.start({url:origin+'/unknown.wav',start:1,end:3},true));
    assert.deepEqual(j.range,{start:1,end:3});await noImages(await service.job(j.id));
  }finally{await service.close();}
});

test('audio-only MCP works with no Skill/ASR: schema, help, source binding and original text',async()=>{
  const client=new Client({name:'audio-only-mcp-test',version:'1.0.0'});let id;
  try{
    await client.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../src/server.mjs',import.meta.url))],
      env:{...process.env,AGENT_VIDEO_DATA_DIR:path.join(root,'mcp'),AGENT_VIDEO_ASR_CONFIG:path.join(root,'no-asr.json')},stderr:'pipe'}));
    const tools=(await client.listTools()).tools;assert.equal(tools.length,19);assert.equal(client.getServerVersion().version,'0.8.0');
    for(const name of ['audio_start','audio_url_start','audio_status'])assert.ok(tools.some(t=>t.name===name));
    const call=async(name,args={})=>{const value=await client.callTool({name,arguments:args});assert.ok(!value.isError,JSON.stringify(value));assert.ok(value.content.every(c=>c.type==='text'));return JSON.parse(value.content[0].text);};
    const help=await client.callTool({name:'video_help',arguments:{}});assert.ok(help.content[0].text.includes('audio_start'),'standalone guide documents audio_start');assert.match(client.getInstructions(),/Audio-only/);
    const started=await call('audio_start',{file:path.join(root,'tone.wav'),start:2,end:4});id=started.id;
    const source=await call('audio_status',{id,waitSeconds:20});assert.equal(source.status,'ready');
    await call('transcript_import',bind(source,captions));
    const text=await call('transcript_read',{id});assert.equal(text.segments[0].text,'Original supplied words');
    const unavailable=await client.callTool({name:'transcript_start',arguments:{id,mode:'asr'}});assert.equal(unavailable.isError,true);
    const retained=await call('transcript_read',{id});assert.equal(retained.segments[0].text,'Original supplied words');
    await call('session_stop',{id});assert.equal((await call('audio_status',{id})).status,'stopped');
  }finally{await client.close();}
});

test('real optional ASR transcribes a standalone local file and survives changed-source rejection',
  {skip:process.env.AGENT_VIDEO_TEST_ASR!=='1',timeout:60000},async()=>{
  const service=new VideoService({dataDir:path.join(root,'real-asr')});
  try{
    const sample=process.env.AGENT_VIDEO_ASR_SAMPLE;assert.ok(sample);
    const j=await ready(service,await service.audio.start({file:sample}));
    const track=await service.text.start({id:j.id,mode:'asr',language:'en'});const t=await finished(service,j.id,track.id);
    assert.equal(t.status,'complete',JSON.stringify(t));assert.ok(t.segments.some(s=>/country/i.test(s.text)));assert.equal(t.source.type,'asr');
    assert.ok(t.segments.every(s=>s.start>=0&&s.end<=j.range.end+0.1));assert.ok(t.processedRanges.length);await noImages(await service.job(j.id));
    const mutable=path.join(root,'mutable.wav');await writeFile(mutable,fixtures['/tone.wav']);
    const old=await ready(service,await service.audio.start({file:mutable,start:1,end:2}));await appendFile(mutable,Buffer.from([0,0]));
    await assert.rejects(()=>service.text.import(bind(old,captions)),/version changed/);
    const stale=await service.text.start({id:old.id,mode:'asr'});assert.equal((await finished(service,old.id,stale.id)).status,'error');
  }finally{await service.close();}
});

test('network audio processes an early block before full transfer; cancel stops the decoder and preserves coverage',
  {skip:process.env.AGENT_VIDEO_TEST_ASR!=='1',timeout:40000},async()=>{
  const service=new VideoService({dataDir:path.join(root,'stream')});const before=performance.now();let pid;
  try{
    const j=await ready(service,await service.audio.start({url:origin+'/slow.wav'},true));
    const track=await service.text.start({id:j.id,mode:'asr'});
    const internal=await service.job(j.id),deadline=Date.now()+25000;
    while(!internal.transcriptTracks?.find(t=>t.id===track.id)?.processedRanges.length&&Date.now()<deadline)await new Promise(r=>setTimeout(r,30));
    const t=await service.text.read({id:j.id,trackId:track.id});
    assert.equal(t.status,'running',JSON.stringify({status:t.status,error:t.error}));assert.ok(t.processedRanges.length);assert.equal(fullTransfers,0);assert.ok(slowBytes<slow.length);
    pid=t.audioPid;assert.ok(pid);assert.equal(t.lastBlock.backendMetrics.backendInvoked,false,'digital silence is processed without loading ASR');
    await service.stop(j.id);const stopped=await service.text.read({id:j.id,trackId:track.id});assert.equal(stopped.status,'stopped');assert.ok(stopped.processedRanges.length);
    await new Promise(r=>setTimeout(r,150));assert.equal(slowActive,0);assert.throws(()=>process.kill(pid,0));await noImages(internal);
    console.log(JSON.stringify({benchmark:'audio streaming/cancel, digital silence fixture',firstProcessedBlockMs:Math.round(performance.now()-before),receivedBytes:slowBytes,fullAudioBytes:slow.length}));
  }finally{await service.close();}
});
