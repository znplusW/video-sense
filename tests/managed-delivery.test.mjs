import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {VideoService} from '../src/service.mjs';
import {ReviewService} from '../src/review.mjs';
const turn=()=>new Promise(r=>setImmediate(r));
function setup(){
 const service=new VideoService();
 const job=()=>{const id=randomUUID(),j={id,mediaId:id,kind:'file',status:'complete',sheets:1,directory:'unused',range:{start:0,end:1},coverage:{mode:'continuous',completeTimeline:true},transcriptTracks:[]};service.jobs.set(id,j);return j;};
 const review=new ReviewService(service);review.save=async()=>{};
 return {service,review,job};
}
const untilAbort=signal=>new Promise((resolve,reject)=>{signal.throwIfAborted();signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});
test('session stop aborts only owned image requests, retains saved evidence and allows later reread',async()=>{
 const {service,review,job}=setup(),a=job(),b=job();
 const one=service.withImages(a.id,undefined,s=>review.imageResponse(a.id,()=>untilAbort(s),s));
 const oneResult=assert.rejects(one,/cancelled/);
 let otherSignal;const two=service.withImages(b.id,undefined,s=>{otherSignal=s;return untilAbort(s);});
 const twoResult=assert.rejects(two,/cancelled/);
 await turn();await service.stop(a.id,'cleanup');await oneResult;
 assert.equal(otherSignal.aborted,false);assert.equal((await review.get(a.id)).pending,null);
 assert.equal(a.status,'complete');assert.equal(await service.withImages(a.id,undefined,async()=>42),42);
 await service.close();await twoResult;assert.equal(service.imageRequests.size,0);
});
test('request AbortSignal cancels a read without cancelling its media job',async()=>{
 const {service,job}=setup(),j=job(),controller=new AbortController();
 const running=service.withImages(j.id,controller.signal,s=>untilAbort(s));const result=assert.rejects(running,/client cancellation/);
 await turn();controller.abort(new Error('client cancellation'));await result;assert.equal(j.status,'complete');assert.equal(service.imageRequests.size,0);await service.close();
});
test('single image over budget creates no receipt or delivery credit',async()=>{
 const {service,review,job}=setup(),j=job(),large={data:Buffer.alloc(8*1024**2+1),mimeType:'image/png',info:{index:0}};
 await assert.rejects(review.imageResponse(j.id,async()=>large),/8 MiB/);
 assert.equal((await review.get(j.id)).pending,null);
 service.readSheet=async()=>large;
 await assert.rejects(service.sheet(j.id,0,'png'),/8 MiB/);
 await assert.rejects(service.nextSaved(j.id,-1,0,undefined,'png'),/8 MiB/);
 assert.equal(service.delivery(j).deliveredSheets,0);await service.close();
});
test('cancelled request waiting for review lock cannot produce or acknowledge images',async()=>{
 const {service,review,job}=setup(),j=job();let release,produced=false;
 const held=review.locked(j.id,()=>new Promise(r=>{release=r;}));await turn();
 const request=service.withImages(j.id,undefined,s=>review.imageResponse(j.id,async()=>{produced=true;return {images:[],info:{}};},s));
 const result=assert.rejects(request,/cancelled/);await turn();const stopping=service.stop(j.id);release();await held;await stopping;await result;
 assert.equal(produced,false);await service.close();
});
