import {MAX_FILE_BYTES} from './study.js';
import {fingerprintUpload} from './material-dedup.mjs';

const imageTypes={'image/png':'png','image/jpeg':'jpg','image/webp':'webp'};
const extensions={png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp'};
export const MATERIAL_ACCEPT='.pdf,.docx,.txt,.md,.png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp';
export function imageMimeType(file){return imageTypes[file?.type]?file.type:extensions[file?.name?.split('.').pop()?.toLowerCase()]||null;}

export async function readImageMaterial(file,{arrayBuffer,testId,fingerprint,signal}={}){
  signal?.throwIfAborted();
  if(file.size>MAX_FILE_BYTES)throw Error('This file is larger than 20 MB.');
  const mime=imageMimeType(file);
  if(!mime)throw Error('Use PNG, JPEG, or WebP images.');
  if(typeof testId!=='string'||!testId)throw Error('Open a test before adding an image.');
  const bytes=arrayBuffer||await file.arrayBuffer();
  if(bytes.byteLength>MAX_FILE_BYTES)throw Error('This file is larger than 20 MB.');
  if(!bytes.byteLength)throw Error('This image is empty.');
  const digest=fingerprint||await fingerprintUpload(bytes);
  signal?.throwIfAborted();
  // Keep pixels in the browser's local library. No upload, OCR, or model call.
  return {id:`img-${digest}`,fingerprint:digest,name:file.name,type:imageTypes[mime],size:bytes.byteLength,text:'Local image preview; not analyzed.',extraction:{kind:'local-image',textOrigin:'local-placeholder'},originalImage:new Blob([bytes],{type:mime})};
}

// Paste is an explicit user gesture. Never read the clipboard proactively or
// take over a normal paste into a form field or rich-text editor.
export function pastedImageFiles(event,{now=new Date()}={}){
  if(event.target?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"])'))return [];
  const clipboard=event.clipboardData;
  if(!clipboard)return [];
  const files=Array.from(clipboard.items||[]).filter(item=>item.kind==='file'&&item.type.startsWith('image/')).map(item=>item.getAsFile()).filter(Boolean);
  if(!files.length)files.push(...Array.from(clipboard.files||[]).filter(file=>file.type.startsWith('image/')));
  return files.map((file,index)=>{
    const mime=imageMimeType(file);
    if(!mime||file.name&&/\.(png|jpe?g|webp)$/i.test(file.name)&&file.name!=='image.png')return file;
    const stamp=now.toISOString().replace(/[:.]/g,'-');
    return new File([file],`Screenshot ${stamp}${index?` ${index+1}`:''}.${imageTypes[mime]}`,{type:mime,lastModified:file.lastModified||now.getTime()});
  });
}
