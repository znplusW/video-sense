import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir,writeFile,readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { VideoService,exactFrame } from '../src/service.mjs';
import { exec,FFMPEG,FFPROBE } from '../src/media.mjs';

const root=path.resolve(process.env.AGENT_VIDEO_TEST_DIR||'work/validation',randomUUID());
await mkdir(root,{recursive:true});
const clip=path.join(root,'中文 portrait three scenes.mp4');
await exec(FFMPEG,['-hide_banner','-v','error','-n',
  '-f','lavfi','-i','color=c=red:s=360x640:r=12:d=2',
  '-f','lavfi','-i','color=c=blue:s=360x640:r=12:d=2',
  '-f','lavfi','-i','color=c=green:s=360x640:r=12:d=2',
  '-filter_complex','[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]','-map','[v]',
  '-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p',clip],{windowsHide:true,timeout:20000});
console.log(`Validation artifacts: ${root}`);
const dataDir=path.join(root,'jobs');
let completedId;

test('file: all 3 selected scenes persisted in order; portrait preserved; exact frame; resume',async()=>{
  const service=new VideoService({dataDir});
  try {
    const j=await service.startVideo({file:clip,scene:true,pace:'dense'});
    const done=await service.status(j.id,20);
    assert.equal(done.status,'complete',JSON.stringify(done));
    assert.equal(done.sheets,3);assert.equal(done.stats.frames,72);
    assert.equal(done.metadata.width,360);assert.equal(done.metadata.height,640);
    assert.equal(done.range.end,6);assert.equal(done.audioAnalyzed,false);
    const times=[];
    for(let i=0;i<done.sheets;i++){
      const s=await service.sheet(j.id,i,'png');times.push(s.info.frames[0].t);
      assert.equal(s.data.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
      assert.equal(s.info.frameCount,1);
    }
    assert.deepEqual(times,[0,2,4]);
    const frame=await exactFrame({file:clip,seconds:2.5,quality:'low'});
    const framePath=path.join(root,'exact-blue.png');await writeFile(framePath,frame.png);
    const pixels=await exec(FFMPEG,['-v','error','-i',framePath,'-f','rawvideo','-pix_fmt','rgb24','pipe:1'],{windowsHide:true,encoding:'buffer',maxBuffer:2e6});
    const at=(x,y)=>[...pixels.stdout.subarray((y*800+x)*3,(y*800+x)*3+3)];
    assert.deepEqual(at(10,220),[0,0,0],'portrait letterbox should stay black');
    assert.ok(at(400,220)[2]>200,'center should be blue');
    assert.ok(at(270,220)[2]<5,'outside portrait area should remain black, not stretched');
    await assert.rejects(()=>service.sheet(j.id,-1));
    completedId=j.id;
  } finally {await service.close();}
  const again=new VideoService({dataDir});
  try{assert.equal((await again.status(completedId)).status,'complete');assert.ok((await again.sheet(completedId,2,'png')).data.length>100);}
  finally{await again.close();}
});

test('file ranges retain source seconds, corrupt input fails, remote input rejected',async()=>{
  const service=new VideoService({dataDir});
  try{
    const j=await service.startVideo({file:clip,start:2,end:4,scene:true});
    const st=await service.status(j.id,20);assert.equal(st.status,'complete');assert.equal(st.stats.frames,24);
    assert.equal((await service.sheet(j.id,0)).info.from,2);
    await assert.rejects(()=>service.startVideo({file:'https://example.com/a.mp4'}));
    await assert.rejects(()=>service.startVideo({file:clip,start:4,end:2}));
    const bad=path.join(root,'corrupt.mp4');await writeFile(bad,'not video');
    const b=await service.startVideo({file:bad});assert.equal((await service.status(b.id,20)).status,'error');
    const cancel=await service.startVideo({file:clip});const cancelled=await service.stop(cancel.id);
    assert.equal(cancelled.status,'stopped');
  }finally{await service.close();}
});

test('default multi-frame packing drains all selected frames without queue loss',async()=>{
  const service=new VideoService({dataDir});
  try{
    const j=await service.startVideo({file:clip});
    const st=await service.status(j.id,20);
    assert.equal(st.status,'complete');assert.equal(st.stats.overflow,0);
    const all=[];
    for(let i=0;i<st.sheets;i++)all.push(...(await service.sheet(j.id,i,'png')).info.frames);
    assert.equal(all.length,st.stats.kept);
    assert.deepEqual(all.map(f=>f.t),[0,2,4]);
    assert.ok(st.sheets<all.length,'normal mode should pack more than one frame');
  }finally{await service.close();}
});

test('client disconnect stops a running worker and its FFmpeg child',async()=>{
  const client=new Client({name:'disconnect-test',version:'1.0.0'});
  const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../src/server.mjs',import.meta.url))],
    env:{...process.env,AGENT_VIDEO_DATA_DIR:path.join(root,'disconnect-jobs')},stderr:'pipe'});
  const long=path.join(root,'long-motion.mp4');
  await exec(FFMPEG,['-v','error','-n','-f','lavfi','-i','testsrc2=s=640x360:r=12:d=120','-c:v','libx264','-preset','ultrafast',long],{windowsHide:true,timeout:20000});
  let pid;
  try{
    await client.connect(transport);
    const start=await client.callTool({name:'video_start',arguments:{file:long,quality:'ultra'}});
    const id=JSON.parse(start.content[0].text).id;
    for(let i=0;i<30&&!pid;i++){
      const r=await client.callTool({name:'video_status',arguments:{id}});
      pid=JSON.parse(r.content[0].text).capturePid;
      if(!pid)await new Promise(r=>setTimeout(r,100));
    }
    assert.ok(pid,'capture child must have started');
  }finally{await client.close();}
  for(let i=0;i<50;i++){
    try{process.kill(pid,0);}catch{return;}
    await new Promise(r=>setTimeout(r,100));
  }
  assert.fail(`FFmpeg ${pid} survived MCP disconnect`);
});

test('MCP stdio: initialize, discover, asynchronous job, real image block, errors',async()=>{
  const client=new Client({name:'integration-test',version:'1.0.0'});
  const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../src/server.mjs',import.meta.url))],
    env:{...process.env,AGENT_VIDEO_DATA_DIR:path.join(root,'mcp-jobs'),AGENT_VIDEO_FFMPEG:FFMPEG,AGENT_VIDEO_FFPROBE:FFPROBE},stderr:'pipe'});
  try{
    await client.connect(transport);
    const list=await client.listTools();assert.equal(list.tools.length,19);
    assert.equal(client.getServerVersion().version,'0.8.0');
    const call=(name,args={})=>client.callTool({name,arguments:args});
    const doctor=await call('video_doctor');assert.equal(JSON.parse(doctor.content[0].text).ffmpeg.ok,true);
    const start=await call('video_start',{file:clip,scene:true});assert.ok(!start.isError);
    const id=JSON.parse(start.content[0].text).id;
    const done=await call('video_status',{id,waitSeconds:20});assert.equal(JSON.parse(done.content[0].text).status,'complete');
    const sheet=await call('video_sheet',{id,index:0,format:'png'});assert.equal(sheet.content[1].type,'image');
    assert.equal(sheet.content[1].mimeType,'image/png');assert.equal(Buffer.from(sheet.content[1].data,'base64').subarray(0,8).toString('hex'),'89504e470d0a1a0a');
    const batch=JSON.parse(sheet.content[0].text).visualReview.pendingBatch;
    await call('video_review',{id,action:'ack',batchId:batch.batchId,viewedIndices:batch.indices});
    const invalid=await call('video_sheet',{id,index:999});assert.equal(invalid.isError,true);
    const frameArgs={file:clip,seconds:2.5,quality:'low'};
    const jpegFrame=await call('video_frame',frameArgs);assert.ok(!jpegFrame.isError,JSON.stringify(jpegFrame));
    const jpegBlock=jpegFrame.content.find(c=>c.type==='image');assert.equal(jpegBlock?.mimeType,'image/jpeg');
    const jpegBytes=Buffer.from(jpegBlock.data,'base64');assert.equal(jpegBytes.subarray(0,2).toString('hex'),'ffd8');
    const jpegPixels=jpeg.decode(jpegBytes,{useTArray:true});
    assert.equal(jpegPixels.width,800);assert.equal(jpegPixels.height,450);
    const jpegAt=(x,y)=>[...jpegPixels.data.subarray((y*800+x)*4,(y*800+x)*4+3)];
    assert.ok(jpegAt(400,220)[2]>200&&jpegAt(400,220)[0]<15&&jpegAt(400,220)[1]<15,'default JPEG contains the requested blue scene');
    assert.ok(jpegAt(10,220).every(v=>v<=3),'JPEG keeps the portrait letterbox black');
    const pngFrame=await call('video_frame',{...frameArgs,format:'png'});assert.ok(!pngFrame.isError,JSON.stringify(pngFrame));
    const pngBlock=pngFrame.content.find(c=>c.type==='image');assert.equal(pngBlock?.mimeType,'image/png');
    const pngBytes=Buffer.from(pngBlock.data,'base64');assert.equal(pngBytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
    const original=await exactFrame(frameArgs);assert.deepEqual(pngBytes,original.png,'explicit PNG preserves the original frame bytes');
    const pngPixels=PNG.sync.read(pngBytes);assert.equal(pngPixels.width,800);assert.equal(pngPixels.height,450);
    assert.ok(pngPixels.data[(220*800+400)*4+2]>200,'PNG contains the same blue source scene');
  }finally{await client.close();}
});
