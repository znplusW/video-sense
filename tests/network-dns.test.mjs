import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {createNetworkProxy,isPublicIP} from '../src/network.mjs';

const answers=(...ips)=>ips.map(address=>({address,family:net.isIP(address)}));
const fake4='198.18.0.13',fake6='2001:2::d';

test('proxy DNS accepts IPv4/IPv6 synthetic and mixed public answers only through an upstream',async()=>{
  for(const records of [answers(fake4),answers(fake6),answers('198.19.255.254','2001:0002:0000:ffff:ffff:ffff:ffff:ffff'),answers(fake4,fake6),answers(fake4,'2606:4700:4700::1111'),answers('1.1.1.1',fake6)]){
    const p=await createNetworkProxy({upstream:'http://127.0.0.1:9',lookupAddress:async()=>records});
    try{assert.equal(await p.validate('https://public.example/video'),'https://public.example/video');}
    finally{p.close();}
    const direct=await createNetworkProxy({upstream:null,lookupAddress:async()=>records});
    try{await assert.rejects(()=>direct.validate('https://public.example/video'),/public Internet/);}
    finally{direct.close();}
  }
  assert.equal(isPublicIP(fake4),false);assert.equal(isPublicIP(fake6),false);assert.equal(isPublicIP('198.20.0.1'),true);
});

test('proxy DNS still rejects literals, internal names and answers outside public/benchmark ranges',async()=>{
  for(const records of [[],answers('127.0.0.1'),answers('10.0.0.1'),answers(fake4,'192.168.1.1'),answers(fake6,'::1'),answers('fc00::1'),answers('169.254.169.254'),answers('198.51.100.1'),answers('2001:db8::1'),answers('2001:2:1::1')]){
    const p=await createNetworkProxy({upstream:'http://127.0.0.1:9',lookupAddress:async()=>records});
    try{await assert.rejects(()=>p.validate('https://public.example/video'),/public Internet/);}
    finally{p.close();}
  }
  for(const host of [fake4,`[${fake6}]`,'private','a.local','a.internal','a.localhost','a.local.']){
    const p=await createNetworkProxy({upstream:'http://127.0.0.1:9',lookupAddress:async()=>answers(fake4,fake6)});
    try{await assert.rejects(()=>p.validate(`https://${host}/video`),/public Internet/);}
    finally{p.close();}
  }
});

test('dual-stack synthetic DNS forwards HTTP URL/Host through the configured proxy',{timeout:10000},async()=>{
  let destination;
  const upstream=http.createServer((req,res)=>{
    destination={url:req.url,host:req.headers.host};res.end('public-media');
  });
  await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
  const p=await createNetworkProxy({upstream:`http://127.0.0.1:${upstream.address().port}`,lookupAddress:async()=>answers(fake4,fake6)});
  try{
    const body=await new Promise((resolve,reject)=>{
      const req=http.get({hostname:'127.0.0.1',port:new URL(p.url).port,path:'http://public.example/video.mp4'},res=>{
        let body='';res.on('data',data=>body+=data);res.once('end',()=>resolve(body));res.once('error',reject);
      });
      req.once('error',reject);
    });
    assert.equal(body,'public-media');assert.deepEqual(destination,{url:'http://public.example/video.mp4',host:'public.example'});
  }finally{p.close();upstream.close();}
});

test('dual-stack synthetic DNS forwards original CONNECT hostname and rechecks each request',{timeout:10000},async()=>{
  const authorities=[];
  const upstream=http.createServer();
  upstream.on('connect',(req,socket)=>{
    authorities.push(req.url);socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    socket.on('data',()=>socket.write('PONG'));
  });
  await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
  let records=answers(fake4,fake6),checks=0;
  const p=await createNetworkProxy({upstream:`http://127.0.0.1:${upstream.address().port}`,lookupAddress:async()=>{checks++;return records;}});
  const connect=()=>new Promise((resolve,reject)=>{
    const socket=net.connect({host:'127.0.0.1',port:new URL(p.url).port});
    let data='',ping=false;
    socket.on('error',reject);socket.setTimeout(3000,()=>{socket.destroy();reject(new Error('CONNECT timeout'));});
    socket.on('connect',()=>socket.write('CONNECT public.example:443 HTTP/1.1\r\nHost: public.example:443\r\n\r\n'));
    socket.on('data',chunk=>{
      data+=chunk.toString();
      if(data.includes('403 Forbidden')){socket.destroy();resolve('blocked');return;}
      if(!ping&&data.includes('200 Connection Established\r\n\r\n')){ping=true;socket.write('PING');}
      if(data.includes('PONG')){socket.destroy();resolve('allowed');}
    });
  });
  try{
    assert.equal(await connect(),'allowed');assert.deepEqual(authorities,['public.example:443']);
    records=answers('192.168.1.10');
    assert.equal(await connect(),'blocked');assert.equal(checks,2);assert.equal(authorities.length,1);
  }finally{p.close();upstream.close();}
});
