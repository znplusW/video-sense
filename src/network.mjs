import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import net from 'node:net';
import { lookup } from 'node:dns/promises';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {createWriteStream} from 'node:fs';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';

const bundled=fileURLToPath(new URL('../tools/yt-dlp.exe',import.meta.url));
export const YTDLP=process.env.AGENT_VIDEO_YTDLP||(process.platform==='win32'&&existsSync(bundled)?bundled:'yt-dlp');
const blocked=new net.BlockList();
for(const [ip,bits] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',3]])blocked.addSubnet(ip,bits);
const global6=new net.BlockList();global6.addSubnet('2000::',3,'ipv6');
const blocked6=new net.BlockList();
for(const [ip,bits] of [['2001::',23],['2001:db8::',32],['2002::',16]])blocked6.addSubnet(ip,bits,'ipv6');
// Benchmark ranges can be synthetic DNS answers from the user's configured proxy.
// They remain non-public destinations; only hostnames may be resolved by that proxy.
const fakeDns=new net.BlockList();
fakeDns.addSubnet('198.18.0.0',15);
fakeDns.addSubnet('2001:2::',48,'ipv6');
function isFakeDnsIP(ip){
  const family=net.isIP(ip);
  return family!==0&&fakeDns.check(ip,family===4?'ipv4':'ipv6');
}
export function isPublicIP(ip) {
  return net.isIP(ip)===4?!blocked.check(ip):net.isIP(ip)===6&&global6.check(ip,'ipv6')&&!blocked6.check(ip,'ipv6');
}
export function webUrl(value) {
  let u;try{u=new URL(value);}catch{throw new Error('Provide an absolute HTTP(S) video or page URL.');}
  if(!['http:','https:'].includes(u.protocol)||u.username||u.password||value.length>16384)throw new Error('Only HTTP(S) URLs without embedded credentials are accepted.');
  u.hash='';return u;
}
export function publicSource(value) {const u=webUrl(value);u.search='';return u.href;}
export function redactNetworkError(e) {
  return String(e?.message??e).replace(/https?:\/\/[^\s"'<>]+/gi,'[network URL]').slice(0,1200);
}

export async function upstreamProxy() {
  let value=process.env.AGENT_VIDEO_HTTP_PROXY;
  if(value==='direct')return null;
  if(!value&&process.platform==='win32') {
    try{
      const {stdout}=await promisify(execFile)('reg.exe',['query','HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],{windowsHide:true,timeout:3000});
      if(/ProxyEnable\s+REG_DWORD\s+0x1\b/.test(stdout)) {
        const setting=/ProxyServer\s+REG_SZ\s+([^\r\n]+)/.exec(stdout)?.[1]?.trim();
        value=setting?.includes('=')?/(?:^|;)https?=([^;]+)/.exec(setting)?.[1]:setting;
        if(value&&!value.includes('://'))value='http://'+value;
      }
    }catch{/* No usable registry proxy: use explicit/environment proxy or direct. */}
  }
  value??=process.env.https_proxy||process.env.HTTPS_PROXY||process.env.http_proxy||process.env.HTTP_PROXY;
  if(!value)return null;
  const u=webUrl(value);
  if(u.protocol!=='http:')throw new Error('AGENT_VIDEO_HTTP_PROXY requires an HTTP CONNECT proxy URL, or direct.');
  return u;
}

// Every HTTP request / HTTPS tunnel gets a fresh DNS check and a pinned IP.
// The exception is injected only by integration tests for their exact fixture origin.
export async function createNetworkProxy({maxBytes=1024**3,allowOrigin,upstream,lookupAddress=lookup}={}) {
  const forward=upstream===undefined?await upstreamProxy():upstream?webUrl(upstream):null;
  let bytes=0,requests=0,closed=false,lastError=null;
  const sockets=new Set();
  const track=s=>{sockets.add(s);s.on('error',()=>{});s.on('close',()=>sockets.delete(s));return s;};
  function count(chunk){bytes+=chunk.length;if(bytes>maxBytes){lastError='Network byte limit reached; partial results retained.';for(const s of sockets)s.destroy();}}
  async function address(u){
    const host=u.hostname.replace(/^\[|\]$/g,'');
    const found=await lookupAddress(host,{all:true});
    const fixture=allowOrigin?.includes(u.origin),useProxy=Boolean(forward&&!fixture);
    // Support IPv4, IPv6 and mixed public/synthetic answers. Only the configured
    // upstream proxy receives the hostname; never connect to synthetic IPs.
    const dnsHost=host.replace(/\.$/,'');
    const fakeDnsAllowed=useProxy&&!net.isIP(host)&&dnsHost.includes('.')&&!/\.(localhost|local|internal)$/i.test(dnsHost)&&
      found.every(x=>isPublicIP(x.address)||isFakeDnsIP(x.address));
    if(!found.length||(!fixture&&!fakeDnsAllowed&&found.some(x=>!isPublicIP(x.address))))throw new Error('Network target is not a public Internet address.');
    return {...(found.find(x=>x.family===4)||found[0]),useProxy};
  }
  const server=http.createServer(async(req,res)=>{
    let remote;
    try{
      if(closed||bytes>=maxBytes)throw new Error('Network session closed or byte limit reached.');
      if(!['GET','HEAD','POST'].includes(req.method))throw new Error('Unsupported network request method.');
      const u=webUrl(req.url);if(u.protocol!=='http:')throw new Error('HTTPS requires CONNECT.');
      const ip=await address(u);requests++;
      const headers={...req.headers,host:u.host};delete headers['proxy-authorization'];delete headers['proxy-connection'];
      const requestOptions=ip.useProxy?{hostname:forward.hostname,port:Number(forward.port||80),path:u.href,method:req.method,headers,agent:false}:
        {hostname:u.hostname,port:Number(u.port||80),path:u.pathname+u.search,method:req.method,headers,agent:false,lookup:(_h,_o,cb)=>cb(null,ip.address,ip.family)};
      remote=http.request(requestOptions,up=>{
        res.writeHead(up.statusCode,up.headers);up.on('data',count);up.pipe(res);
      });
      remote.on('socket',track);remote.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end('Network request failed');});
      remote.setTimeout(15000,()=>remote.destroy());
      let body=0;req.on('data',b=>{body+=b.length;if(body>1024*1024)remote.destroy();});
      res.on('close',()=>remote.destroy());req.pipe(remote);
    }catch(e){lastError=redactNetworkError(e);res.writeHead(403);res.end('Network target rejected');remote?.destroy();}
  });
  server.on('connection',track);
  server.on('connect',async(req,client,head)=>{
    let upstream;
    try{
      if(closed||bytes>=maxBytes)throw new Error('Network session closed or byte limit reached.');
      const u=webUrl('https://'+req.url),ip=await address(u);requests++;
      upstream=track(net.connect(ip.useProxy?{host:forward.hostname,port:Number(forward.port||80)}:{host:ip.address,port:Number(u.port||443),family:ip.family}));
      upstream.setTimeout(15000,()=>upstream.destroy());
      const ready=extra=>{client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(extra?.length){count(extra);client.write(extra);}if(head.length)upstream.write(head);client.pipe(upstream);upstream.on('data',count);upstream.pipe(client);};
      upstream.on('connect',()=>{
        if(!ip.useProxy){ready();return;}
        let buffer=Buffer.alloc(0);
        const response=chunk=>{buffer=Buffer.concat([buffer,chunk]);const end=buffer.indexOf('\r\n\r\n');
          if(buffer.length>16384){upstream.destroy();return;}
          if(end<0)return;
          upstream.removeListener('data',response);
          if(!/^HTTP\/1\.[01] 200\b/.test(buffer.toString('ascii',0,end))){lastError='Configured upstream proxy refused CONNECT.';upstream.destroy();return;}
          ready(buffer.subarray(end+4));
        };
        const authority=`${u.hostname}:${u.port||443}`;
        upstream.on('data',response);upstream.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
      });
      upstream.on('error',()=>client.destroy());upstream.on('close',()=>client.destroy());client.on('close',()=>upstream.destroy());
    }catch(e){lastError=redactNetworkError(e);client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');upstream?.destroy();}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const url=`http://127.0.0.1:${server.address().port}`;
  return {url,validate:async value=>{const u=webUrl(value);await address(u);return u.href;},
    get stats(){return {receivedBytes:bytes,requests,limitBytes:maxBytes,usesConfiguredProxy:Boolean(forward),error:lastError};},
    env:{...process.env,http_proxy:url,https_proxy:url,HTTP_PROXY:url,HTTPS_PROXY:url,ALL_PROXY:url,all_proxy:url,NO_PROXY:'',no_proxy:''},
    close(){closed=true;for(const s of sockets)s.destroy();server.close();},
  };
}

export function runNetworkCommand(command,args,{signal,proxy,timeout=30000,maxBuffer=4*1024*1024}={}) {
  return new Promise((resolve,reject)=>{
    if(signal?.aborted){reject(new Error('Network task cancelled.'));return;}
    let timer,ended=false,termination;
    const child=execFile(command,args,{windowsHide:true,maxBuffer,env:proxy?.env},(error,stdout)=>{
      ended=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);
      if(error||termination){const e=new Error(termination??`Network command failed: ${redactNetworkError(error)}`);e.code=error?.code;reject(e);}
      else resolve(stdout);
    });
    function terminate(message){
      if(ended||termination)return;termination=message;
      // Bundled yt-dlp can spawn a PyInstaller child. Stop only this owned tree.
      if(process.platform==='win32'&&child.pid)execFile('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,timeout:3000},()=>{if(!ended)child.kill();});
      else child.kill();
    }
    function cancel(){terminate('Network task cancelled.');}
    signal?.addEventListener('abort',cancel,{once:true});
    timer=setTimeout(()=>terminate('Network command timed out.'),timeout);
  });
}

const directExtension=/\.(mp4|m4v|webm|mkv|mov|ts|m3u8|mpd)(?:$)/i;
const audioExtension=/\.(mp3|wav|wave|flac|m4a|aac|ogg|oga|opus|aif|aiff|wma|amr|mka|m3u8|mpd)$/i;
async function extractPage(spec,url,proxy,signal,format,index){
  const raw=await runNetworkCommand(YTDLP,['--ignore-config','--no-plugin-dirs','--no-playlist','--playlist-items',String(index),
    '--skip-download','--dump-single-json','--no-warnings','--socket-timeout','12','--retries','1','--extractor-retries','1','--no-cache-dir','--proxy',proxy.url,
    '--js-runtimes',`node:${process.execPath}`,'--format',format,'--',url],{signal,proxy,timeout:45000});
  const root=JSON.parse(raw),data=root.entries?root.entries.filter(Boolean)[0]:root;
  if(!data)throw new Error('No media at the requested 1-based item index.');
  if(!root.entries&&index!==1)throw new Error('This page resolved to a single item; use index=1.');
  if(data.is_live||data.live_status==='is_live')throw new Error('Live web streams are not supported; use finite on-demand media.');
  if(data.has_drm)throw new Error('This media is DRM protected; no playable stream was resolved.');
  return {root,data,selected:data.requested_downloads?.[0]??data};
}
function sourceHeaders(selected,data){
  const headers={};
  for(const [k,v] of Object.entries(selected.http_headers??data.http_headers??{})){
    if(['user-agent','referer','origin','accept','accept-language'].includes(k.toLowerCase())&&typeof v==='string'&&!/[\r\n]/.test(v))headers[k]=v;
  }
  return headers;
}
function subtitleResources(data,headers){
  const subtitles=[];
  for(const [category,tracks] of [['manual',data.subtitles],['automatic',data.automatic_captions]])for(const [language,variants] of Object.entries(tracks??{})){
    const variant=['vtt','srt','json3','json','bcc'].map(ext=>variants.find(v=>v.ext===ext&&/^https?:/.test(v.url??''))).find(Boolean);
    if(variant)subtitles.push({id:`${category}:${language}`,language,category:new URL(variant.url).searchParams.has('tlang')?'translated':category,format:variant.ext,url:variant.url,headers});
  }
  return subtitles;
}
export async function resolveAudioUrl(spec,proxy,signal){
  const url=await proxy.validate(spec.url),index=spec.itemIndex??1;
  const direct=spec.sourceType==='direct'||(spec.sourceType!=='page'&&audioExtension.test(new URL(url).pathname));
  if(direct){
    if(index!==1)throw new Error('itemIndex applies to a page, not a direct audio URL.');
    const audio={url,headers:{},kind:'direct'};
    return {...audio,resources:{audio,subtitles:[]},metadata:{resolver:'direct',source:publicSource(url)}};
  }
  const {root,data,selected}=await extractPage(spec,url,proxy,signal,'bestaudio[protocol^=http]/bestaudio/best',index);
  if(!selected.url||selected.acodec==='none')throw new Error('No audio stream could be resolved from this page.');
  const mediaUrl=await proxy.validate(selected.url),headers=sourceHeaders(selected,data);
  const audio={url:mediaUrl,headers,formatId:selected.format_id,protocol:selected.protocol,kind:selected.vcodec==='none'?'audio-only':'muxed'};
  return {...audio,resources:{audio,subtitles:subtitleResources(data,headers)},metadata:{resolver:'yt-dlp',source:publicSource(url),title:String(data.title??'').slice(0,300),
    duration:Number(data.duration)||null,formatId:selected.format_id??null,sourceMediaKey:{extractor:data.extractor_key??data.extractor,id:data.id,playlistIndex:data.playlist_index??1},
    pageItemIndex:root.entries?(data.playlist_index??index):1,pageSelection:root.entries?'Only the selected page/playlist item is opened.':'Single item'}};
}
export async function resolveVideoUrl(spec,proxy,signal) {
  const url=await proxy.validate(spec.url);
  const direct=spec.sourceType==='direct'||(spec.sourceType!=='page'&&directExtension.test(new URL(url).pathname));
  if(direct){
    if((spec.videoIndex??1)!==1)throw new Error('videoIndex applies to a multi-video page, not a direct media URL.');
    return {url,headers:{},resources:{audio:{url,headers:{},kind:'muxed-or-unknown'},subtitles:[]},metadata:{resolver:'direct',source:publicSource(url),sourceQuality:'server-provided; output scaling does not reduce network traffic'}};
  }
  const height={low:480,standard:720,high:1080,ultra:1440}[spec.quality];
  const format=`bestvideo[height<=?${height}][protocol^=http]/best[height<=?${height}][protocol^=http]/bestvideo[height<=?${height}]/best[height<=?${height}]`;
  const {root,data,selected}=await extractPage(spec,url,proxy,signal,format,spec.videoIndex??1);
  if(!selected.url||selected.vcodec==='none')throw new Error('No standalone video stream could be resolved.');
  const mediaUrl=await proxy.validate(selected.url);
  const headers=sourceHeaders(selected,data);
  const audio=(data.formats??[]).filter(f=>f.acodec&&f.acodec!=='none'&&f.vcodec==='none'&&/^https?:/.test(f.url??'')).sort((a,b)=>(a.abr??a.tbr??Infinity)-(b.abr??b.tbr??Infinity))[0];
  const audioSource=audio??(selected.acodec!=='none'?selected:null);
  const subtitles=subtitleResources(data,headers);
  return {url:mediaUrl,headers,protocol:selected.protocol,resources:{audio:audioSource?{url:audioSource.url,headers,formatId:audioSource.format_id,protocol:audioSource.protocol,kind:audio?'audio-only':'muxed'}:null,subtitles},metadata:{resolver:'yt-dlp',source:publicSource(url),title:String(data.title??'').slice(0,300),
    sourceMediaKey:{extractor:data.extractor_key??data.extractor,id:data.id,playlistIndex:data.playlist_index??1},
    duration:Number(data.duration)||null,sourceHeight:selected.height??null,formatId:selected.format_id??null,videoOnly:selected.acodec==='none',requestedMaxHeight:height,
    pageVideoIndex:root.entries?(data.playlist_index??spec.videoIndex??1):1,pageSelection:root.entries?'Only the selected page/playlist video is analyzed.':'Single video'}};
}

export async function fetchNetworkText(input,signal,maxBytes=4*1024*1024,redirects=0) {
  if(redirects>4)throw new Error('Too many subtitle redirects.');
  const u=new URL(await input.proxy.validate(input.url)),proxyUrl=new URL(input.proxy.url);
  return new Promise((resolve,reject)=>{
    let agent;
    const finishError=e=>reject(new Error(redactNetworkError(e)));
    let request;
    if(u.protocol==='https:'){
      agent=new https.Agent({keepAlive:false});
      agent.createConnection=(_options,callback)=>{
        const tunnel=http.request({hostname:proxyUrl.hostname,port:proxyUrl.port,method:'CONNECT',path:`${u.hostname}:${u.port||443}`,signal});
        tunnel.once('connect',(res,socket)=>{if(res.statusCode!==200){socket.destroy();callback(new Error('Subtitle tunnel rejected.'));return;}callback(null,tls.connect({socket,servername:u.hostname}));});
        tunnel.once('error',callback);tunnel.end();
      };
      request=https.request(u,{agent,headers:input.headers,signal});
    }else request=http.request({hostname:proxyUrl.hostname,port:proxyUrl.port,path:u.href,headers:{...input.headers,host:u.host},signal});
    request.setTimeout(15000,()=>request.destroy(new Error('Subtitle request timed out.')));
    request.once('response',res=>{
      if(res.statusCode>=300&&res.statusCode<400&&res.headers.location){res.resume();agent?.destroy();fetchNetworkText({...input,url:new URL(res.headers.location,u).href},signal,maxBytes,redirects+1).then(resolve,reject);return;}
      if(res.statusCode!==200){res.resume();agent?.destroy();reject(new Error(`Subtitle HTTP ${res.statusCode}.`));return;}
      let size=0;const chunks=[];
      res.on('data',b=>{size+=b.length;if(size>maxBytes)res.destroy(new Error('Subtitle text size limit reached.'));else chunks.push(b);});
      res.once('error',finishError);res.once('end',()=>{agent?.destroy();resolve(Buffer.concat(chunks).toString('utf8'));});
    });
    request.once('error',e=>{agent?.destroy();finishError(e);});request.end();
  });
}

export function networkInputArgs(input) {
  const args=['-protocol_whitelist','http,https,tcp,tls,httpproxy,crypto','-rw_timeout','15000000','-http_proxy',input.proxy.url,
    '-reconnect','1','-reconnect_on_network_error','1','-reconnect_on_http_error','429,500,502,503,504',
    '-reconnect_max_retries','2','-reconnect_delay_max','2','-reconnect_delay_total_max','6'];
  const headers=Object.entries(input.headers??{}).map(([k,v])=>`${k}: ${v}\r\n`).join('');
  if(headers)args.push('-headers',headers);
  return args;
}

// Complete-file fallback for a resolved HTTP audio resource. Each redirect still
// passes the same destination policy; partial files are retained, never unlinked.
export async function downloadNetworkFile(input,file,{signal,maxBytes=1024**3,onProgress}={},redirects=0){
  signal=signal?AbortSignal.any([signal,AbortSignal.timeout(1800000)]):AbortSignal.timeout(1800000);
  if(redirects>4)throw new Error('Too many media download redirects.');
  const u=new URL(await input.proxy.validate(input.url)),proxyUrl=new URL(input.proxy.url);
  if(signal?.aborted)throw new Error('Media download cancelled.');
  let agent;
  const response=await new Promise((resolve,reject)=>{
    let request;
    if(u.protocol==='https:'){
      agent=new https.Agent({keepAlive:false});
      agent.createConnection=(_options,callback)=>{
        const tunnel=http.request({hostname:proxyUrl.hostname,port:proxyUrl.port,method:'CONNECT',path:`${u.hostname}:${u.port||443}`,signal});
        tunnel.once('connect',(res,socket)=>{if(res.statusCode!==200){socket.destroy();callback(new Error('Media download tunnel rejected.'));return;}callback(null,tls.connect({socket,servername:u.hostname}));});
        tunnel.once('error',callback);tunnel.end();
      };
      request=https.request(u,{agent,headers:input.headers,signal});
    }else request=http.request({hostname:proxyUrl.hostname,port:proxyUrl.port,path:u.href,headers:{...input.headers,host:u.host},signal});
    request.setTimeout(15000,()=>request.destroy(new Error('Media download timed out.')));
    request.once('response',resolve);request.once('error',e=>{agent?.destroy();reject(e);});request.end();
  });
  try{
    if(response.statusCode>=300&&response.statusCode<400&&response.headers.location){
      response.resume();agent?.destroy();
      return await downloadNetworkFile({...input,url:new URL(response.headers.location,u).href},file,{signal,maxBytes,onProgress},redirects+1);
    }
    if(response.statusCode!==200)throw new Error(`Media download HTTP ${response.statusCode}.`);
    const expected=response.headers['content-length']===undefined?null:Number(response.headers['content-length']);
    if(expected!==null&&(!Number.isSafeInteger(expected)||expected<0||expected>maxBytes))throw new Error('Media download size limit reached.');
    let bytes=0;
    const meter=new Transform({transform(chunk,_encoding,callback){
      bytes+=chunk.length;if(bytes>maxBytes){callback(new Error('Media download size limit reached.'));return;}
      onProgress?.({bytes,expectedBytes:expected});callback(null,chunk);
    }});
    await pipeline(response,meter,createWriteStream(file,{flags:'wx'}),{signal});
    if(!response.complete||(expected!==null&&bytes!==expected))throw new Error('Media file download ended before the HTTP response was complete.');
    return {bytes,expectedBytes:expected};
  }finally{response.destroy();agent?.destroy();}
}
