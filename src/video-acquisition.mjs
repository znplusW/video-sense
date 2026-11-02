import {mkdir,mkdtemp,stat} from 'node:fs/promises';
import path from 'node:path';
import {exec,FFMPEG,FFPROBE,metadataFromProbe} from './media.mjs';
import {downloadNetworkFile,networkInputArgs,runNetworkCommand,redactNetworkError} from './network.mjs';

// Only network input failures may enter the complete-file fallback. Errors from
// image output, limits, configuration or explicit source rejection remain errors.
export function videoAcquisitionError(message){
  const error=new Error(message);
  if(!/public Internet|target rejected|byte limit|size limit|output limit|session closed|\b(?:401|403|404)\b|Unauthorized|Forbidden|Not Found|not permitted|Invalid argument|Unrecognized option|Unknown decoder|No such filter|Permission denied|No space left|ENOENT|EACCES|ENOSPC/i.test(message))error.code='VIDEO_ACQUISITION_FAILED';
  return error;
}

export async function downloadVideo(input,directory,{signal,expectedDuration,maxBytes=1024**3,onProgress}={}){
  if(signal?.aborted)throw new Error('Video download cancelled.');
  await mkdir(directory,{recursive:true});
  const target=await mkdtemp(path.join(directory,'complete-video-download-'));
  const remux=/\.(m3u8|mpd)$/i.test(new URL(input.url).pathname)||/m3u8|dash/.test(input.protocol??'');
  const file=path.join(target,remux?'video.mkv':'source.video');
  let bytes,method;
  if(remux){
    await runNetworkCommand(FFMPEG,['-hide_banner','-v','error','-nostdin','-n',...networkInputArgs(input),'-i',input.url,
      '-map','0:v:0','-an','-sn','-c:v','copy','-fs',String(maxBytes),'-f','matroska',file],
    {signal,proxy:input.proxy,timeout:1800000,maxBuffer:1024**2});
    bytes=(await stat(file)).size;method='complete_video_track_remux';
    if(bytes>=maxBytes)throw new Error('Complete video download hit its size limit.');
  }else{({bytes}=await downloadNetworkFile(input,file,{signal,maxBytes,onProgress}));method='complete_http_video_file';}
  if(signal?.aborted)throw new Error('Video download cancelled.');
  const {stdout}=await exec(FFPROBE,['-v','error','-protocol_whitelist','file,pipe',
    '-show_entries','format=duration:stream=codec_type,width,height,sample_aspect_ratio:stream_side_data=rotation','-of','json',file],
  {signal,windowsHide:true,timeout:15000,maxBuffer:1024**2});
  const metadata=metadataFromProbe(JSON.parse(stdout),true);
  if(!Number.isFinite(expectedDuration)||metadata.duration+0.5<expectedDuration)throw new Error('Downloaded video is shorter than the complete source or expected duration is unavailable; completeness not established.');
  return {file,bytes,method,duration:metadata.duration,hasAudio:metadata.hasAudio};
}

// Retry the uncompleted range from its beginning. Old partial images remain
// visible with sourcePass metadata; only successful passes complete coverage.
export async function processVideoRanges({ranges,input,directory,expectedDuration,videoFallback='on_failure',signal,
  maxBytes=1024**3,runRange,onTransfer,onRangeComplete,download=downloadVideo}){
  if(!['on_failure','never'].includes(videoFallback))throw new Error('videoFallback must be on_failure or never.');
  let local=null,lastError,transfer;
  const check=()=>{if(signal?.aborted)throw new Error('Video acquisition cancelled.');};
  const update=async value=>{transfer=value;await onTransfer?.({...value});};
  for(const range of ranges){
    check();let succeeded=false;
    if(!local){
      lastError=undefined;
      for(let attempt=1;attempt<=2;attempt++){
        check();
        await update({mode:'stream',status:attempt===1?'running':'retrying',streamAttempt:attempt,range,videoFallback,
          replayPolicy:'Restart the unfinished range; retained partial images may overlap.',...(lastError?{reason:redactNetworkError(lastError)}:{})});
        try{await runRange({range,mode:'stream',streamAttempt:attempt});check();succeeded=true;break;}
        catch(e){if(signal?.aborted||e.code!=='VIDEO_ACQUISITION_FAILED')throw e;lastError=e;}
      }
      if(!succeeded){
        if(videoFallback==='never')throw lastError;
        check();
        await update({mode:'download_fallback',status:'downloading',streamAttempts:2,range,videoFallback,
          reason:redactNetworkError(lastError),bytes:0,downloadScope:'Complete selected source video, not only the requested range.',
          replayPolicy:'Same media task and source timestamps; reprocess unfinished range locally and retain partial images.'});
        local=await download(input,directory,{signal,expectedDuration,maxBytes,onProgress:progress=>onTransfer?.({...transfer,...progress})});
        check();await update({...transfer,...local,status:'download_complete'});
      }
    }
    if(!succeeded){
      await update({...transfer,status:'decoding_local',range,...local});
      await runRange({range,mode:'local_download',file:local.file});check();
    }
    await onRangeComplete?.(range);
  }
  await update({...transfer,status:'complete'});
  return transfer;
}
