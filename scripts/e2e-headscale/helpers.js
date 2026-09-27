var T=(sel,text)=>{const e=document.querySelector(sel);e.focus();const d=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(e),"value");d.set.call(e,text);e.dispatchEvent(new Event("input",{bubbles:true}));e.dispatchEvent(new Event("change",{bubbles:true}));return e.value};
var C=(text)=>{const b=[...document.querySelectorAll("button,a")].filter(e=>e.offsetParent&&e.innerText.trim().toLowerCase()===text.toLowerCase());if(!b.length)return "no button "+text;b[0].click();return "clicked "+text+(b[0].disabled?" (disabled)":"")};
var V=()=>document.body.innerText;
var W=ms=>new Promise(r=>setTimeout(r,ms));
var CTL=()=>JSON.stringify([...document.querySelectorAll("input,button,textarea,select")].filter(e=>e.offsetParent).map(e=>[e.tagName,e.id||e.name,(e.innerText||e.placeholder||"").trim().slice(0,40),e.disabled?"disabled":""]));
