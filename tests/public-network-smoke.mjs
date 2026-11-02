// Optional live Internet smoke: no cookies or private media, not part of deterministic tests.
import { VideoService } from '../src/service.mjs';
import { mkdir,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const dataDir=path.resolve(process.env.AGENT_VIDEO_TEST_DIR||'work/validation',`public-${randomUUID()}`);
await mkdir(dataDir,{recursive:true});
const service=new VideoService({dataDir}),results=[];
try {
  for(const target of [
    {url:'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4',sourceType:'direct'},
    {url:'https://www.w3schools.com/html/html5_video.asp',sourceType:'page'},
  ]) {
    const started=performance.now();const job=await service.startUrl({...target,end:2});
    const first=await service.nextSaved(job.id,-1,20);
    const firstMs=Math.round(performance.now()-started);
    const status=await service.status(job.id,20);
    if(['starting','running'].includes(status.status))await service.stop(job.id);
    const item={source:target.url,status:status.status,firstImageMs:first.data?firstMs:null,sheets:status.sheets,
      metadata:status.metadata,network:status.network,error:status.error,manifest:status.manifest};
    results.push(item);console.log(JSON.stringify(item));
    if(status.status!=='complete'||!status.sheets)process.exitCode=1;
  }
}finally{await service.close();await writeFile(path.join(dataDir,'public-results.json'),JSON.stringify(results,null,2));}
