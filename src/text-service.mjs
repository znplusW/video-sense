import { mkdir,readFile,writeFile,stat } from 'node:fs/promises';
import { randomUUID,createHash } from 'node:crypto';
import path from 'node:path';
import { createNetworkProxy,fetchNetworkText,redactNetworkError } from './network.mjs';
import { parseTranscript,queryTranscript,mergeSegments } from './transcript.mjs';
import { mapAsrSegments } from './audio.mjs';
import { resilientAudioBlocks } from './audio-acquisition.mjs';
import { loadAsrConfig,doctorAsr,transcribeAudio,closeAsr,asrCacheIdentity } from './asr.mjs';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const working=s=>['starting','running'].includes(s);
export const sameSource=t=>t?.origin==='media_task'||typeof t?.cacheKey==='string';
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export async function mediaIdentity(spec) {
  if(spec.mode==='file'){const s=await stat(spec.file);return 'media_'+digest({file:spec.file,size:s.size,mtimeMs:s.mtimeMs});}
  return 'media_'+digest(spec.mode==='audio-url'?{url:spec.url,mediaType:'audio',itemIndex:spec.itemIndex}:{url:spec.url,videoIndex:spec.videoIndex});
}
function summary(t){
  const {segments,events,unalignedText,sourceFullText,...data}=t;
  return {...data,segmentCount:segments.length,eventCount:events?.length??0,...(unalignedText?{hasUnalignedText:true}:{})};
}
function convertWebSubtitle(raw,format){
  if(!['json3','json','bcc'].includes(format))return {raw,format};
  const data=JSON.parse(raw);
  if(Array.isArray(data.body))return {format:'json',raw:{segments:data.body.map(s=>({start:s.from,end:s.to,text:s.content}))}};
  if(Array.isArray(data.events))return {format:'json',raw:{segments:data.events.filter(e=>e.segs?.some(s=>s.utf8?.trim())).map(e=>({start:e.tStartMs/1000,end:(e.tStartMs+e.dDurationMs)/1000,text:e.segs.map(s=>s.utf8??'').join('')}))}};
  return {raw:data,format:'json'};
}

export class TextService {
  constructor(owner){this.owner=owner;this.running=new Map();this.tracks=new Map();this.registration=Promise.resolve();}
  async register(fn){const previous=this.registration;let release;this.registration=new Promise(r=>{release=r;});await previous;try{return await fn();}finally{release();}}
  async doctor(){return doctorAsr();}
  async ready(j,signal){
    for(let i=0;i<600&&!j.metadata;i++){
      if(signal?.aborted)throw new Error('Text processing stopped.');
      if(!working(j.status))throw new Error('Media metadata unavailable; source task failed, stopped or was interrupted.');
      await sleep(50);
    }
    if(!j.metadata)throw new Error('Media metadata not ready; try again later.');
  }
  async load(j,id){
    id??=j.transcriptTracks?.filter(sameSource).at(-1)?.id;
    if(!id||!j.transcriptTracks?.some(t=>t.id===id))throw new Error('Transcript track not found; start same-source subtitle retrieval or transcription first.');
    const key=j.id+':'+id;
    if(!this.tracks.has(key)){
      const t=JSON.parse(await readFile(path.join(j.directory,'transcripts',id+'.json'),'utf8'));
      if(working(t.status)){t.status='interrupted';t.error='Original text task is no longer attached.';}
      this.tracks.set(key,t);
    }
    const track=this.tracks.get(key);
    if(!sameSource(track))throw new Error('Legacy external transcript is not a same-source media track. Use the external text directly in the Agent; it is no longer served by this MCP.');
    return track;
  }
  async store(j,t){
    const dir=path.join(j.directory,'transcripts');await mkdir(dir,{recursive:true});
    t.updatedAt=new Date().toISOString();
    // Serialize snapshots immediately so later segment revisions cannot change queued writes.
    const data=JSON.stringify(t);
    j.textPersist=(j.textPersist??Promise.resolve()).catch(()=>{}).then(()=>writeFile(path.join(dir,t.id+'.json'),data));
    await j.textPersist;
    j.transcriptTracks??=[];
    const index=j.transcriptTracks.findIndex(x=>x.id===t.id);
    if(index<0)j.transcriptTracks.push(summary(t));else j.transcriptTracks[index]=summary(t);
    this.tracks.set(j.id+':'+t.id,t);await this.owner.save(j);
  }
  append(t,incoming){
    if(t.events.length+incoming.length>100000)throw new Error('Transcript event limit reached; partial data retained.');
    t.segments=mergeSegments(t.segments,incoming);
    for(const segment of incoming)t.events.push({sequence:t.events.length+1,...segment});
  }
  async resources(j,signal){
    await this.ready(j,signal);
    if((j.kind==='url'||(j.kind==='audio'&&j.sourceType==='url'))&&!j.resolved)throw new Error('Private media resolution is unavailable after server restart; reopen the original URL to avoid guessing media identity.');
    return j.resolved?.resources;
  }
  async start(args){
    return this.register(()=>this.startUnlocked(args));
  }
  async startUnlocked(args){
    const requestedAt=Date.now();
    const j=await this.owner.job(args.id);
    const epoch=j.textEpoch??0;
    if(this.owner.closed)throw new Error('Service is closed.');
    if((j.transcriptTracks?.filter(sameSource).length??0)>=8)throw new Error('At most eight text tracks per job.');
    if(this.running.size>=2)throw new Error('At most two active text tasks per server.');
    const mode=args.mode??'asr';
    if(!['asr','subtitles'].includes(mode))throw new Error('Text mode must be asr or subtitles.');
    if(mode==='subtitles'&&!args.trackId){
      const resources=await this.resources(j);
      const availableTracks=(resources?.subtitles??[]).map(({url,headers,...t})=>t);
      return {id:j.id,mediaId:j.mediaId,status:availableTracks.length?'selection_required':'no_tracks',availableTracks,
        note:availableTracks.length?'Choose an explicit subtitle trackId. No subtitle was fetched or validated for synchronization.':
          'No subtitle tracks were resolved. This does not mean the source has no audio or speech. Continue the host-chosen visual workflow; optional ASR is a separate decision based on the user request.'};
    }
    const config=mode==='asr'?await loadAsrConfig():null;
    if(mode==='asr'&&!config)throw new Error('ASR is not configured. Configure an optional backend or select available same-source network subtitles; visual evidence remains available. External text stays with the Agent.');
    if(args.backend&&args.backend!==config?.backend)throw new Error('Requested backend is not the configured backend.');
    await this.ready(j);
    const backendIdentity=config?await asrCacheIdentity(config):null;
    const cacheKey=digest({mediaId:j.mediaId,start:args.start??j.range?.start,end:args.end??j.range?.end,mode,trackId:args.trackId,language:args.language,config,backendIdentity,
      ...(backendIdentity?.modelRevision.startsWith('identifier:')?{unresolvedModelRevisionNonce:randomUUID()}:{})});
    const cached=j.transcriptTracks?.find(t=>t.cacheKey===cacheKey&&t.status==='complete');
    if(cached&&!args.force)return {...cached,cached:true};
    const t={id:randomUUID(),origin:'media_task',schemaVersion:'1',mediaId:j.mediaId,timeBase:'source_media_seconds',timeUnit:'seconds',status:'starting',source:{type:mode==='asr'?'asr':'subtitle'},
      binding:{basis:'Same job and selected source entry',syncVerified:false},mapping:{operation:'source seconds = block origin + backend relative seconds',precision:'Resampled sample position plus requested seek; backend timings are estimates.'},
      alignment:'aligned',segments:[],events:[],processedRanges:[],requestedRange:{start:args.start??j.range?.start??j.requestedRange?.start??0,end:args.end??j.range?.end},createdAt:new Date(requestedAt).toISOString(),cacheKey};
    await this.store(j,t);
    if(this.owner.closed||(j.textEpoch??0)!==epoch){t.status='stopped';await this.store(j,t);return summary(t);}
    const controller=new AbortController();
    const promise=this.run(j,t,args,config,controller.signal).catch(async e=>{t.status=controller.signal.aborted?'stopped':'error';t.error=redactNetworkError(e);t.errorCode=e.code;await this.store(j,t);}).finally(()=>this.running.delete(t.id));
    this.running.set(t.id,{jobId:j.id,controller,promise});return summary(t);
  }
  async run(j,t,args,config,signal){
    await this.ready(j,signal);
    t.requestedRange={start:args.start??j.range.start,end:Math.min(args.end??j.range.end,j.metadata.duration??Infinity)};
    const {start,end}=t.requestedRange;
    if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<=start||(j.metadata.duration!=null&&args.end>j.metadata.duration))throw new Error('Invalid transcript source range.');
    if(end-start>1800)throw new Error('A text task is limited to 1800 source seconds; request a shorter range.');
    if((j.kind==='file'||(j.kind==='audio'&&j.sourceType==='file'))&&j.mediaId!==await mediaIdentity({mode:'file',file:j.source}))throw new Error('Local media version changed since the media task started.');
    let proxy;
    try{
      let input;
      if(j.kind==='url'||(j.kind==='audio'&&j.sourceType==='url')){
        const resources=await this.resources(j,signal);
        proxy=await createNetworkProxy({maxBytes:1024**3,allowOrigin:process.env.AGENT_VIDEO_TEST_NETWORK_ORIGIN?.split(',')});
        if(args.mode==='subtitles'){
          const selected=resources.subtitles.find(s=>s.id===args.trackId);if(!selected)throw new Error('Subtitle track unavailable; select from availableTracks.');
          t.status='running';t.source={type:'subtitle',language:selected.language,trackId:selected.id,subtitleKind:selected.category};await this.store(j,t);
          const raw=await fetchNetworkText({...selected,proxy},signal),converted=convertWebSubtitle(raw,selected.format);
          const parsed=parseTranscript(converted.raw,{format:converted.format,source:t.source,duration:j.metadata.duration??undefined,mediaId:j.mediaId,bindingBasis:'Subtitle track from the same resolved source entry'});
          parsed.segments=parsed.segments.filter(s=>s.start<end&&s.end>start);
          Object.assign(t,parsed);this.append(t,parsed.segments);t.processedRanges=parsed.segments.map(s=>({start:Math.max(start,s.start),end:Math.min(end,s.end)}));
          t.coverageBasis='Retrieved subtitle cue intervals; cue gaps do not establish silence.';t.status='complete';t.network=proxy.stats;await this.store(j,t);return;
        }
        if(!resources.audio)throw new Error('No audio track resolved for the selected media entry.');
        await proxy.validate(resources.audio.url);input={...resources.audio,proxy};t.audioSource={kind:resources.audio.kind,formatId:resources.audio.formatId};
      }else if(args.mode==='subtitles')throw new Error('Same-source subtitle retrieval requires a resolved network subtitle track. Local external subtitles stay with the Agent; use optional ASR for local media.');
      t.status='running';t.phase='acquiring_audio';t.source={type:'asr',backend:config.backend,model:config.model,device:config.device,...(args.language?{language:args.language}:{})};
      const directory=path.join(j.directory,'transcripts',t.id+'-audio');await mkdir(directory,{recursive:true});await this.store(j,t);
      const began=performance.now();
      for await(const block of resilientAudioBlocks({file:j.source,input,...t.requestedRange,directory,signal,contextSeconds:config.wordTimestamps?1:0,
        audioFallback:args.audioFallback??'on_failure',expectedDuration:j.metadata.duration,
        onPid:pid=>{t.audioPid=pid;},onAcquisition:state=>{t.acquisition=state;},
        onTransfer:async state=>{t.audioTransfer=state;if(state.status==='downloading')t.phase='downloading_audio_fallback';await this.store(j,t);}})){
        t.phase='transcribing';await this.store(j,t);
        const result=block.digitalSilence?{segments:[],backend:config.backend,model:config.model,device:config.device,metrics:{backendInvoked:false,reason:'All decoded signed-16-bit PCM samples are exactly zero.'}}:
          await transcribeAudio({file:block.file,config:{...config,...(args.language?{language:args.language}:{})},signal});
        t.source={...t.source,backend:result.backend,model:result.model,modelRevision:result.modelRevision??t.source.modelRevision,engineVersion:result.engineVersion??t.source.engineVersion,device:result.device,...(result.language?{language:result.language}:{})};
        this.append(t,mapAsrSegments(result,block,t.id,t.segments));
        t.speechStatus=t.segments.length?'recognized':'no_speech_in_processed_ranges';
        t.processedRanges.push({start:block.coreStart,end:block.coreEnd});
        t.lastBlock={index:block.index,sampleStart:block.sampleStart,sampleCount:block.sampleCount,sourceStart:block.start,sourceEnd:block.end,backendMetrics:result.metrics};
        if(t.segments.length&&!t.firstFinalTextMs){t.firstFinalTextMs=Math.round(performance.now()-began);t.requestToFirstFinalTextMs=Date.now()-Date.parse(t.createdAt);}
        t.network=proxy?.stats;t.phase='acquiring_audio';await this.store(j,t);
      }
      t.status='complete';t.speechStatus=t.segments.length?'recognized':'no_speech';t.phase='finished';t.totalMs=Math.round(performance.now()-began);await this.store(j,t);
    }finally{proxy?.close();t.audioPid=null;}
  }
  async read(args,signal){
    const j=await this.owner.job(args.id);
    if(!args.trackId&&!j.transcriptTracks?.some(sameSource))return {schemaVersion:'1',jobId:j.id,mediaId:j.mediaId,status:'not_enabled',segments:[],nextAfter:0};
    const t=await this.load(j,args.trackId),after=args.after??0,limit=args.limit??100;
    if(!Number.isInteger(after)||after<0||!Number.isInteger(limit)||limit<1||limit>500)throw new Error('after >=0, limit 1..500 required.');
    const start=args.start??0,end=args.end??Infinity;
    if(!Number.isFinite(start)||start<0||!(end>start))throw new Error('Invalid text query range.');
    const deadline=Date.now()+Math.min(20,args.waitSeconds??0)*1000;
    while(t.events.length<=after&&working(t.status)&&Date.now()<deadline&&!signal?.aborted)await sleep(50);
    if(signal?.aborted)throw new Error('Text wait cancelled; processing can be stopped with session_stop.');
    const matching=t.events.filter(s=>s.sequence>after&&s.start<end&&s.end>start),events=matching.slice(0,limit);
    return {...summary(t),segments:events,nextAfter:events.at(-1)?.sequence??after,more:matching.length>events.length,
      ...(t.alignment==='unaligned'?{unalignedText:t.unalignedText}:{}),cursorSemantics:'Monotonic event sequence; revised segment IDs replace earlier revisions, not new events.'};
  }
  async evidence(args,signal){
    const j=await this.owner.job(args.id);await this.ready(j);
    if(j.kind==='audio')throw new Error('Audio-only tasks use transcript_read; video_evidence requires video images.');
    const {start,end}=args;if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<=start)throw new Error('Evidence needs a finite source time interval.');
    const limit=args.imageLimit??2;if(!Number.isInteger(limit)||limit<0||limit>12)throw new Error('imageLimit must be 0..12.');
    if(!Number.isInteger(args.afterSheet??0)||(args.afterSheet??0)<0)throw new Error('afterSheet must be a nonnegative next sheet offset.');
    const images=[],frames=[];let nextSheet=null;
    for(let i=args.afterSheet??0;i<j.sheets;i++){
      const raw=JSON.parse(await readFile(path.join(j.directory,`sheet-${String(i).padStart(6,'0')}.json`),'utf8'));
      const matches=raw.frames.map((f,k)=>({...f,frameNumber:k+1,sheetIndex:i})).filter(f=>f.t>=start&&f.t<end);
      if(!matches.length)continue;
      if(images.length>=limit){nextSheet=i;break;}
      const image=await this.owner.readSheet(j,i,args.format,{signal});
      if(images.reduce((n,s)=>n+s.data.length,0)+image.data.length>8*1024**2){
        if(!images.length)throw new Error('Image exceeds the 8 MiB batch budget; request a lower-quality analysis.');
        nextSheet=i;break;
      }
      images.push(image);frames.push(...matches);
    }
    const texts=[];
    for(const index of (j.transcriptTracks??[]).filter(sameSource)){const t=await this.load(j,index.id);texts.push({trackId:t.id,status:t.status,...queryTranscript(t,{start,end,limit:args.textLimit??100})});}
    const info={schemaVersion:'1',jobId:j.id,mediaId:j.mediaId,timeBase:'source_media_seconds',timeUnit:'seconds',requestedRange:{start,end},
      timestampAccuracy:'Video frame times are requested seek + 12fps output sample grid estimates, not exact source PTS.',frames,
      transcripts:texts,relations:frames.map(f=>({sheetIndex:f.sheetIndex,frameNumber:f.frameNumber,time:f.t,segments:texts.flatMap(t=>t.segments.filter(s=>s.start<=f.t&&s.end>f.t).map(s=>({trackId:t.trackId,segmentId:s.id})))})),
      relationMeaning:'Time interval intersection only; no semantic match or causal judgment.',visualStatus:j.status,visualCoverage:this.owner.snapshot(j).visualCoverage,nextSheet};
    // A later missing/invalid transcript can fail the whole response. Commit
    // delivery only once every image, text page and time relation is prepared.
    signal?.throwIfAborted();this.owner.recordDelivery(j,images.map(image=>image.info.index));
    const visualDelivery=this.owner.delivery(j);
    return {images:images.map(image=>({...image,info:{...image.info,visualDelivery}})),info:{...info,visualDelivery}};
  }
  async stop(id){const j=await this.owner.job(id);j.textEpoch=(j.textEpoch??0)+1;await Promise.all([...this.running.values()].filter(x=>x.jobId===id).map(async x=>{x.controller.abort();await x.promise;}));}
  async close(){await Promise.all([...this.running.values()].map(async x=>{x.controller.abort();await x.promise;}));await closeAsr();}
}
