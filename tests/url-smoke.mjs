// Manual, bounded real-network check. Not part of the automatic test suite.
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const url=process.argv[2],directory=process.env.AGENT_VIDEO_TEST_DIR;
if(!url||!directory)throw new Error('Provide a public video URL argument and AGENT_VIDEO_TEST_DIR.');
await mkdir(directory,{recursive:true});
const root=fileURLToPath(new URL('../',import.meta.url));
const config=JSON.parse(await readFile(new URL('../config/workbuddy.local.json',import.meta.url),'utf8')).mcpServers['video-sense'];
const client=new Client({name:'bounded-url-smoke',version:'1.0.0'});
const started=performance.now(),log=[];
let id;
const call=async(name,args={})=>{
  const before=performance.now();
  const value=await client.callTool({name,arguments:args},undefined,{timeout:45000});
  assert.ok(!value.isError,JSON.stringify(value));
  const info=JSON.parse(value.content.find(c=>c.type==='text').text);
  log.push({tool:name,elapsedMs:Math.round(performance.now()-before),info});
  for(const [i,image] of value.content.filter(c=>c.type==='image').entries()){
    await writeFile(path.join(directory,`${log.length}-${name}-${i}.${image.mimeType==='image/jpeg'?'jpg':'png'}`),Buffer.from(image.data,'base64'));
  }
  await writeFile(path.join(directory,'call-log.json'),JSON.stringify(log,null,2));
  return info;
};
try{
  await client.connect(new StdioClientTransport({command:config.command,args:[path.join(root,'src/server.mjs')],
    env:{...process.env,...config.env,AGENT_VIDEO_DATA_DIR:path.join(directory,'data')},stderr:'pipe'}));
  assert.equal(client.getServerVersion().version,'0.7.0');
  console.log(JSON.stringify({server:client.getServerVersion(),phase:'starting'}));
  const first=await call('video_url_start',{url,start:0,end:30,quality:'low'});id=first.id;
  assert.notEqual(first.status,'error',JSON.stringify(first));
  console.log(JSON.stringify({phase:'first_image',ready:first.firstImageReady,elapsedMs:Math.round(performance.now()-started)}));
  let state=await call('video_status',{id,waitSeconds:20});
  if(state.status==='running')state=await call('video_status',{id,waitSeconds:20});
  assert.equal(state.status,'complete',JSON.stringify(state));assert.ok(state.sheets>0);
  await call('video_evidence',{id,start:0,end:30,imageLimit:4});
  const tracks=await call('transcript_start',{id,mode:'subtitles'});
  const selected=tracks.availableTracks?.find(t=>t.language==='zh-CN'||t.language==='zh')??tracks.availableTracks?.[0];
  const track=selected?await call('transcript_start',{id,mode:'subtitles',trackId:selected.id}):await call('transcript_start',{id,mode:'asr',language:'zh',start:0,end:30});
  let text=await call('transcript_read',{id,trackId:track.id,waitSeconds:20});
  const segments=new Map(text.segments.map(s=>[s.id,s]));
  const deadline=performance.now()+120000;
  while(['queued','starting','running'].includes(text.status)&&performance.now()<deadline){
    text=await call('transcript_read',{id,trackId:track.id,after:text.nextAfter,waitSeconds:20});
    for(const segment of text.segments)segments.set(segment.id,segment);
  }
  assert.equal(text.status,'complete',JSON.stringify({status:text.status,error:text.error,phase:text.phase,processedRanges:text.processedRanges}));assert.ok(segments.size>0);
  const result={serverVersion:client.getServerVersion().version,title:state.metadata.title,sourceMediaKey:state.metadata.sourceMediaKey,
    verifiedRange:state.requestedRange,imageSheets:state.sheets,network:state.network,subtitleTracks:tracks.availableTracks?.length,
    textStatus:text.status,textSource:text.source,segmentCount:segments.size,textExcerpt:[...segments.values()].slice(0,4).map(s=>s.text),elapsedMs:Math.round(performance.now()-started)};
  await writeFile(path.join(directory,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{
  if(id)await call('session_stop',{id}).catch(()=>{});
  await client.close();
}
