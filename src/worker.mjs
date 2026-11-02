import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { createEvidencePipeline as createPipeline } from './compact-sheet.mjs';
import { decode,probe,SIZES,CUTS,analysisSize } from './media.mjs';

let run, stopping=false, stopReason='user', timer, finished=false;
function send(value) { if(process.connected) process.send(value); }
function stop(reason='user') {stopping=true;stopReason=reason;run?.stop();}
process.on('disconnect',()=>stop('client-disconnected'));
process.on('SIGTERM',()=>stop('terminated'));
process.on('message',async msg=>{
  if(msg.type==='stop') {stop(msg.reason);return;}
  if(msg.type!=='start'||finished||run) return;
  const spec=msg.spec;
  let [width,height]=SIZES[spec.quality];
  let pipeline, count=0, byteCount=0, lastProgress=0;
  try {
    if(spec.mode!=='file') throw new Error('Local video worker requires mode=file.');
    const metadata=await probe(spec.file);
    spec.end=Math.min(spec.end??metadata.duration,metadata.duration);
    if(spec.start>=spec.end) throw new Error('start must be before the end of the video.');
    // Score only the image area: large portrait letterboxes dilute HSV differences.
    spec.canvas=analysisSize(metadata,spec.quality);
    [width,height]=spec.canvas;
    send({type:'metadata',metadata:{...metadata,canvas:spec.canvas},range:{start:spec.start,end:spec.end}});
    if(stopping) throw new Error('Stopped before decoding.');
    pipeline=createPipeline({width,height,fps:12,queueDepth:0,cutAbs:spec.scene?CUTS.dense:CUTS[spec.pace],
      ...(spec.scene?{maxFrames:1,strategy:'single'}:{})});
    function emit(sheet) {
      if(!sheet) return;
      if(count>=spec.maxSheets||byteCount+sheet.png.length>spec.maxBytes) throw new Error('Output limit reached; partial results retained. Analyze a shorter time range.');
      const {png,...data}=sheet;
      const info={...data,index:count,frameCount:data.frames.length};
      const base=`sheet-${String(count).padStart(6,'0')}`;
      writeFileSync(path.join(spec.directory,base+'.png'),png,{flag:'wx'});
      writeFileSync(path.join(spec.directory,base+'.json'),JSON.stringify(info),{flag:'wx'});
      send({type:'sheet',info});
      count++;byteCount+=png.length;
    }
    function drain() {let s;while((s=pipeline.take?.())) emit(s);}
    run=await decode(spec,frame=>{
      pipeline.push(frame);
      drain();
      if(Date.now()-lastProgress>1000) {
        lastProgress=Date.now();
        send({type:'progress',decodedThrough:frame.t,frames:pipeline.stats.frames,sheets:count,bytes:byteCount});
      }
    });
    send({type:'running',capturePid:run.pid});
    if(stopping) run.stop();
    timer=setTimeout(()=>stop('duration-limit'),spec.maxRunSeconds*1000);
    const result=await run.done;
    pipeline.finish();drain();
    if(!stopping&&result.code!==0) throw new Error(`FFmpeg exited ${result.code}: ${result.error}`);
    if(!stopping&&!result.frames) throw new Error('FFmpeg produced no frames.');
    send({type:'end',status:stopping?'stopped':'complete',reason:stopping?stopReason:null,
      stats:pipeline.stats,sheets:count,bytes:byteCount});
  } catch(e) {
    run?.stop();
    send({type:'end',status:stopping?'stopped':'error',reason:stopping?stopReason:null,error:e.message,sheets:count,bytes:byteCount});
  } finally {
    finished=true;clearTimeout(timer);
    if(process.connected) process.disconnect();
  }
});
