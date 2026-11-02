import { spawn } from 'node:child_process';

export const JPEG_PROFILE='ffmpeg-mjpeg-q4-444-t1-v1';
export const JPEG_LIMITS=Object.freeze({concurrency:2,maxQueued:24,timeoutMs:10000,queueTimeoutMs:30000,maxOutputBytes:8*1024**2,stderrBytes:16*1024});
function error(code,message){return Object.assign(new Error(message),{code});}
export function checkImageSignal(signal){if(signal?.aborted)throw error('JPEG_ABORTED','Image request cancelled.');}

// A process-wide queue, shared by every job and every image tool. A cancelled
// active task holds its slot until the child closes, so cancellation cannot
// accidentally exceed the process limit. It never kills unrelated processes.
export class JpegEncoder {
  constructor({command=process.env.AGENT_VIDEO_FFMPEG||'ffmpeg',spawnProcess=spawn,...limits}={}){
    this.command=command;this.spawnProcess=spawnProcess;this.limits={...JPEG_LIMITS,...limits};
    for(const [name,n] of Object.entries(this.limits))if(!Number.isInteger(n)||n<1)throw new Error(`Invalid JPEG limit ${name}.`);
    this.queue=[];this.running=new Set();this.closed=false;
  }
  snapshot(){return {backend:'ffmpeg',profile:JPEG_PROFILE,active:this.running.size,queued:this.queue.length,...this.limits};}
  encode(png,{signal}={}){
    try{checkImageSignal(signal);}catch(e){return Promise.reject(e);}
    if(this.closed)return Promise.reject(error('JPEG_CLOSED','Image encoder is closed.'));
    if(this.running.size>=this.limits.concurrency&&this.queue.length>=this.limits.maxQueued)return Promise.reject(error('JPEG_BUSY','Image encoding queue is full; retry after current requests finish.'));
    return new Promise((resolve,reject)=>{
      const task={png,signal,resolve,reject,state:'queued'};
      task.done=new Promise(r=>{task.resolveDone=r;});
      task.abort=()=>this.fail(task,error('JPEG_ABORTED','Image request cancelled.'));
      signal?.addEventListener('abort',task.abort,{once:true});
      task.timer=setTimeout(()=>this.fail(task,error('JPEG_QUEUE_TIMEOUT','Image encoding queue wait exceeded 30 seconds.')),this.limits.queueTimeoutMs);
      this.queue.push(task);this.drain();
    });
  }
  drain(){while(!this.closed&&this.running.size<this.limits.concurrency&&this.queue.length)this.start(this.queue.shift());}
  fail(task,reason){
    if(task.state==='done')return;
    task.failure??=reason;
    if(task.state==='queued'){
      const index=this.queue.indexOf(task);if(index>=0)this.queue.splice(index,1);
      this.finish(task);
    }else{
      // FFmpeg is the owned child itself, not a shell or a process tree.
      task.child?.stdin.destroy();
      try{task.child?.kill('SIGKILL');}catch{}
    }
  }
  finish(task,data){
    if(task.state==='done')return;
    clearTimeout(task.timer);task.signal?.removeEventListener('abort',task.abort);
    task.state='done';this.running.delete(task);task.png=null;
    if(task.failure)task.reject(task.failure);else task.resolve(data);
    task.resolveDone();this.drain();
  }
  start(task){
    clearTimeout(task.timer);task.state='running';this.running.add(task);
    if(task.signal?.aborted){task.failure=error('JPEG_ABORTED','Image request cancelled.');this.finish(task);return;}
    let child;try{
      child=this.spawnProcess(this.command,['-hide_banner','-v','error','-nostdin','-threads','1','-f','image2pipe','-c:v','png','-i','pipe:0',
        '-frames:v','1','-an','-c:v','mjpeg','-q:v','4','-pix_fmt','yuvj444p','-threads','1','-filter_threads','1','-f','image2pipe','pipe:1'],
        {stdio:['pipe','pipe','pipe'],windowsHide:true});
    }catch(e){task.failure=error('JPEG_SPAWN_FAILED',`Cannot start JPEG encoder: ${e.message}`);this.finish(task);return;}
    task.child=child;let size=0,stderr=Buffer.alloc(0);const chunks=[];
    task.timer=setTimeout(()=>this.fail(task,error('JPEG_TIMEOUT',`JPEG encoding exceeded ${this.limits.timeoutMs} ms.`)),this.limits.timeoutMs);
    child.stderr.on('data',chunk=>{const d=Buffer.from(chunk);stderr=Buffer.concat([stderr,d]).subarray(-this.limits.stderrBytes);});
    child.stderr.on('error',e=>this.fail(task,error('JPEG_PIPE_FAILED',`JPEG stderr failed: ${e.message}`)));
    child.stdout.on('error',e=>this.fail(task,error('JPEG_PIPE_FAILED',`JPEG stdout failed: ${e.message}`)));
    child.stdout.on('data',chunk=>{
      if(task.failure)return;
      size+=chunk.length;
      if(size>this.limits.maxOutputBytes){this.fail(task,error('JPEG_OUTPUT_LIMIT','Encoded image exceeds the 8 MiB image budget.'));return;}
      chunks.push(chunk);
    });
    child.stdin.on('error',e=>{
      // EPIPE commonly accompanies an encoder failure: let close report the
      // bounded stderr reason. Other pipe errors terminate the owned encoder.
      if(e.code!=='EPIPE')this.fail(task,error('JPEG_PIPE_FAILED',`JPEG input failed: ${e.message}`));
    });
    child.on('error',e=>this.fail(task,error('JPEG_SPAWN_FAILED',`Cannot start JPEG encoder: ${e.message}`)));
    child.on('close',(code,signal)=>{
      if(!task.failure&&(code!==0||size===0))task.failure=error('JPEG_FAILED',`JPEG encoding failed (${code??signal}): ${stderr.toString('utf8').trim()||'no JPEG output'}`);
      this.finish(task,task.failure?undefined:Buffer.concat(chunks,size));
    });
    if(task.signal?.aborted)this.fail(task,error('JPEG_ABORTED','Image request cancelled.'));
    else try{child.stdin.end(task.png);}catch(e){this.fail(task,error('JPEG_PIPE_FAILED',`JPEG input failed: ${e.message}`));}
  }
  async close(){
    this.closed=true;const tasks=[...this.queue,...this.running];
    for(const task of tasks)this.fail(task,error('JPEG_CLOSED','Image encoder is closed.'));
    await Promise.all(tasks.map(t=>t.done));
  }
}

export const jpegEncoder=new JpegEncoder();
