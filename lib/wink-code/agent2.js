// @ts-nocheck
// Ported from team/0.2.2/deck-v2/agent-v2.js (app-design), unchanged in its drawing: the agent family's renderer (design-system v2, FIXES.md section 3).
/* Agent avatar v2.1: the blob made crisp, then made distinguishable. One body family, one light, one rim, one stroke weight (2.6); each seed picks from small fixed sets,
   so a dozen agents differ by silhouette and face and not only by colour (colour-blind safe): body 2 proportions x 2 roundness, 4 eye styles, 3 mouths, 3 marks, 8 colours. */
export function agentV2(seed,size,th){
 var h=2166136261,s='agent2:'+seed;for(var i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619)}
 var rnd=function(){h^=h<<13;h^=h>>>17;h^=h<<5;h>>>=0;return h/4294967296};
 var pick=function(a){return a[Math.floor(rnd()*a.length)]};
 var P=['#F2A58C','#F3C970','#86D0BB','#E39A5B','#E897C0','#CDBF9B','#EE9494','#93D2B0'];
 var col=pick(P);
 function mix(hex,t,to){var n=parseInt(hex.slice(1),16),r=n>>16,g=n>>8&255,b=n&255,tr=to==='w'?255:0;return '#'+[r,g,b].map(function(c){return Math.round(c+(tr-c)*t).toString(16).padStart(2,'0')}).join('')}
 var ink='#1C1A17',rim=mix(col,.28),hi=mix(col,.14,'w'),lo=mix(col,.06);
 var tall=rnd()<.5,sq=rnd()<.5,eyes=pick(['round','big','sleepy','happy']),mouth=pick(['smile','grin','smirk']),mark=pick(['none','blush','brow']);
 var n=sq?3.4:2.2,sx=tall?40:48,sy=tall?47:40,cx=60,cy=60,pts=[];
 for(var k=0;k<72;k++){var a=k/72*Math.PI*2,c=Math.cos(a),sn=Math.sin(a);var r=Math.pow(Math.pow(Math.abs(c),n)+Math.pow(Math.abs(sn),n),-1/n);pts.push((cx+c*r*sx).toFixed(2)+' '+(cy+sn*r*sy).toFixed(2))}
 var d='M'+pts.join(' L')+'Z',id='a'+seed.replace(/[^a-z0-9]/gi,'');
 var ex=tall?13:16,ey=cy-6;
 var eye=function(x){
  if(eyes==='sleepy')return '<path d="M'+(x-5.5)+' '+ey+' Q'+x+' '+(ey+5.5)+' '+(x+5.5)+' '+ey+'" fill="none" stroke="'+ink+'" stroke-width="2.8" stroke-linecap="round"/>';
  if(eyes==='happy')return '<path d="M'+(x-5.5)+' '+(ey+2)+' Q'+x+' '+(ey-5)+' '+(x+5.5)+' '+(ey+2)+'" fill="none" stroke="'+ink+'" stroke-width="2.8" stroke-linecap="round"/>';
  var big=eyes==='big';return '<ellipse cx="'+x+'" cy="'+ey+'" rx="'+(big?6:4)+'" ry="'+(big?7:5.2)+'" fill="'+ink+'"/><circle cx="'+(x+(big?2:1.4))+'" cy="'+(ey-(big?2.4:1.8))+'" r="'+(big?2:1.4)+'" fill="#fff" opacity=".92"/>'};
 var my=cy+11,m=mouth==='grin'?'<path d="M'+(cx-9)+' '+(my-3)+' Q'+cx+' '+(my-3)+' '+(cx+9)+' '+(my-3)+' Q'+cx+' '+(my+11)+' '+(cx-9)+' '+(my-3)+'Z" fill="'+ink+'" stroke="'+ink+'" stroke-width="2" stroke-linejoin="round"/>'
  :mouth==='smirk'?'<path d="M'+(cx-7)+' '+(my+1)+' Q'+(cx+2)+' '+(my+1)+' '+(cx+8)+' '+(my-4)+'" fill="none" stroke="'+ink+'" stroke-width="2.8" stroke-linecap="round"/>'
  :'<path d="M'+(cx-7)+' '+my+' Q'+cx+' '+(my+6)+' '+(cx+7)+' '+my+'" fill="none" stroke="'+ink+'" stroke-width="2.8" stroke-linecap="round"/>';
 var mk=mark==='blush'?'<circle cx="'+(cx-ex-5)+'" cy="'+(my-3)+'" r="4.2" fill="#E8604C" opacity=".38"/><circle cx="'+(cx+ex+5)+'" cy="'+(my-3)+'" r="4.2" fill="#E8604C" opacity=".38"/>'
  :mark==='brow'?'<path d="M'+(cx-ex-5)+' '+(ey-12)+' L'+(cx-ex+5)+' '+(ey-13.5)+' M'+(cx+ex-5)+' '+(ey-13.5)+' L'+(cx+ex+5)+' '+(ey-12)+'" fill="none" stroke="'+ink+'" stroke-width="2.8" stroke-linecap="round"/>':'';
 return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="'+size+'" height="'+size+'"><defs><linearGradient id="'+id+'" x1="0" y1="0" x2=".8" y2="1"><stop offset="0" stop-color="'+hi+'"/><stop offset=".55" stop-color="'+col+'"/><stop offset="1" stop-color="'+lo+'"/></linearGradient></defs><path d="'+d+'" fill="url(#'+id+')" stroke="'+rim+'" stroke-width="2.6" stroke-linejoin="round"/>'+mk+eye(cx-ex)+eye(cx+ex)+m+'</svg>'}
