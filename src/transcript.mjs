import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

// Canonical external JSON: {schemaVersion?:'1', mediaId?:string,
// timeBase?:'source_media_seconds'|'clip_relative_seconds'|'chunk_relative_seconds',
// timeUnit?:'seconds', source?:{type,language?,trackId?,subtitleKind?,backend?,model?},
// segments:[{id?,start,end,text,final?,revision?,speaker?,quality?,words?:[{start,end,text,quality?}]}]}.
// Untimed {text:string} is retained separately; no sentence timestamps are invented.
const bases=new Set(['source_media_seconds','clip_relative_seconds','chunk_relative_seconds']);
const sourceTypes=new Set(['subtitle','asr','external_transcript']);
const sourceKeys=['language','trackId','subtitleKind','backend','model','engineVersion','device','provider','timestampAccuracy','quality'];
const MAX_BYTES=10*1024*1024,MAX_SEGMENTS=100000,MAX_WORDS=500000;
const own=(x,k)=>Object.prototype.hasOwnProperty.call(x,k);
const clone=x=>JSON.parse(JSON.stringify(x));

function finite(value,label){
  if(typeof value!=='number'||!Number.isFinite(value))throw new Error(`${label} must be a finite number of seconds.`);
  return value;
}
function string(value,label,{empty=false}={}){
  if(typeof value!=='string'||(!empty&&!value.trim()))throw new Error(`${label} must be a nonempty string.`);
  return value;
}
function object(value,label){
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error(`${label} must be an object.`);
  return value;
}
function serializable(value,label,depth=0){
  if(depth>12)throw new Error(`${label} is too deeply nested.`);
  if(value===null||typeof value==='string'||typeof value==='boolean')return;
  if(typeof value==='number'){finite(value,label);return;}
  if(typeof value!=='object')throw new Error(`${label} must contain JSON values.`);
  for(const v of Object.values(value))serializable(v,label,depth+1);
}
function sourceValue(given,format){
  const source=given===undefined?{}:object(given,'source');
  const type=source.type??(format==='json'?'external_transcript':'subtitle');
  if(!sourceTypes.has(type))throw new Error('source.type must be subtitle, asr, or external_transcript.');
  if(format!=='json'&&type!=='subtitle')throw new Error('SRT/VTT data must be identified as subtitle, not ASR.');
  const out={type};
  for(const key of sourceKeys)if(own(source,key)){
    if(key==='quality'){serializable(source[key],'source.quality');out[key]=clone(source[key]);}
    else out[key]=string(source[key],`source.${key}`);
  }
  if(out.subtitleKind!==undefined&&!['manual','automatic','translated','unknown'].includes(out.subtitleKind))throw new Error('source.subtitleKind must be manual, automatic, translated, or unknown.');
  return out;
}
function cueTime(value,format){
  const separator=format==='srt'?',':'.';
  const parts=value.split(':');
  if(parts.length!==3&&(format!=='vtt'||parts.length!==2))throw new Error('Invalid subtitle timecode.');
  const last=parts.at(-1).split(separator);
  if(last.length!==2||!/^\d{2}$/.test(last[0])||!/^\d{3}$/.test(last[1]))throw new Error('Subtitle timecodes require seconds and three fractional digits.');
  const sec=Number(last[0]),min=Number(parts.at(-2)),hours=parts.length===3?Number(parts[0]):0;
  if(!/^\d{2}$/.test(parts.at(-2))||!/^\d{2,}$/.test(parts[0])||sec>59||min>59||!Number.isSafeInteger(hours))throw new Error('Invalid subtitle hour/minute/second.');
  return hours*3600+min*60+sec+Number(last[1])/1000;
}
function subtitleCues(content,format){
  const normalized=content.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n');
  let blocks=normalized.split(/\n[\t ]*\n+/),header;
  if(format==='vtt'){
    const first=blocks.shift()??'';
    if(!/^WEBVTT(?:[\t ].*)?(?:\n|$)/.test(first))throw new Error('VTT must begin with a WEBVTT header.');
    if(first.includes('-->'))throw new Error('VTT header requires a blank line before cues.');
    header={lines:first.split('\n')};
    const language=/^Language:[\t ]*(\S.*)$/mi.exec(first)?.[1]?.trim();
    if(language)header.language=language;
  }
  const cues=[];
  for(const block of blocks){
    if(!block.trim())continue;
    if(format==='vtt'&&/^(?:NOTE(?:[\t ]|\n|$)|STYLE(?:\n|$)|REGION(?:\n|$))/.test(block))continue;
    const lines=block.replace(/^\n+|\n+$/g,'').split('\n');
    let timing=0,cueId;
    if(!lines[0].includes('-->')){cueId=lines[0];timing=1;}
    const match=/^(\S+)\s+-->\s+(\S+)(?:[\t ]+(.*))?$/.exec(lines[timing]??'');
    if(!match)throw new Error(`Invalid ${format.toUpperCase()} timing at cue ${cues.length+1}.`);
    cues.push({start:cueTime(match[1],format),end:cueTime(match[2],format),text:lines.slice(timing+1).join('\n'),cueId,
      ...(match[3]?{cueSettings:match[3]}:{})});
  }
  return {cues,header};
}
function mappedTime(start,end,offset,duration,label,allowPoint=false){
  finite(start,`${label}.start`);finite(end,`${label}.end`);
  if(start<0||(allowPoint?end<start:end<=start))throw new Error(`${label} must have nonnegative ordered times${allowPoint?'':' with positive duration'}.`);
  const mappedStart=start+offset,mappedEnd=end+offset;
  if(mappedStart< -1e-7||mappedEnd<0||duration!==undefined&&mappedEnd>duration+1e-7)throw new Error(`${label} is outside media bounds after offset.`);
  return {start:Math.max(0,mappedStart),end:mappedEnd,originalStart:start,originalEnd:end};
}
function normalizeSegments(raw,{mediaId,source,format,offsetSeconds,duration}){
  if(raw.length>MAX_SEGMENTS)throw new Error(`At most ${MAX_SEGMENTS} segments per import.`);
  let wordCount=0;
  return raw.map((value,index)=>{
    object(value,`segments[${index}]`);
    const text=string(value.text,`segments[${index}].text`);
    const times=mappedTime(value.start,value.end,offsetSeconds,duration,`segments[${index}]`);
    const id=format==='json'&&own(value,'id')?String(value.id):'segment_'+createHash('sha256')
      .update([mediaId,source.type,source.trackId??'',format,index].join('\0')).digest('hex').slice(0,20);
    if(!id.trim()||id.length>300)throw new Error('Segment ID must be nonempty and at most 300 characters.');
    if(own(value,'id')&&format==='json'&&(!['string','number'].includes(typeof value.id)||typeof value.id==='number'&&!Number.isFinite(value.id)))throw new Error('Segment ID must be a string or finite number.');
    const final=own(value,'final')?value.final:true,revision=own(value,'revision')?value.revision:0;
    if(typeof final!=='boolean'||!Number.isSafeInteger(revision)||revision<0)throw new Error('final must be boolean and revision must be a nonnegative integer.');
    const segment={id,...times,text,sourceType:source.type,final,revision};
    if(value.cueId!==undefined)segment.cueId=value.cueId;
    if(value.cueSettings!==undefined)segment.cueSettings=value.cueSettings;
    if(own(value,'speaker'))segment.speaker=string(value.speaker,'segment.speaker');
    if(own(value,'quality')){serializable(value.quality,'segment.quality');segment.quality=clone(value.quality);}
    if(own(value,'words')){
      if(!Array.isArray(value.words))throw new Error('words must be an array.');
      wordCount+=value.words.length;if(wordCount>MAX_WORDS)throw new Error('Too many word timestamps.');
      segment.words=value.words.map((word,i)=>{
        object(word,'word');const wordText=string(word.text,'word.text');
        const wt=mappedTime(word.start,word.end,offsetSeconds,duration,`word ${i}`,true);
        if(wt.start<times.start-1e-7||wt.end>times.end+1e-7)throw new Error('Word timestamps must lie inside their segment.');
        const out={...wt,text:wordText};
        if(own(word,'quality')){serializable(word.quality,'word.quality');out.quality=clone(word.quality);}
        return out;
      });
    }
    return segment;
  });
}

/** Parse source text and apply only an explicit time translation; no semantic processing. */
export function parseTranscript(content,{format,source,offsetSeconds=0,duration,mediaId,bindingBasis,timeBase='source_media_seconds'}={}){
  if(!['srt','vtt','json'].includes(format))throw new Error('format must be srt, vtt, or json.');
  if(source!==undefined)object(source,'source');
  string(mediaId,'mediaId');string(bindingBasis,'bindingBasis');finite(offsetSeconds,'offsetSeconds');
  if(duration!==undefined&&(finite(duration,'duration')<=0))throw new Error('duration must be positive.');
  if(!bases.has(timeBase))throw new Error('Unknown input timeBase.');
  let parsed={};
  if(typeof content==='string'){
    if(Buffer.byteLength(content,'utf8')>MAX_BYTES)throw new Error('Transcript import exceeds 10 MiB.');
    if(format==='json'){
      try{parsed=JSON.parse(content.replace(/^\uFEFF/,''));}catch{throw new Error('Invalid transcript JSON.');}
    }
  }else if(format==='json'){
    serializable(content,'transcript');
    if(Buffer.byteLength(JSON.stringify(content),'utf8')>MAX_BYTES)throw new Error('Transcript import exceeds 10 MiB.');
    parsed=content;
  }else throw new Error('SRT/VTT content must be a string.');
  if(format==='json'){
    if(Array.isArray(parsed))parsed={segments:parsed};
    object(parsed,'JSON transcript');
    if(parsed.schemaVersion!==undefined&&String(parsed.schemaVersion)!=='1')throw new Error('Unsupported transcript schemaVersion.');
    const declaredMediaId=parsed.mediaId??parsed.media_id;
    if(declaredMediaId!==undefined&&declaredMediaId!==mediaId)throw new Error('Transcript mediaId does not match the target media.');
    if(parsed.timeUnit!==undefined&&parsed.timeUnit!=='seconds')throw new Error('Transcript timeUnit must be seconds.');
    if(parsed.timeBase!==undefined){if(!bases.has(parsed.timeBase))throw new Error('Unknown JSON timeBase.');timeBase=parsed.timeBase;}
    if(parsed.source!==undefined)object(parsed.source,'JSON source');
    if(source!==undefined&&parsed.source?.type!==undefined&&source.type!==undefined&&parsed.source.type!==source.type)throw new Error('Conflicting transcript source types.');
  }
  const actualSource=sourceValue({...parsed.source,...source},format);
  if(actualSource.language===undefined&&parsed.language!==undefined)actualSource.language=string(parsed.language,'transcript.language');
  const track={schemaVersion:'1',mediaId,timeBase:'source_media_seconds',timeUnit:'seconds',source:actualSource,
    binding:{basis:bindingBasis,syncVerified:false},mapping:{inputTimeBase:timeBase,offsetSeconds,operation:'mapped_seconds = input_seconds + offsetSeconds',
      limitation:'A constant offset does not correct edits or clock drift.'},alignment:'aligned',segments:[]};
  let raw;
  if(format==='json'){
    if(!own(parsed,'segments')){
      track.unalignedText=string(parsed.text,'Untimed transcript text');track.alignment='unaligned';return track;
    }
    if(!Array.isArray(parsed.segments))throw new Error('segments must be an array.');
    raw=parsed.segments;
    if(own(parsed,'text'))track.sourceFullText=string(parsed.text,'transcript.text',{empty:true});
  }else{
    const cues=subtitleCues(content,format);raw=cues.cues;
    if(cues.header){track.subtitleHeader=cues.header;if(actualSource.language===undefined&&cues.header.language)actualSource.language=cues.header.language;}
  }
  track.segments=mergeSegments([],normalizeSegments(raw,{mediaId,source:actualSource,format,offsetSeconds,duration}));
  return track;
}

/** Stable IDs are the revision key. Equal text at overlapping times is not a duplicate rule. */
export function mergeSegments(existing,incoming){
  if(!Array.isArray(existing)||!Array.isArray(incoming))throw new Error('Segment collections must be arrays.');
  const merged=new Map();
  for(const item of [...existing,...incoming]){
    object(item,'segment');string(item.id,'segment.id');string(item.text,'segment.text');
    finite(item.start,'segment.start');finite(item.end,'segment.end');
    if(item.start<0||item.end<=item.start||typeof item.final!=='boolean'||!Number.isSafeInteger(item.revision)||item.revision<0)throw new Error('Invalid normalized segment.');
    const old=merged.get(item.id);
    if(old){
      if(item.revision<old.revision)continue;
      if(item.revision===old.revision){
        if(!isDeepStrictEqual(item,old))throw new Error('A changed segment with the same ID requires a greater revision.');
        continue;
      }
      if(old.final&&!item.final)throw new Error('A final segment cannot be revised to provisional.');
    }
    merged.set(item.id,clone(item));
  }
  if(merged.size>MAX_SEGMENTS)throw new Error('Too many normalized segments.');
  return [...merged.values()].sort((a,b)=>a.start-b.start||a.end-b.end||a.id.localeCompare(b.id));
}

/** Half-open time ranges [start,end); overlapping source cues remain separate results. */
export function queryTranscript(track,{start=0,end,after=0,limit=100}={}){
  finite(start,'query.start');if(start<0)throw new Error('query.start must be nonnegative.');
  if(end!==undefined&&(finite(end,'query.end')<=start))throw new Error('query.end must be greater than start.');
  if(!Number.isInteger(after)||after<0||!Number.isInteger(limit)||limit<1||limit>500)throw new Error('after must be a nonnegative offset; limit must be 1..500.');
  const matches=track.segments.filter(s=>s.end>start&&(end===undefined||s.start<end));
  const segments=matches.slice(after,after+limit);
  return {schemaVersion:'1',mediaId:track.mediaId,timeBase:track.timeBase,timeUnit:'seconds',alignment:track.alignment,source:clone(track.source),
    binding:clone(track.binding),mapping:clone(track.mapping),requestedRange:{start,...(end===undefined?{}:{end})},
    segments:clone(segments),total:matches.length,offset:after,nextOffset:after+segments.length<matches.length?after+segments.length:null,
    ...(track.alignment==='unaligned'?{unalignedText:track.unalignedText}:{})};
}
