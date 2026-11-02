import test from 'node:test';
import assert from 'node:assert/strict';
import {loadAsrConfig,normalizeConfig,doctorAsr,asrCacheIdentity,transcribeAudio,closeAsr} from '../src/asr.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

const root=path.resolve(process.env.AGENT_VIDEO_TEST_DIR||'work/validation',`asr-${randomUUID()}`);
await mkdir(root,{recursive:true});
const example={backend:'faster-whisper',python:process.platform==='win32'?'C:/Python/python.exe':'/usr/bin/python3',model:'small'};

test('ASR is optional; missing/unsupported configuration reports capability independently',async()=>{
  const disabled=await doctorAsr(null);assert.equal(disabled.configured,false);assert.equal(disabled.visualIndependent,true);
  assert.throws(()=>normalizeConfig({...example,backend:'arbitrary-engine'}),/Unsupported ASR adapter/);
  assert.throws(()=>normalizeConfig({...example,model:'https://example.org/model'}),/not a URL/);
  assert.throws(()=>normalizeConfig({...example,idleSeconds:0}),/idleSeconds/);
  assert.throws(()=>normalizeConfig({...example,language:'translate this'}),/language/);
  const file=path.join(root,'asr-config.json');await writeFile(file,JSON.stringify({...example,language:'zh',wordTimestamps:false}));
  const loaded=await loadAsrConfig(file);assert.equal(loaded.language,'zh');assert.equal(loaded.wordTimestamps,false);assert.equal(loaded.allowDownload,false);
  const absent=await doctorAsr({...example,model:path.join(root,'absent-model')});assert.equal(absent.available,false);assert.match(absent.error,/model.bin/);
});

test('cache identity changes with actual model file revision and inference configuration',async()=>{
  const model=path.join(root,'model');await mkdir(model);await writeFile(path.join(model,'model.bin'),'test fixture, not a real model');
  const a=await asrCacheIdentity({...example,model});
  const b=await asrCacheIdentity({...example,model,language:'zh'});
  assert.notEqual(a.configurationSha256,b.configurationSha256);assert.equal(a.modelRevision,b.modelRevision);
  await writeFile(path.join(model,'model.bin'),'changed fixture model contents and size');
  const c=await asrCacheIdentity({...example,model});assert.notEqual(a.modelRevision,c.modelRevision);
});

test('real optional backend: reference speech, model reuse, wrong model rejection, cancellation and idle release',
  {skip:process.env.AGENT_VIDEO_TEST_ASR!=='1',timeout:60000},async()=>{
  const config={...await loadAsrConfig(),idleSeconds:5},file=process.env.AGENT_VIDEO_TEST_ASR_SAMPLE;
  assert.ok(file,'Set AGENT_VIDEO_TEST_ASR_SAMPLE to the official JFK test audio path.');
  const events=[];
  try{
    const first=await transcribeAudio({file,config,onSegments:s=>events.push(...s)});
    assert.equal(first.backend,'faster-whisper');assert.equal(first.model,config.model);assert.equal(first.device,config.device);
    assert.match(first.segments.map(x=>x.text).join(''),/fellow Americans.*ask not what your country can do for you.*what you can do for your country/i);
    assert.equal(first.language,'en');assert.equal(first.duration,11);assert.ok(events.length>0);
    assert.ok(first.segments.every(s=>s.start>=0&&s.end<=11.5&&s.words.length>0));
    const second=await transcribeAudio({file,config});assert.equal(second.metrics.modelReused,true);assert.equal(second.metrics.modelLoadMs,0);
    const another=transcribeAudio({file,config}),queuedAbort=new AbortController();
    const queued=transcribeAudio({file,config,signal:queuedAbort.signal});queuedAbort.abort();
    await assert.rejects(queued,/cancelled/);assert.ok((await another).segments.length,'cancelling queued job must not stop another active job');
    await assert.rejects(()=>transcribeAudio({file,config:{...config,model:path.join(root,'wrong-model')}}),/model.bin/);
    const controller=new AbortController(),cancelled=transcribeAudio({file,config,signal:controller.signal});
    setTimeout(()=>controller.abort(),100);
    await assert.rejects(cancelled,/cancelled/);
    const after=await transcribeAudio({file,config});assert.equal(after.metrics.modelReused,false,'cancelled owned worker must be replaced');
    await new Promise(r=>setTimeout(r,5500));const idle=await doctorAsr(config);assert.equal(idle.modelLoaded,false);
    await writeFile(path.join(root,'real-asr.json'),JSON.stringify({first,second,after,idle},null,2));
    console.log(JSON.stringify({asrValidation:root,engine:first.engineVersion,model:first.model,device:first.device,language:first.language,cold:first.metrics,warm:second.metrics}));
  }finally{await closeAsr();}
});

test('cancel during asynchronous engine preparation does not start a late worker',
  {skip:process.env.AGENT_VIDEO_TEST_ASR!=='1',timeout:15000},async()=>{
  const directory=path.join(root,'cancel-preparation');await mkdir(directory);
  // A real Python startup hook provides a deterministic preparation window.
  // No ASR results are mocked: the cancelled request must never start inference.
  const preparation=path.join(directory,'preparing.txt'),worker=path.join(directory,'worker-started.txt');
  const hook=`import sys,time\nfrom pathlib import Path\nif sys.argv[0] == '-c':\n Path(${JSON.stringify(preparation)}).write_text('preparing')\n time.sleep(1)\nelse:\n Path(${JSON.stringify(worker)}).write_text(str(sys.argv))\n`;
  await writeFile(path.join(directory,'sitecustomize.py'),hook);
  const script=path.join(directory,'cancel.mjs');
  const moduleUrl=new URL('../src/asr.mjs',import.meta.url).href;
  const code=`import assert from 'node:assert/strict';
import {stat} from 'node:fs/promises';
import {loadAsrConfig,transcribeAudio,closeAsr} from ${JSON.stringify(moduleUrl)};
const controller=new AbortController(),config=await loadAsrConfig();
const task=transcribeAudio({file:${JSON.stringify(process.env.AGENT_VIDEO_TEST_ASR_SAMPLE)},config,signal:controller.signal});
const rejected=assert.rejects(task,/cancelled/);
try {
 let ready=false;for(let i=0;i<150;i++){try{await stat(${JSON.stringify(preparation)});ready=true;break;}catch{await new Promise(r=>setTimeout(r,20));}}
 assert.ok(ready,'engine preparation must have started');controller.abort();await rejected;
 await new Promise(r=>setTimeout(r,1700));
 await assert.rejects(()=>stat(${JSON.stringify(worker)}),{code:'ENOENT'});
 console.log('Preparation cancellation: no late ASR worker');
}finally{await closeAsr();}`;
  await writeFile(script,code);
  const {stdout}=await promisify(execFile)(process.execPath,[script],{windowsHide:true,timeout:12000,
    env:{...process.env,PYTHONPATH:directory}});
  assert.match(stdout,/no late ASR worker/);
});
