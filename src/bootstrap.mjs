import {existsSync,realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import os from 'node:os';

export const packageRoot=fileURLToPath(new URL('../',import.meta.url));
export function runtimeEnvironment(root=packageRoot,env=process.env) {
  const result={...env};
  for(const [key,name] of [['AGENT_VIDEO_FFMPEG','ffmpeg'],['AGENT_VIDEO_FFPROBE','ffprobe'],['AGENT_VIDEO_YTDLP','yt-dlp']]) {
    if(result[key]){if(!path.isAbsolute(result[key])&&/[\\/]/.test(result[key]))result[key]=path.resolve(root,result[key]);continue;}
    const exe=name+(process.platform==='win32'?'.exe':'');
    const candidates=[path.join(root,'runtime',exe),path.join(root,'runtime','bin',exe),path.join(root,'runtime','ffmpeg','bin',exe)];
    if(name==='yt-dlp')candidates.push(path.join(root,'tools',exe));
    const found=candidates.find(existsSync);if(found)result[key]=found;
  }
  result.AGENT_VIDEO_CONFIG_DIR=path.resolve(env.AGENT_VIDEO_CONFIG_DIR||path.join(env.XDG_CONFIG_HOME||path.join(os.homedir(),'.config'),'video-sense','generic'));
  result.AGENT_VIDEO_DATA_DIR=path.resolve(result.AGENT_VIDEO_CONFIG_DIR,result.AGENT_VIDEO_DATA_DIR||'data');
  // A missing default asr.json means unconfigured; an explicit bad path stays an error.
  if(result.AGENT_VIDEO_ASR_CONFIG&&!path.isAbsolute(result.AGENT_VIDEO_ASR_CONFIG))result.AGENT_VIDEO_ASR_CONFIG=path.resolve(result.AGENT_VIDEO_CONFIG_DIR,result.AGENT_VIDEO_ASR_CONFIG);
  return result;
}

if(process.argv[1]&&realpathSync(process.argv[1])===fileURLToPath(import.meta.url)) {
  Object.assign(process.env,runtimeEnvironment());
  if(process.argv[2]==='--cli'){
    process.argv=[process.execPath,fileURLToPath(new URL('./cli.mjs',import.meta.url)),...process.argv.slice(3)];
    await import('./cli.mjs');
  }else await import('./server.mjs');
}
