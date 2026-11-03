import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {VideoService} from '../src/service.mjs';

test('old imported text stays on disk but is not served as same-source evidence',async()=>{
  const root=path.resolve('work/legacy-text-boundary-'+randomUUID());
  const id=randomUUID(),mediaId='media_'+id,dir=path.join(root,id),externalId=randomUUID(),generatedId=randomUUID();
  await mkdir(path.join(dir,'transcripts'),{recursive:true});
  const external={id:externalId,mediaId,status:'complete',source:{type:'subtitle'},binding:{basis:'Caller assertion',syncVerified:false},segments:[],events:[]};
  const own={...external,id:generatedId,cacheKey:'old-server-generated-cache-key',mapping:{offsetSeconds:0},alignment:'aligned',timeBase:'source_media_seconds',segments:[{id:'cue',start:0,end:1,text:'Same-source text',final:true,revision:1}],events:[{sequence:1,id:'cue',start:0,end:1,text:'Same-source text',final:true,revision:1}],processedRanges:[{start:0,end:1}]};
  const file=path.join(dir,'transcripts',externalId+'.json');
  await writeFile(file,JSON.stringify(external));
  await writeFile(path.join(dir,'transcripts',generatedId+'.json'),JSON.stringify(own));
  await writeFile(path.join(dir,'manifest.json'),JSON.stringify({id,mediaId,kind:'file',status:'complete',sheets:0,metadata:{duration:2},range:{start:0,end:2},transcriptTracks:[own,external]}));
  const service=new VideoService({dataDir:root});
  try{
    assert.equal(service.text.import,undefined);
    const page=await service.text.read({id});assert.equal(page.id,generatedId);assert.equal(page.segments[0].text,'Same-source text');
    await assert.rejects(service.text.read({id,trackId:externalId}),/Legacy external transcript/);
    const evidence=await service.text.evidence({id,start:0,end:2,imageLimit:0});
    assert.deepEqual(evidence.info.transcripts.map(t=>t.trackId),[generatedId]);
    assert.deepEqual(JSON.parse(await readFile(file,'utf8')),external);
    const j=await service.job(id);j.transcriptTracks=[external];
    assert.equal((await service.text.read({id})).status,'not_enabled');
    assert.equal(service.snapshot(j).statuses.transcript,'not_enabled');
    assert.deepEqual(service.snapshot(j).transcriptTracks,[]);
    j.kind='audio';j.transcriptTracks=[{...external,source:{type:'asr'},processedRanges:[{start:0,end:1}]}];
    assert.equal(service.snapshot(j).audioAnalyzed,false);
    assert.deepEqual(service.snapshot(j).textCoverage,[]);
    j.kind='file';j.transcriptTracks=Array.from({length:8},()=>({...external,id:randomUUID()}));
    assert.equal((await service.text.start({id,mode:'subtitles'})).status,'no_tracks');
    await service.save(j);
    assert.equal(JSON.parse(await readFile(path.join(dir,'manifest.json'),'utf8')).transcriptTracks.length,8);
  }finally{await service.close();}
});
