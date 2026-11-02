import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { compactLayout, renderCompactSheet, createEvidencePipeline } from '../src/compact-sheet.mjs';
import { createPipeline } from '../vendor/dsh-see-now/pipeline.js';
import { fillRect, PAD_FILL, PAD_GLYPH, BADGE_FG } from '../vendor/dsh-see-now/sheet.js';

const colorFrame = (w, h, color) => { const buf = Buffer.alloc(w * h * 3); fillRect(buf,w,h,0,0,w,h,color); return buf; };
const at = (buffer, w, x, y) => [...buffer.subarray((y*w+x)*3,(y*w+x)*3+3)];
function unpack(png) {
  const width=png.readUInt32BE(16),height=png.readUInt32BE(20),chunks=[];
  for(let offset=8;offset<png.length;) {
    const length=png.readUInt32BE(offset),type=png.toString('ascii',offset+4,offset+8);
    if(type==='IDAT')chunks.push(png.subarray(offset+8,offset+8+length));
    offset+=length+12;
  }
  const raw=inflateSync(Buffer.concat(chunks)),buffer=Buffer.alloc(width*height*3);
  for(let y=0;y<height;y++){
    assert.equal(raw[y*(width*3+1)],0);
    raw.copy(buffer,y*width*3,y*(width*3+1)+1,(y+1)*(width*3+1));
  }
  return {buffer,width,height};
}

test('1–40 frames tile the canvas exactly, stay in order and within the pixel/side budget',()=>{
  for(const [w,h] of [[800,400],[640,360],[360,640],[512,512],[1600,90]]) {
    for(let n=1;n<=40;n++) {
      const p=compactLayout(n,w,h);
      assert.equal(p.rects.length,n); assert.ok(p.width*p.height<=w*h);
      assert.ok(Math.max(p.width,p.height)<=Math.max(w,h));
      let previous;
      for(const [i,r] of p.rects.entries()) {
        assert.equal(r.index,i+1); assert.ok(r.pw>0&&r.ph>0);
        assert.ok(r.px>=0&&r.py>=0&&r.px+r.pw<=p.width&&r.py+r.ph<=p.height);
        assert.ok(r.pw<=w&&r.ph<=h,'do not upscale source frames');
        if(previous)assert.ok(r.py>previous.py||(r.py===previous.py&&r.px>previous.px));
        previous=r;
        for(const other of p.rects.slice(0,i))assert.ok(r.px>=other.px+other.pw||other.px>=r.px+r.pw||r.py>=other.py+other.ph||other.py>=r.py+r.ph,'no overlap');
      }
      assert.equal(p.rects.reduce((sum,r)=>sum+r.pw*r.ph,0),p.width*p.height,'no unoccupied rectangles');
    }
  }
});

test('three-frame regression eliminates both padding colours and enlarges each image within the same budget',()=>{
  const frames=[[180,40,40],[40,180,40],[40,40,180]].map(c=>({buf:colorFrame(800,400,c)}));
  const result=renderCompactSheet({frames,tiers:[1,1,1],width:800,height:400});
  assert.ok(result.area>0.98); assert.ok(result.rects.every(r=>r.pw>400&&r.ph>200));
  assert.ok(result.width*result.height<=800*400);
  for(let p=0;p<result.buffer.length;p+=3) {
    const pixel=[...result.buffer.subarray(p,p+3)];
    assert.notDeepEqual(pixel,PAD_FILL); assert.notDeepEqual(pixel,PAD_GLYPH);
  }
  result.rects.forEach((r,i)=>{
    assert.deepEqual(at(result.buffer,result.width,r.px+Math.floor(r.pw/2),r.py+Math.floor(r.ph/2)),[[180,40,40],[40,180,40],[40,40,180]][i]);
    let yellow=0;
    for(let y=r.py;y<r.py+r.ph;y++)for(let x=r.px;x<r.px+r.pw;x++) {
      if(at(result.buffer,result.width,x,y).every((c,k)=>c===BADGE_FG[k]))yellow++;
    }
    assert.ok(yellow>0,'each real frame has a numbered badge');
  });
});

test('landscape, portrait and single-frame rendering retain all four source edges',()=>{
  for(const [width,height] of [[640,360],[360,640]])for(const count of [1,3,7]) {
    const buf=colorFrame(width,height,[80,80,80]),edge=24;
    fillRect(buf,width,height,0,0,width,edge,[240,0,0]);
    fillRect(buf,width,height,0,height-edge,width,edge,[0,240,0]);
    fillRect(buf,width,height,0,0,edge,height,[0,0,240]);
    fillRect(buf,width,height,width-edge,0,edge,height,[240,0,240]);
    const result=renderCompactSheet({frames:Array.from({length:count},()=>({buf})),tiers:Array(count).fill(1),width,height});
    for(const r of result.rects) {
      const seam=count>1?1:0,cw=r.pw-seam,ch=r.ph-seam;
      const pixel=(x,y)=>at(result.buffer,result.width,r.px+x,r.py+y);
      assert.deepEqual(pixel(Math.floor(cw/2),0),[240,0,0]);
      assert.deepEqual(pixel(Math.floor(cw/2),ch-1),[0,240,0]);
      assert.deepEqual(pixel(0,Math.floor(ch/2)),[0,0,240]);
      assert.deepEqual(pixel(cw-1,Math.floor(ch/2)),[240,0,240]);
    }
  }
});

test('renderer substitution preserves every selected timestamp, tier, batch and flush reason',()=>{
  const width=160,height=90,colors=[[220,0,0],[0,0,220],[0,180,0],[220,220,0],[220,0,220],[0,220,220]];
  for(const extra of [{},{oneShot:true,maxWaitSec:5},{maxFrames:1,strategy:'single'}]) {
    const options={width,height,fps:12,queueDepth:0,...extra};
    const old=createPipeline(options),current=createEvidencePipeline(options);
    for(let i=0;i<36*12;i++) {
      const frame={t:i/12,buf:colorFrame(width,height,colors[Math.floor(i/24)%colors.length])};
      old.push(frame);current.push(frame);
    }
    old.finish();current.finish();
    const take=p=>{const result=[];let sheet;while((sheet=p.take()))result.push(sheet);return result;};
    const before=take(old),after=take(current);
    const evidence=s=>({at:s.at,from:s.from,to:s.to,frames:s.frames,why:s.why,bins:s.bins});
    assert.deepEqual(after.map(evidence),before.map(evidence));
    assert.deepEqual(current.stats,old.stats);assert.equal(current.stats.overflow,0);
    for(const s of after) {
      const decoded=unpack(s.png);
      assert.equal(decoded.width,s.w);assert.equal(decoded.height,s.h);
      assert.equal(s.layout,'compact-rows-v1');assert.equal(s.cells.length,s.frames.length);
      assert.deepEqual(s.cells.map(c=>c.tier),s.frames.map(f=>f.tier));
    }
  }
});

test('tiny-cell badges stay inside their own cell and unscaled source buffers remain immutable',()=>{
  const width=1600,height=36,count=40,color=[180,120,80];
  const source=colorFrame(width,height,color),original=Buffer.from(source);
  const result=renderCompactSheet({frames:Array.from({length:count},()=>({buf:source})),tiers:Array(count).fill(8),width,height});
  assert.ok(result.rects.some(r=>r.ph<14),'fixture exercises badge-height overflow');
  for(const r of result.rects) {
    for(let y=0;y<Math.min(4,r.ph-1);y++)for(let x=0;x<r.pw-1;x++) {
      assert.deepEqual(at(result.buffer,result.width,r.px+x,r.py+y),color,'previous row badge cannot cover this cell');
    }
    assert.deepEqual(at(result.buffer,result.width,r.px+r.pw-1,r.py),[18,18,20],'seam stays clean');
  }
  renderCompactSheet({frames:[{buf:source}],tiers:[1],width,height});
  assert.deepEqual(source,original);
});
