import { randomUUID,createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { assertImageBudget } from './image-delivery.mjs';

const visual = j => ['file','url'].includes(j.kind);
const working = s => ['starting','running'].includes(s);
const uuid = s => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const basis = 'Caller acknowledgement of images actually received and inspected. This is a caller assertion, not proof of visual understanding. Sent images alone never count as acknowledged.';
export async function renameReview(temp,file,move=rename,delay=ms=>new Promise(r=>setTimeout(r,ms))) {
  for(let attempt=0;;attempt++)try{return await move(temp,file);}catch(error){
    if(attempt>=5||!['EPERM','EACCES','EBUSY'].includes(error.code))throw error;
    await delay(Math.min(200,25*2**attempt));
  }
}

// Per-consumer visual plans and image receipts, separate from production and
// legacy server-side delivery counters. No semantic notes are stored here.
export class ReviewService {
  constructor(service) { this.service=service;this.sessions=new Map();this.locks=new Map(); }
  async locked(id,fn) {
    const prior=this.locks.get(id)??Promise.resolve();let release;
    const current=new Promise(r=>{release=r;});this.locks.set(id,current);
    await prior;try{return await fn();}finally{release();if(this.locks.get(id)===current)this.locks.delete(id);}
  }
  async get(id,resumeId) {
    const j=await this.service.job(id);if(!visual(j))return null;
    let r=this.sessions.get(id);
    if(resumeId&&r?.reviewId!==resumeId) {
      if(!uuid(resumeId))throw new Error('Invalid reviewId.');
      const restored=JSON.parse(await readFile(path.join(j.directory,'reviews',resumeId+'.json'),'utf8'));
      if(restored.jobId!==id||restored.mediaId!==j.mediaId||restored.schemaVersion!==1)throw new Error('Review does not belong to this media version.');
      // Prior versions also tracked required text pages. They no longer form
      // part of this image-only ledger; retain visual receipts when resuming.
      r={...restored,plan:{visual:restored.plan.visual,indices:restored.plan.indices??[]}};
      delete r.textSeen;this.sessions.set(id,r);
    }
    if(!r) {
      r={schemaVersion:1,jobId:id,mediaId:j.mediaId,reviewId:randomUUID(),state:'reading',
        plan:{visual:'undecided',indices:[]},acknowledged:[],sent:[],pending:null,
        createdAt:new Date().toISOString(),guard:{calls:0,stalls:0}};
      this.sessions.set(id,r);await this.save(j,r);
    }
    return r;
  }
  async save(j,r) {
    const directory=path.join(j.directory,'reviews');await mkdir(directory,{recursive:true});
    r.updatedAt=new Date().toISOString();const file=path.join(directory,r.reviewId+'.json'),temp=file+'.tmp';
    // All mutations are serialized by locked(); rename prevents partial JSON
    // after a process interruption. This replaces state, never media evidence.
    await writeFile(temp,JSON.stringify(r));await renameReview(temp,file);
  }
  progress(j,r) {
    if(!r)return undefined;
    const targets=r.plan.visual==='all'?Array.from({length:j.sheets},(_,i)=>i):r.plan.visual==='selected'?r.plan.indices:[];
    const seen=new Set(r.acknowledged),missing=targets.filter(i=>!seen.has(i));
    const reasons=[];
    if(r.plan.visual==='undecided')reasons.push('host_must_choose_evidence_scope');
    if(r.pending)reasons.push('image_batch_awaits_acknowledgement');
    if(missing.length)reasons.push('chosen_images_unread');
    if(r.plan.visual==='all'&&j.status!=='complete')reasons.push(working(j.status)?'visual_production_running':'visual_production_incomplete');
    if(r.plan.visual==='all'&&!j.sheets)reasons.push('no_images');
    const ready=!reasons.length;
    return {reviewId:r.reviewId,state:r.state,plan:r.plan,basis,generatedSheets:j.sheets,sentSheets:r.sent.length,
      acknowledgedSheets:r.acknowledged.length,acknowledgedIndices:r.acknowledged,requiredSheets:targets.length,
      missingChosenIndices:missing,pendingBatch:r.pending?{batchId:r.pending.batchId,indices:r.pending.indices}:null,
      mechanicallyReady:ready,reasons,productionStatus:j.status,coverage:j.coverage,
      nextAction:r.pending?{tool:'video_review',arguments:{id:j.id,action:'ack',batchId:r.pending.batchId,viewedIndices:r.pending.indices},
        condition:'Only after seeing the actual images. If the response was lost, use action=replay instead. Acknowledge only inspected indices; [] discards this batch without claiming it was viewed.'}:
        missing.length?{tool:'video_read',arguments:{id:j.id,after:missing[0]-1,limit:Math.min(12,missing.length)}}:
        r.plan.visual==='undecided'?{tool:'video_review',arguments:{id:j.id,action:'plan'},condition:'Host chooses all, selected indices, or none using the user request and actual text/visual evidence; none is valid when text suffices.'}:
        ready?{tool:'video_review',arguments:{id:j.id,action:'finish'}}:{tool:'video_status',arguments:{id:j.id,waitSeconds:20}}};
  }
  peek(id) {const j=this.service.jobs.get(id);return j?this.progress(j,this.sessions.get(id)):undefined;}
  async imageResponse(id,produce,signal) {
    return this.locked(id,async()=>{
      signal?.throwIfAborted();
      const j=await this.service.job(id);if(!visual(j))return produce();
      const r=await this.get(id);
      if(r.pending)throw new Error(JSON.stringify({code:'IMAGE_BATCH_PENDING',review:this.progress(j,r),
        message:'Return the previous batch to the model and inspect it before another image call. Use video_review ack after inspection, or replay after transport failure. Do not accumulate batches inside one script.'}));
      const result=await produce();
      const images=result.images??(result.data?[{data:result.data,mimeType:result.mimeType,info:result.info}]:[]);
      signal?.throwIfAborted();assertImageBudget(images);
      if(images.length) {
        r.state='reading';r.pending={batchId:randomUUID(),indices:images.map(s=>s.info.index),
          imageInfo:images.map(s=>({...s.info,format:s.mimeType==='image/jpeg'?'jpeg':'png',sha256:createHash('sha256').update(s.data).digest('hex')})),createdAt:new Date().toISOString()};
        r.sent=[...new Set([...r.sent,...r.pending.indices])].sort((a,b)=>a-b);await this.save(j,r);
      }
      result.info={...result.info,visualReview:this.progress(j,r)};return result;
    });
  }
  async action(args,signal) {
    return this.locked(args.id,async()=>{
      signal?.throwIfAborted();
      const j=await this.service.job(args.id),r=await this.get(args.id,args.reviewId);
      if(!r)throw new Error('video_review applies to saved video jobs, not audio.');
      const action=args.action??'status';
      if(action==='plan') {
        if(!['all','selected','none'].includes(args.visual))throw new Error('Choose visual=all, selected or none.');
        const indices=[...new Set(args.indices??[])].sort((a,b)=>a-b);
        if(args.visual==='selected'&&(!indices.length||indices.some(i=>!Number.isInteger(i)||i<0||i>=5000)))throw new Error('selected requires 1..5000 valid zero-based sheet indices.');
        r.plan={visual:args.visual,indices:args.visual==='selected'?indices:[]};
        r.state='reading';r.guard={calls:0,stalls:0};
      } else if(action==='ack') {
        if(!r.pending||args.batchId!==r.pending.batchId)throw new Error('batchId does not match the pending batch.');
        if(!Array.isArray(args.viewedIndices)||args.viewedIndices.some(i=>!r.pending.indices.includes(i)))throw new Error('viewedIndices must explicitly list only images inspected from this batch; [] releases it without acknowledging any image.');
        r.acknowledged=[...new Set([...r.acknowledged,...args.viewedIndices])].sort((a,b)=>a-b);
        r.pending=null;
      } else if(action==='replay') {
        if(!r.pending)throw new Error('There is no pending batch to replay.');
        const images=[];let bytes=0;
        for(const [offset,index] of r.pending.indices.entries()){
          const recorded=r.pending.imageInfo?.[offset];
          const image=await this.service.readSheet(j,index,recorded?.format??'png',{signal,replay:recorded});
          if(recorded?.sha256&&recorded.sha256!==createHash('sha256').update(image.data).digest('hex'))throw new Error('Pending image bytes changed; replay cannot claim the same evidence.');
          bytes+=image.data.length;if(bytes>8*1024**2)throw new Error('Replay exceeds the 8 MiB image budget.');
          images.push(image);
        }
        signal?.throwIfAborted();assertImageBudget(images);
        return {images,info:{id:j.id,images:images.map(s=>s.info),replayed:true,visualReview:this.progress(j,r)}};
      } else if(action==='finish') {
        const progress=this.progress(j,r);
        if(!progress.mechanicallyReady)return {info:{id:j.id,finished:false,visualReview:progress,
          note:'Finish the chosen visual work or revise the plan if the user task permits. This check does not track text reading. A partial-progress disclaimer does not complete feasible work.'},images:[]};
        r.state='finished';
      } else if(action!=='status')throw new Error('Unknown review action.');
      await this.save(j,r);
      return {info:{id:j.id,finished:r.state==='finished',visualReview:this.progress(j,r),
        note:'The host must still judge whether the chosen evidence answers the user. No acknowledgement or completion flag proves understanding or complete-video coverage.'},images:[]};
    });
  }
  async cancel(id) {
    const j=await this.service.job(id);if(!visual(j))return;
    await this.locked(id,async()=>{const r=await this.get(id);r.state='cancelled';await this.save(j,r);});
  }
  async guard() {
    const pending=[];
    for(const [id] of this.sessions)await this.locked(id,async()=>{
      const j=await this.service.job(id),r=this.sessions.get(id);
      if(r.state!=='reading'||(!working(j.status)&&j.status!=='complete'))return;
      const p=this.progress(j,r),signature=JSON.stringify([j.sheets,r.acknowledged.length,r.pending?.batchId,r.plan]);
      r.guard.calls++;r.guard.stalls=signature===r.guard.signature?r.guard.stalls+1:0;r.guard.signature=signature;
      await this.save(j,r);
      if(r.guard.calls<=8&&r.guard.stalls<3)pending.push({id,review:p});
    });
    if(!pending.length)return {};
    return {decision:'block',reason:'The video evidence workflow is not closed. Continue the host-chosen evidence plan, or adjust it to the user request and evidence sufficiency; do NOT force all images or ASR. Inspect one bounded image batch per model step, acknowledge only images actually inspected, then video_review finish. Explicit user cancellation must be respected. Pending state: '+JSON.stringify(pending)};
  }
}
