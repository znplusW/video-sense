import { fork } from 'node:child_process';
import { mkdir,readFile,writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { options,localFile,exec,FFMPEG,FFPROBE,exactFrame } from './media.mjs';
import { webUrl,publicSource,YTDLP } from './network.mjs';
import { TextService,mediaIdentity,sameSource } from './text-service.mjs';
import { AudioService } from './audio-service.mjs';
import { visualDelivery } from './visual-delivery.mjs';
import { readImage,imageFormat,imageHash,assertImageBudget,MAX_IMAGES,MAX_IMAGE_BYTES } from './image-delivery.mjs';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const active=s=>s==='starting'||s==='running';
const worker=fileURLToPath(new URL('./worker.mjs',import.meta.url));
const networkWorker=fileURLToPath(new URL('./network-worker.mjs',import.meta.url));
const VERSION='0.9.0';
export class VideoService {
  constructor({dataDir=process.env.AGENT_VIDEO_DATA_DIR||path.resolve('work/video-sense-data')}={}) {
    this.root=path.resolve(dataDir);this.jobs=new Map();this.deliveries=new Map();this.closed=false;this.text=new TextService(this);this.audio=new AudioService(this);this.startQueue=Promise.resolve();this.imageRequests=new Set();

  }
  async withImages(id,signal,fn) {
    if(this.closed)throw new Error('Service is closed.');
    const controller=new AbortController(),combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
    const request={id,controller,promise:null};this.imageRequests.add(request);
    request.promise=Promise.resolve().then(()=>{combined.throwIfAborted();return fn(combined);});
    try{return await request.promise;}finally{this.imageRequests.delete(request);}
  }
  async cancelImages(id) {
    const requests=[...this.imageRequests].filter(r=>id===undefined||r.id===id);
    for(const r of requests)r.controller.abort(new Error('Image request cancelled.'));
    await Promise.allSettled(requests.map(r=>r.promise));
  }
  async doctor() {
    const result={version:VERSION,node:process.version,platform:process.platform,dataDir:this.root,networkVideoSupported:true,audioInputSupported:true,networkAudioSupported:true,imageDelivery:{backend:'ffmpeg',format:'jpeg',quality:4,pixelFormat:'yuvj444p',maxImages:12,maxImageBytes:MAX_IMAGE_BYTES,maxConcurrentPerProcess:2,timeoutSeconds:10,maxQueued:24,queueTimeoutSeconds:30,cancellable:true,pngOriginals:true}};
    for(const [name,command] of [['ffmpeg',FFMPEG],['ffprobe',FFPROBE],['ytDlp',YTDLP]]) {
      try {const r=await exec(command,[name==='ytDlp'?'--version':'-version'],{windowsHide:true,timeout:10000});result[name]={ok:true,command,version:r.stdout.split(/\r?\n/)[0]};}
      catch(e){result[name]={ok:false,command,error:e.message};}
    }
    result.asr=await this.text.doctor();result.textSources=['same_source_network_subtitles','optional_asr'];result.externalTranscriptImport=false;result.textReadCompletionRequired=false;result.evidenceSchemaVersion='1';return result;
  }
  async startVideo(args) {
    const file=await localFile(args.file), start=args.start??0, end=args.end;
    if(!Number.isFinite(start)||start<0||(end!==undefined&&(!Number.isFinite(end)||end<=start))) throw new Error('Invalid start/end range.');
    return this.start({mode:'file',file,start,end,...options(args),maxRunSeconds:7200,maxSheets:5000,maxBytes:2*1024**3});
  }
  async startUrl(args) {
    const url=webUrl(args.url).href,start=args.start??0,end=args.end;
    const analysis=args.analysis??'continuous',sourceType=args.sourceType??'auto',samples=args.samples??8,videoIndex=args.videoIndex??1,videoFallback=args.videoFallback??'on_failure';
    if(!['on_failure','never'].includes(videoFallback))throw new Error('videoFallback must be on_failure or never.');
    if(!Number.isFinite(start)||start<0||(end!==undefined&&(!Number.isFinite(end)||end<=start)))throw new Error('Invalid start/end range.');
    if(!['continuous','overview'].includes(analysis)||!['auto','direct','page'].includes(sourceType))throw new Error('Invalid analysis or sourceType.');
    if(!Number.isInteger(samples)||samples<2||samples>16)throw new Error('samples must be 2..16.');
    if(!Number.isInteger(videoIndex)||videoIndex<1||videoIndex>100)throw new Error('videoIndex must be 1..100.');
    return this.start({mode:'url',url,start,end,analysis,sourceType,samples,videoIndex,videoFallback,...options(args),maxRunSeconds:1800,maxSheets:5000,maxBytes:2*1024**3,maxNetworkBytes:1024**3});
  }
  async start(spec) {
    const previous=this.startQueue;let release;this.startQueue=new Promise(r=>{release=r;});await previous;
    try{return await this.startInternal(spec);}finally{release();}
  }
  async startInternal(spec) {
    if(this.closed) throw new Error('Service is closed.');
    if(!['file','url','audio'].includes(spec.mode))throw new Error('Unsupported source mode; use file, url or audio.');
    if([...this.jobs.values()].filter(j=>active(j.status)).length>=2) throw new Error('At most two active sessions per server.');
    if(spec.mode==='audio')return this.audio.startInternal(spec);
    const id=randomUUID(), directory=path.join(this.root,id);
    await mkdir(directory,{recursive:true});
    const j={id,kind:spec.mode,status:'starting',sheets:0,bytes:0,frames:0,created:new Date().toISOString(),
      mediaId:await mediaIdentity(spec),schemaVersion:'1',requestedRange:{start:spec.start??0,...(spec.end===undefined?{}:{end:spec.end})},
      source:spec.mode==='url'?publicSource(spec.url):spec.file,settings:{...options(spec),...(spec.mode==='url'?{analysis:spec.analysis,sourceType:spec.sourceType,samples:spec.samples,videoIndex:spec.videoIndex,videoFallback:spec.videoFallback,maxNetworkBytes:spec.maxNetworkBytes,maxRunSeconds:spec.maxRunSeconds}:{})},touched:Date.now(),directory,
      worker:null,persist:Promise.resolve()};
    this.jobs.set(id,j);
    await this.save(j);
    const child=fork(spec.mode==='url'?networkWorker:worker,[],{stdio:['ignore','ignore','pipe','ipc'],serialization:'advanced',windowsHide:true});
    j.worker=child;let stderr='';
    child.stderr.on('data',d=>{stderr=(stderr+d).slice(-2000);});
    child.on('message',msg=>{
      if(msg.type==='resolved-private'){j.resolved=msg.resolved;j.resolvedAt=msg.at;const cached=[...this.jobs.values()].filter(x=>x.resolved).sort((a,b)=>b.resolvedAt-a.resolvedAt);for(const old of cached.slice(16))old.resolved=null;return;}
      if(msg.type==='phase')j.phase=msg.phase;
      if(msg.type==='video-transfer')j.videoTransfer=msg.videoTransfer;
      if(msg.type==='metadata') {j.metadata=msg.metadata;j.range=msg.range;j.coverage=msg.coverage??{mode:'continuous',plannedRanges:[msg.range],completedRanges:[],completeTimeline:false};}
      if(msg.network)j.network=msg.network;
      if(msg.completedRanges&&j.coverage)j.coverage.completedRanges=msg.completedRanges;
      if(msg.type==='running') {if(active(j.status))j.status='running';j.capturePid=msg.capturePid;}
      if(msg.type==='progress') Object.assign(j,{decodedThrough:msg.decodedThrough,frames:msg.frames,bytes:msg.bytes});
      if(msg.type==='sheet') {
        j.sheets=msg.info.index+1;j.lastTime=msg.info.to;

      }
      if(msg.type==='end') {
        j.status=msg.status;j.reason=msg.reason;j.error=msg.error;j.stats=msg.stats;j.bytes=msg.bytes;j.sheets=msg.sheets;
        j.frames=msg.stats?.frames??j.frames;
        if(j.coverage){j.coverage.completeTimeline=msg.status==='complete'&&j.coverage.mode==='continuous';if(j.coverage.completeTimeline)j.coverage.completedRanges=[j.range];}
      }
      if(msg.type!=='progress') this.save(j).catch(e=>{j.error=`Manifest write: ${e.message}`;});
    });
    child.on('error',e=>{j.status='error';j.error=e.message;this.save(j).catch(()=>{});});
    child.on('exit',()=>{
      if(active(j.status)) {j.status='error';j.error=stderr||'Worker exited before completion.';}
      j.worker=null;j.capturePid=null;this.save(j).catch(()=>{});
    });
    child.send({type:'start',spec:{...spec,directory}});
    return this.snapshot(j);
  }
  snapshot(j) {
    const {worker,persist,textPersist,touched,directory,resolved,resolvedAt,visualDelivery:priorDelivery,...publicData}=j;
    const tracks=(j.transcriptTracks??[]).filter(sameSource),textStatus=tracks.some(t=>active(t.status))?'running':tracks.at(-1)?.status??'not_enabled';
    if(j.kind==='audio')return {...publicData,transcriptTracks:tracks,directory,manifest:path.join(directory,'manifest.json'),
      statuses:{source:j.status,transcript:textStatus,visual:'not_applicable'},audioAnalyzed:tracks.some(t=>t.source.type==='asr'&&t.processedRanges?.length>0),
      timeBase:'source_media_seconds',timeUnit:'seconds',timestampAccuracy:'Resampled audio sample position plus requested seek; ASR timings are estimates.',
      textCoverage:tracks.map(t=>({trackId:t.id,status:t.status,requestedRange:t.requestedRange,processedRanges:t.processedRanges,alignment:t.alignment,coverageBasis:t.coverageBasis}))};
    const processed=[...(j.coverage?.completedRanges??[])];
    const current=j.coverage?.plannedRanges?.find(r=>j.decodedThrough>=r.start&&j.decodedThrough<r.end&&!processed.some(p=>p.start===r.start&&p.end===r.end));
    if(current)processed.push({start:current.start,end:Math.min(current.end,j.decodedThrough+1/12)});
    return {...publicData,transcriptTracks:tracks,directory,manifest:path.join(directory,'manifest.json'),schemaVersion:'1',statuses:{visual:j.status,transcript:textStatus},audioAnalyzed:tracks.some(t=>t.source.type==='asr'&&t.processedRanges?.length>0),
      timeBase:'source_media_seconds',timeUnit:'seconds',
      timestampAccuracy:'Requested input seek plus 12fps output sample grid; not exact original PTS.',
      visualCoverage:{...j.coverage,processedRanges:processed},visualDelivery:this.delivery(j),sampling:'adaptive visual sampling, not every second and not every original frame'};
  }
  delivery(j) {return visualDelivery(j,this.deliveries.get(j.id));}
  recordDelivery(j,indices) {
    if(!['file','url'].includes(j.kind))return;
    let delivered=this.deliveries.get(j.id);
    if(!delivered){delivered=new Set();this.deliveries.set(j.id,delivered);}
    for(const index of indices)delivered.add(index);
  }
  async save(j) {
    // Retain legacy track metadata on disk, but do not serve it as current evidence.
    const data=JSON.stringify({...this.snapshot(j),transcriptTracks:j.transcriptTracks??[]},null,2);
    j.persist=j.persist.catch(()=>{}).then(()=>writeFile(path.join(j.directory,'manifest.json'),data));
    await j.persist;
  }
  async job(id) {
    if(!/^[0-9a-f-]{36}$/.test(id))throw new Error('Invalid session ID.');
    if(this.jobs.has(id))return this.jobs.get(id);
    let saved;
    try{saved=JSON.parse(await readFile(path.join(this.root,id,'manifest.json'),'utf8'));}
    catch{throw new Error('Session not found in this server data directory.');}
    // Saved delivery counts belong to a different server process, not this client.
    if(!['file','url','audio'].includes(saved.kind))throw new Error('Unsupported saved source kind; screen capture has been removed.');
    delete saved.visualDelivery;this.deliveries.delete(id);
    const j={...saved,directory:path.join(this.root,id),worker:null,persist:Promise.resolve()};
    j.mediaId??='legacy_job_'+id;
    if(active(j.status)){j.status='interrupted';j.error='Original worker is no longer attached to this MCP process; completeness is not established.';}
    for(const t of j.transcriptTracks??[])if(active(t.status)){t.status='interrupted';t.error='Original text worker is no longer attached.';}
    this.jobs.set(id,j);return j;
  }
  async status(id,waitSeconds=0,signal) {
    const j=await this.job(id), deadline=Date.now()+Math.max(0,Math.min(20,waitSeconds))*1000;
    while((active(j.status)||(j.kind==='audio'&&j.transcriptTracks?.some(t=>active(t.status))))&&Date.now()<deadline&&!signal?.aborted)await sleep(100);
    return this.snapshot(j);
  }
  async sheet(id,index,format='jpeg',signal) {
    const j=await this.job(id);
    const result=await this.readSheet(j,index,format,{signal});
    signal?.throwIfAborted();assertImageBudget([result]);
    this.recordDelivery(j,[index]);
    return {...result,info:{...result.info,visualDelivery:this.delivery(j)}};
  }
  async readSheet(j,index,format='jpeg',options={}) {
    if(j.kind==='audio')throw new Error('Audio tasks have no images; use transcript_read and audio_status.');
    if(!['file','url'].includes(j.kind)||!Number.isInteger(index)||index<0||index>=j.sheets)throw new Error('Sheet index not available. Use zero-based indices below sheets.');
    const base=path.join(j.directory,`sheet-${String(index).padStart(6,'0')}`);
    return this.withImages(j.id,options.signal,async signal=>{
      const [image,raw]=await Promise.all([readImage(base+'.png',format,{...options,signal}),readFile(base+'.json','utf8')]);
      signal.throwIfAborted();assertImageBudget([image]);
      return {data:image.data,mimeType:image.mimeType,info:{...JSON.parse(raw),index,jobId:j.id,mediaId:j.mediaId,timeBase:'source_media_seconds',timeUnit:'seconds',timestampAccuracy:'Requested seek plus 12fps output grid, not exact source PTS.',path:image.path,originalPath:image.originalPath,encodingProfile:image.encodingProfile,sourceSha256:image.sourceSha256,format:imageFormat(format),mimeType:image.mimeType,imageBytes:image.data.length,sha256:imageHash(image.data),totalSheets:j.sheets,status:j.status}};
    });
  }
  async nextSaved(id,after=-1,waitSeconds=20,signal,format='jpeg') {
    const j=await this.job(id);
    if(j.kind==='audio')throw new Error('Audio tasks have no images; use transcript_read and audio_status.');
    if(!Number.isInteger(after)||after< -1)throw new Error('after must be the last viewed index, starting at -1.');
    const started=Date.now(),deadline=started+Math.max(0,Math.min(20,waitSeconds))*1000,index=after+1;
    while(index>=j.sheets&&active(j.status)&&Date.now()<deadline&&!signal?.aborted)await sleep(25);
    if(signal?.aborted)throw new Error('Waiting cancelled; call session_stop to end the analysis.');
    const extra={id,mediaId:j.mediaId,status:j.status,statuses:this.snapshot(j).statuses,phase:j.phase,coverage:j.coverage,network:j.network,videoTransfer:j.videoTransfer,error:j.error,audioAnalyzed:this.snapshot(j).audioAnalyzed,waitedMs:Date.now()-started};
    if(index>=j.sheets)return {info:{...extra,newImage:false,totalSheets:j.sheets,visualDelivery:this.delivery(j)}};
    const sheet=await this.sheet(id,index,format,signal);
    return {...sheet,info:{...sheet.info,...extra,newImage:true}};
  }
  async readImages({id,after=-1,limit=12,waitSeconds=20,format='jpeg'},signal) {
    const j=await this.job(id);
    if(!['file','url'].includes(j.kind))throw new Error('video_read requires a saved file/URL video task; audio has no images.');
    if(!Number.isInteger(after)||after< -1)throw new Error('after must be the last returned image index, starting at -1.');
    if(!Number.isInteger(limit)||limit<1||limit>MAX_IMAGES)throw new Error('limit must be 1..12 images.');
    if(!Number.isFinite(waitSeconds)||waitSeconds<0||waitSeconds>20)throw new Error('waitSeconds must be 0..20.');
    imageFormat(format);
    const began=Date.now(),deadline=began+waitSeconds*1000,first=after+1;
    while(first>=j.sheets&&active(j.status)&&Date.now()<deadline&&!signal?.aborted)await sleep(25);
    if(signal?.aborted)throw new Error('Image wait cancelled; use session_stop to stop processing.');
    const candidates=Array.from({length:Math.max(0,Math.min(limit,j.sheets-first))},(_,offset)=>first+offset);
    // Commit a batch only after all of its files were read successfully. A failed
    // response must not count its earlier images as delivered.
    const images=[],indices=[];let imageBytes=0;
    batches: for(let offset=0;offset<candidates.length;offset+=2) {
      const controller=new AbortController(),pairSignal=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
      let failure;
      const pair=candidates.slice(offset,offset+2);
      const results=await Promise.allSettled(pair.map(index=>this.readSheet(j,index,format,{signal:pairSignal}).catch(error=>{failure??=error;controller.abort(error);throw error;})));
      if(failure)throw failure;
      for(let n=0;n<pair.length;n++) {
        const image=results[n].value,index=pair[n];
        if(imageBytes+image.data.length>MAX_IMAGE_BYTES) {
          if(!images.length)throw new Error('Image exceeds the 8 MiB batch budget; request a lower-quality analysis.');
          break batches;
        }
        images.push(image);indices.push(index);imageBytes+=image.data.length;
      }
    }
    if(signal?.aborted)throw new Error('Image wait cancelled; use session_stop to stop processing.');
    this.recordDelivery(j,indices);
    const progress=this.delivery(j),nextAfter=indices.at(-1)??after;
    const hasMore=active(j.status)||nextAfter+1<j.sheets;
    const snapshot=this.snapshot(j);
    return {images,info:{id,mediaId:j.mediaId,status:j.status,statuses:snapshot.statuses,
      images:images.map(image=>image.info),totalSheets:j.sheets,returnedImages:images.length,
      nextAfter,hasMore,exhausted:!hasMore,productionComplete:progress.productionComplete,
      productionTerminal:progress.productionTerminal,visualDelivery:progress,
      visualCoverage:snapshot.visualCoverage,videoTransfer:j.videoTransfer,waitedMs:Date.now()-began,error:j.error,
      imageBytes,maxImageBytes:MAX_IMAGE_BYTES,
      cursorSemantics:'after/nextAfter are zero-based image indices. Acknowledge actual inspection before another batch. Continue for the host-chosen evidence scope; generation/delivery alone does not establish sufficient evidence.'}};
  }
  async stop(id,reason='user') {
    await this.cancelImages(id);
    const j=await this.job(id);
    if(j.kind==='audio')await this.audio.stop(id);
    const stoppingText=this.text.stop(id);
    if(j.worker&&active(j.status)) {
      const child=j.worker;
      if(child.connected)child.send({type:'stop',reason});
      for(let i=0;i<30&&j.worker&&active(j.status);i++)await sleep(100);
      if(j.worker&&active(j.status)){child.kill();j.status='stopped';j.reason=reason;}
      await this.save(j);
    }
    await stoppingText;
    if(j.kind==='audio'){j.status='stopped';j.reason=reason;await this.save(j);}
    return this.snapshot(j);
  }
  async close() {
    this.closed=true;
    await this.cancelImages();
    await this.audio.close();
    await Promise.all([...this.jobs.values()].filter(j=>j.worker).map(j=>this.stop(j.id,'server-closed')));
    await this.text.close();
    await Promise.all([...this.jobs.values()].map(j=>j.persist));
  }
}
export {exactFrame};
