import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { mkdir,readFile,writeFile,readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { VideoService } from '../src/service.mjs';
import { exec,FFMPEG } from '../src/media.mjs';
import { createNetworkProxy,isPublicIP,webUrl,runNetworkCommand } from '../src/network.mjs';
import { networkPlan } from '../src/network-worker.mjs';

const root=path.resolve(process.env.AGENT_VIDEO_TEST_DIR||'work/validation',`network-${randomUUID()}`);
await mkdir(root,{recursive:true});
const clip=path.join(root,'clip.mp4'),long=path.join(root,'long.mp4');
await exec(FFMPEG,['-v','error','-n','-f','lavfi','-i','testsrc2=s=320x180:r=12:d=8','-c:v','libx264','-preset','ultrafast','-g','24','-movflags','+faststart',clip],{windowsHide:true,timeout:20000});
await exec(FFMPEG,['-v','error','-n','-f','lavfi','-i','testsrc2=s=640x360:r=12:d=60','-c:v','libx264','-preset','ultrafast','-g','24','-movflags','+faststart',long],{windowsHide:true,timeout:20000});
await exec(FFMPEG,['-v','error','-n','-i',clip,'-c','copy','-hls_time','2','-hls_list_size','0','-hls_playlist_type','vod','-hls_flags','temp_file','-hls_segment_filename',path.join(root,'segment-%d.ts'),path.join(root,'video.m3u8')],{windowsHide:true,timeout:20000});
assert.match(await readFile(path.join(root,'video.m3u8'),'utf8'),/#EXT-X-ENDLIST/,'The fixture must be finalized VOD, not an unfinished live playlist.');
await exec(FFMPEG,['-v','error','-n','-i',clip,'-c','copy','-f','dash','-seg_duration','2','video.mpd'],{windowsHide:true,timeout:20000,cwd:root});
const files=new Map();for(const file of await readdir(root))files.set('/'+file,await readFile(path.join(root,file)));
files.set('/slow.mp4',files.get('/long.mp4'));
let slowActive=0,slowBytes=0,slowFinished=0,rangeRequests=0;
const web=http.createServer((req,res)=>{
  const name=new URL(req.url,'http://fixture').pathname;
  if(name==='/watch'){res.setHeader('content-type','text/html');res.end('<html><head><title>Adaptive vision fixture</title></head><body><video controls src="/clip.mp4"></video></body></html>');return;}
  if(name==='/multi'){res.setHeader('content-type','text/html');res.end('<html><head><title>Two videos</title></head><body><video src="/clip.mp4"></video><video src="/long.mp4"></video></body></html>');return;}
  if(name==='/private.mp4'){res.writeHead(302,{location:'http://127.0.0.1:9/private'});res.end();return;}
  if(name==='/bad.m3u8'){res.end('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nhttp://127.0.0.1:9/private.ts\n#EXT-X-ENDLIST\n');return;}
  const data=files.get(name);if(!data){res.writeHead(404);res.end();return;}
  const match=/bytes=(\d+)-(\d*)/.exec(req.headers.range??'');
  const start=match?Number(match[1]):0,end=match?.[2]?Math.min(Number(match[2]),data.length-1):data.length-1;
  if(start>=data.length){res.writeHead(416,{'content-range':`bytes */${data.length}`});res.end();return;}
  const headers={'accept-ranges':'bytes','content-length':end-start+1,'content-type':name.endsWith('.mp4')?'video/mp4':name.endsWith('.m3u8')?'application/vnd.apple.mpegurl':name.endsWith('.mpd')?'application/dash+xml':'application/octet-stream'};
  if(match){headers['content-range']=`bytes ${start}-${end}/${data.length}`;rangeRequests++;}
  res.writeHead(match?206:200,headers);
  if(req.method==='HEAD'){res.end();return;}
  if(name!=='/slow.mp4'){res.end(data.subarray(start,end+1));return;}
  slowActive++;let offset=start;
  const timer=setInterval(()=>{if(offset>end){slowFinished++;res.end();return;}const to=Math.min(offset+16384,end+1);res.write(data.subarray(offset,to));slowBytes+=to-offset;offset=to;},40);
  res.on('close',()=>{clearInterval(timer);slowActive--;});
});
await new Promise(r=>web.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${web.address().port}`;
process.env.AGENT_VIDEO_TEST_NETWORK_ORIGIN=origin;
test.after(()=>{web.closeAllConnections();web.close();});
console.log(`Network validation artifacts: ${root}`);

test('URL boundary, private addresses and overview coverage',async()=>{
  for(const value of ['file:///C:/secret','ftp://example.org/a','https://user:pass@example.org/a'])assert.throws(()=>webUrl(value));
  for(const ip of ['127.0.0.1','10.2.3.4','169.254.169.254','::1','::ffff:127.0.0.1','192.168.2.1'])assert.equal(isPublicIP(ip),false,ip);
  for(const ip of ['1.1.1.1','8.8.8.8','2606:4700:4700::1111'])assert.equal(isPublicIP(ip),true,ip);
  const p=await createNetworkProxy();try{await assert.rejects(()=>p.validate(origin),/public Internet/);}finally{p.close();}
  const plan=networkPlan({analysis:'overview',samples:4,start:10,end:100},{duration:120});
  assert.equal(plan.length,4);assert.equal(plan[0].start,10);assert.equal(plan.at(-1).end,100);assert.ok(plan.reduce((a,x)=>a+x.end-x.start,0)<=8.01);
});

test('configured upstream proxy receives a CONNECT authority including default port',{timeout:10000},async()=>{
  let authority;const upstream=http.createServer();
  upstream.on('connect',(req,socket)=>{authority=req.url;socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');socket.on('data',()=>socket.write('PONG'));});
  await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
  const p=await createNetworkProxy({upstream:`http://127.0.0.1:${upstream.address().port}`});
  let socket;
  try{
    await new Promise((resolve,reject)=>{
      socket=net.connect({host:'127.0.0.1',port:new URL(p.url).port});let data='',ping=false;
      socket.on('error',reject);socket.setTimeout(5000,()=>reject(new Error('CONNECT timeout')));
      socket.on('connect',()=>socket.write('CONNECT 1.1.1.1:443 HTTP/1.1\r\nHost: 1.1.1.1:443\r\n\r\n'));
      socket.on('data',chunk=>{data+=chunk.toString();if(!ping&&data.includes('\r\n\r\n')){ping=true;socket.write('PING');}if(data.includes('PONG'))resolve();});
    });
    assert.equal(authority,'1.1.1.1:443');assert.equal(p.stats.usesConfiguredProxy,true);assert.ok(p.stats.receivedBytes>=4);
  }finally{socket?.destroy();p.close();upstream.close();}
});

test('cancelling a resolver command terminates its owned subprocess',{timeout:10000},async()=>{
  const pidFile=path.join(root,'command-pid.txt'),controller=new AbortController();
  const code=`require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`;
  const run=runNetworkCommand(process.execPath,['-e',code],{signal:controller.signal});
  const rejected=assert.rejects(run,/cancelled/);
  let pid;
  for(let i=0;i<30&&!pid;i++){try{pid=Number(await readFile(pidFile,'utf8'));}catch{await new Promise(r=>setTimeout(r,50));}}
  assert.ok(pid);controller.abort();await rejected;assert.throws(()=>process.kill(pid,0));
});

test('HTTP stream emits first image before full transfer; stop closes connections and FFmpeg',{timeout:30000},async()=>{
  const s=new VideoService({dataDir:path.join(root,'stream')});let pid;
  try{
    const before=performance.now(),job=await s.startUrl({url:origin+'/slow.mp4'});
    const first=await s.nextSaved(job.id,-1,15);
    assert.ok(first.data?.length>100,JSON.stringify(first.info));
    assert.equal(first.info.status,'running');assert.equal(first.info.index,0);
    assert.equal(slowFinished,0);assert.ok(slowBytes<files.get('/long.mp4').length);
    pid=(await s.status(job.id)).capturePid;
    console.log(JSON.stringify({benchmark:'throttled HTTP input, no model generation',firstImageMs:Math.round(performance.now()-before),receivedBeforeFirstImage:slowBytes,fullVideoBytes:files.get('/long.mp4').length}));
    assert.equal((await s.stop(job.id)).status,'stopped');
  }finally{await s.close();}
  await new Promise(r=>setTimeout(r,300));assert.equal(slowActive,0);if(pid)assert.throws(()=>process.kill(pid,0));
});

test('HTTP range, source timestamps, saved-image replay and token redaction',{timeout:30000},async()=>{
  const s=new VideoService({dataDir:path.join(root,'ranges')});let id;
  try{
    const j=await s.startUrl({url:origin+'/clip.mp4?secret=do-not-persist',start:4,end:6,scene:true});id=j.id;
    const st=await s.status(id,20);assert.equal(st.status,'complete',JSON.stringify(st));assert.equal(st.stats.frames,24);assert.equal(st.coverage.completeTimeline,true);
    const img=await s.nextSaved(id,-1,0);assert.equal(img.info.frames[0].t,4);assert.ok(rangeRequests>0);
    assert.ok(!(await readFile(st.manifest,'utf8')).includes('do-not-persist'));
    assert.ok((await s.sheet(id,0)).data.equals(img.data));
  }finally{await s.close();}
  const reload=new VideoService({dataDir:path.join(root,'ranges')});try{assert.equal((await reload.status(id)).status,'complete');assert.ok((await reload.sheet(id,0)).data);}finally{await reload.close();}
});

test('HLS and DASH stream through the proxy; original frames selected in order',{timeout:45000},async()=>{
  const s=new VideoService({dataDir:path.join(root,'manifests')});
  try{for(const file of ['video.m3u8','video.mpd']){
    const j=await s.startUrl({url:origin+'/'+file,start:2,end:6});const st=await s.status(j.id,20);
    assert.equal(st.status,'complete',JSON.stringify(st));assert.equal(st.stats.frames,48);assert.ok(st.network.receivedBytes>0);
    const frames=[];for(let i=0;i<st.sheets;i++)frames.push(...(await s.sheet(j.id,i)).info.frames.map(x=>x.t));
    assert.ok(frames.every((t,i)=>t>=2&&t<6&&(!i||t>=frames[i-1])));assert.ok(frames.length>0);
  }}finally{await s.close();}
});

test('overview samples separated windows and never reports full coverage',{timeout:30000},async()=>{
  const s=new VideoService({dataDir:path.join(root,'overview')});
  try{const j=await s.startUrl({url:origin+'/long.mp4',analysis:'overview',samples:3});const st=await s.status(j.id,20);
    assert.equal(st.status,'complete',JSON.stringify(st));assert.equal(st.stats.frames,72);assert.equal(st.coverage.completeTimeline,false);
    assert.deepEqual(st.coverage.completedRanges,[{start:0,end:2},{start:29,end:31},{start:58,end:60}]);
    assert.ok(st.network.receivedBytes<files.get('/long.mp4').length,'seekable overview should avoid full transfer');
  }finally{await s.close();}
});

test('actual yt-dlp resolves an HTML video page without a media download',{timeout:45000},async()=>{
  const s=new VideoService({dataDir:path.join(root,'pages')});
  try{const j=await s.startUrl({url:origin+'/watch',end:2});const st=await s.status(j.id,20);
    assert.equal(st.status,'complete',JSON.stringify(st));assert.equal(st.metadata.resolver,'yt-dlp');assert.ok(st.sheets>0);
    assert.ok((await readdir(st.directory)).every(f=>f.endsWith('.json')||f.endsWith('.png')));
  }finally{await s.close();}
});

test('multi-video page chooses the explicitly requested index',{timeout:30000},async()=>{
  const s=new VideoService({dataDir:path.join(root,'multi')});
  try{const j=await s.startUrl({url:origin+'/multi',videoIndex:2,end:2});const st=await s.status(j.id,20);
    assert.equal(st.status,'complete',JSON.stringify(st));assert.equal(st.metadata.pageVideoIndex,2);assert.equal(st.metadata.duration,60);
  }finally{await s.close();}
});

test('redirects and nested HTTP manifest requests cannot reach private hosts',{timeout:45000},async()=>{
  const s=new VideoService({dataDir:path.join(root,'blocked')});
  try{for(const file of ['private.mp4','bad.m3u8']){const j=await s.startUrl({url:origin+'/'+file,end:2});const st=await s.status(j.id,20);assert.equal(st.status,'error',JSON.stringify(st));assert.equal(st.sheets,0);}}
  finally{await s.close();}
});

test('MCP URL start defaults to metadata; explicit firstImage keeps ordered image receipts',{timeout:30000},async()=>{
  const client=new Client({name:'network-integration',version:'1.0.0'});
  const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../src/server.mjs',import.meta.url))],env:{...process.env,AGENT_VIDEO_DATA_DIR:path.join(root,'mcp')},stderr:'pipe'});
  let id;
  try{
    await client.connect(transport);assert.equal(client.getServerVersion().version,'0.9.0');
    const tools=(await client.listTools()).tools;
    assert.equal(tools.find(t=>t.name==='video_url_start').inputSchema.properties.firstImage.type,'boolean');
    const metadata=await client.callTool({name:'video_url_start',arguments:{url:origin+'/clip.mp4',end:4,scene:true}});
    assert.ok(!metadata.isError,JSON.stringify(metadata));const job=JSON.parse(metadata.content[0].text);
    assert.equal(metadata.content.filter(x=>x.type==='image').length,0);assert.ok(!job.visualReview?.pendingBatch);
    const state=await client.callTool({name:'video_status',arguments:{id:job.id,waitSeconds:20}});
    const completed=JSON.parse(state.content[0].text);assert.equal(completed.status,'complete');assert.ok(completed.sheets>0);
    assert.ok(!completed.visualReview?.pendingBatch,'image production alone must not require a viewing receipt');
    const optional=await client.callTool({name:'video_next',arguments:{id:job.id,after:-1,waitSeconds:0}});
    assert.ok(optional.content.some(x=>x.type==='image'),'images remain available when the host chooses to read them');
    await client.callTool({name:'session_stop',arguments:{id:job.id}});
    const start=await client.callTool({name:'video_url_start',arguments:{url:origin+'/clip.mp4',end:4,scene:true,firstImage:true}});
    assert.ok(!start.isError,JSON.stringify(start));const info=JSON.parse(start.content[0].text);id=info.id;
    assert.equal(info.firstImageReady,true);assert.ok(start.content.some(x=>x.type==='image'));
    const batch=info.visualReview.pendingBatch;await client.callTool({name:'video_review',arguments:{id,action:'ack',batchId:batch.batchId,viewedIndices:batch.indices}});
    const next=await client.callTool({name:'video_next',arguments:{id,after:info.index,waitSeconds:10}});const n=JSON.parse(next.content[0].text);
    if(n.newImage)assert.equal(n.index,info.index+1);else assert.equal(n.status,'complete');
  }finally{if(id)await client.callTool({name:'session_stop',arguments:{id}});await client.close();}
});
