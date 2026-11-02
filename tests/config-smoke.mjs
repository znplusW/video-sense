import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const config=JSON.parse(await readFile(new URL('../config/workbuddy.local.json',import.meta.url),'utf8')).mcpServers['video-sense'];
if(process.argv[2])config.args=[process.argv[2]];
const client=new Client({name:'configuration-smoke',version:'1.0.0'});
try {
  await client.connect(new StdioClientTransport({command:config.command,args:config.args,env:{...process.env,...config.env},stderr:'pipe'}));
  const version=client.getServerVersion();
  assert.equal(version.name,'video-sense');assert.equal(version.title,'动态视听');assert.equal(version.version,'0.8.0');assert.match(version.description,/颜色与运动变化/);assert.match(version.description,/纯音频/);
  const tools=await client.listTools();assert.equal(tools.tools.length,19);
  const doctor=await client.callTool({name:'video_doctor',arguments:{}});
  const state=JSON.parse(doctor.content[0].text);assert.equal(state.ffmpeg.ok,true);assert.equal(state.ffprobe.ok,true);
  assert.equal(state.ytDlp.ok,true);
  console.log(JSON.stringify({name:version.name,title:version.title,version:version.version,tools:tools.tools.length,ffmpeg:state.ffmpeg.ok,ffprobe:state.ffprobe.ok,ytDlp:state.ytDlp.version}));
} finally {await client.close();}
