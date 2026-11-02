import { readFile, writeFile, rename, realpath } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { jpegEncoder,JPEG_PROFILE,checkImageSignal } from './jpeg-encoder.mjs';

export const MAX_IMAGES=12, MAX_IMAGE_BYTES=8*1024**2;
const LEGACY_PROFILE='jpeg-js-044-q85-444';
export const imageHash=data=>createHash('sha256').update(data).digest('hex');
export function imageFormat(format='jpeg') {
  if(!['jpeg','png'].includes(format))throw new Error('format must be jpeg or png.');
  return format;
}
export function assertImageBudget(images) {
  const bytes=images.reduce((n,image)=>n+(image.data??image).length,0);
  if(bytes>MAX_IMAGE_BYTES)throw new Error('Image response exceeds the 8 MiB image budget; request a lower-quality analysis.');
  return bytes;
}
function validatePng(png){
  if(png.length<24||png.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw new Error('Invalid PNG evidence.');
  const width=png.readUInt32BE(16),height=png.readUInt32BE(20);
  if(!width||!height||width*height>16*1024**2)throw new Error('PNG exceeds image delivery pixel budget.');
}
function validateJpeg(data){
  assertImageBudget([data]);
  if(data.length<4||data.readUInt16BE(0)!==0xffd8||data.readUInt16BE(data.length-2)!==0xffd9)throw new Error('Invalid JPEG cache; use format=png to inspect the original.');
}
async function renameCache(temp,file,signal){
  for(let attempt=0;;attempt++){
    checkImageSignal(signal);
    try{await rename(temp,file);return;}catch(e){
      if(attempt>=5||!['EPERM','EACCES','EBUSY'].includes(e.code))throw e;
      await new Promise(r=>setTimeout(r,Math.min(200,25*2**attempt)));
    }
  }
}
export async function encodeImage(png,format='jpeg',{signal}={}) {
  imageFormat(format);
  checkImageSignal(signal);validatePng(png);
  if(format==='png'){assertImageBudget([png]);return {data:png,mimeType:'image/png',encodingProfile:'png-original',sourceSha256:imageHash(png)};}
  const data=await jpegEncoder.encode(png,{signal});checkImageSignal(signal);validateJpeg(data);
  return {data,mimeType:'image/jpeg',encodingProfile:JPEG_PROFILE,sourceSha256:imageHash(png)};
}
export async function readImage(file,format='jpeg',{signal,replay}={}) {
  imageFormat(format);
  checkImageSignal(signal);
  const png=await readFile(file,{signal});checkImageSignal(signal);validatePng(png);
  if(format==='png')return {...await encodeImage(png,format,{signal}),path:file,originalPath:file};
  const hash=imageHash(png),directory=path.dirname(file),base=path.basename(file,'.png');
  let profile=JPEG_PROFILE,cache=path.join(directory,`${base}.${profile}.${hash}.jpg`);
  if(replay){
    // Never follow an arbitrary ledger path. Both legacy and current cache
    // filenames bind the exact PNG basename, encoding profile and source hash.
    const recorded=path.resolve(replay.path??'');
    const name=path.basename(recorded);
    const match=[JPEG_PROFILE,LEGACY_PROFILE].find(p=>name===`${base}.${p}.${hash}.jpg`);
    if(!match||path.dirname(recorded)!==path.resolve(directory)||(replay.sourceSha256&&replay.sourceSha256!==hash))throw new Error('Pending image source changed or its cache path is invalid.');
    profile=match;cache=recorded;
    if(replay.encodingProfile&&replay.encodingProfile!==profile)throw new Error('Pending image encoding profile changed.');
  }
  let data;
  try{
    // Reject symlinks/junction escapes even if the lexical path is in the job.
    const [actual,dir]=await Promise.all([realpath(cache),realpath(directory)]);
    if(path.dirname(actual)!==dir||path.basename(actual)!==path.basename(cache))throw new Error('JPEG cache resolves outside its evidence directory.');
    data=await readFile(cache,{signal});
  }catch(error){if(error.code!=='ENOENT')throw error;}
  checkImageSignal(signal);
  if(!data){
    if(replay)throw new Error('Pending JPEG cache is missing; replay cannot regenerate different evidence.');
    data=(await encodeImage(png,format,{signal})).data;
    const temp=cache+'.'+randomUUID()+'.tmp';
    await writeFile(temp,data,{flag:'wx',signal});checkImageSignal(signal);await renameCache(temp,cache,signal);
  }
  checkImageSignal(signal);validateJpeg(data);
  return {data,mimeType:'image/jpeg',path:cache,originalPath:file,encodingProfile:profile,sourceSha256:hash};
}
