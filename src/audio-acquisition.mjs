import {mkdir,stat} from 'node:fs/promises';
import path from 'node:path';
import {audioBlocks} from './audio.mjs';
import {exec,FFMPEG,FFPROBE} from './media.mjs';
import {downloadNetworkFile,networkInputArgs,runNetworkCommand,redactNetworkError} from './network.mjs';

export async function downloadAudio(input,directory,{signal,expectedDuration,requiredEnd,maxBytes=1024**3,onProgress}={}){
  await mkdir(directory,{recursive:true});
  const remux=/\.(m3u8|mpd)$/i.test(new URL(input.url).pathname)||/m3u8|dash/.test(input.protocol??'')||/^muxed/.test(input.kind??'');
  const file=path.join(directory,remux?'audio.mka':'source.audio');
  let bytes,method;
  if(remux){
    await runNetworkCommand(FFMPEG,['-hide_banner','-v','error','-nostdin','-n',...networkInputArgs(input),'-i',input.url,
      '-map','0:a:0','-vn','-sn','-c:a','copy','-fs',String(maxBytes),'-f','matroska',file],{signal,proxy:input.proxy,timeout:1800000,maxBuffer:1024**2});
    bytes=(await stat(file)).size;method='complete_audio_remux';
    if(bytes>=maxBytes)throw new Error('Complete audio download hit its size limit.');
  }else{({bytes}=await downloadNetworkFile(input,file,{signal,maxBytes,onProgress}));method='complete_http_audio_file';}
  // Technical completeness check; final local decoding still validates the range.
  const {stdout}=await exec(FFPROBE,['-v','error','-protocol_whitelist','file,pipe','-show_entries','format=duration:stream=codec_type','-of','json',file],{signal,windowsHide:true,timeout:15000,maxBuffer:1024**2});
  const metadata=JSON.parse(stdout),duration=Number(metadata.format?.duration);
  if(!metadata.streams?.some(s=>s.codec_type==='audio'))throw new Error('Downloaded resource has no audio stream.');
  if(Number.isFinite(duration)&&duration+0.5<(expectedDuration??requiredEnd))throw new Error('Downloaded audio is shorter than the expected source; completeness not established.');
  return {file,bytes,method,duration:Number.isFinite(duration)&&duration>0?duration:null};
}

// A single resumed stream attempt precedes the optional complete-audio download.
// Only acquisition failures enter this path; ASR exceptions occur in the caller.
export async function* resilientAudioBlocks({input,file,start,end,directory,signal,audioFallback='on_failure',expectedDuration,onTransfer,...options}){
  if(!['on_failure','never'].includes(audioFallback))throw new Error('audioFallback must be on_failure or never.');
  if(!input){yield* audioBlocks({file,start,end,directory,signal,...options});return;}
  let resume=start,index=0,lastError;
  for(let attempt=0;attempt<2;attempt++){
    const attemptDir=attempt?path.join(directory,'stream-retry-1'):directory;await mkdir(attemptDir,{recursive:true});
    await onTransfer?.({mode:'stream',status:attempt?'retrying':'running',streamAttempt:attempt+1,resumeAt:resume,audioFallback,
      ...(lastError?{reason:redactNetworkError(lastError)}:{})});
    try{
      for await(const block of audioBlocks({input,start:resume,end,directory:attemptDir,signal,...options})){
        yield {...block,index:index++};resume=block.coreEnd;
      }
      await onTransfer?.({mode:'stream',status:'complete',streamAttempt:attempt+1,audioFallback});return;
    }catch(e){
      if(signal?.aborted||e.code!=='AUDIO_ACQUISITION_FAILED')throw e;
      lastError=e;
    }
  }
  if(audioFallback==='never')throw lastError;
  const fallbackDir=path.join(directory,'complete-download');
  const transfer={mode:'download_fallback',status:'downloading',streamAttempts:2,resumeAt:resume,audioFallback,reason:redactNetworkError(lastError),bytes:0};
  await onTransfer?.(transfer);
  const downloaded=await downloadAudio(input,fallbackDir,{signal,expectedDuration,requiredEnd:end,onProgress:progress=>Object.assign(transfer,progress)});
  await onTransfer?.({...transfer,status:'download_complete',...downloaded});
  const decodeDir=path.join(directory,'download-decode');await mkdir(decodeDir,{recursive:true});
  for await(const block of audioBlocks({file:downloaded.file,start:resume,end,directory:decodeDir,signal,...options})){
    yield {...block,index:index++};resume=block.coreEnd;
  }
  await onTransfer?.({...transfer,status:'complete',...downloaded});
}
