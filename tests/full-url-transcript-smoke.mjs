// Opt-in full-range real-network/ASR acceptance. Does not summarize the source.
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';

const directory=process.env.AGENT_VIDEO_TEST_DIR,url=process.argv[2];
if(!directory||!url)throw new Error('Set AGENT_VIDEO_TEST_DIR and provide a video URL.');
await mkdir(directory,{recursive:true});
const config=JSON.parse(await readFile(new URL('../config/workbuddy.local.json',import.meta.url),'utf8')).mcpServers['video-sense'];
const client=new Client({name:'full-range-network-transcript-acceptance',version:'1.0.0'});
const log=[],segments=new Map(),started=performance.now();let id;
const call=async(name,args={})=>{
  const r=await client.callTool({name,arguments:args},undefined,{timeout:45000});assert.ok(!r.isError,JSON.stringify(r));
  const info=JSON.parse(r.content.find(c=>c.type==='text').text);log.push({tool:name,info,imageCount:r.content.filter(c=>c.type==='image').length});
  await writeFile(path.join(directory,'call-log.json'),JSON.stringify(log,null,2));return info;
};
try{
  await client.connect(new StdioClientTransport({command:config.command,args:[fileURLToPath(new URL('../src/server.mjs',import.meta.url))],
    env:{...process.env,...config.env,AGENT_VIDEO_DATA_DIR:path.join(directory,'data')},stderr:'pipe'}));
  assert.equal(client.getServerVersion().version,'0.9.0');
  const j=await call('video_url_start',{url,analysis:'overview'});id=j.id;
  assert.notEqual(j.status,'error',JSON.stringify(j));
  const subtitles=await call('transcript_start',{id,mode:'subtitles'});
  const track=await call('transcript_start',{id,mode:'asr',language:'zh',force:true});
  let text,after=0;const deadline=Date.now()+15*60000;
  do{
    text=await call('transcript_read',{id,trackId:track.id,after,waitSeconds:20,limit:500});after=text.nextAfter;
    for(const s of text.segments)segments.set(s.id,s);
    console.log(JSON.stringify({status:text.status,phase:text.phase,processedThrough:text.processedRanges?.at(-1)?.end??0,
      acquisition:text.acquisition,segments:segments.size,elapsedMs:Math.round(performance.now()-started),...(text.error?{error:text.error}:{})}));
  }while(['starting','running'].includes(text.status)&&Date.now()<deadline);
  assert.equal(text.status,'complete',JSON.stringify({status:text.status,error:text.error,acquisition:text.acquisition}));
  const range=text.requestedRange;assert.ok(range.end>590,'must verify the full long source, not a short startup window');
  let through=range.start;
  for(const r of text.processedRanges){assert.ok(Math.abs(r.start-through)<0.01,'coverage must be contiguous');through=r.end;}
  assert.ok(Math.abs(through-range.end)<0.5);assert.equal(text.acquisition.status,'complete');assert.ok(segments.size>0);
  const status=await call('video_status',{id,waitSeconds:20});assert.equal(status.status,'complete');assert.equal(status.visualCoverage.completeTimeline,false);
  const result={serverVersion:client.getServerVersion().version,source:status.source,sourceMediaKey:status.metadata.sourceMediaKey,
    title:status.metadata.title,duration:status.metadata.duration,requestedRange:range,textStatus:text.status,processedThrough:through,
    processedRanges:text.processedRanges,acquisition:text.acquisition,audioTransfer:text.audioTransfer,textSource:text.source,segmentCount:segments.size,
    lastSegment:[...segments.values()].at(-1),visualOverviewSheets:status.sheets,subtitleTracks:subtitles.availableTracks?.length,elapsedMs:Math.round(performance.now()-started)};
  await writeFile(path.join(directory,'transcript-segments.json'),JSON.stringify([...segments.values()],null,2));
  await writeFile(path.join(directory,'result.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify({acceptance:'complete',serverVersion:result.serverVersion,requestedRange:range,processedThrough:through,segments:segments.size,elapsedMs:result.elapsedMs}));
}finally{
  if(id)await call('session_stop',{id}).catch(()=>{});await client.close();
}
