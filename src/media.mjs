import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { networkInputArgs,runNetworkCommand } from './network.mjs';

export const exec = promisify(execFile);
export const FFMPEG = process.env.AGENT_VIDEO_FFMPEG || 'ffmpeg';
export const FFPROBE = process.env.AGENT_VIDEO_FFPROBE || 'ffprobe';
export const SIZES = { low: [800,450], standard: [1066,600], high: [1280,720], ultra: [1600,900] };
export const CUTS = { calm:20, normal:12, dense:7 };
export async function localFile(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('Use an absolute local file path; URLs are not supported.');
  const file = await realpath(value);
  if (!(await stat(file)).isFile()) throw new Error('Input must be a regular file.');
  return file;
}
export function options(input={}) {
  const quality=input.quality ?? 'low', pace=input.pace ?? 'normal';
  if (!SIZES[quality] || !Object.hasOwn(CUTS, pace)) throw new Error('Invalid quality or pace.');
  return {quality, pace, scene: input.scene === true};
}
export function fitFilter(w,h) {
  return `scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=area,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
}
export async function probe(file,signal) {
  const {stdout} = await exec(FFPROBE, ['-v','error','-protocol_whitelist','file,pipe','-show_entries','format=duration:stream=codec_type,width,height,sample_aspect_ratio:stream_side_data=rotation','-of','json',file], {windowsHide:true,timeout:15000,maxBuffer:1024*1024,signal});
  return metadataFromProbe(JSON.parse(stdout),true);
}
export function metadataFromProbe(r,requireDuration=false) {
  const video=r.streams?.find(s=>s.codec_type==='video');
  if (!video) throw new Error('No video stream found.');
  const duration=Number(r.format?.duration);
  if (requireDuration&&(!Number.isFinite(duration) || duration<=0)) throw new Error('A finite video duration is required.');
  if(!(video.width>0&&video.height>0))throw new Error('Video dimensions are unavailable.');
  const [sn,sd]=String(video.sample_aspect_ratio||'1:1').split(':').map(Number);
  let displayWidth=video.width*(sn>0&&sd>0?sn/sd:1),displayHeight=video.height;
  const rotation=Number(video.side_data_list?.find(s=>s.rotation!==undefined)?.rotation||0);
  if(Math.abs(rotation)%180===90)[displayWidth,displayHeight]=[displayHeight,displayWidth];
  return {duration:Number.isFinite(duration)&&duration>0?duration:null,width:video.width,height:video.height,displayWidth,displayHeight,rotation,hasAudio:r.streams.some(s=>s.codec_type==='audio')};
}

export async function probeNetwork(input,signal) {
  const stdout=await runNetworkCommand(FFPROBE,['-v','error',...networkInputArgs(input),'-analyzeduration','1000000','-probesize','262144',
    '-show_entries','format=duration:stream=codec_type,width,height,sample_aspect_ratio:stream_side_data=rotation','-of','json',input.url],
    {signal,proxy:input.proxy,timeout:20000,maxBuffer:1024*1024});
  return metadataFromProbe(JSON.parse(stdout));
}

export function analysisSize(metadata,quality) {
  const [maxW,maxH]=SIZES[quality];
  const ratio=metadata.displayWidth/metadata.displayHeight;
  const width=Math.max(64,Math.round(Math.min(maxW,maxH*ratio)));
  const height=Math.max(36,Math.round(Math.min(maxH,maxW/ratio)));
  return [width,height];
}

// Single rawvideo process; original scoring/selection/batching is unchanged.
// File and URL frames carry original-video seconds.
export async function decode(spec,onFrame) {
  if(!['file','url'].includes(spec.mode)) throw new Error('Video decoding requires mode=file or mode=url.');
  const [width,height]=spec.canvas??SIZES[spec.quality], fps=12;
  const args=['-hide_banner','-v','error','-nostdin',...(spec.mode==='url'?networkInputArgs(spec.input):['-protocol_whitelist','file,pipe']),
      ...(spec.start>0?['-ss',String(spec.start)]:[]),'-i',spec.mode==='url'?spec.input.url:spec.file,'-t',String(spec.end-spec.start),
      '-map','0:v:0','-an','-sn','-vf',`fps=${fps},${fitFilter(width,height)}`,
      '-f','rawvideo','-pix_fmt','rgb24','pipe:1'];
  const child=spawn(FFMPEG,args,{stdio:['ignore','pipe','pipe'],windowsHide:true,...(spec.mode==='url'?{env:spec.input.proxy.env}:{})});
  const size=width*height*3;
  let chunks=[], bytes=0, n=0, stderr='', failure=null;
  const stop=()=>{ if(child.exitCode===null) child.kill(); };
  const done=new Promise((resolve,reject)=>{
    child.stderr.on('data',d=>{stderr=(stderr+d).slice(-4000);});
    child.stdout.on('data',chunk=>{
      if(failure) return;
      chunks.push(chunk); bytes+=chunk.length;
      if(bytes<size) return;
      let buf=Buffer.concat(chunks,bytes), offset=0;
      try {
        while(buf.length-offset>=size) {
          const t=spec.start+n/fps;
          onFrame({t,receivedAt:Date.now(),buf:Buffer.from(buf.subarray(offset,offset+size))});
          offset+=size; n++;
        }
      } catch(e) { failure=e; stop(); }
      const tail=buf.subarray(offset); chunks=tail.length?[tail]:[]; bytes=tail.length;
    });
    child.on('error',reject);
    child.on('close',(code,signal)=>{
      if(failure) reject(failure);
      else resolve({frames:n,code,signal,error:stderr.trim()});
    });
  });
  return {done,stop,pid:child.pid};
}

export async function exactFrame({file,seconds,quality='high'},signal) {
  signal?.throwIfAborted();
  file=await localFile(file);
  if(!Number.isFinite(seconds)||seconds<0) throw new Error('seconds must be >= 0.');
  const meta=await probe(file,signal);
  if(seconds>=meta.duration) throw new Error('Requested time is outside the video.');
  const [w,h]=SIZES[options({quality}).quality];
  const {stdout}=await exec(FFMPEG,['-hide_banner','-v','error','-nostdin','-protocol_whitelist','file,pipe',
    '-ss',String(seconds),'-i',file,'-map','0:v:0','-frames:v','1','-an','-sn','-vf',fitFilter(w,h),
    '-f','image2pipe','-c:v','png','pipe:1'],{encoding:'buffer',windowsHide:true,timeout:20000,maxBuffer:12*1024*1024,signal});
  if(stdout.length<8) throw new Error('No frame decoded at the requested time.');
  return {png:stdout,info:{file,requestedSeconds:seconds,quality,note:'Frame at/after requested seek time; not a guarantee of original frame PTS.'}};
}
