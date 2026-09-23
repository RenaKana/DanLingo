import { translatedPacket, type BilibiliComment } from './messages.ts';

type Data = Record<string, any>;
interface Output { kind: 'screen' | 'chat' | 'render'; fn: Function; owner: unknown; args: any[] }
/**
 * Run the reviewed native decoder/filter once on the ORIGINAL. Only its synchronous
 * output sinks are captured. This preserves own-message and keyword/block decisions.
 * Restore the temporary screen sink before entering any asynchronous queue.
 */
export function captureNativeDispatch(engine: Data, context: Data, original: Function, args: any[], source: BilibiliComment) {
  const owner=engine.danmaku, add=owner?.add;
  if(typeof add!=='function'||typeof context?.isBlocked!=='function'||typeof context?.emitDanmaku!=='function')return null;
  const descriptor=Object.getOwnPropertyDescriptor(owner,'add');
  if(descriptor ? !('value' in descriptor)||descriptor.writable!==true : !Object.isExtensible(owner))return null;
  const outputs:Output[]=[];
  const screen=function(this:unknown,...values:any[]) { if(this!==owner)return Reflect.apply(add,this,values);outputs.push({kind:'screen',fn:add,owner,args:values}); };
  const proxy=Object.create(context);
  Object.defineProperties(proxy,{
    isBlocked:{value:(...values:any[])=>Reflect.apply(context.isBlocked,context,values)},
    emitDanmaku:{value:(...values:any[])=>{outputs.push({kind:'chat',fn:context.emitDanmaku,owner:context,args:values});}},
    ...(typeof context.toRender==='function'?{toRender:{value:(...values:any[])=>{outputs.push({kind:'render',fn:context.toRender,owner:context,args:values});}}}:{}),
  });
  try { Object.defineProperty(owner,'add',descriptor?{...descriptor,value:screen}:{value:screen,configurable:true,writable:true}); }
  catch { return null; }
  let result:unknown, submitted=false;
  const submit=(packet:Data)=>{
    if(submitted)return; submitted=true;
    const text=packet.info[1], translated=text!==source.originalText;
    for(const output of outputs) {
      const values=[...output.args];
      if(translated&&output.kind==='screen') values[0]={...values[0],text};
      if(translated&&output.kind==='chat') values[0]=translatedPacket({...source,packet:values[0]},text);
      Reflect.apply(output.fn,output.owner,values);
    }
  };
  try { result=Reflect.apply(original,engine,[args[0],proxy,...args.slice(2)]); }
  catch(error) { submit(source.packet);throw error; }
  finally { if(owner.add===screen){if(descriptor)Object.defineProperty(owner,'add',descriptor);else delete owner.add;} }
  const valid=outputs.length>0&&outputs.every(output=>output.kind==='render'||output.kind==='screen'
    ? output.kind==='render'||output.args[0]&&typeof output.args[0]==='object'&&output.args[0].text===source.originalText
    : Array.isArray(output.args[0]?.info)&&output.args[0].info[1]===source.originalText);
  return { result, submit, translatable:valid };
}
