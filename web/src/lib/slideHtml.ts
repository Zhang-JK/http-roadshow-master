import type { DeckDoc } from '../types';

const baseCss = (w: number, h: number) => `
html,body{margin:0;padding:0;background:transparent;overflow:hidden}
.slide{width:${w}px;height:${h}px;position:relative;overflow:hidden;box-sizing:border-box;margin:0}
.slide *{box-sizing:border-box}`;

/**
 * Runs inside the preview iframe. Lets the user click (shift/ctrl/cmd for multi-select) or drag a
 * marquee to pick elements carrying data-eid, and reports the selection to the parent window.
 * Double-clicking an element that holds only text (and <br>) makes it editable in place; the typed
 * text goes to the parent (text-edit-commit), which saves it. Elements outside that rule must stay
 * in sync with plainText() in server/src/deck.ts.
 */
const SELECTION_SCRIPT = `
(function(){
  var slide=document.querySelector('section.slide');
  if(!slide) return;
  var layer=document.createElement('div');
  layer.setAttribute('data-rs-ui','1');
  layer.style.cssText='position:absolute;left:0;top:0;width:0;height:0;pointer-events:none;z-index:2147483647';
  document.body.appendChild(layer);
  function mk(css){var d=document.createElement('div');d.style.cssText='position:absolute;pointer-events:none;box-sizing:border-box;display:none;'+css;layer.appendChild(d);return d;}
  var hoverBox=mk('outline:3px dashed #f59e0b;background:rgba(245,158,11,.07)');
  var hoverTag=mk('background:#f59e0b;color:#111;font:600 20px/1.6 system-ui,sans-serif;padding:0 10px;border-radius:6px;white-space:nowrap');
  var marquee=mk('border:3px dashed #2563eb;background:rgba(37,99,235,.12)');
  var selected=[], boxes=[];
  function rectOf(el){var r=el.getBoundingClientRect();return {x:r.left+scrollX,y:r.top+scrollY,w:r.width,h:r.height};}
  function place(d,r){d.style.left=r.x+'px';d.style.top=r.y+'px';d.style.width=r.w+'px';d.style.height=r.h+'px';d.style.display='block';}
  function label(el){
    var t=el.tagName.toLowerCase();
    var names={h1:'标题',h2:'标题',h3:'小标题',h4:'小标题',p:'段落',ul:'列表',ol:'列表',li:'列表项',img:'图片',svg:'图表/图形',table:'表格',tr:'表格行',td:'单元格',th:'表头',span:'文字',a:'链接',button:'按钮',section:'整页',header:'页眉区',footer:'页脚区',figure:'图片区'};
    return names[t]||'区块';
  }
  var NOT_TEXT=/^(svg|math|textarea|select|option|script|style|noscript|template|iframe|object|canvas|video|audio)$/i;
  function textOnly(el){
    if(!el||el===slide||NOT_TEXT.test(el.tagName))return false;
    var has=false;
    for(var n=el.firstChild;n;n=n.nextSibling){
      if(n.nodeType===3){if(/\\S/.test(n.data))has=true;}
      else if(n.nodeType===1){if(n.tagName!=='BR')return false;}
      else if(n.nodeType!==8)return false;
    }
    return has;
  }
  function info(el){
    var r=el.getBoundingClientRect(), s=slide.getBoundingClientRect();
    var text=(el.innerText||el.textContent||'').replace(/\\s+/g,' ').trim().slice(0,80);
    return {eid:el.getAttribute('data-eid'),tag:el.tagName.toLowerCase(),cls:(el.getAttribute('class')||'').slice(0,80),text:text,label:label(el),isPage:el===slide,textOnly:textOnly(el),
      rect:{x:Math.round(r.left-s.left),y:Math.round(r.top-s.top),w:Math.round(r.width),h:Math.round(r.height)}};
  }
  var editing=null;
  function render(){
    boxes.forEach(function(b){b.remove();});
    boxes=[];
    selected.forEach(function(el,i){
      if(editing&&editing.el===el)return;
      var r=rectOf(el);
      var b=mk('outline:4px solid #2563eb;background:rgba(37,99,235,.10)');place(b,r);
      var n=mk('background:#2563eb;color:#fff;font:700 20px/1.5 system-ui,sans-serif;padding:0 9px;border-radius:6px');
      n.textContent=String(i+1);place(n,{x:r.x,y:Math.max(0,r.y-32),w:NaN,h:NaN});n.style.width='';n.style.height='';
      boxes.push(b,n);
    });
  }
  function post(msg){msg.source='rs-frame';parent.postMessage(msg,'*');}
  function emit(){render();post({type:'selection',items:selected.map(info)});}
  function pick(e){var t=e.target;if(!(t instanceof Element))return null;if(t.closest('[data-rs-ui]'))return null;return t.closest('[data-eid]');}
  function topLevel(list){return list.filter(function(el){return !list.some(function(o){return o!==el&&o.contains(el);});});}
  function readText(el){
    var keep=/^(pre|pre-wrap|pre-line|break-spaces)$/.test(getComputedStyle(el).whiteSpace), out='';
    (function walk(node){
      for(var n=node.firstChild;n;n=n.nextSibling){
        if(n.nodeType===3)out+=keep?n.data:n.data.replace(/[ \\t\\n\\r\\f]+/g,' ');
        else if(n.nodeType===1){
          if(n.tagName==='BR'){out+='\\n';continue;}
          var block=/^(DIV|P|LI|H[1-6])$/.test(n.tagName);
          if(block&&out&&out.slice(-1)!=='\\n')out+='\\n';
          walk(n);
          if(block)out+='\\n';
        }
      }
    })(el);
    return out.split('\\n').map(function(l){return l.replace(/[ \\t\\r\\f]+/g,' ').trim();}).join('\\n').replace(/^\\n+|\\n+$/g,'');
  }
  function caretAt(el,x,y){
    var sel=getSelection(),r=null;
    if(!sel)return;
    if(x!==undefined){
      if(document.caretRangeFromPoint)r=document.caretRangeFromPoint(x,y);
      else if(document.caretPositionFromPoint){var p=document.caretPositionFromPoint(x,y);if(p){r=document.createRange();r.setStart(p.offsetNode,p.offset);}}
      if(r&&!el.contains(r.startContainer))r=null;
    }
    if(!r){r=document.createRange();r.selectNodeContents(el);r.collapse(false);}
    sel.removeAllRanges();sel.addRange(r);
  }
  function onBlur(){finishEdit(true);}
  function startEdit(el,x,y){
    if(editing){if(editing.el===el)return;finishEdit(true);}
    selected=[el];
    if(!textOnly(el)){emit();if(el!==slide)post({type:'text-edit-denied',eid:el.getAttribute('data-eid'),label:label(el)});return;}
    editing={el:el,html:el.innerHTML,style:el.getAttribute('style'),before:readText(el)};
    var s=el.style;
    s.outline='3px solid #10b981';s.outlineOffset='4px';s.cursor='text';s.userSelect='text';s.webkitUserSelect='text';
    try{el.contentEditable='plaintext-only';}catch(_){}
    if(el.contentEditable!=='plaintext-only')el.contentEditable='true';
    hoverBox.style.display='none';hoverTag.style.display='none';
    emit();
    el.focus();
    caretAt(el,x,y);
    el.addEventListener('blur',onBlur);
    post({type:'text-edit-start',eid:el.getAttribute('data-eid')});
  }
  function finishEdit(save){
    var ed=editing;
    if(!ed)return;
    editing=null;
    var el=ed.el,text=readText(el),commit=save&&!!text&&text!==ed.before;
    el.removeEventListener('blur',onBlur);
    el.removeAttribute('contenteditable');
    if(ed.style===null)el.removeAttribute('style');else el.setAttribute('style',ed.style);
    if(!commit)el.innerHTML=ed.html;
    var gs=getSelection();if(gs)gs.removeAllRanges();
    emit();
    post({type:commit?'text-edit-commit':'text-edit-cancel',eid:el.getAttribute('data-eid'),pageId:slide.getAttribute('data-page-id'),text:text,oldText:ed.before,empty:save&&!text});
  }
  var down=null, dragging=false;
  document.addEventListener('dragstart',function(e){e.preventDefault();},true);
  document.addEventListener('drop',function(e){e.preventDefault();},true);
  document.addEventListener('mousedown',function(e){
    if(e.button!==0)return;
    if(editing){if(editing.el.contains(e.target))return;finishEdit(true);}
    var gs=getSelection();if(gs)gs.removeAllRanges();try{parent.getSelection().removeAllRanges();}catch(_){}down={x:e.pageX,y:e.pageY,add:e.shiftKey||e.ctrlKey||e.metaKey};dragging=false;e.preventDefault();
  });
  document.addEventListener('mousemove',function(e){
    if(down){
      var dx=e.pageX-down.x, dy=e.pageY-down.y;
      if(!dragging && Math.abs(dx)+Math.abs(dy)>8){dragging=true;hoverBox.style.display='none';hoverTag.style.display='none';}
      if(dragging){place(marquee,{x:Math.min(down.x,e.pageX),y:Math.min(down.y,e.pageY),w:Math.abs(dx),h:Math.abs(dy)});}
      return;
    }
    var el=pick(e);
    if(!el||(editing&&editing.el===el)){hoverBox.style.display='none';hoverTag.style.display='none';return;}
    var r=rectOf(el);place(hoverBox,r);
    hoverTag.textContent=label(el)+' <'+el.tagName.toLowerCase()+'>'+(textOnly(el)?' · 双击改字':'');
    place(hoverTag,{x:r.x,y:Math.max(0,r.y-34),w:NaN,h:NaN});hoverTag.style.width='';hoverTag.style.height='';
  });
  document.addEventListener('mouseup',function(e){
    if(!down)return;
    var add=down.add;
    if(dragging){
      var x1=Math.min(down.x,e.pageX),y1=Math.min(down.y,e.pageY),x2=Math.max(down.x,e.pageX),y2=Math.max(down.y,e.pageY);
      var hits=[].slice.call(slide.querySelectorAll('[data-eid]')).filter(function(el){
        var r=rectOf(el);return r.w>0&&r.h>0&&r.x>=x1-2&&r.y>=y1-2&&r.x+r.w<=x2+2&&r.y+r.h<=y2+2;
      });
      hits=topLevel(hits);
      selected=add?topLevel(selected.concat(hits.filter(function(h){return selected.indexOf(h)<0;}))):hits;
      marquee.style.display='none';
    } else {
      var el=pick(e);
      if(el){
        var i=selected.indexOf(el);
        if(add){ if(i>=0) selected.splice(i,1); else selected=topLevel(selected.concat([el])); }
        else selected=(i>=0&&selected.length===1)?[]:[el];
      } else if(!add) selected=[];
    }
    down=null;dragging=false;emit();
  });
  document.addEventListener('click',function(e){e.preventDefault();},true);
  document.addEventListener('dblclick',function(e){
    if(editing&&editing.el.contains(e.target))return;
    if(e.shiftKey||e.ctrlKey||e.metaKey)return;
    var el=pick(e);
    if(el)startEdit(el,e.clientX,e.clientY);
  });
  document.addEventListener('keydown',function(e){
    if(editing){
      if(e.key==='Escape'){e.preventDefault();finishEdit(false);}
      else if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing&&e.keyCode!==229){e.preventDefault();finishEdit(true);}
      return;
    }
    if(e.key==='Escape'){selected=[];emit();}
  });
  document.addEventListener('paste',function(e){
    if(!editing)return;
    e.preventDefault();
    var t=(e.clipboardData&&e.clipboardData.getData('text/plain'))||'';
    if(t)document.execCommand('insertText',false,t);
  });
  document.addEventListener('beforeinput',function(e){if(editing&&/^format/.test(e.inputType))e.preventDefault();});
  window.addEventListener('message',function(e){
    var d=e.data||{};
    if(d.type==='rs-edit-text'){var t=slide.querySelector('[data-eid="'+d.eid+'"]');if(t)startEdit(t);}
    if(d.type==='rs-text-commit')finishEdit(true);
    if(d.type==='rs-text-cancel')finishEdit(false);
    if(d.type==='rs-set-selection'){selected=(d.eids||[]).map(function(id){return slide.querySelector('[data-eid="'+id+'"]')||(slide.getAttribute('data-eid')===id?slide:null);}).filter(Boolean);emit();}
    if(d.type==='rs-select-parent'){selected=topLevel(selected.map(function(el){var p=el.parentElement&&el.parentElement.closest('[data-eid]');return p||el;}).filter(function(v,i,a){return a.indexOf(v)===i;}));emit();}
    if(d.type==='rs-flash'){var el=slide.querySelector('[data-eid="'+d.eid+'"]');if(el){var b=mk('outline:5px solid #ec4899;background:rgba(236,72,153,.15);transition:opacity 1.2s');place(b,rectOf(el));setTimeout(function(){b.style.opacity='0';},900);setTimeout(function(){b.remove();},2200);}}
  });
  var init=window.__RS_INIT||[];
  if(init.length){selected=init.map(function(id){return slide.querySelector('[data-eid="'+id+'"]')||(slide.getAttribute('data-eid')===id?slide:null);}).filter(Boolean);}
  window.addEventListener('load',function(){emit();});
  setTimeout(emit,50);
})();`;

export function pageHtml(doc: DeckDoc, pageId: string, opts: { editor?: boolean; initialSelection?: string[] } = {}): string {
  const page = doc.pages.find((p) => p.id === pageId) ?? doc.pages[0];
  const script = opts.editor
    ? `<script>window.__RS_INIT=${JSON.stringify(opts.initialSelection ?? [])};</script><script>${SELECTION_SCRIPT}</script>
<style>body{cursor:crosshair;user-select:none;-webkit-user-select:none}</style>`
    : '';
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><base href="${location.origin}/">
${doc.head}
<style>${baseCss(doc.width, doc.height)}</style>
<style>${doc.css}</style>
</head><body>${page?.html ?? ''}${script}</body></html>`;
}
