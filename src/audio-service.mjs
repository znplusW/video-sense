import {mkdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {localFile,exec,FFPROBE} from './media.mjs';
import {mediaIdentity} from './text-service.mjs';
import {createNetworkProxy,resolveAudioUrl,networkInputArgs,runNetworkCommand,webUrl,publicSource,redactNetworkError} from './network.mjs';

export async function probeAudio({file,input,signal}){
  const args=['-v','error',...(input?networkInputArgs(input):['-protocol_whitelist','file,pipe']),
    '-analyzeduration','1000000','-probesize','65536','-show_entries','format=duration:stream=codec_type,codec_name,sample_rate,channels,duration','-of','json',input?.url??file];
  const raw=input?await runNetworkCommand(FFPROBE,args,{signal,proxy:input.proxy,timeout:20000,maxBuffer:1024**2}):
    (await exec(FFPROBE,args,{signal,windowsHide:true,timeout:15000,maxBuffer:1024**2})).stdout;
  const data=JSON.parse(raw),audio=data.streams?.find(s=>s.codec_type==='audio');
  if(!audio)throw new Error('No audio stream found in this source.');
  const duration=Number(data.format?.duration??audio.duration);
  return {duration:Number.isFinite(duration)&&duration>0?duration:null,hasAudio:true,hasVideo:data.streams.some(s=>s.codec_type==='video'),codec:audio.codec_name,
    sampleRate:Number(audio.sample_rate)||null,channels:audio.channels??null};
}

export function audioSourceRange(spec,duration){
  const end=Math.min(spec.end??duration??NaN,duration??Infinity);
  if(!Number.isFinite(end)||end<=spec.start)throw new Error('Audio needs a finite duration or an explicit end greater than start.');
  if(spec.end!==undefined&&duration!==null&&spec.end>duration+0.05)throw new Error('Requested audio end exceeds source duration.');
  return {start:spec.start,end};
}

// Registers audio media directly. No visual worker, selector, PNG or video task.
export class AudioService{
  constructor(owner){this.owner=owner;this.running=new Map();}
  async start(args,isUrl=false){
    const start=args.start??0,end=args.end;
    if(!Number.isFinite(start)||start<0||(end!==undefined&&(!Number.isFinite(end)||end<=start)))throw new Error('Invalid audio start/end range.');
    const spec={mode:'audio',sourceType:isUrl?'url':'file',start,end};
    if(isUrl){
      spec.url=webUrl(args.url).href;spec.urlType=args.sourceType??'auto';spec.itemIndex=args.itemIndex??1;
      if(!['auto','direct','page'].includes(spec.urlType))throw new Error('sourceType must be auto, direct or page.');
      if(!Number.isInteger(spec.itemIndex)||spec.itemIndex<1||spec.itemIndex>100)throw new Error('itemIndex must be 1..100.');
    }else spec.file=await localFile(args.file);
    return this.owner.start(spec);
  }
  async startInternal(spec){
    const id=randomUUID(),directory=path.join(this.owner.root,id);
    await mkdir(directory,{recursive:true});
    const j={id,kind:'audio',sourceType:spec.sourceType,status:'starting',phase:spec.sourceType==='url'?'resolving':'probing',
      mediaId:await mediaIdentity(spec.sourceType==='file'?{mode:'file',file:spec.file}:{mode:'audio-url',url:spec.url,itemIndex:spec.itemIndex}),
      schemaVersion:'1',created:new Date().toISOString(),requestedRange:{start:spec.start,...(spec.end===undefined?{}:{end:spec.end})},
      source:spec.sourceType==='url'?publicSource(spec.url):spec.file,settings:spec.sourceType==='url'?{sourceType:spec.urlType,itemIndex:spec.itemIndex,maxNetworkBytes:1024**3}:{},
      directory,persist:Promise.resolve(),worker:null};
    this.owner.jobs.set(id,j);await this.owner.save(j);
    if(this.owner.closed){j.status='stopped';await this.owner.save(j);return this.owner.snapshot(j);}
    const controller=new AbortController();
    const promise=Promise.resolve().then(()=>this.prepare(j,spec,controller.signal)).catch(async e=>{
      j.status=controller.signal.aborted?'stopped':'error';j.error=controller.signal.aborted?undefined:redactNetworkError(e);
      await this.owner.save(j);
    }).finally(()=>this.running.delete(id));
    this.running.set(id,{controller,promise});return this.owner.snapshot(j);
  }
  async prepare(j,spec,signal){
    let proxy;
    try{
      let input,resolved;
      if(spec.sourceType==='url'){
        proxy=await createNetworkProxy({maxBytes:1024**3,allowOrigin:process.env.AGENT_VIDEO_TEST_NETWORK_ORIGIN?.split(',')});
        resolved=await resolveAudioUrl({...spec,sourceType:spec.urlType},proxy,signal);
        input={...resolved,proxy};
      }
      if(signal.aborted)throw new Error('Audio source preparation cancelled.');
      j.phase='probing';await this.owner.save(j);
      const probed=await probeAudio({file:spec.file,input,signal});
      const metadata={...resolved?.metadata,...probed,duration:probed.duration??resolved?.metadata.duration??null};
      if(resolved&&probed.hasVideo)resolved.resources.audio.kind='muxed';
      const range=audioSourceRange(spec,metadata.duration);
      if(signal.aborted)throw new Error('Audio source preparation cancelled.');
      j.metadata=metadata;j.range=range;
      if(resolved){j.resolved=resolved;j.resolvedAt=Date.now();
        const cached=[...this.owner.jobs.values()].filter(x=>x.resolved).sort((a,b)=>b.resolvedAt-a.resolvedAt);
        for(const old of cached.slice(16))old.resolved=null;
      }
      j.status='ready';j.phase='source_ready';j.network=proxy?.stats;await this.owner.save(j);
    }finally{if(proxy){j.network=proxy.stats;proxy.close();}}
  }
  async status(id,waitSeconds,signal){
    const j=await this.owner.job(id);if(j.kind!=='audio')throw new Error('audio_status requires an audio task ID.');
    return this.owner.status(id,waitSeconds,signal);
  }
  async stop(id){const source=this.running.get(id);if(source){source.controller.abort();await source.promise;}}
  async close(){await Promise.all([...this.running.keys()].map(id=>this.stop(id)));}
}
