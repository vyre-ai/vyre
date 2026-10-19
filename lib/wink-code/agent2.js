// @ts-nocheck
// Ported from team/0.2.2/deck-v2/agent-v2.js (app-design), unchanged in its drawing: the agent family's renderer (design-system v2, FIXES.md section 3).
/* Agent avatar v2.1: the blob made crisp, then made distinguishable. One body family, one light, one rim, one stroke weight (2.6); each seed picks from small fixed sets,
   so a dozen agents differ by silhouette and face and not only by colour (colour-blind safe): body 2 proportions x 2 roundness, 4 eye styles, 3 mouths, 3 marks, 8 colours. */
/* The sixteen body colours. A seed that ends in ~c0 to ~c15 takes that colour; the rest of the drawing still comes from the seed before it, so one shape can be seen in any colour.
   The first eight are the original colours and keep their numbers (an agent made before c8 to c15 existed is drawn as it was, and a seed with no colour still picks only from those eight).
   c8 to c15 are soft too, from the owner's ask (19 Oct): blue, deep indigo, violet, a deeper teal, coral, mint, sky and graphite. */
export var AGENT_COLORS=['#F2A58C','#F3C970','#86D0BB','#E39A5B','#E897C0','#CDBF9B','#EE9494','#93D2B0','#7FA6F2','#7A78D6','#B08CEB','#3FA699','#F28274','#A9E5CF','#8DCBF0','#8E95A3'];
export function agentV2(seed,size,th){
 var full=seed,tm=/(~c(1[0-5]|[0-9]))?(~e([0-5]))?(~m([0-4]))?(~t([0-6]))?(~b([01]))?(~h([0-5]))?$/.exec(seed),cm=tm&&tm[2]!==undefined?[tm[1],tm[2]]:null;if(tm)seed=seed.slice(0,seed.length-tm[0].length);
 /* the character a look may carry after its shape and colour: eyes ~e0-5, mouth ~m0-4, top ~t0-6, blush ~b0|1, charm ~h0-5. A part it does not name is drawn as before. */
 var part=function(i){return tm&&tm[i]!==undefined?+tm[i]:-1},PE=part(4),PM=part(6),PT=part(8),PB=part(10),PH=part(12);
 var h=2166136261,s='agent2:'+seed;for(var i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619)}
 var rnd=function(){h^=h<<13;h^=h>>>17;h^=h<<5;h>>>=0;return h/4294967296};
 var pick=function(a){return a[Math.floor(rnd()*a.length)]};
 var P=AGENT_COLORS;
 var col=pick(P.slice(0,8));if(cm)col=P[+cm[1]];
 function mix(hex,t,to){var n=parseInt(hex.slice(1),16),r=n>>16,g=n>>8&255,b=n&255,tr=to==='w'?255:0;return '#'+[r,g,b].map(function(c){return Math.round(c+(tr-c)*t).toString(16).padStart(2,'0')}).join('')}
 var ink='#1C1A17',rim=mix(col,.28),hi=mix(col,.14,'w'),lo=mix(col,.06);
 var tall=rnd()<.5,sq=rnd()<.5,eyes=pick(['round','big','sleepy','happy']),mouth=pick(['smile','grin','smirk']),mark=pick(['none','blush','brow']);
 if(PE>=0)eyes=['round','big','sleepy','happy','wink','wide'][PE];if(PM>=0)mouth=['smile','grin','smirk','o','cat'][PM];if(PB>=0)mark=PB?'blush':'none';
 var n=sq?3.4:2.2,sx=tall?40:48,sy=tall?47:40,cx=60,cy=60,pts=[];
 for(var k=0;k<72;k++){var a=k/72*Math.PI*2,c=Math.cos(a),sn=Math.sin(a);var r=Math.pow(Math.pow(Math.abs(c),n)+Math.pow(Math.abs(sn),n),-1/n);pts.push((cx+c*r*sx).toFixed(2)+' '+(cy+sn*r*sy).toFixed(2))}
 var d='M'+pts.join(' L')+'Z',id='a'+full.replace(/[^a-z0-9]/gi,'');
 var ex=tall?13:16,ey=cy-6;
 var eye=function(x){
  var rt=x>cx,e=eyes==='wink'?(rt?'happy':'round'):eyes;
  if(e==='wide')return '<circle cx="'+x+'" cy="'+ey+'" r="7" fill="#fff"/><circle cx="'+(x+1)+'" cy="'+(ey+1)+'" r="3.8" fill="'+ink+'"/>';
  if(e==='sleepy')return '<path d="M'+(x-5.5)+' '+ey+' Q'+x+' '+(ey+5.5)+' '+(x+5.5)+' '+ey+'" fill="none" stroke="'+ink+'" stroke-width="2.8" stroke-linecap="round"/>';
  if(e==='happy')return '<path d="M'+(x-5.5)+' '+(ey+2)+' Q'+x+' '+(ey-5)+' '+(x+5.5)+' '+(ey+2)+'" fill="none" stroke="'+ink+'" stroke-width="2.8" stroke-linecap="round"/>';
  var big=e==='big';return '<ellipse cx="'+x+'" cy="'+ey+'" rx="'+(big?6:4)+'" ry="'+(big?7:5.2)+'" fill="'+ink+'"/><circle cx="'+(x+(big?2:1.4))+'" cy="'+(ey-(big?2.4:1.8))+'" r="'+(big?2:1.4)+'" fill="#fff" opacity=".92"/>'};
 var my=cy+11,m=mouth==='grin'?'<path d="M'+(cx-9)+' '+(my-3)+' Q'+cx+' '+(my-3)+' '+(cx+9)+' '+(my-3)+' Q'+cx+' '+(my+11)+' '+(cx-9)+' '+(my-3)+'Z" fill="'+ink+'" stroke="'+ink+'" stroke-width="2" stroke-linejoin="round"/>'
  :mouth==='o'?'<ellipse cx="'+cx+'" cy="'+(my+1)+'" rx="4" ry="5" fill="'+ink+'"/>'
  :mouth==='cat'?'<path d="M'+(cx-7)+' '+my+' Q'+(cx-3.5)+' '+(my+4)+' '+cx+' '+my+' Q'+(cx+3.5)+' '+(my+4)+' '+(cx+7)+' '+my+'" fill="none" stroke="'+ink+'" stroke-width="2.8" stroke-linecap="round"/>'
  :mouth==='smirk'?'<path d="M'+(cx-7)+' '+(my+1)+' Q'+(cx+2)+' '+(my+1)+' '+(cx+8)+' '+(my-4)+'" fill="none" stroke="'+ink+'" stroke-width="2.8" stroke-linecap="round"/>'
  :'<path d="M'+(cx-7)+' '+my+' Q'+cx+' '+(my+6)+' '+(cx+7)+' '+my+'" fill="none" stroke="'+ink+'" stroke-width="2.8" stroke-linecap="round"/>';
 var mk=mark==='blush'?'<circle cx="'+(cx-ex-5)+'" cy="'+(my-3)+'" r="4.2" fill="#E8604C" opacity=".38"/><circle cx="'+(cx+ex+5)+'" cy="'+(my-3)+'" r="4.2" fill="#E8604C" opacity=".38"/>'
  :mark==='brow'?'<path d="M'+(cx-ex-5)+' '+(ey-12)+' L'+(cx-ex+5)+' '+(ey-13.5)+' M'+(cx+ex-5)+' '+(ey-13.5)+' L'+(cx+ex+5)+' '+(ey-12)+'" fill="none" stroke="'+ink+'" stroke-width="2.8" stroke-linecap="round"/>':'';
 var ty=cy-sy,lo2=mix(col,.3),tp=[
  '',
  '<path d="M60 '+(ty+2)+' V'+(ty-9)+'" stroke="'+rim+'" stroke-width="3" stroke-linecap="round"/><circle cx="60" cy="'+(ty-12)+'" r="5" fill="#B8A4FF"/>',
  '<path d="M60 '+(ty+2)+'c-2-10 4-16 13-16-1 9-6 15-13 16z" fill="#7FB069"/><path d="M60 '+(ty+2)+'c2-6 6-10 11-13" stroke="#5E8F4E" stroke-width="1.5" fill="none"/>',
  '<path d="M54 '+(ty+2)+'q2-12 6-2q3-12 6 2" stroke="'+lo2+'" stroke-width="3" fill="none" stroke-linecap="round"/>',
  '<path d="M60 '+(ty+1)+'l-12-7v14zM60 '+(ty+1)+'l12-7v14z" fill="#E8857A"/><circle cx="60" cy="'+(ty+1)+'" r="3.5" fill="#D06B60"/>',
  '<path d="M44 '+(ty+8)+'Q60 '+(ty-14)+' 76 '+(ty+8)+'z" fill="#5B6B8C"/><rect x="42" y="'+(ty+5)+'" width="36" height="5" rx="2.5" fill="#46557A"/>',
  '<path d="M60 '+(ty+2)+'V'+(ty-5)+'" stroke="#5E8F4E" stroke-width="2.6" stroke-linecap="round"/><path d="M60 '+(ty-5)+'c-1-7-8-8-12-6 1 6 6 8 12 6zM60 '+(ty-5)+'c1-7 8-8 12-6-1 6-6 8-12 6z" fill="#7FB069"/>'
 ][PT>0?PT:0],
 cx2=cx+sx*.62,cy2=cy+sy*.62,ch=[
  '',
  '<path d="M'+cx2+' '+(cy2-7)+'l2.2 4.8 5.2.6-3.9 3.5 1.1 5.2-4.6-2.7-4.6 2.7 1.1-5.2-3.9-3.5 5.2-.6z" fill="#F3C970" stroke="'+rim+'" stroke-width="1.2" stroke-linejoin="round"/>',
  '<path d="M'+cx2+' '+(cy2+6)+'c-9-6-9-12-4.5-12.5 2.5-.3 4.5 1.5 4.5 3.5 0-2 2-3.8 4.5-3.5 4.5.5 4.5 6.5-4.5 12.5z" fill="#E8857A" stroke="'+rim+'" stroke-width="1.2" stroke-linejoin="round"/>',
  '<path d="M'+(cx2+1)+' '+(cy2-8)+'l-6 9h4.5l-2 8 7-10.5h-4.6z" fill="#B8A4FF" stroke="'+rim+'" stroke-width="1.2" stroke-linejoin="round"/>',
  '<path d="M'+(cx2+3)+' '+(cy2-7)+'a7 7 0 1 0 3 12.5 6 6 0 0 1-3-12.5z" fill="#F3E3A0" stroke="'+rim+'" stroke-width="1.2" stroke-linejoin="round"/>',
  '<path d="M'+cx2+' '+(cy2-8)+'c4 5 6 8 6 11a6 6 0 0 1-12 0c0-3 2-6 6-11z" fill="#8CC8E8" stroke="'+rim+'" stroke-width="1.2" stroke-linejoin="round"/>'
 ][PH>0?PH:0];
 return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="'+size+'" height="'+size+'"><defs><linearGradient id="'+id+'" x1="0" y1="0" x2=".8" y2="1"><stop offset="0" stop-color="'+hi+'"/><stop offset=".55" stop-color="'+col+'"/><stop offset="1" stop-color="'+lo+'"/></linearGradient></defs>'+tp+'<path d="'+d+'" fill="url(#'+id+')" stroke="'+rim+'" stroke-width="2.6" stroke-linejoin="round"/>'+mk+eye(cx-ex)+eye(cx+ex)+m+ch+'</svg>'}
