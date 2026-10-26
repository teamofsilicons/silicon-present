/**
 * GET /sandbox/html-edit: the page an HTML element is edited inside (components/editor/html-inside.tsx). It draws the
 * element's own html and css (never its JS: the element is edited as written, not as its scripts left it) with every
 * part numbered (lib/editor/html-inside.ts `markParts`), and tells the editor what the Carbon points at, drags and
 * types. The editor makes each change in the element's source; this page only shows it.
 *
 * The same sandbox as /sandbox/html: the editor frames it `sandbox="allow-scripts"` without allow-same-origin, so it
 * runs in an opaque origin and talks to the editor by postMessage only. Its policy runs one script, this page's own (by
 * its hash): the element's inline handlers, `javascript:` links and scripts never run here, and it parses the source
 * with DOMParser, which runs nothing, and drops <script>, <noscript> and <meta http-equiv> before showing it.
 *
 * Messages. Editor to page: `{type:"present:edit-doc", rev, base, css, html, selected}` (the marked html, the page
 * defaults, the element's css, the part to keep selected). Page to editor, each with the `rev` it shows:
 * `present:edit-ready`, `present:edit-select {part, info}`, `present:edit-typing {typing}`,
 * `present:edit-change {change}` (a move or a part's new text), `present:edit-key {key}` (Escape, Delete, undo, redo,
 * a nudge). The editor treats every one of them as untrusted.
 */
import { createHash } from "node:crypto";

export const dynamic = "force-static";

const SCRIPT = `(function(){
var P="data-sp-part",rev=-1,sel=null,hover=null,editing=null,drag=null,boxes=null;
var INLINE=/^(A|ABBR|B|BDI|BDO|BR|CITE|CODE|DATA|DFN|EM|I|KBD|MARK|Q|S|SAMP|SMALL|SPAN|STRONG|SUB|SUP|TIME|U|VAR|WBR|FONT|LABEL)$/;
function send(m){m.rev=rev;parent.postMessage(m,"*");}
function partOf(n){while(n&&n.nodeType!==1)n=n.parentNode;return n&&n.closest?n.closest("["+P+"]"):null;}
function num(el){return el?Number(el.getAttribute(P)):null;}
function isText(el){
  if(!el||el===document.body||el===document.documentElement||!/\\S/.test(el.textContent||""))return false;
  var all=el.querySelectorAll("*");
  for(var i=0;i<all.length;i++)if(!INLINE.test(all[i].tagName))return false;
  return true;
}
function textPart(el){while(el){if(isText(el))return el;el=el.parentElement?partOf(el.parentElement):null;}return null;}
function texts(root){var out=[];(function walk(n){for(var c=n.firstChild;c;c=c.nextSibling){if(c.nodeType===3)out.push(c.data);else if(c.nodeType===1&&!/^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT)$/.test(c.tagName))walk(c);}})(root);return out;}
function info(el){var cs=getComputedStyle(el);return{tag:el.tagName.toLowerCase(),text:isText(el),color:cs.color,background:cs.backgroundColor,fontSize:parseFloat(cs.fontSize)||0,fontWeight:cs.fontWeight,fontStyle:cs.fontStyle};}
function select(el){
  if(el===document.documentElement)el=null;
  if(el===sel)return;
  sel=el;
  send({type:"present:edit-select",part:num(el),info:el?info(el):null});
}
function translateOf(v){var m=/^(-?[\\d.]+)px(?:\\s+(-?[\\d.]+)px)?$/.exec(v||"");return m?[Number(m[1]),Number(m[2]||0)]:[0,0];}
function startEditing(el,x,y){
  if(editing)commit();
  select(el);editing=el;
  try{el.contentEditable="plaintext-only";}catch(_){el.contentEditable="true";}
  document.documentElement.setAttribute("data-sp-typing","");
  el.focus();
  var s=getSelection(),r=x!==undefined&&document.caretRangeFromPoint?document.caretRangeFromPoint(x,y):null;
  if(!r||!el.contains(r.startContainer)){r=document.createRange();r.selectNodeContents(el);r.collapse(false);}
  s.removeAllRanges();s.addRange(r);
  send({type:"present:edit-typing",typing:true});
}
function commit(){
  var el=editing;if(!el)return;editing=null;
  el.removeAttribute("contenteditable");
  document.documentElement.removeAttribute("data-sp-typing");
  var s=getSelection();if(s)s.removeAllRanges();
  send({type:"present:edit-change",change:{kind:"text",part:num(el),texts:texts(el)}});
  send({type:"present:edit-typing",typing:false});
}
function place(box,el){
  if(!el||!el.isConnected){box.style.display="none";return;}
  var r=el.getBoundingClientRect();
  box.style.display="block";box.style.left=r.left+"px";box.style.top=r.top+"px";box.style.width=r.width+"px";box.style.height=r.height+"px";
}
function tick(){if(boxes){place(boxes[0],sel);place(boxes[1],hover!==sel&&!drag?hover:null);}requestAnimationFrame(tick);}
function render(d){
  if(editing){editing.removeAttribute("contenteditable");editing=null;}
  var doc=new DOMParser().parseFromString("<!doctype html><html><head></head><body>"+d.html+"</body></html>","text/html");
  var drop=doc.querySelectorAll("script,noscript,meta[http-equiv]");
  for(var i=0;i<drop.length;i++)drop[i].remove();
  var styles=[d.base,d.css,"html:not([data-sp-typing]),html:not([data-sp-typing]) *{-webkit-user-select:none;user-select:none}[contenteditable]{outline:none;cursor:text}["+P+"]{cursor:default}"];
  for(var k=0;k<styles.length;k++){var st=doc.createElement("style");st.textContent=styles[k];doc.head.appendChild(st);}
  var root=document.importNode(doc.documentElement,true);
  document.replaceChild(root,document.documentElement);
  var layer=document.createElement("div");
  layer.setAttribute("style","position:fixed;inset:0;pointer-events:none;z-index:2147483647");
  boxes=[0,1].map(function(i){var b=document.createElement("div");b.setAttribute("style","position:fixed;display:none;box-sizing:border-box;pointer-events:none;"+(i?"outline:1px dashed rgba(31,95,184,.7)":"outline:2px solid #1F5FB8;outline-offset:1px"));layer.appendChild(b);return b;});
  root.appendChild(layer);
  rev=d.rev;hover=null;drag=null;
  var keep=typeof d.selected==="number"?document.querySelector("["+P+'="'+d.selected+'"]'):null;
  sel=undefined;select(keep);
}
addEventListener("message",function(e){
  if(e.source!==parent)return;
  var d=e.data;
  if(!d||d.type!=="present:edit-doc"||typeof d.rev!=="number"||typeof d.html!=="string"||typeof d.css!=="string"||typeof d.base!=="string")return;
  render(d);
});
document.addEventListener("pointerdown",function(e){
  if(e.button!==0)return;
  if(editing&&editing.contains(e.target))return;
  if(editing)commit();
  try{window.focus();}catch(_){}
  var el=partOf(e.target);
  if(!el||el===document.documentElement){select(null);return;}
  select(el);
  if(el===document.body)return;
  drag={el:el,id:e.pointerId,x:e.clientX,y:e.clientY,moved:false,base:el.style.translate||""};
  try{el.setPointerCapture(e.pointerId);}catch(_){}
},true);
document.addEventListener("pointermove",function(e){
  if(!drag){hover=partOf(e.target);if(hover===document.documentElement||hover===document.body)hover=null;return;}
  if(e.pointerId!==drag.id)return;
  var dx=e.clientX-drag.x,dy=e.clientY-drag.y;
  if(e.shiftKey){if(Math.abs(dx)>Math.abs(dy))dy=0;else dx=0;}
  if(!drag.moved&&Math.abs(dx)+Math.abs(dy)<4)return;
  drag.moved=true;drag.dx=dx;drag.dy=dy;
  var t=translateOf(drag.base);
  drag.el.style.translate=(t[0]+dx)+"px "+(t[1]+dy)+"px";
},true);
function endDrag(e,cancel){
  var d=drag;if(!d||e.pointerId!==d.id)return;drag=null;
  if(!d.moved)return;
  if(cancel){d.el.style.translate=d.base;return;}
  send({type:"present:edit-change",change:{kind:"move",part:num(d.el),dx:Math.round(d.dx*10)/10,dy:Math.round(d.dy*10)/10}});
}
document.addEventListener("pointerup",function(e){endDrag(e,false);},true);
document.addEventListener("pointercancel",function(e){endDrag(e,true);},true);
document.addEventListener("dblclick",function(e){
  var t=textPart(partOf(e.target));
  if(!t||editing===t)return;
  e.preventDefault();startEditing(t,e.clientX,e.clientY);
},true);
document.addEventListener("click",function(e){if(!editing||!editing.contains(e.target))e.preventDefault();},true);
document.addEventListener("dragstart",function(e){e.preventDefault();},true);
document.addEventListener("focusout",function(e){if(editing&&e.target===editing)commit();},true);
document.addEventListener("beforeinput",function(e){if(/^(format|insertParagraph$|insertFromDrop$)/.test(e.inputType))e.preventDefault();},true);
document.addEventListener("paste",function(e){if(!editing)return;e.preventDefault();var t=e.clipboardData?e.clipboardData.getData("text/plain"):"";if(t)document.execCommand("insertText",false,t);},true);
document.addEventListener("keydown",function(e){
  var mod=e.metaKey||e.ctrlKey,k=e.key;
  if(editing){
    if((k==="Enter"&&!e.shiftKey)||k==="Escape"){e.preventDefault();commit();}
    return;
  }
  if(mod&&(k==="z"||k==="Z")){e.preventDefault();send({type:"present:edit-key",key:e.shiftKey?"redo":"undo"});return;}
  if(mod&&(k==="y"||k==="Y")){e.preventDefault();send({type:"present:edit-key",key:"redo"});return;}
  if(mod||e.altKey)return;
  if(k==="Escape"){e.preventDefault();if(sel)select(null);else send({type:"present:edit-key",key:"Escape"});return;}
  if(!sel)return;
  if(k==="Delete"||k==="Backspace"){e.preventDefault();send({type:"present:edit-key",key:"Delete"});return;}
  if(k==="Enter"&&isText(sel)){e.preventDefault();startEditing(sel);return;}
  if(/^Arrow(Left|Right|Up|Down)$/.test(k)){e.preventDefault();send({type:"present:edit-key",key:k,shift:e.shiftKey});}
},true);
requestAnimationFrame(tick);
parent.postMessage({type:"present:edit-ready"},"*");
})();`;

const HASH = createHash("sha256").update(SCRIPT).digest("base64");

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:transparent}</style><script>${SCRIPT}</script></head><body></body></html>`;

export function GET() {
  return new Response(PAGE, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // Anything may load (images, fonts, stylesheets, as when the element runs); the only script is this page's.
      "Content-Security-Policy": `default-src * data: blob: 'unsafe-inline'; script-src 'sha256-${HASH}'; object-src 'none'; frame-ancestors 'self'`,
      "Cache-Control": "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}
