// Opt-in real-network check; not part of npm test. Uses only independent audio tools.
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {mkdir,readFile,writeFile,readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const directory=process.env.AGENT_VIDEO_TEST_DIR;
if(!directory||!process.argv[2])throw new Error('Provide AGENT_VIDEO_TEST_DIR and one or more audio/page URLs.');
await mkdir(directory,{recursive:true});
const config=JSON.parse(await readFile(new URL('../config/workbuddy.local.json',import.meta.url),'utf8')).mcpServers['video-sense'];
const client=new Client({name:'independent-audio-network-smoke',version:'1.0.0'});
const log=[],results=[];
const call=async(name,args)=>{
  const response=await client.callTool({name,arguments:args},undefined,{timeout:45000});
  assert.ok(!response.isError,JSON.stringify(response));assert.ok(response.content.every(c=>c.type==='text'),'audio output must not contain images');
  const info=JSON.parse(response.content[0].text);log.push({tool:name,info});
  await writeFile(path.join(directory,'call-log.json'),JSON.stringify(log,null,2));return info;
};
try{
  await client.connect(new StdioClientTransport({command:config.command,args:[fileURLToPath(new URL('../src/server.mjs',import.meta.url))],
    env:{...process.env,...config.env,AGENT_VIDEO_DATA_DIR:path.join(directory,'data')},stderr:'pipe'}));
  assert.equal(client.getServerVersion().version,'0.9.0');
  for(const url of process.argv.slice(2)){
    const before=performance.now(),source=await call('audio_url_start',{url,start:0,end:6});
    const id=source.id;
    try{
      let state;do{state=await call('audio_status',{id,waitSeconds:20});}while(state.status==='starting');
      assert.equal(state.status,'ready',JSON.stringify(state));assert.equal(state.kind,'audio');assert.equal(state.statuses.visual,'not_applicable');
      const track=await call('transcript_start',{id,mode:'asr'});
      let text,after=0;const segments=new Map();
      do{
        text=await call('transcript_read',{id,trackId:track.id,after,waitSeconds:20});after=text.nextAfter;
        for(const s of text.segments)segments.set(s.id,s);
      }while(['starting','running'].includes(text.status));
      assert.equal(text.status,'complete',JSON.stringify({status:text.status,error:text.error}));assert.ok(segments.size>0);
      const files=await readdir(state.directory,{recursive:true});assert.ok(!files.some(f=>f.endsWith('.png')));
      const result={version:client.getServerVersion().version,source:state.source,sourceIdentity:state.metadata.sourceMediaKey??null,
        requestedRange:state.range,sourceStatus:state.status,textStatus:text.status,processedRanges:text.processedRanges,
        sourceMetadata:state.metadata,textSource:text.source,segments:segments.size,excerpt:[...segments.values()].slice(0,2).map(s=>s.text),
        noImages:true,elapsedMs:Math.round(performance.now()-before)};
      results.push(result);console.log(JSON.stringify(result));
    }finally{await call('session_stop',{id});}
  }
  assert.ok(!log.some(x=>/^video_(start|url_start|next|sheet|frame|evidence)$/.test(x.tool)));
  await writeFile(path.join(directory,'result.json'),JSON.stringify(results,null,2));
}finally{await client.close();}
