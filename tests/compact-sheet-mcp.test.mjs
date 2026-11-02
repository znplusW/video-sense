import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { exec, FFMPEG } from '../src/media.mjs';

// A short local clip exercises worker wiring, persistence and MCP image delivery.
// No network, screen capture, ASR, model download or transcript work is involved.
test('short local video returns every compact PNG with matching dimensions and frame metadata',async()=>{
  const root=path.resolve(process.env.AGENT_VIDEO_TEST_DIR||'work/validation-compact',randomUUID());
  await mkdir(root,{recursive:true});
  const clip=path.join(root,'three-colors.mp4');
  await exec(FFMPEG,['-hide_banner','-v','error','-n',
    '-f','lavfi','-i','color=c=red:s=320x160:r=12:d=1',
    '-f','lavfi','-i','color=c=blue:s=320x160:r=12:d=1',
    '-f','lavfi','-i','color=c=green:s=320x160:r=12:d=1',
    '-filter_complex','[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]','-map','[v]',
    '-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p',clip],{windowsHide:true,timeout:20000});
  const expected=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')).version;
  const client=new Client({name:'compact-storyboard-test',version:'1.0.0'});
  async function call(name,args) {
    const result=await client.callTool({name,arguments:args});assert.ok(!result.isError,JSON.stringify(result));
    return {info:JSON.parse(result.content.find(c=>c.type==='text').text),images:result.content.filter(c=>c.type==='image')};
  }
  try {
    await client.connect(new StdioClientTransport({command:process.execPath,
      args:[fileURLToPath(new URL('../src/server.mjs',import.meta.url))],
      env:{...process.env,AGENT_VIDEO_DATA_DIR:path.join(root,'jobs')},stderr:'pipe'}));
    assert.equal(client.getServerVersion().version,expected);
    const started=await call('video_start',{file:clip});
    const id=started.info.id;
    const status=await call('video_status',{id,waitSeconds:20});
    assert.equal(status.info.status,'complete',JSON.stringify(status.info));
    const frames=[];let after=-1,done=false,pages=0;
    while(!done&&pages++<5) {
      const page=await call('video_read',{id,after,waitSeconds:0,format:'png'});
      assert.equal(page.info.images.length,page.images.length);
      for(let i=0;i<page.images.length;i++) {
        const meta=page.info.images[i],png=Buffer.from(page.images[i].data,'base64');
        assert.equal(png.readUInt32BE(16),meta.w);assert.equal(png.readUInt32BE(20),meta.h);
        assert.equal(meta.layout,'compact-rows-v1');assert.ok(meta.fill>0.98);
        assert.equal(meta.cells.length,meta.frames.length);frames.push(...meta.frames);
        await writeFile(path.join(root,`returned-${meta.index}.png`),png);
      }
      const batch=page.info.visualReview.pendingBatch;if(batch)await call('video_review',{id,action:'ack',batchId:batch.batchId,viewedIndices:batch.indices});
      after=page.info.nextAfter;done=page.info.exhausted;
    }
    assert.equal(done,true);assert.deepEqual(frames.map(f=>f.t),[0,1,2]);
    const final=await call('video_status',{id});
    assert.equal(final.info.visualDelivery.allDelivered,true);
    console.log(JSON.stringify({artifacts:root,version:expected,sheets:final.info.sheets,frames:frames.length,allDelivered:true}));
  } finally { await client.close(); }
});
