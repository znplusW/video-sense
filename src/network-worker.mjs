import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { createEvidencePipeline as createPipeline } from './compact-sheet.mjs';
import { decode,probeNetwork,CUTS,analysisSize } from './media.mjs';
import { createNetworkProxy,resolveVideoUrl,redactNetworkError } from './network.mjs';
import {processVideoRanges,videoAcquisitionError} from './video-acquisition.mjs';

export function networkPlan(spec,metadata) {
  const start=spec.start??0,end=Math.min(spec.end??metadata.duration??NaN,metadata.duration??Infinity);
  if(!Number.isFinite(end)||end<=start)throw new Error('A finite video duration or explicit end greater than start is required.');
  if(spec.analysis!=='overview')return [{start,end}];
  const length=end-start,window=Math.min(2,length),count=Math.min(spec.samples??8,Math.ceil(length/window));
  const ranges=[];
  for(let i=0;i<count;i++){
    const at=count===1?start:start+(length-window)*i/(count-1);
    if(ranges.length&&at<=ranges.at(-1).end+1e-6)ranges.at(-1).end=at+window;
    else ranges.push({start:at,end:at+window});
  }
  return ranges;
}

// Streaming is preferred. Only repeated input failures materialize the complete
// selected video, then feed the local file through the same 12fps selector.
if(process.send) {
  let started=false,stopping=false,reason='user',run,proxy,timer;
  const abort=new AbortController();
  const send=x=>{if(process.connected)process.send(x);};
  const stop=why=>{stopping=true;reason=why;abort.abort();run?.stop();proxy?.close();};
  process.on('disconnect',()=>stop('client-disconnected'));
  process.on('SIGTERM',()=>stop('terminated'));
  process.on('message',async msg=>{
    if(msg.type==='stop'){stop(msg.reason);return;}
    if(msg.type!=='start'||started)return;
    started=true;const spec=msg.spec;
    let count=0,byteCount=0,frames=0,lastProgress=0,pipeline,sourcePass,videoTransfer;
    const completedRanges=[],stats={frames:0,kept:0,cuts:0,marks:0,floors:0,overflow:0};
    timer=setTimeout(()=>stop('duration-limit'),spec.maxRunSeconds*1000);
    try{
      proxy=await createNetworkProxy({maxBytes:spec.maxNetworkBytes,
        allowOrigin:process.env.AGENT_VIDEO_TEST_NETWORK_ORIGIN?.split(',')});
      if(stopping)throw new Error('Stopped before resolving.');
      send({type:'phase',phase:'resolving'});
      const resolved=await resolveVideoUrl(spec,proxy,abort.signal);
      send({type:'resolved-private',resolved,at:Date.now()});
      const input={...resolved,proxy};
      send({type:'phase',phase:'probing'});
      const probed=await probeNetwork(input,abort.signal);
      const metadata={...resolved.metadata,...probed,
        selectedVideoStreamHasAudio:probed.hasAudio,
        sourceAudioAvailability:resolved.resources?.audio?'available':probed.hasAudio?'available':'unknown',
        audioAvailabilityBasis:'hasAudio describes the probed video stream only. Separate source audio may be resolved independently.'};
      metadata.duration??=resolved.metadata.duration;
      if(!Number.isFinite(metadata.duration)||metadata.duration<=0)throw new Error('A finite on-demand video duration is required; live network streams are not supported.');
      const ranges=networkPlan(spec,metadata),canvas=analysisSize(metadata,spec.quality);
      const [width,height]=canvas;
      send({type:'metadata',metadata:{...metadata,canvas},range:{start:ranges[0].start,end:ranges.at(-1).end},
        coverage:{mode:spec.analysis,plannedRanges:ranges,completedRanges:[],completeTimeline:false,
          note:spec.analysis==='overview'?'Sparse sampled windows; gaps have NOT been examined.':'Continuous decoding within the requested range; adaptive selection can still miss events.'}});
      function emit(sheet){
        if(!sheet)return;
        if(count>=spec.maxSheets||byteCount+sheet.png.length>spec.maxBytes)throw new Error('Output limit reached; partial results retained.');
        const {png,...data}=sheet,info={...data,index:count,frameCount:data.frames.length,sourcePass};
        const base=path.join(spec.directory,`sheet-${String(count).padStart(6,'0')}`);
        writeFileSync(base+'.png',png,{flag:'wx'});writeFileSync(base+'.json',JSON.stringify(info),{flag:'wx'});
        send({type:'sheet',info});count++;byteCount+=png.length;
      }
      function drain(){let s;while((s=pipeline.take()))emit(s);}
      await processVideoRanges({ranges,input,directory:spec.directory,expectedDuration:metadata.duration,
        videoFallback:spec.videoFallback??'on_failure',signal:abort.signal,maxBytes:spec.maxNetworkBytes,
        onTransfer:value=>{videoTransfer=value;send({type:'video-transfer',videoTransfer});
          if(value.status==='downloading')send({type:'phase',phase:'downloading_video_fallback'});},
        onRangeComplete:range=>{completedRanges.push(range);send({type:'coverage',completedRanges:[...completedRanges],network:proxy.stats});},
        runRange:async pass=>{
        const {range,file}=pass;sourcePass={...pass,firstSheet:count};
        if(stopping)throw new Error('Video acquisition cancelled.');
        // oneShot emits the first selected frame immediately, without the 15s sheet wait.
        // Reset across overview gaps or a failed-pass replay. Healthy continuous
        // analysis still uses a single decoder and selector.
        pipeline=createPipeline({width,height,fps:12,queueDepth:0,oneShot:true,cutAbs:spec.scene?CUTS.dense:CUTS[spec.pace],
          maxWaitSec:5,...(spec.scene?{maxFrames:1,strategy:'single'}:{})});
        send({type:'phase',phase:file?'decoding_local_fallback':'decoding'});
        run=await decode({...spec,...range,canvas,input,...(file?{mode:'file',file}:{})},frame=>{
          pipeline.push(frame);drain();frames++;
          if(Date.now()-lastProgress>=250){lastProgress=Date.now();send({type:'progress',decodedThrough:frame.t,frames,bytes:byteCount,network:proxy.stats});}
        });
        send({type:'running',capturePid:run.pid});
        if(stopping)run.stop();
        const result=await run.done;
        pipeline.finish();drain();
        for(const key of Object.keys(stats))stats[key]+=Number(pipeline.stats[key])||0;
        if(stopping)throw new Error('Video acquisition cancelled.');
        if(proxy.stats.receivedBytes>=spec.maxNetworkBytes)throw new Error('Network byte limit reached; partial results retained.');
        if(result.code!==0||!result.frames)throw videoAcquisitionError(proxy.stats.error||`FFmpeg could not finish the ${file?'local downloaded':'network'} range: ${result.error}`);
        if(result.frames<Math.max(1,Math.ceil((range.end-range.start)*12-1e-6)-1))throw videoAcquisitionError('Video media ended before the requested range; partial results retained.');
      }});
      if(stopping&&reason==='duration-limit')throw new Error('Processing time limit reached; partial results retained.');
      send({type:'end',status:stopping?'stopped':'complete',reason:stopping?reason:null,stats,sheets:count,bytes:byteCount,network:proxy.stats,completedRanges,videoTransfer});
    }catch(e){
      run?.stop();
      if(videoTransfer){videoTransfer={...videoTransfer,status:stopping?'stopped':'error',error:stopping?undefined:redactNetworkError(e)};send({type:'video-transfer',videoTransfer});}
      send({type:'end',status:stopping?'stopped':'error',reason:stopping?reason:null,error:stopping?undefined:redactNetworkError(e),sheets:count,bytes:byteCount,stats,network:proxy?.stats,completedRanges,videoTransfer});
    }finally{
      clearTimeout(timer);proxy?.close();
      if(run)await run.done.catch(()=>{});
      if(process.connected)process.disconnect();
    }
  });
}
