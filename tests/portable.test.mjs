import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,writeFile,mkdtemp,readFile,cp,readdir,stat,symlink} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {runtimeEnvironment} from '../src/bootstrap.mjs';
import {renameReview} from '../src/review.mjs';

test('bootstrap executes through a shared directory junction',async()=>{
  const root=await mkdtemp(path.resolve('work/portable-junction-'));
  const link=path.join(root,'共享 runtime');
  await symlink(fileURLToPath(new URL('../',import.meta.url)),link,process.platform==='win32'?'junction':'dir');
  const {stdout}=await promisify(execFile)(process.execPath,[path.join(link,'src/bootstrap.mjs'),'--cli','doctor'],{
    windowsHide:true,timeout:30000,env:{...process.env,AGENT_VIDEO_CONFIG_DIR:path.join(root,'client'),AGENT_VIDEO_DATA_DIR:path.join(root,'data'),AGENT_VIDEO_ASR_CONFIG:''}
  });
  assert.equal(JSON.parse(stdout).version,'0.8.0');
});

test('review atomic replacement retries transient Windows locks and preserves permanent errors',async()=>{
  let calls=0;const delays=[];
  await renameReview('temp','target',async()=>{if(++calls<3)throw Object.assign(new Error('locked'),{code:'EPERM'});},async ms=>delays.push(ms));
  assert.equal(calls,3);assert.deepEqual(delays,[25,50]);
  const permanent=Object.assign(new Error('missing'),{code:'ENOENT'});
  await assert.rejects(renameReview('temp','target',async()=>{throw permanent;}),e=>e===permanent);
  calls=0;
  await assert.rejects(renameReview('temp','target',async()=>{calls++;throw Object.assign(new Error('still locked'),{code:'EBUSY'});},async()=>{}));
  assert.equal(calls,6);
});

test('portable runtime resolves bundled dependencies and relative explicit overrides independently of cwd',async()=>{
  await mkdir(path.resolve('work'),{recursive:true});
  const root=await mkdtemp(path.resolve('work/portable-unit-'));
  await mkdir(path.join(root,'runtime'),{recursive:true});
  const ext=process.platform==='win32'?'.exe':'';
  for(const name of ['ffmpeg','ffprobe'])await writeFile(path.join(root,'runtime',name+ext),'fixture');
  const env=runtimeEnvironment(root,{XDG_CONFIG_HOME:path.join(root,'user-config')});
  assert.equal(env.AGENT_VIDEO_FFMPEG,path.join(root,'runtime','ffmpeg'+ext));
  assert.equal(env.AGENT_VIDEO_FFPROBE,path.join(root,'runtime','ffprobe'+ext));
  assert.equal(env.AGENT_VIDEO_CONFIG_DIR,path.join(root,'user-config','video-sense','generic'));
  assert.equal(env.AGENT_VIDEO_DATA_DIR,path.join(env.AGENT_VIDEO_CONFIG_DIR,'data'));
  assert.equal(env.AGENT_VIDEO_ASR_CONFIG,undefined);
  const clientConfig=path.join(root,'client-configuration');
  const override=runtimeEnvironment(root,{AGENT_VIDEO_CONFIG_DIR:clientConfig,AGENT_VIDEO_FFMPEG:'custom/ffmpeg',AGENT_VIDEO_ASR_CONFIG:'my-asr.json',AGENT_VIDEO_DATA_DIR:'chosen-data'});
  assert.equal(override.AGENT_VIDEO_FFMPEG,path.join(root,'custom','ffmpeg'));
  assert.equal(override.AGENT_VIDEO_ASR_CONFIG,path.join(clientConfig,'my-asr.json'));
  assert.equal(override.AGENT_VIDEO_DATA_DIR,path.join(clientConfig,'chosen-data'));
});

test('one shared runtime generates isolated generic and example client configurations outside its source', {skip:process.platform!=='win32'},async()=>{
  const exec=promisify(execFile);
  const parent=await mkdtemp(path.resolve('work/shared-install-'));
  const shared=path.join(parent,'共享 源码'),configA=path.join(parent,'Agent A 配置'),configB=path.join(parent,'Agent B 配置');
  await mkdir(path.join(shared,'runtime'),{recursive:true});
  for(const f of ['configure.ps1','install.ps1'])await cp(path.resolve(f),path.join(shared,f));
  await mkdir(path.join(shared,'src'),{recursive:true});await writeFile(path.join(shared,'src/bootstrap.mjs'),'// fixture');
  await mkdir(path.join(shared,'skills/video-sense'),{recursive:true});await writeFile(path.join(shared,'skills/video-sense/SKILL.md'),'---\nname: video-sense\ndescription: Shared fixture\n---\n');
  for(const f of ['node.exe','ffmpeg.exe','ffprobe.exe'])await writeFile(path.join(shared,'runtime',f),'fixture');
  const run=(file,args=[])=>exec('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(shared,file),...args],{windowsHide:true,timeout:30000});
  await run('install.ps1',['-ConfigDir',configA]);
  await run('configure.ps1',['-Client','workbuddy','-ConfigDir',configB,'-AsrConfig','speech.json']);
  const a=JSON.parse(await readFile(path.join(configA,'mcp.json'),'utf8')).mcpServers['video-sense'];
  const b=JSON.parse(await readFile(path.join(configB,'mcp.json'),'utf8')).mcpServers['video-sense'];
  assert.deepEqual(a.args,b.args);assert.equal(a.args[0],path.join(shared,'src/bootstrap.mjs').replaceAll('\\','/'));
  assert.notEqual(a.env.AGENT_VIDEO_DATA_DIR,b.env.AGENT_VIDEO_DATA_DIR);
  assert.equal(a.env.AGENT_VIDEO_CONFIG_DIR,configA.replaceAll('\\','/'));
  assert.equal(a.env.AGENT_VIDEO_ASR_CONFIG,undefined);
  assert.equal(b.env.AGENT_VIDEO_ASR_CONFIG,path.join(configB,'speech.json').replaceAll('\\','/'));
  assert.equal(b.type,'stdio');assert.equal(a.type,undefined);
  const sourceEntries=await readdir(shared);assert(!sourceEntries.includes('config'));assert(!sourceEntries.includes('data'));
  const original=await readFile(path.join(configA,'mcp.json'),'utf8');
  await run('configure.ps1',['-ConfigDir',configA,'-DataDir',path.join(parent,'moved-data')]);
  const backups=(await readdir(configA)).filter(n=>n.startsWith('mcp.json.')&&n.endsWith('.bak'));
  assert.equal(backups.length,1);assert.equal(await readFile(path.join(configA,backups[0]),'utf8'),original);
  const codex=path.join(parent,'第三方 TOML 配置');await run('configure.ps1',['-Client','codex','-ConfigDir',codex]);
  const toml=await readFile(path.join(codex,'mcp.toml'),'utf8');assert(toml.includes('[mcp_servers.video-sense]'));assert(toml.includes(a.args[0]));
  await assert.rejects(run('configure.ps1',['-ConfigDir',path.join(shared,'private-config')]));
  await assert.rejects(run('configure.ps1',['-ConfigDir',configB,'-DataDir',path.join(shared,'data')]));
  const skill=path.join(parent,'共享 Skill');await run('install.ps1',['-ConfigDir',configA,'-SkillDir',skill]);
  assert((await stat(path.join(skill,'SKILL.md'))).isFile());assert(!(await readdir(skill)).includes('runtime-location.json'));
});
