// Mechanical image delivery bookkeeping only. The server cannot observe whether
// a model actually inspected, understood or retained a returned image.
export function visualDelivery(job,delivered=new Set()) {
  if(!['file','url'].includes(job.kind))return undefined;
  const total=Math.max(0,job.sheets??0),missingIndexRanges=[];
  let count=0,missingStart=null;
  for(let index=0;index<total;index++) {
    if(delivered.has(index)) {
      count++;
      if(missingStart!==null){missingIndexRanges.push({start:missingStart,end:index-1});missingStart=null;}
    } else if(missingStart===null)missingStart=index;
  }
  if(missingStart!==null)missingIndexRanges.push({start:missingStart,end:total-1});
  const productionComplete=job.status==='complete';
  const productionTerminal=!['starting','running'].includes(job.status);
  const allGeneratedDelivered=count===total;
  return {
    scope:'server_process',
    basis:'Image bytes successfully read for tool responses in this MCP process. This does not prove the Agent inspected or understood them. Direct filesystem reads are not tracked; delivery resets on server restart.',
    generatedSheets:total,deliveredSheets:count,remainingSheets:total-count,
    missingIndexRanges,nextUndeliveredIndex:missingIndexRanges[0]?.start??null,
    productionComplete,productionTerminal,allGeneratedDelivered,
    allDelivered:productionComplete&&total>0&&allGeneratedDelivered,
    continuousCoverageComplete:productionComplete&&job.coverage?.mode==='continuous'&&job.coverage?.completeTimeline===true,
  };
}
