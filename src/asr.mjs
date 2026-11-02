import { spawn,execFile } from 'node:child_process';
import { readFile,stat,realpath } from 'node:fs/promises';
import { createHash,randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import path from 'node:path';
import os from 'node:os';

const localConfig=path.join(process.env.AGENT_VIDEO_CONFIG_DIR||path.join(process.env.XDG_CONFIG_HOME||path.join(os.homedir(),'.config'),'video-sense','generic'),'asr.json');
const workerScript=fileURLToPath(new URL('./asr-worker.py',import.meta.url));
const exec=promisify(execFile),pool=new Map(),queues=new Map(),queueDepth=new Map(),enginePaths=new Map();
let generation=0;
const capabilities=Object.freeze({segmentTimestamps:true,wordTimestamps:true,incrementalFinalSegments:true,
  provisionalSegments:false,revisions:false,languageDetection:true,sourceTimeMapping:false,
  note:'Times are relative to the supplied audio file; the scheduler maps them to source media seconds. No semantic interpretation.'});
const sha=value=>createHash('sha256').update(value).digest('hex');
const cleanError=e=>String(e?.message??e).replace(/https?:\/\/[^\s"'<>]+/gi,'[URL]').slice(0,1600);

export async function loadAsrConfig(configPath=process.env.AGENT_VIDEO_ASR_CONFIG||localConfig) {
  let data;
  try{data=JSON.parse((await readFile(configPath,'utf8')).replace(/^\uFEFF/,''));}
  catch(e){if(e.code==='ENOENT'&&!process.env.AGENT_VIDEO_ASR_CONFIG&&configPath===localConfig)return null;throw new Error(`ASR configuration: ${cleanError(e)}`);}
  return normalizeConfig(data);
}
export function normalizeConfig(input) {
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('ASR configuration must be a JSON object.');
  if(input.backend!=='faster-whisper')throw new Error('Unsupported ASR adapter. This release implements faster-whisper; new engine interfaces require an adapter.');
  for(const key of ['python','model'])if(typeof input[key]!=='string'||!input[key].trim())throw new Error(`ASR ${key} is required.`);
  if(/^https?:/i.test(input.model))throw new Error('Use a local model path or supported model identifier, not a URL.');
  const c={backend:input.backend,python:input.python,model:input.model,device:input.device??'cpu',computeType:input.computeType??'int8',
    cpuThreads:input.cpuThreads??4,beamSize:input.beamSize??5,language:input.language??null,wordTimestamps:input.wordTimestamps??true,
    allowDownload:input.allowDownload??false,idleSeconds:input.idleSeconds??120,timeoutSeconds:input.timeoutSeconds??600,
    ...(input.downloadRoot?{downloadRoot:input.downloadRoot}:{})};
  if(!['cpu','cuda','auto'].includes(c.device))throw new Error('ASR device must be cpu, cuda or auto.');
  if(typeof c.computeType!=='string'||typeof c.wordTimestamps!=='boolean'||typeof c.allowDownload!=='boolean')throw new Error('Invalid ASR computeType/wordTimestamps/allowDownload.');
  for(const [key,lo,hi] of [['cpuThreads',1,32],['beamSize',1,10],['idleSeconds',5,600],['timeoutSeconds',5,3600]])
    if(!Number.isInteger(c[key])||c[key]<lo||c[key]>hi)throw new Error(`ASR ${key} must be ${lo}..${hi}.`);
  if(c.language!==null&&(typeof c.language!=='string'||!/^[-a-zA-Z]{2,12}$/.test(c.language)))throw new Error('ASR language must be a language code or null.');
  if(!path.isAbsolute(c.python))throw new Error('ASR python must be an absolute executable path.');
  return c;
}

export async function asrCacheIdentity(config) {
  const c=normalizeConfig(config);
  let modelRevision='identifier:'+c.model;
  if(path.isAbsolute(c.model)) {
    const files=[];
    for(const name of ['config.json','model.bin','tokenizer.json','vocabulary.json','vocabulary.txt']) {
      try{const s=await stat(path.join(c.model,name));files.push([name,s.size,s.mtimeMs]);}catch(e){if(e.code!=='ENOENT')throw e;}
    }
    if(!files.some(x=>x[0]==='model.bin'))throw new Error('ASR model.bin is unavailable at the configured model path.');
    modelRevision='local-stat-sha256:'+sha(JSON.stringify(files));
  }
  const engine=await engineIdentity(c.python);
  return {backend:c.backend,model:c.model,modelRevision,...engine,configurationSha256:sha(JSON.stringify(c)),
    note:'Local model revision fingerprints file sizes/mtimes, not a cryptographic hash of model weights.'};
}

async function engineIdentity(python) {
  // The probe discovers installation paths without importing/loading the ASR
  // engine. Later calls stat those files; replaced dist-info triggers rediscovery.
  let cached=enginePaths.get(python);
  if(cached){try{await Promise.all(cached.files.map(f=>stat(f)));}catch{cached=null;enginePaths.delete(python);}}
  if(!cached) {
    const code='import json,importlib.metadata as m; out={"files":[]};\nfor name,key in [("faster-whisper","engineVersion"),("ctranslate2","runtimeVersion")]:\n d=m.distribution(name); out[key]=d.version\n for p in d.files or []:\n  s=str(p).replace(chr(92),"/")\n  if s.endswith("/METADATA") or s in ["faster_whisper/transcribe.py","ctranslate2/__init__.py"] or ("_ext" in s and (s.endswith(".pyd") or s.endswith(".so"))): out["files"].append(str(d.locate_file(p)))\nprint(json.dumps(out))';
    try{const {stdout}=await exec(python,['-c',code],{windowsHide:true,timeout:10000,maxBuffer:1024*1024});cached=JSON.parse(stdout);enginePaths.set(python,cached);}
    catch(e){return {engineRevision:'unavailable',engineIdentityError:cleanError(e)};}
  }
  const revisions=[];for(const file of cached.files){const s=await stat(file);revisions.push([file,s.size,s.mtimeMs]);}
  return {engineVersion:cached.engineVersion,runtimeVersion:cached.runtimeVersion,engineRevision:'installation-stat-sha256:'+sha(JSON.stringify(revisions))};
}

export async function doctorAsr(config) {
  try {
    const c=config===undefined?await loadAsrConfig():config?normalizeConfig(config):null;
    if(!c)return {configured:false,available:false,status:'not_configured',supportedAdapters:['faster-whisper'],visualIndependent:true};
    const identity=await asrCacheIdentity(c);
    const code='import json,importlib.metadata as m,ctranslate2; import faster_whisper; print(json.dumps({"engineVersion":m.version("faster-whisper"),"runtimeVersion":m.version("ctranslate2"),"cpuComputeTypes":sorted(ctranslate2.get_supported_compute_types("cpu"))}))';
    const {stdout}=await exec(c.python,['-c',code],{windowsHide:true,timeout:15000,maxBuffer:1024*1024,env:{...process.env,PYTHONUTF8:'1'}});
    return {configured:true,available:true,status:'ready_not_loaded',...identity,...JSON.parse(stdout),device:c.device,computeType:c.computeType,language:c.language,
      capabilities,configuredWordTimestamps:c.wordTimestamps,modelLoaded:[...pool.values()].some(w=>w.key===sha(JSON.stringify(c))&&w.loaded),
      idleReleaseSeconds:c.idleSeconds,allowDownload:c.allowDownload,visualIndependent:true};
  } catch(e) {return {configured:true,available:false,status:'unavailable',error:cleanError(e),supportedAdapters:['faster-whisper'],visualIndependent:true};}
}

function makeWorker(c) {
  const key=sha(JSON.stringify(c));
  const existing=pool.get(key);if(existing)return existing;
  if(pool.size>=2)throw new Error('ASR worker limit reached (2 configured models); close idle workers or wait.');
  const child=spawn(c.python,['-u',workerScript],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,PYTHONUTF8:'1',HF_HUB_OFFLINE:c.allowDownload?'0':'1'}});
  const w={key,child,pending:null,idle:null,loaded:false,stderr:''};pool.set(key,w);
  let rejectReady;
  w.ready=new Promise((resolve,reject)=>{rejectReady=reject;w.markReady=resolve;});
  // Always attach a rejection observer; startup can fail before the request awaits.
  w.ready.catch(()=>{});
  const fail=error=>{
    clearTimeout(w.idle);if(pool.get(key)===w)pool.delete(key);
    rejectReady(error);w.pending?.reject(error);w.pending=null;
  };
  w.fail=fail;
  child.stderr.on('data',d=>{w.stderr=(w.stderr+d.toString()).slice(-3000);});
  const lines=createInterface({input:child.stdout,crlfDelay:Infinity});
  lines.on('line',line=>{
    try{
      if(line.length>8*1024*1024)throw new Error('ASR protocol message exceeds 8 MiB.');
      const msg=JSON.parse(line);
      if(msg.type==='ready'){w.markReady();return;}
      const p=w.pending;if(!p||msg.id!==p.id)return;
      if(msg.type==='segments'){
        for(const segment of msg.segments??[]){validateSegment(segment);p.segments.push(segment);}
        p.onSegments?.(msg.segments);
      }
      if(msg.type==='done'){w.loaded=true;p.resolve({...msg.result,segments:p.segments});w.pending=null;}
      if(msg.type==='error'){p.reject(new Error(cleanError(msg.error)));w.pending=null;}
    }catch(e){fail(new Error(`ASR protocol error: ${cleanError(e)}`));child.kill();}
  });
  child.on('error',e=>fail(new Error(`ASR worker could not start: ${cleanError(e)}`)));
  child.on('exit',(code)=>fail(new Error(`ASR worker exited (${code}): ${cleanError(w.stderr)}`)));
  return w;
}
function validateSegment(s) {
  if(!s||!Number.isFinite(s.start)||!Number.isFinite(s.end)||s.start<0||s.end<s.start||typeof s.text!=='string')throw new Error('Backend returned invalid segment.');
  if(s.words)for(const word of s.words)if(!Number.isFinite(word.start)||!Number.isFinite(word.end)||word.start<0||word.end<word.start)throw new Error('Backend returned invalid word times.');
}
function killWorker(w,error) {
  if(!w)return;
  w.fail(error);w.child.kill();
}

export async function transcribeAudio({file,config,signal,onSegments}={}) {
  const requested=performance.now();
  const c=config?normalizeConfig(config):await loadAsrConfig();
  if(!c)throw new Error('ASR is not configured. Import an existing transcript or configure an optional backend.');
  const key=sha(JSON.stringify(c));
  if((queueDepth.get(key)??0)>=8)throw new Error('ASR queue limit reached (8 calls per model).');
  queueDepth.set(key,(queueDepth.get(key)??0)+1);
  const ownGeneration=generation;
  const checkCancelled=()=>{if(signal?.aborted||ownGeneration!==generation)throw new Error('ASR cancelled.');};
  const predecessor=queues.get(key)??Promise.resolve();
  const work=predecessor.catch(()=>{}).then(async()=>{
    const queueWaitMs=Math.round(performance.now()-requested);
    checkCancelled();
    file=await realpath(file);checkCancelled();
    if(!(await stat(file)).isFile())throw new Error('ASR input must be a regular audio file.');
    checkCancelled();
    const identity=await asrCacheIdentity(c),signature=sha(JSON.stringify(identity));
    checkCancelled();
    const prior=pool.get(key);
    if(prior&&prior.identitySignature!==signature)killWorker(prior,new Error('ASR configuration/model installation changed.'));
    const w=makeWorker(c);w.identitySignature=signature;clearTimeout(w.idle);
    let firstSegmentMs;
    const abort=()=>killWorker(w,new Error('ASR cancelled.'));
    signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(()=>killWorker(w,new Error('ASR timeout reached.')),c.timeoutSeconds*1000);
    try{
      if(signal?.aborted||ownGeneration!==generation){abort();checkCancelled();}
      await w.ready;
      if(signal?.aborted||ownGeneration!==generation){abort();checkCancelled();}
      const result=await new Promise((resolve,reject)=>{
        const id=randomUUID();
        w.pending={id,resolve,reject,segments:[],onSegments:segments=>{if(firstSegmentMs===undefined&&segments.length)firstSegmentMs=Math.round(performance.now()-requested);onSegments?.(segments);}};
        w.child.stdin.write(JSON.stringify({id,type:'transcribe',file,config:c})+'\n',err=>{if(err)killWorker(w,new Error('ASR worker input closed.'));});
      });
      return {...result,...identity,metrics:{...result.metrics,queueWaitMs,firstFinalSegmentMs:firstSegmentMs??null,totalMs:Math.round(performance.now()-requested)}};
    }finally{
      clearTimeout(timer);signal?.removeEventListener('abort',abort);
      if(pool.get(key)===w){w.idle=setTimeout(()=>killWorker(w,new Error('ASR idle release.')),c.idleSeconds*1000);w.idle.unref();}
    }
  });
  queues.set(key,work);
  const cleanup=()=>{queueDepth.set(key,(queueDepth.get(key)??1)-1);if(queues.get(key)===work)queues.delete(key);};
  work.then(cleanup,cleanup);
  // A cancelled queued call returns immediately without killing the active call
  // belonging to another media job. Its deferred operation checks abort again.
  if(!signal)return work;
  return new Promise((resolve,reject)=>{
    const cancelled=()=>{signal.removeEventListener('abort',cancelled);reject(new Error('ASR cancelled.'));};
    if(signal.aborted){cancelled();return;}
    signal.addEventListener('abort',cancelled,{once:true});
    work.then(value=>{signal.removeEventListener('abort',cancelled);resolve(value);},error=>{signal.removeEventListener('abort',cancelled);reject(error);});
  });
}

export async function closeAsr() {
  generation++;
  const workers=[...pool.values()];
  for(const w of workers)killWorker(w,new Error('ASR service closed.'));
  await Promise.all(workers.map(w=>new Promise(resolve=>{if(w.child.exitCode!==null)return resolve();const timer=setTimeout(resolve,1000);w.child.once('exit',()=>{clearTimeout(timer);resolve();});})));
}
process.once('exit',()=>{for(const w of pool.values())w.child.kill();});
