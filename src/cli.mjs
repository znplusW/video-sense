import { VideoService } from './service.mjs';
import { parseArgs } from 'node:util';

const {values,positionals}=parseArgs({allowPositionals:true,options:{
  'data-dir':{type:'string'},quality:{type:'string'},pace:{type:'string'},scene:{type:'boolean'},format:{type:'string'},
  start:{type:'string'},end:{type:'string'},help:{type:'boolean'},analysis:{type:'string'},'source-type':{type:'string'},samples:{type:'string'},'video-index':{type:'string'},
}});
if(values.help||!positionals.length){
  console.log('node src/cli.mjs doctor\nnode src/cli.mjs analyze ABSOLUTE_VIDEO --data-dir ABSOLUTE_OUTPUT [--start 0 --end 30 --quality high --pace dense --scene]\nnode src/cli.mjs analyze-url HTTP_URL --data-dir ABSOLUTE_OUTPUT [--analysis continuous|overview --start 0 --end 30 --source-type auto|direct|page --samples 8]');
}else{
  const s=new VideoService({dataDir:values['data-dir']});
  process.on('SIGINT',()=>s.close().finally(()=>process.exit(130)));
  process.on('SIGTERM',()=>s.close().finally(()=>process.exit(143)));
  try{
    if(positionals[0]==='doctor')console.log(JSON.stringify(await s.doctor(),null,2));
    else if(['analyze','analyze-url'].includes(positionals[0])){
      const args={quality:values.quality,pace:values.pace,scene:values.scene,
        start:values.start===undefined?0:Number(values.start),end:values.end===undefined?undefined:Number(values.end)};
      const j=positionals[0]==='analyze'?await s.startVideo({file:positionals[1],...args}):await s.startUrl({url:positionals[1],...args,
        analysis:values.analysis,sourceType:values['source-type'],samples:values.samples===undefined?undefined:Number(values.samples),videoIndex:values['video-index']===undefined?undefined:Number(values['video-index'])});
      console.error(`job ${j.id}`);
      let after=-1;
      while(true){const next=await s.nextSaved(j.id,after,20,undefined,values.format);if(next.data){after=next.info.index;console.log(JSON.stringify({type:'image',...next.info}));}
        else if(!['starting','running'].includes(next.info.status))break;}
      const st=await s.status(j.id);
      console.log(JSON.stringify(st,null,2));
      if(st.status!=='complete')process.exitCode=1;
    }else throw new Error('Unknown command. Use --help.');
  }catch(e){console.error(e.message);process.exitCode=1;}
  finally{await s.close();}
}
