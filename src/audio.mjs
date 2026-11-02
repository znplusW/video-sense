import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { FFMPEG } from './media.mjs';
import { networkInputArgs,redactNetworkError } from './network.mjs';

export function wav(pcm) {
  const h=Buffer.alloc(44);h.write('RIFF');h.writeUInt32LE(36+pcm.length,4);h.write('WAVEfmt ',8);h.writeUInt32LE(16,16);
  h.writeUInt16LE(1,20);h.writeUInt16LE(1,22);h.writeUInt32LE(16000,24);h.writeUInt32LE(32000,28);h.writeUInt16LE(2,32);h.writeUInt16LE(16,34);h.write('data',36);h.writeUInt32LE(pcm.length,40);
  return Buffer.concat([h,pcm]);
}

// Drain one continuous decoder independently of ASR. WAV blocks are spooled to
// bounded disk storage; the queue contains descriptors, not retained PCM buffers.
export async function* audioBlocks({file,input,start,end,directory,signal,chunkSeconds=20,contextSeconds=1,onPid,onAcquisition,maxSpoolBytes=64*1024**2}) {
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start)throw new Error('Audio range must be finite.');
  if(!Number.isFinite(chunkSeconds)||chunkSeconds<=0||!Number.isFinite(contextSeconds)||contextSeconds<0||contextSeconds>chunkSeconds)throw new Error('Invalid audio chunk/context size.');
  const decoderAbort=new AbortController(),cancel=()=>decoderAbort.abort();
  signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
  const args=['-hide_banner','-v','error','-nostdin',...(input?networkInputArgs(input):['-protocol_whitelist','file,pipe']),
    ...(start?['-ss',String(start)]:[]),'-i',input?.url??file,'-t',String(end-start),'-map','0:a:0','-vn','-sn',
    '-af','aresample=16000:async=1:first_pts=0','-ac','1','-ar','16000','-f','s16le','pipe:1'];
  const child=spawn(FFMPEG,args,{stdio:['ignore','pipe','pipe'],windowsHide:true,env:input?.proxy.env,signal:decoderAbort.signal});
  onPid?.(child.pid);let stderr='',failure;
  const done=new Promise(resolve=>{child.on('error',e=>{failure=e;resolve(-1);});child.on('close',code=>{onPid?.(null);resolve(code);});});
  child.stderr.on('data',b=>stderr=(stderr+b).slice(-2000));
  const coreBytes=Math.round(chunkSeconds*16000)*2,contextBytes=Math.round(contextSeconds*16000)*2;
  let pending=Buffer.alloc(0),left=Buffer.alloc(0),samples=0,index=0,spooledBytes=0,finished=false,producerError,wake;
  const queue=[];
  let acquisitionStatus='running';
  const report=(status=acquisitionStatus,error)=>{
    acquisitionStatus=status;
    onAcquisition?.({status,decodedThrough:start+samples/16000,decodedSamples:samples,blocks:index,spooledBytes,queueDepth:queue.length,
      maxSpoolBytes,method:'continuous_decode_to_bounded_wav_spool',...(error?{error:redactNetworkError(error)}:{})});
  };
  const notify=()=>{const waiting=wake;wake=null;waiting?.();};
  async function make(last=false){
    const size=Math.min(coreBytes,pending.length),core=pending.subarray(0,size),right=pending.subarray(size,Math.min(size+contextBytes,pending.length));
    const data=Buffer.concat([left,core,right]),blockStart=start+(samples-left.length/2)/16000;
    const result={index,file:path.join(directory,`audio-${String(index).padStart(5,'0')}.wav`),start:blockStart,end:blockStart+data.length/32000,
      coreStart:start+samples/16000,coreEnd:start+(samples+size/2)/16000,sampleRate:16000,sampleStart:samples-left.length/2,sampleCount:data.length/2,digitalSilence:data.every(byte=>byte===0),last};
    if(spooledBytes+44+data.length>maxSpoolBytes)throw new Error('Audio spool limit reached; partial results retained.');
    await writeFile(result.file,wav(data),{flag:'wx'});spooledBytes+=44+data.length;
    left=Buffer.from(core.subarray(Math.max(0,size-contextBytes)));pending=Buffer.from(pending.subarray(size));samples+=size/2;index++;
    return result;
  }
  const timer=setTimeout(()=>child.kill(),1800000);
  const enqueue=async last=>{const block=await make(last);queue.push(block);report();notify();};
  report();
  const producer=(async()=>{
    try{
      for await(const chunk of child.stdout){
        if(decoderAbort.signal.aborted)throw new Error('Audio extraction cancelled.');
        pending=Buffer.concat([pending,chunk]);
        while(pending.length>=coreBytes+contextBytes)await enqueue(false);
      }
      const code=await done;
      if(decoderAbort.signal.aborted)throw new Error('Audio extraction cancelled.');
      if(failure)throw failure;
      if(code!==0){const e=new Error(redactNetworkError(new Error(`Audio decoder failed: ${stderr}`)));e.code=/HTTP error (401|403|404)|Server returned (401|403|404)/i.test(stderr)?'AUDIO_SOURCE_REJECTED':'AUDIO_ACQUISITION_FAILED';throw e;}
      if(!samples&&!pending.length){const e=new Error('No audio samples decoded.');e.code='AUDIO_ACQUISITION_FAILED';throw e;}
      while(pending.length)await enqueue(pending.length<=coreBytes);
      if(samples/16000<end-start-0.5){const e=new Error('Audio ended before the requested range; processed blocks are partial.');e.code='AUDIO_ACQUISITION_FAILED';throw e;}
      report('complete');
    }catch(e){producerError=e;report(decoderAbort.signal.aborted?'stopped':'error',e);}
    finally{finished=true;clearTimeout(timer);notify();}
  })();
  try{
    while(!finished||queue.length){
      if(signal?.aborted)throw new Error('Audio extraction cancelled.');
      if(queue.length){const block=queue.shift();report();yield block;}
      else await new Promise(resolve=>{wake=resolve;});
    }
    if(producerError)throw producerError;
  }finally{
    signal?.removeEventListener('abort',cancel);decoderAbort.abort();clearTimeout(timer);
    if(child.exitCode===null)child.kill();await producer;await done;onPid?.(null);
  }
}

export function mapAsrSegments(result,block,trackId,existing=[]) {
  const output=[],normal=s=>s.replace(/\s+/g,' ').trim();
  for(let i=0;i<result.segments.length;i++){
    const s=result.segments[i];
    if(!Number.isFinite(s.start)||!Number.isFinite(s.end)||s.start<0||s.end<=s.start||s.end>block.end-block.start+0.1||typeof s.text!=='string')throw new Error('ASR backend returned invalid segment timestamps.');
    let start=block.start+s.start,end=block.start+s.end,text=s.text,words;
    if(s.words?.length){
      words=s.words.map(w=>{if(!Number.isFinite(w.start)||!Number.isFinite(w.end)||w.start<0||w.end<w.start||w.end>block.end-block.start+0.1)throw new Error('Invalid ASR word timestamps.');return {...w,text:w.text??w.word,originalStart:w.start,originalEnd:w.end,start:block.start+w.start,end:block.start+w.end};})
        .filter(w=>{const mid=(w.start+w.end)/2;return mid>=block.coreStart&&mid<block.coreEnd;})
        .filter(w=>![...existing,...output].some(p=>p.words?.some(old=>normal(old.word??old.text??'').toLowerCase()===normal(w.word??w.text??'').toLowerCase()&&old.start<w.end&&old.end>w.start)));
      if(!words.length)continue;
      start=words[0].start;end=words.at(-1).end;text=words.map(w=>w.word??w.text??'').join('');
    }else{const mid=(start+end)/2;if(mid<block.coreStart||mid>=block.coreEnd)continue;}
    const duplicate=[...existing,...output].find(p=>normal(p.text)===normal(text)&&p.start<end&&p.end>start);
    const id=duplicate?.id??`${trackId}-b${block.index}-s${i}`;
    output.push({...s,id,start,end,text,originalText:s.text,originalStart:s.start,originalEnd:s.end,final:s.final!==false,sourceType:'asr',revision:(duplicate?.revision??0)+1,
      mapping:{blockIndex:block.index,blockStart:block.start,coreStart:block.coreStart,coreEnd:block.coreEnd,sampleRate:block.sampleRate,sampleStart:block.sampleStart},
      ...(words?{words,boundaryHandling:'Original word times assigned by core midpoint; overlapping equal words removed mechanically.'}:{boundaryHandling:'Segment midpoint ownership; no word timestamps available.'})});
  }
  return output;
}
