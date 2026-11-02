import test from 'node:test';
import assert from 'node:assert/strict';
import {parseTranscript,queryTranscript,mergeSegments} from '../src/transcript.mjs';

const binding={mediaId:'media_local_sha256_example',bindingBasis:'User attached this subtitle to this video version.',duration:900};
const parse=(content,args={})=>parseTranscript(content,{...binding,...args});

test('SRT preserves original multiline text, explicit source, and overlapping cues',()=>{
  const srt='\uFEFF1\r\n00:00:01,250 --> 00:00:03,500\r\n  点击保存 <b>按钮</b>。\r\n第二行 &amp; 原文字\r\n\r\n2\r\n00:00:02,000 --> 00:00:04,000\r\n另一人同时讲话\r\n';
  const track=parse(srt,{format:'srt',source:{type:'subtitle',language:'zh',trackId:'human-zh',subtitleKind:'manual'}});
  assert.equal(track.segments.length,2);
  assert.equal(track.segments[0].text,'  点击保存 <b>按钮</b>。\n第二行 &amp; 原文字');
  assert.equal(track.segments[0].start,1.25);assert.equal(track.segments[0].end,3.5);
  assert.equal(track.segments[0].cueId,'1');assert.equal(track.segments[1].start,2);
  assert.deepEqual(track.source,{type:'subtitle',language:'zh',trackId:'human-zh',subtitleKind:'manual'});
  assert.equal(track.binding.syncVerified,false);assert.equal(track.mapping.offsetSeconds,0);
  const again=parse(srt,{format:'srt',source:{type:'subtitle',language:'zh',trackId:'human-zh',subtitleKind:'manual'}});
  assert.deepEqual(again.segments.map(s=>s.id),track.segments.map(s=>s.id));
  const page=queryTranscript(track,{start:2.5,end:3,limit:1});
  assert.equal(page.total,2);assert.equal(page.nextOffset,1);
  assert.equal(queryTranscript(track,{start:2.5,end:3,after:1,limit:1}).segments[0].text,'另一人同时讲话');
});

test('VTT header, notes, cue identifiers and layout settings do not become dialogue',()=>{
  const vtt='WEBVTT - source header\nKind: captions\nLanguage: en\n\nNOTE internal note\nnot spoken\n\nSTYLE\n::cue { color: red; }\n\ncue-a\n00:01.000 --> 00:02.500 align:start position:10%\n<v Alice>Hello &lt;world&gt;</v>\n\n00:00:03.000 --> 00:00:04.000\nGoodbye.\n';
  const track=parse(vtt,{format:'vtt',source:{type:'subtitle',subtitleKind:'automatic'}});
  assert.equal(track.segments.length,2);assert.equal(track.segments[0].cueId,'cue-a');
  assert.equal(track.segments[0].cueSettings,'align:start position:10%');
  assert.equal(track.segments[0].text,'<v Alice>Hello &lt;world&gt;</v>');
  assert.equal(track.segments[1].start,3);
  assert.equal(track.source.language,'en','retain declared header language; do not infer it from dialogue');
  assert.deepEqual(track.subtitleHeader.lines,['WEBVTT - source header','Kind: captions','Language: en']);
});

test('external ASR JSON maps clip-relative sentence and word timestamps back to source second 600',()=>{
  const content={schemaVersion:'1',mediaId:binding.mediaId,timeBase:'clip_relative_seconds',timeUnit:'seconds',
    source:{type:'asr',language:'en',backend:'configured-asr',model:'actual-model',device:'cpu'},segments:[
      {id:'chunk-0-segment-0',start:0,end:2,text:'Save the file.',final:true,quality:{avg_logprob:-0.3,no_speech_prob:0.01},
        words:[{start:0.1,end:0.5,text:'Save',quality:{probability:0.92}},{start:0.6,end:1.5,text:'the file.'}]}]};
  const track=parse(content,{format:'json',offsetSeconds:600});
  assert.equal(track.timeBase,'source_media_seconds');assert.equal(track.mapping.inputTimeBase,'clip_relative_seconds');
  assert.equal(track.mapping.offsetSeconds,600);assert.equal(track.binding.syncVerified,false);
  const s=track.segments[0];assert.equal(s.id,'chunk-0-segment-0');assert.equal(s.start,600);assert.equal(s.end,602);
  assert.equal(s.originalStart,0);assert.equal(s.originalEnd,2);assert.equal(s.words[0].start,600.1);assert.equal(s.words[0].originalStart,0.1);
  assert.deepEqual(s.quality,{avg_logprob:-0.3,no_speech_prob:0.01});assert.equal(s.words[0].quality.probability,0.92);
  assert.equal(queryTranscript(track,{start:601,end:603}).segments.length,1);
  assert.equal(queryTranscript(track,{start:602,end:603}).segments.length,0,'half-open ranges exclude a cue ending at query start');
});

test('JSON stable IDs support provisional -> final revision without creating duplicate events',()=>{
  const track=parse({segments:[
    {id:'stable-1',start:0,end:2,text:'save',final:false,revision:0},
    {id:'stable-1',start:0,end:2.1,text:'save file',final:true,revision:1},
    {id:'overlap-2',start:1,end:2,text:'save file',final:true,revision:0},
  ]},{format:'json'});
  assert.equal(track.segments.length,2);assert.equal(track.segments[0].text,'save file');assert.equal(track.segments[0].revision,1);
  assert.equal(track.segments[1].id,'overlap-2','separate source cue IDs preserve legitimate overlap');
  assert.equal(mergeSegments(track.segments,[track.segments[0]]).length,2,'retry is idempotent');
  assert.equal(mergeSegments(track.segments,[Object.fromEntries(Object.entries(track.segments[0]).reverse())]).length,2,'JSON key order is not a revision');
  const stale={...track.segments[0],text:'old result',revision:0,final:false};
  assert.equal(mergeSegments(track.segments,[stale])[0].text,'save file');
  assert.throws(()=>mergeSegments(track.segments,[{...track.segments[0],text:'changed without revision'}]),/greater revision/);
  assert.throws(()=>mergeSegments(track.segments,[{...track.segments[0],final:false,revision:2}]),/final/);
});

test('untimed JSON remains unaligned; empty recognized output is distinct from untimed text',()=>{
  const track=parse({text:'全文而无逐句时码。不要替这个文本编造时间。'},{format:'json'});
  assert.equal(track.alignment,'unaligned');assert.deepEqual(track.segments,[]);
  assert.equal(track.unalignedText,'全文而无逐句时码。不要替这个文本编造时间。');
  const q=queryTranscript(track,{start:600,end:660});assert.equal(q.segments.length,0);assert.ok(q.unalignedText);
  const empty=parse({source:{type:'asr',backend:'configured',model:'actual'},segments:[]},{format:'json'});
  assert.equal(empty.alignment,'aligned');assert.deepEqual(empty.segments,[]);assert.equal(empty.unalignedText,undefined);
  const known=parse({language:'zh',source:{type:'asr',backend:'external',model:'known'},segments:[]},{format:'json',source:{type:'asr',trackId:'selected'}});
  assert.equal(known.source.language,'zh');assert.equal(known.source.backend,'external');assert.equal(known.source.trackId,'selected');
});

test('binding metadata rejects an explicitly different media and never asserts synchronization',()=>{
  assert.throws(()=>parse({mediaId:'another-episode',segments:[]},{format:'json'}),/mediaId does not match/);
  assert.throws(()=>parseTranscript({segments:[]},{format:'json',mediaId:binding.mediaId}),/bindingBasis/);
  assert.throws(()=>parseTranscript({segments:[]},{format:'json',bindingBasis:'user-selected'}),/mediaId/);
  const t=parse({segments:[]},{format:'json',bindingBasis:'Explicit attachment, not content verification'});
  assert.equal(t.binding.syncVerified,false);
  assert.throws(()=>parse('1\n00:00:00,000 --> 00:00:01,000\nHi',{format:'srt',source:{type:'asr'}}),/subtitle/);
});

test('invalid numeric values, bounds, empty text, revisions and words fail without time fabrication',()=>{
  const segment={start:1,end:2,text:'valid'};
  const bad=[{start:null},{start:NaN},{start:Infinity},{start:'1'},{start:-1},{end:1},{end:0.5},{text:''},{text:'  '},{final:null},{revision:null},{revision:-1},{id:null},
    {words:[{start:0,end:0.5,text:'outside'}]},{quality:{score:Infinity}}];
  for(const item of bad)assert.throws(()=>parse({segments:[{...segment,...item}]},{format:'json'}),JSON.stringify(item));
  assert.throws(()=>parse({segments:[segment]},{format:'json',offsetSeconds:-2}),/outside/);
  assert.throws(()=>parse({segments:[segment]},{format:'json',duration:1}),/outside/);
  assert.throws(()=>parse({segments:[segment]},{format:'json',offsetSeconds:Infinity}),/finite/);
  assert.throws(()=>parse({segments:[segment],timeUnit:'milliseconds'},{format:'json'}),/seconds/);
  assert.throws(()=>parse({segments:[segment],source:{type:'asr'}},{format:'json',source:{type:'subtitle'}}),/Conflicting/);
  assert.throws(()=>parse({segments:[segment],source:{type:'unknown-guessed'}},{format:'json'}),/source.type/);
});

test('malformed subtitle timing is rejected, including an unseparated VTT header',()=>{
  for(const srt of [
    '1\n00:61:00,000 --> 00:62:00,000\nwrong minutes',
    '1\n00:00:60,000 --> 00:01:02,000\nwrong seconds',
    '1\n00:00:01.000 --> 00:00:02.000\nwrong SRT separator',
    '1\n00:00:01,000 --> 00:00:00,500\nbackwards',
    '1\n00:00:01,000 --> 00:00:02,000\n',
  ])assert.throws(()=>parse(srt,{format:'srt'}));
  assert.throws(()=>parse('00:01.000 --> 00:02.000\nNo header',{format:'vtt'}),/WEBVTT/);
  assert.throws(()=>parse('WEBVTT\n00:01.000 --> 00:02.000\nNo separator',{format:'vtt'}),/blank line/);
});

test('query pagination is bounded and input mutation cannot change stored evidence',()=>{
  const input={segments:[{start:1,end:2,text:'Original words',quality:{backend_score:0.2},description:'Do not expose an inferred semantic field'}]};
  const track=parse(input,{format:'json'});input.segments[0].quality.backend_score=1;
  assert.equal(track.segments[0].quality.backend_score,0.2);assert.equal(track.segments[0].description,undefined);
  const page=queryTranscript(track,{start:0,end:3});page.segments[0].text='mutated';assert.equal(track.segments[0].text,'Original words');
  for(const args of [{limit:501},{limit:0},{after:-1},{after:0.5},{start:-1},{start:1,end:1},{start:NaN}])assert.throws(()=>queryTranscript(track,args));
});
