var _v="160",xv={LEFT:0,MIDDLE:1,RIGHT:2,ROTATE:0,DOLLY:1,PAN:2},vv={ROTATE:0,PAN:1,DOLLY_PAN:2,DOLLY_ROTATE:3},cf=0,Ml=1,lf=2,yv=3,Mv=0,Rd=1,hf=2,vn=3,Wn=0,He=1,Mn=2,Sv=2,zn=0,Ki=1,Sl=2,bl=3,El=4,uf=5,oi=100,df=101,ff=102,Al=103,Tl=104,pf=200,mf=201,gf=202,_f=203,wo=204,Ro=205,xf=206,vf=207,yf=208,Mf=209,Sf=210,bf=211,Ef=212,Af=213,Tf=214,wf=0,Rf=1,Cf=2,Gr=3,Pf=4,Lf=5,If=6,Uf=7,Pa=0,Df=1,Nf=2,Vn=0,Of=1,Ff=2,Bf=3,zf=4,Vf=5,kf=6,wl="attached",Hf="detached",rl=300,Xn=301,mi=302,Wr=303,Xr=304,Ys=306,qr=1e3,Fe=1001,Yr=1002,pe=1003,Co=1004,bv=1004,Hr=1005,Ev=1005,me=1006,Cd=1007,Av=1007,gi=1008,Tv=1008,kn=1009,Gf=1010,Wf=1011,al=1012,Pd=1013,Nn=1014,cn=1015,Is=1016,Ld=1017,Id=1018,ui=1020,Xf=1021,qe=1023,qf=1024,Yf=1025,di=1026,ts=1027,Zf=1028,Ud=1029,Jf=1030,Dd=1031,Nd=1033,Ba=33776,za=33777,Va=33778,ka=33779,Rl=35840,Cl=35841,Pl=35842,Ll=35843,Od=36196,Il=37492,Ul=37496,Dl=37808,Nl=37809,Ol=37810,Fl=37811,Bl=37812,zl=37813,Vl=37814,kl=37815,Hl=37816,Gl=37817,Wl=37818,Xl=37819,ql=37820,Yl=37821,Ha=36492,Zl=36494,Jl=36495,$f=36283,$l=36284,Kl=36285,Ql=36286,Kf=2200,Qf=2201,jf=2202,Zr=2300,Jr=2301,Ga=2302,Xi=2400,qi=2401,$r=2402,ol=2500,Fd=2501,wv=0,Rv=1,Cv=2,Bd=3e3,fi=3001,tp=3200,ep=3201,Si=0,np=1,$e="",Se="srgb",En="srgb-linear",cl="display-p3",La="display-p3-linear",Kr="linear",se="srgb",Qr="rec709",jr="p3",Pv=0,bi=7680,Lv=7681,Iv=7682,Uv=7683,Dv=34055,Nv=34056,Ov=5386,Fv=512,Bv=513,zv=514,Vv=515,kv=516,Hv=517,Gv=518,jl=519,ip=512,sp=513,rp=514,zd=515,ap=516,op=517,cp=518,lp=519,ta=35044,Wv=35048,Xv=35040,qv=35045,Yv=35049,Zv=35041,Jv=35046,$v=35050,Kv=35042,Qv="100",th="300 es",Po=1035,ln=2e3,Us=2001,hn=class{addEventListener(t,e){this._listeners===void 0&&(this._listeners={});let n=this._listeners;n[t]===void 0&&(n[t]=[]),n[t].indexOf(e)===-1&&n[t].push(e)}hasEventListener(t,e){if(this._listeners===void 0)return!1;let n=this._listeners;return n[t]!==void 0&&n[t].indexOf(e)!==-1}removeEventListener(t,e){if(this._listeners===void 0)return;let i=this._listeners[t];if(i!==void 0){let s=i.indexOf(e);s!==-1&&i.splice(s,1)}}dispatchEvent(t){if(this._listeners===void 0)return;let n=this._listeners[t.type];if(n!==void 0){t.target=this;let i=n.slice(0);for(let s=0,a=i.length;s<a;s++)i[s].call(this,t);t.target=null}}},Re=["00","01","02","03","04","05","06","07","08","09","0a","0b","0c","0d","0e","0f","10","11","12","13","14","15","16","17","18","19","1a","1b","1c","1d","1e","1f","20","21","22","23","24","25","26","27","28","29","2a","2b","2c","2d","2e","2f","30","31","32","33","34","35","36","37","38","39","3a","3b","3c","3d","3e","3f","40","41","42","43","44","45","46","47","48","49","4a","4b","4c","4d","4e","4f","50","51","52","53","54","55","56","57","58","59","5a","5b","5c","5d","5e","5f","60","61","62","63","64","65","66","67","68","69","6a","6b","6c","6d","6e","6f","70","71","72","73","74","75","76","77","78","79","7a","7b","7c","7d","7e","7f","80","81","82","83","84","85","86","87","88","89","8a","8b","8c","8d","8e","8f","90","91","92","93","94","95","96","97","98","99","9a","9b","9c","9d","9e","9f","a0","a1","a2","a3","a4","a5","a6","a7","a8","a9","aa","ab","ac","ad","ae","af","b0","b1","b2","b3","b4","b5","b6","b7","b8","b9","ba","bb","bc","bd","be","bf","c0","c1","c2","c3","c4","c5","c6","c7","c8","c9","ca","cb","cc","cd","ce","cf","d0","d1","d2","d3","d4","d5","d6","d7","d8","d9","da","db","dc","dd","de","df","e0","e1","e2","e3","e4","e5","e6","e7","e8","e9","ea","eb","ec","ed","ee","ef","f0","f1","f2","f3","f4","f5","f6","f7","f8","f9","fa","fb","fc","fd","fe","ff"],eh=1234567,pi=Math.PI/180,es=180/Math.PI;function Ye(){let r=Math.random()*4294967295|0,t=Math.random()*4294967295|0,e=Math.random()*4294967295|0,n=Math.random()*4294967295|0;return(Re[r&255]+Re[r>>8&255]+Re[r>>16&255]+Re[r>>24&255]+"-"+Re[t&255]+Re[t>>8&255]+"-"+Re[t>>16&15|64]+Re[t>>24&255]+"-"+Re[e&63|128]+Re[e>>8&255]+"-"+Re[e>>16&255]+Re[e>>24&255]+Re[n&255]+Re[n>>8&255]+Re[n>>16&255]+Re[n>>24&255]).toLowerCase()}function he(r,t,e){return Math.max(t,Math.min(e,r))}function ll(r,t){return(r%t+t)%t}function hp(r,t,e,n,i){return n+(r-t)*(i-n)/(e-t)}function up(r,t,e){return r!==t?(e-r)/(t-r):0}function ws(r,t,e){return(1-e)*r+e*t}function dp(r,t,e,n){return ws(r,t,1-Math.exp(-e*n))}function fp(r,t=1){return t-Math.abs(ll(r,t*2)-t)}function pp(r,t,e){return r<=t?0:r>=e?1:(r=(r-t)/(e-t),r*r*(3-2*r))}function mp(r,t,e){return r<=t?0:r>=e?1:(r=(r-t)/(e-t),r*r*r*(r*(r*6-15)+10))}function gp(r,t){return r+Math.floor(Math.random()*(t-r+1))}function _p(r,t){return r+Math.random()*(t-r)}function xp(r){return r*(.5-Math.random())}function vp(r){r!==void 0&&(eh=r);let t=eh+=1831565813;return t=Math.imul(t^t>>>15,t|1),t^=t+Math.imul(t^t>>>7,t|61),((t^t>>>14)>>>0)/4294967296}function yp(r){return r*pi}function Mp(r){return r*es}function Lo(r){return(r&r-1)===0&&r!==0}function Sp(r){return Math.pow(2,Math.ceil(Math.log(r)/Math.LN2))}function ea(r){return Math.pow(2,Math.floor(Math.log(r)/Math.LN2))}function bp(r,t,e,n,i){let s=Math.cos,a=Math.sin,o=s(e/2),c=a(e/2),l=s((t+n)/2),h=a((t+n)/2),u=s((t-n)/2),d=a((t-n)/2),f=s((n-t)/2),m=a((n-t)/2);switch(i){case"XYX":r.set(o*h,c*u,c*d,o*l);break;case"YZY":r.set(c*d,o*h,c*u,o*l);break;case"ZXZ":r.set(c*u,c*d,o*h,o*l);break;case"XZX":r.set(o*h,c*m,c*f,o*l);break;case"YXY":r.set(c*f,o*h,c*m,o*l);break;case"ZYZ":r.set(c*m,c*f,o*h,o*l);break;default:console.warn("THREE.MathUtils: .setQuaternionFromProperEuler() encountered an unknown order: "+i)}}function ke(r,t){switch(t.constructor){case Float32Array:return r;case Uint32Array:return r/4294967295;case Uint16Array:return r/65535;case Uint8Array:return r/255;case Int32Array:return Math.max(r/2147483647,-1);case Int16Array:return Math.max(r/32767,-1);case Int8Array:return Math.max(r/127,-1);default:throw new Error("Invalid component type.")}}function zt(r,t){switch(t.constructor){case Float32Array:return r;case Uint32Array:return Math.round(r*4294967295);case Uint16Array:return Math.round(r*65535);case Uint8Array:return Math.round(r*255);case Int32Array:return Math.round(r*2147483647);case Int16Array:return Math.round(r*32767);case Int8Array:return Math.round(r*127);default:throw new Error("Invalid component type.")}}var jv={DEG2RAD:pi,RAD2DEG:es,generateUUID:Ye,clamp:he,euclideanModulo:ll,mapLinear:hp,inverseLerp:up,lerp:ws,damp:dp,pingpong:fp,smoothstep:pp,smootherstep:mp,randInt:gp,randFloat:_p,randFloatSpread:xp,seededRandom:vp,degToRad:yp,radToDeg:Mp,isPowerOfTwo:Lo,ceilPowerOfTwo:Sp,floorPowerOfTwo:ea,setQuaternionFromProperEuler:bp,normalize:zt,denormalize:ke},Z=class r{constructor(t=0,e=0){r.prototype.isVector2=!0,this.x=t,this.y=e}get width(){return this.x}set width(t){this.x=t}get height(){return this.y}set height(t){this.y=t}set(t,e){return this.x=t,this.y=e,this}setScalar(t){return this.x=t,this.y=t,this}setX(t){return this.x=t,this}setY(t){return this.y=t,this}setComponent(t,e){switch(t){case 0:this.x=e;break;case 1:this.y=e;break;default:throw new Error("index is out of range: "+t)}return this}getComponent(t){switch(t){case 0:return this.x;case 1:return this.y;default:throw new Error("index is out of range: "+t)}}clone(){return new this.constructor(this.x,this.y)}copy(t){return this.x=t.x,this.y=t.y,this}add(t){return this.x+=t.x,this.y+=t.y,this}addScalar(t){return this.x+=t,this.y+=t,this}addVectors(t,e){return this.x=t.x+e.x,this.y=t.y+e.y,this}addScaledVector(t,e){return this.x+=t.x*e,this.y+=t.y*e,this}sub(t){return this.x-=t.x,this.y-=t.y,this}subScalar(t){return this.x-=t,this.y-=t,this}subVectors(t,e){return this.x=t.x-e.x,this.y=t.y-e.y,this}multiply(t){return this.x*=t.x,this.y*=t.y,this}multiplyScalar(t){return this.x*=t,this.y*=t,this}divide(t){return this.x/=t.x,this.y/=t.y,this}divideScalar(t){return this.multiplyScalar(1/t)}applyMatrix3(t){let e=this.x,n=this.y,i=t.elements;return this.x=i[0]*e+i[3]*n+i[6],this.y=i[1]*e+i[4]*n+i[7],this}min(t){return this.x=Math.min(this.x,t.x),this.y=Math.min(this.y,t.y),this}max(t){return this.x=Math.max(this.x,t.x),this.y=Math.max(this.y,t.y),this}clamp(t,e){return this.x=Math.max(t.x,Math.min(e.x,this.x)),this.y=Math.max(t.y,Math.min(e.y,this.y)),this}clampScalar(t,e){return this.x=Math.max(t,Math.min(e,this.x)),this.y=Math.max(t,Math.min(e,this.y)),this}clampLength(t,e){let n=this.length();return this.divideScalar(n||1).multiplyScalar(Math.max(t,Math.min(e,n)))}floor(){return this.x=Math.floor(this.x),this.y=Math.floor(this.y),this}ceil(){return this.x=Math.ceil(this.x),this.y=Math.ceil(this.y),this}round(){return this.x=Math.round(this.x),this.y=Math.round(this.y),this}roundToZero(){return this.x=Math.trunc(this.x),this.y=Math.trunc(this.y),this}negate(){return this.x=-this.x,this.y=-this.y,this}dot(t){return this.x*t.x+this.y*t.y}cross(t){return this.x*t.y-this.y*t.x}lengthSq(){return this.x*this.x+this.y*this.y}length(){return Math.sqrt(this.x*this.x+this.y*this.y)}manhattanLength(){return Math.abs(this.x)+Math.abs(this.y)}normalize(){return this.divideScalar(this.length()||1)}angle(){return Math.atan2(-this.y,-this.x)+Math.PI}angleTo(t){let e=Math.sqrt(this.lengthSq()*t.lengthSq());if(e===0)return Math.PI/2;let n=this.dot(t)/e;return Math.acos(he(n,-1,1))}distanceTo(t){return Math.sqrt(this.distanceToSquared(t))}distanceToSquared(t){let e=this.x-t.x,n=this.y-t.y;return e*e+n*n}manhattanDistanceTo(t){return Math.abs(this.x-t.x)+Math.abs(this.y-t.y)}setLength(t){return this.normalize().multiplyScalar(t)}lerp(t,e){return this.x+=(t.x-this.x)*e,this.y+=(t.y-this.y)*e,this}lerpVectors(t,e,n){return this.x=t.x+(e.x-t.x)*n,this.y=t.y+(e.y-t.y)*n,this}equals(t){return t.x===this.x&&t.y===this.y}fromArray(t,e=0){return this.x=t[e],this.y=t[e+1],this}toArray(t=[],e=0){return t[e]=this.x,t[e+1]=this.y,t}fromBufferAttribute(t,e){return this.x=t.getX(e),this.y=t.getY(e),this}rotateAround(t,e){let n=Math.cos(e),i=Math.sin(e),s=this.x-t.x,a=this.y-t.y;return this.x=s*n-a*i+t.x,this.y=s*i+a*n+t.y,this}random(){return this.x=Math.random(),this.y=Math.random(),this}*[Symbol.iterator](){yield this.x,yield this.y}},Gt=class r{constructor(t,e,n,i,s,a,o,c,l){r.prototype.isMatrix3=!0,this.elements=[1,0,0,0,1,0,0,0,1],t!==void 0&&this.set(t,e,n,i,s,a,o,c,l)}set(t,e,n,i,s,a,o,c,l){let h=this.elements;return h[0]=t,h[1]=i,h[2]=o,h[3]=e,h[4]=s,h[5]=c,h[6]=n,h[7]=a,h[8]=l,this}identity(){return this.set(1,0,0,0,1,0,0,0,1),this}copy(t){let e=this.elements,n=t.elements;return e[0]=n[0],e[1]=n[1],e[2]=n[2],e[3]=n[3],e[4]=n[4],e[5]=n[5],e[6]=n[6],e[7]=n[7],e[8]=n[8],this}extractBasis(t,e,n){return t.setFromMatrix3Column(this,0),e.setFromMatrix3Column(this,1),n.setFromMatrix3Column(this,2),this}setFromMatrix4(t){let e=t.elements;return this.set(e[0],e[4],e[8],e[1],e[5],e[9],e[2],e[6],e[10]),this}multiply(t){return this.multiplyMatrices(this,t)}premultiply(t){return this.multiplyMatrices(t,this)}multiplyMatrices(t,e){let n=t.elements,i=e.elements,s=this.elements,a=n[0],o=n[3],c=n[6],l=n[1],h=n[4],u=n[7],d=n[2],f=n[5],m=n[8],_=i[0],g=i[3],p=i[6],v=i[1],x=i[4],y=i[7],C=i[2],T=i[5],R=i[8];return s[0]=a*_+o*v+c*C,s[3]=a*g+o*x+c*T,s[6]=a*p+o*y+c*R,s[1]=l*_+h*v+u*C,s[4]=l*g+h*x+u*T,s[7]=l*p+h*y+u*R,s[2]=d*_+f*v+m*C,s[5]=d*g+f*x+m*T,s[8]=d*p+f*y+m*R,this}multiplyScalar(t){let e=this.elements;return e[0]*=t,e[3]*=t,e[6]*=t,e[1]*=t,e[4]*=t,e[7]*=t,e[2]*=t,e[5]*=t,e[8]*=t,this}determinant(){let t=this.elements,e=t[0],n=t[1],i=t[2],s=t[3],a=t[4],o=t[5],c=t[6],l=t[7],h=t[8];return e*a*h-e*o*l-n*s*h+n*o*c+i*s*l-i*a*c}invert(){let t=this.elements,e=t[0],n=t[1],i=t[2],s=t[3],a=t[4],o=t[5],c=t[6],l=t[7],h=t[8],u=h*a-o*l,d=o*c-h*s,f=l*s-a*c,m=e*u+n*d+i*f;if(m===0)return this.set(0,0,0,0,0,0,0,0,0);let _=1/m;return t[0]=u*_,t[1]=(i*l-h*n)*_,t[2]=(o*n-i*a)*_,t[3]=d*_,t[4]=(h*e-i*c)*_,t[5]=(i*s-o*e)*_,t[6]=f*_,t[7]=(n*c-l*e)*_,t[8]=(a*e-n*s)*_,this}transpose(){let t,e=this.elements;return t=e[1],e[1]=e[3],e[3]=t,t=e[2],e[2]=e[6],e[6]=t,t=e[5],e[5]=e[7],e[7]=t,this}getNormalMatrix(t){return this.setFromMatrix4(t).invert().transpose()}transposeIntoArray(t){let e=this.elements;return t[0]=e[0],t[1]=e[3],t[2]=e[6],t[3]=e[1],t[4]=e[4],t[5]=e[7],t[6]=e[2],t[7]=e[5],t[8]=e[8],this}setUvTransform(t,e,n,i,s,a,o){let c=Math.cos(s),l=Math.sin(s);return this.set(n*c,n*l,-n*(c*a+l*o)+a+t,-i*l,i*c,-i*(-l*a+c*o)+o+e,0,0,1),this}scale(t,e){return this.premultiply(Wa.makeScale(t,e)),this}rotate(t){return this.premultiply(Wa.makeRotation(-t)),this}translate(t,e){return this.premultiply(Wa.makeTranslation(t,e)),this}makeTranslation(t,e){return t.isVector2?this.set(1,0,t.x,0,1,t.y,0,0,1):this.set(1,0,t,0,1,e,0,0,1),this}makeRotation(t){let e=Math.cos(t),n=Math.sin(t);return this.set(e,-n,0,n,e,0,0,0,1),this}makeScale(t,e){return this.set(t,0,0,0,e,0,0,0,1),this}equals(t){let e=this.elements,n=t.elements;for(let i=0;i<9;i++)if(e[i]!==n[i])return!1;return!0}fromArray(t,e=0){for(let n=0;n<9;n++)this.elements[n]=t[n+e];return this}toArray(t=[],e=0){let n=this.elements;return t[e]=n[0],t[e+1]=n[1],t[e+2]=n[2],t[e+3]=n[3],t[e+4]=n[4],t[e+5]=n[5],t[e+6]=n[6],t[e+7]=n[7],t[e+8]=n[8],t}clone(){return new this.constructor().fromArray(this.elements)}},Wa=new Gt;function Vd(r){for(let t=r.length-1;t>=0;--t)if(r[t]>=65535)return!0;return!1}var Ep={Int8Array,Uint8Array,Uint8ClampedArray,Int16Array,Uint16Array,Int32Array,Uint32Array,Float32Array,Float64Array};function Yi(r,t){return new Ep[r](t)}function Ds(r){return document.createElementNS("http://www.w3.org/1999/xhtml",r)}function Ap(){let r=Ds("canvas");return r.style.display="block",r}var nh={};function Rs(r){r in nh||(nh[r]=!0,console.warn(r))}var ih=new Gt().set(.8224621,.177538,0,.0331941,.9668058,0,.0170827,.0723974,.9105199),sh=new Gt().set(1.2249401,-.2249404,0,-.0420569,1.0420571,0,-.0196376,-.0786361,1.0982735),$s={[En]:{transfer:Kr,primaries:Qr,toReference:r=>r,fromReference:r=>r},[Se]:{transfer:se,primaries:Qr,toReference:r=>r.convertSRGBToLinear(),fromReference:r=>r.convertLinearToSRGB()},[La]:{transfer:Kr,primaries:jr,toReference:r=>r.applyMatrix3(sh),fromReference:r=>r.applyMatrix3(ih)},[cl]:{transfer:se,primaries:jr,toReference:r=>r.convertSRGBToLinear().applyMatrix3(sh),fromReference:r=>r.applyMatrix3(ih).convertLinearToSRGB()}},Tp=new Set([En,La]),jt={enabled:!0,_workingColorSpace:En,get workingColorSpace(){return this._workingColorSpace},set workingColorSpace(r){if(!Tp.has(r))throw new Error(`Unsupported working color space, "${r}".`);this._workingColorSpace=r},convert:function(r,t,e){if(this.enabled===!1||t===e||!t||!e)return r;let n=$s[t].toReference,i=$s[e].fromReference;return i(n(r))},fromWorkingColorSpace:function(r,t){return this.convert(r,this._workingColorSpace,t)},toWorkingColorSpace:function(r,t){return this.convert(r,t,this._workingColorSpace)},getPrimaries:function(r){return $s[r].primaries},getTransfer:function(r){return r===$e?Kr:$s[r].transfer}};function Qi(r){return r<.04045?r*.0773993808:Math.pow(r*.9478672986+.0521327014,2.4)}function Xa(r){return r<.0031308?r*12.92:1.055*Math.pow(r,.41666)-.055}var Ei,na=class{static getDataURL(t){if(/^data:/i.test(t.src)||typeof HTMLCanvasElement>"u")return t.src;let e;if(t instanceof HTMLCanvasElement)e=t;else{Ei===void 0&&(Ei=Ds("canvas")),Ei.width=t.width,Ei.height=t.height;let n=Ei.getContext("2d");t instanceof ImageData?n.putImageData(t,0,0):n.drawImage(t,0,0,t.width,t.height),e=Ei}return e.width>2048||e.height>2048?(console.warn("THREE.ImageUtils.getDataURL: Image converted to jpg for performance reasons",t),e.toDataURL("image/jpeg",.6)):e.toDataURL("image/png")}static sRGBToLinear(t){if(typeof HTMLImageElement<"u"&&t instanceof HTMLImageElement||typeof HTMLCanvasElement<"u"&&t instanceof HTMLCanvasElement||typeof ImageBitmap<"u"&&t instanceof ImageBitmap){let e=Ds("canvas");e.width=t.width,e.height=t.height;let n=e.getContext("2d");n.drawImage(t,0,0,t.width,t.height);let i=n.getImageData(0,0,t.width,t.height),s=i.data;for(let a=0;a<s.length;a++)s[a]=Qi(s[a]/255)*255;return n.putImageData(i,0,0),e}else if(t.data){let e=t.data.slice(0);for(let n=0;n<e.length;n++)e instanceof Uint8Array||e instanceof Uint8ClampedArray?e[n]=Math.floor(Qi(e[n]/255)*255):e[n]=Qi(e[n]);return{data:e,width:t.width,height:t.height}}else return console.warn("THREE.ImageUtils.sRGBToLinear(): Unsupported image type. No color space conversion applied."),t}},wp=0,On=class{constructor(t=null){this.isSource=!0,Object.defineProperty(this,"id",{value:wp++}),this.uuid=Ye(),this.data=t,this.version=0}set needsUpdate(t){t===!0&&this.version++}toJSON(t){let e=t===void 0||typeof t=="string";if(!e&&t.images[this.uuid]!==void 0)return t.images[this.uuid];let n={uuid:this.uuid,url:""},i=this.data;if(i!==null){let s;if(Array.isArray(i)){s=[];for(let a=0,o=i.length;a<o;a++)i[a].isDataTexture?s.push(qa(i[a].image)):s.push(qa(i[a]))}else s=qa(i);n.url=s}return e||(t.images[this.uuid]=n),n}};function qa(r){return typeof HTMLImageElement<"u"&&r instanceof HTMLImageElement||typeof HTMLCanvasElement<"u"&&r instanceof HTMLCanvasElement||typeof ImageBitmap<"u"&&r instanceof ImageBitmap?na.getDataURL(r):r.data?{data:Array.from(r.data),width:r.width,height:r.height,type:r.data.constructor.name}:(console.warn("THREE.Texture: Unable to serialize Texture."),{})}var Rp=0,Ee=class r extends hn{constructor(t=r.DEFAULT_IMAGE,e=r.DEFAULT_MAPPING,n=Fe,i=Fe,s=me,a=gi,o=qe,c=kn,l=r.DEFAULT_ANISOTROPY,h=$e){super(),this.isTexture=!0,Object.defineProperty(this,"id",{value:Rp++}),this.uuid=Ye(),this.name="",this.source=new On(t),this.mipmaps=[],this.mapping=e,this.channel=0,this.wrapS=n,this.wrapT=i,this.magFilter=s,this.minFilter=a,this.anisotropy=l,this.format=o,this.internalFormat=null,this.type=c,this.offset=new Z(0,0),this.repeat=new Z(1,1),this.center=new Z(0,0),this.rotation=0,this.matrixAutoUpdate=!0,this.matrix=new Gt,this.generateMipmaps=!0,this.premultiplyAlpha=!1,this.flipY=!0,this.unpackAlignment=4,typeof h=="string"?this.colorSpace=h:(Rs("THREE.Texture: Property .encoding has been replaced by .colorSpace."),this.colorSpace=h===fi?Se:$e),this.userData={},this.version=0,this.onUpdate=null,this.isRenderTargetTexture=!1,this.needsPMREMUpdate=!1}get image(){return this.source.data}set image(t=null){this.source.data=t}updateMatrix(){this.matrix.setUvTransform(this.offset.x,this.offset.y,this.repeat.x,this.repeat.y,this.rotation,this.center.x,this.center.y)}clone(){return new this.constructor().copy(this)}copy(t){return this.name=t.name,this.source=t.source,this.mipmaps=t.mipmaps.slice(0),this.mapping=t.mapping,this.channel=t.channel,this.wrapS=t.wrapS,this.wrapT=t.wrapT,this.magFilter=t.magFilter,this.minFilter=t.minFilter,this.anisotropy=t.anisotropy,this.format=t.format,this.internalFormat=t.internalFormat,this.type=t.type,this.offset.copy(t.offset),this.repeat.copy(t.repeat),this.center.copy(t.center),this.rotation=t.rotation,this.matrixAutoUpdate=t.matrixAutoUpdate,this.matrix.copy(t.matrix),this.generateMipmaps=t.generateMipmaps,this.premultiplyAlpha=t.premultiplyAlpha,this.flipY=t.flipY,this.unpackAlignment=t.unpackAlignment,this.colorSpace=t.colorSpace,this.userData=JSON.parse(JSON.stringify(t.userData)),this.needsUpdate=!0,this}toJSON(t){let e=t===void 0||typeof t=="string";if(!e&&t.textures[this.uuid]!==void 0)return t.textures[this.uuid];let n={metadata:{version:4.6,type:"Texture",generator:"Texture.toJSON"},uuid:this.uuid,name:this.name,image:this.source.toJSON(t).uuid,mapping:this.mapping,channel:this.channel,repeat:[this.repeat.x,this.repeat.y],offset:[this.offset.x,this.offset.y],center:[this.center.x,this.center.y],rotation:this.rotation,wrap:[this.wrapS,this.wrapT],format:this.format,internalFormat:this.internalFormat,type:this.type,colorSpace:this.colorSpace,minFilter:this.minFilter,magFilter:this.magFilter,anisotropy:this.anisotropy,flipY:this.flipY,generateMipmaps:this.generateMipmaps,premultiplyAlpha:this.premultiplyAlpha,unpackAlignment:this.unpackAlignment};return Object.keys(this.userData).length>0&&(n.userData=this.userData),e||(t.textures[this.uuid]=n),n}dispose(){this.dispatchEvent({type:"dispose"})}transformUv(t){if(this.mapping!==rl)return t;if(t.applyMatrix3(this.matrix),t.x<0||t.x>1)switch(this.wrapS){case qr:t.x=t.x-Math.floor(t.x);break;case Fe:t.x=t.x<0?0:1;break;case Yr:Math.abs(Math.floor(t.x)%2)===1?t.x=Math.ceil(t.x)-t.x:t.x=t.x-Math.floor(t.x);break}if(t.y<0||t.y>1)switch(this.wrapT){case qr:t.y=t.y-Math.floor(t.y);break;case Fe:t.y=t.y<0?0:1;break;case Yr:Math.abs(Math.floor(t.y)%2)===1?t.y=Math.ceil(t.y)-t.y:t.y=t.y-Math.floor(t.y);break}return this.flipY&&(t.y=1-t.y),t}set needsUpdate(t){t===!0&&(this.version++,this.source.needsUpdate=!0)}get encoding(){return Rs("THREE.Texture: Property .encoding has been replaced by .colorSpace."),this.colorSpace===Se?fi:Bd}set encoding(t){Rs("THREE.Texture: Property .encoding has been replaced by .colorSpace."),this.colorSpace=t===fi?Se:$e}};Ee.DEFAULT_IMAGE=null;Ee.DEFAULT_MAPPING=rl;Ee.DEFAULT_ANISOTROPY=1;var te=class r{constructor(t=0,e=0,n=0,i=1){r.prototype.isVector4=!0,this.x=t,this.y=e,this.z=n,this.w=i}get width(){return this.z}set width(t){this.z=t}get height(){return this.w}set height(t){this.w=t}set(t,e,n,i){return this.x=t,this.y=e,this.z=n,this.w=i,this}setScalar(t){return this.x=t,this.y=t,this.z=t,this.w=t,this}setX(t){return this.x=t,this}setY(t){return this.y=t,this}setZ(t){return this.z=t,this}setW(t){return this.w=t,this}setComponent(t,e){switch(t){case 0:this.x=e;break;case 1:this.y=e;break;case 2:this.z=e;break;case 3:this.w=e;break;default:throw new Error("index is out of range: "+t)}return this}getComponent(t){switch(t){case 0:return this.x;case 1:return this.y;case 2:return this.z;case 3:return this.w;default:throw new Error("index is out of range: "+t)}}clone(){return new this.constructor(this.x,this.y,this.z,this.w)}copy(t){return this.x=t.x,this.y=t.y,this.z=t.z,this.w=t.w!==void 0?t.w:1,this}add(t){return this.x+=t.x,this.y+=t.y,this.z+=t.z,this.w+=t.w,this}addScalar(t){return this.x+=t,this.y+=t,this.z+=t,this.w+=t,this}addVectors(t,e){return this.x=t.x+e.x,this.y=t.y+e.y,this.z=t.z+e.z,this.w=t.w+e.w,this}addScaledVector(t,e){return this.x+=t.x*e,this.y+=t.y*e,this.z+=t.z*e,this.w+=t.w*e,this}sub(t){return this.x-=t.x,this.y-=t.y,this.z-=t.z,this.w-=t.w,this}subScalar(t){return this.x-=t,this.y-=t,this.z-=t,this.w-=t,this}subVectors(t,e){return this.x=t.x-e.x,this.y=t.y-e.y,this.z=t.z-e.z,this.w=t.w-e.w,this}multiply(t){return this.x*=t.x,this.y*=t.y,this.z*=t.z,this.w*=t.w,this}multiplyScalar(t){return this.x*=t,this.y*=t,this.z*=t,this.w*=t,this}applyMatrix4(t){let e=this.x,n=this.y,i=this.z,s=this.w,a=t.elements;return this.x=a[0]*e+a[4]*n+a[8]*i+a[12]*s,this.y=a[1]*e+a[5]*n+a[9]*i+a[13]*s,this.z=a[2]*e+a[6]*n+a[10]*i+a[14]*s,this.w=a[3]*e+a[7]*n+a[11]*i+a[15]*s,this}divideScalar(t){return this.multiplyScalar(1/t)}setAxisAngleFromQuaternion(t){this.w=2*Math.acos(t.w);let e=Math.sqrt(1-t.w*t.w);return e<1e-4?(this.x=1,this.y=0,this.z=0):(this.x=t.x/e,this.y=t.y/e,this.z=t.z/e),this}setAxisAngleFromRotationMatrix(t){let e,n,i,s,c=t.elements,l=c[0],h=c[4],u=c[8],d=c[1],f=c[5],m=c[9],_=c[2],g=c[6],p=c[10];if(Math.abs(h-d)<.01&&Math.abs(u-_)<.01&&Math.abs(m-g)<.01){if(Math.abs(h+d)<.1&&Math.abs(u+_)<.1&&Math.abs(m+g)<.1&&Math.abs(l+f+p-3)<.1)return this.set(1,0,0,0),this;e=Math.PI;let x=(l+1)/2,y=(f+1)/2,C=(p+1)/2,T=(h+d)/4,R=(u+_)/4,U=(m+g)/4;return x>y&&x>C?x<.01?(n=0,i=.707106781,s=.707106781):(n=Math.sqrt(x),i=T/n,s=R/n):y>C?y<.01?(n=.707106781,i=0,s=.707106781):(i=Math.sqrt(y),n=T/i,s=U/i):C<.01?(n=.707106781,i=.707106781,s=0):(s=Math.sqrt(C),n=R/s,i=U/s),this.set(n,i,s,e),this}let v=Math.sqrt((g-m)*(g-m)+(u-_)*(u-_)+(d-h)*(d-h));return Math.abs(v)<.001&&(v=1),this.x=(g-m)/v,this.y=(u-_)/v,this.z=(d-h)/v,this.w=Math.acos((l+f+p-1)/2),this}min(t){return this.x=Math.min(this.x,t.x),this.y=Math.min(this.y,t.y),this.z=Math.min(this.z,t.z),this.w=Math.min(this.w,t.w),this}max(t){return this.x=Math.max(this.x,t.x),this.y=Math.max(this.y,t.y),this.z=Math.max(this.z,t.z),this.w=Math.max(this.w,t.w),this}clamp(t,e){return this.x=Math.max(t.x,Math.min(e.x,this.x)),this.y=Math.max(t.y,Math.min(e.y,this.y)),this.z=Math.max(t.z,Math.min(e.z,this.z)),this.w=Math.max(t.w,Math.min(e.w,this.w)),this}clampScalar(t,e){return this.x=Math.max(t,Math.min(e,this.x)),this.y=Math.max(t,Math.min(e,this.y)),this.z=Math.max(t,Math.min(e,this.z)),this.w=Math.max(t,Math.min(e,this.w)),this}clampLength(t,e){let n=this.length();return this.divideScalar(n||1).multiplyScalar(Math.max(t,Math.min(e,n)))}floor(){return this.x=Math.floor(this.x),this.y=Math.floor(this.y),this.z=Math.floor(this.z),this.w=Math.floor(this.w),this}ceil(){return this.x=Math.ceil(this.x),this.y=Math.ceil(this.y),this.z=Math.ceil(this.z),this.w=Math.ceil(this.w),this}round(){return this.x=Math.round(this.x),this.y=Math.round(this.y),this.z=Math.round(this.z),this.w=Math.round(this.w),this}roundToZero(){return this.x=Math.trunc(this.x),this.y=Math.trunc(this.y),this.z=Math.trunc(this.z),this.w=Math.trunc(this.w),this}negate(){return this.x=-this.x,this.y=-this.y,this.z=-this.z,this.w=-this.w,this}dot(t){return this.x*t.x+this.y*t.y+this.z*t.z+this.w*t.w}lengthSq(){return this.x*this.x+this.y*this.y+this.z*this.z+this.w*this.w}length(){return Math.sqrt(this.x*this.x+this.y*this.y+this.z*this.z+this.w*this.w)}manhattanLength(){return Math.abs(this.x)+Math.abs(this.y)+Math.abs(this.z)+Math.abs(this.w)}normalize(){return this.divideScalar(this.length()||1)}setLength(t){return this.normalize().multiplyScalar(t)}lerp(t,e){return this.x+=(t.x-this.x)*e,this.y+=(t.y-this.y)*e,this.z+=(t.z-this.z)*e,this.w+=(t.w-this.w)*e,this}lerpVectors(t,e,n){return this.x=t.x+(e.x-t.x)*n,this.y=t.y+(e.y-t.y)*n,this.z=t.z+(e.z-t.z)*n,this.w=t.w+(e.w-t.w)*n,this}equals(t){return t.x===this.x&&t.y===this.y&&t.z===this.z&&t.w===this.w}fromArray(t,e=0){return this.x=t[e],this.y=t[e+1],this.z=t[e+2],this.w=t[e+3],this}toArray(t=[],e=0){return t[e]=this.x,t[e+1]=this.y,t[e+2]=this.z,t[e+3]=this.w,t}fromBufferAttribute(t,e){return this.x=t.getX(e),this.y=t.getY(e),this.z=t.getZ(e),this.w=t.getW(e),this}random(){return this.x=Math.random(),this.y=Math.random(),this.z=Math.random(),this.w=Math.random(),this}*[Symbol.iterator](){yield this.x,yield this.y,yield this.z,yield this.w}},Io=class extends hn{constructor(t=1,e=1,n={}){super(),this.isRenderTarget=!0,this.width=t,this.height=e,this.depth=1,this.scissor=new te(0,0,t,e),this.scissorTest=!1,this.viewport=new te(0,0,t,e);let i={width:t,height:e,depth:1};n.encoding!==void 0&&(Rs("THREE.WebGLRenderTarget: option.encoding has been replaced by option.colorSpace."),n.colorSpace=n.encoding===fi?Se:$e),n=Object.assign({generateMipmaps:!1,internalFormat:null,minFilter:me,depthBuffer:!0,stencilBuffer:!1,depthTexture:null,samples:0},n),this.texture=new Ee(i,n.mapping,n.wrapS,n.wrapT,n.magFilter,n.minFilter,n.format,n.type,n.anisotropy,n.colorSpace),this.texture.isRenderTargetTexture=!0,this.texture.flipY=!1,this.texture.generateMipmaps=n.generateMipmaps,this.texture.internalFormat=n.internalFormat,this.depthBuffer=n.depthBuffer,this.stencilBuffer=n.stencilBuffer,this.depthTexture=n.depthTexture,this.samples=n.samples}setSize(t,e,n=1){(this.width!==t||this.height!==e||this.depth!==n)&&(this.width=t,this.height=e,this.depth=n,this.texture.image.width=t,this.texture.image.height=e,this.texture.image.depth=n,this.dispose()),this.viewport.set(0,0,t,e),this.scissor.set(0,0,t,e)}clone(){return new this.constructor().copy(this)}copy(t){this.width=t.width,this.height=t.height,this.depth=t.depth,this.scissor.copy(t.scissor),this.scissorTest=t.scissorTest,this.viewport.copy(t.viewport),this.texture=t.texture.clone(),this.texture.isRenderTargetTexture=!0;let e=Object.assign({},t.texture.image);return this.texture.source=new On(e),this.depthBuffer=t.depthBuffer,this.stencilBuffer=t.stencilBuffer,t.depthTexture!==null&&(this.depthTexture=t.depthTexture.clone()),this.samples=t.samples,this}dispose(){this.dispatchEvent({type:"dispose"})}},Ke=class extends Io{constructor(t=1,e=1,n={}){super(t,e,n),this.isWebGLRenderTarget=!0}},Ns=class extends Ee{constructor(t=null,e=1,n=1,i=1){super(null),this.isDataArrayTexture=!0,this.image={data:t,width:e,height:n,depth:i},this.magFilter=pe,this.minFilter=pe,this.wrapR=Fe,this.generateMipmaps=!1,this.flipY=!1,this.unpackAlignment=1}},rh=class extends Ke{constructor(t=1,e=1,n=1,i={}){super(t,e,i),this.isWebGLArrayRenderTarget=!0,this.depth=n,this.texture=new Ns(null,t,e,n),this.texture.isRenderTargetTexture=!0}},ia=class extends Ee{constructor(t=null,e=1,n=1,i=1){super(null),this.isData3DTexture=!0,this.image={data:t,width:e,height:n,depth:i},this.magFilter=pe,this.minFilter=pe,this.wrapR=Fe,this.generateMipmaps=!1,this.flipY=!1,this.unpackAlignment=1}},ah=class extends Ke{constructor(t=1,e=1,n=1,i={}){super(t,e,i),this.isWebGL3DRenderTarget=!0,this.depth=n,this.texture=new ia(null,t,e,n),this.texture.isRenderTargetTexture=!0}},oh=class extends Ke{constructor(t=1,e=1,n=1,i={}){super(t,e,i),this.isWebGLMultipleRenderTargets=!0;let s=this.texture;this.texture=[];for(let a=0;a<n;a++)this.texture[a]=s.clone(),this.texture[a].isRenderTargetTexture=!0}setSize(t,e,n=1){if(this.width!==t||this.height!==e||this.depth!==n){this.width=t,this.height=e,this.depth=n;for(let i=0,s=this.texture.length;i<s;i++)this.texture[i].image.width=t,this.texture[i].image.height=e,this.texture[i].image.depth=n;this.dispose()}this.viewport.set(0,0,t,e),this.scissor.set(0,0,t,e)}copy(t){this.dispose(),this.width=t.width,this.height=t.height,this.depth=t.depth,this.scissor.copy(t.scissor),this.scissorTest=t.scissorTest,this.viewport.copy(t.viewport),this.depthBuffer=t.depthBuffer,this.stencilBuffer=t.stencilBuffer,t.depthTexture!==null&&(this.depthTexture=t.depthTexture.clone()),this.texture.length=0;for(let e=0,n=t.texture.length;e<n;e++)this.texture[e]=t.texture[e].clone(),this.texture[e].isRenderTargetTexture=!0;return this}},Be=class{constructor(t=0,e=0,n=0,i=1){this.isQuaternion=!0,this._x=t,this._y=e,this._z=n,this._w=i}static slerpFlat(t,e,n,i,s,a,o){let c=n[i+0],l=n[i+1],h=n[i+2],u=n[i+3],d=s[a+0],f=s[a+1],m=s[a+2],_=s[a+3];if(o===0){t[e+0]=c,t[e+1]=l,t[e+2]=h,t[e+3]=u;return}if(o===1){t[e+0]=d,t[e+1]=f,t[e+2]=m,t[e+3]=_;return}if(u!==_||c!==d||l!==f||h!==m){let g=1-o,p=c*d+l*f+h*m+u*_,v=p>=0?1:-1,x=1-p*p;if(x>Number.EPSILON){let C=Math.sqrt(x),T=Math.atan2(C,p*v);g=Math.sin(g*T)/C,o=Math.sin(o*T)/C}let y=o*v;if(c=c*g+d*y,l=l*g+f*y,h=h*g+m*y,u=u*g+_*y,g===1-o){let C=1/Math.sqrt(c*c+l*l+h*h+u*u);c*=C,l*=C,h*=C,u*=C}}t[e]=c,t[e+1]=l,t[e+2]=h,t[e+3]=u}static multiplyQuaternionsFlat(t,e,n,i,s,a){let o=n[i],c=n[i+1],l=n[i+2],h=n[i+3],u=s[a],d=s[a+1],f=s[a+2],m=s[a+3];return t[e]=o*m+h*u+c*f-l*d,t[e+1]=c*m+h*d+l*u-o*f,t[e+2]=l*m+h*f+o*d-c*u,t[e+3]=h*m-o*u-c*d-l*f,t}get x(){return this._x}set x(t){this._x=t,this._onChangeCallback()}get y(){return this._y}set y(t){this._y=t,this._onChangeCallback()}get z(){return this._z}set z(t){this._z=t,this._onChangeCallback()}get w(){return this._w}set w(t){this._w=t,this._onChangeCallback()}set(t,e,n,i){return this._x=t,this._y=e,this._z=n,this._w=i,this._onChangeCallback(),this}clone(){return new this.constructor(this._x,this._y,this._z,this._w)}copy(t){return this._x=t.x,this._y=t.y,this._z=t.z,this._w=t.w,this._onChangeCallback(),this}setFromEuler(t,e=!0){let n=t._x,i=t._y,s=t._z,a=t._order,o=Math.cos,c=Math.sin,l=o(n/2),h=o(i/2),u=o(s/2),d=c(n/2),f=c(i/2),m=c(s/2);switch(a){case"XYZ":this._x=d*h*u+l*f*m,this._y=l*f*u-d*h*m,this._z=l*h*m+d*f*u,this._w=l*h*u-d*f*m;break;case"YXZ":this._x=d*h*u+l*f*m,this._y=l*f*u-d*h*m,this._z=l*h*m-d*f*u,this._w=l*h*u+d*f*m;break;case"ZXY":this._x=d*h*u-l*f*m,this._y=l*f*u+d*h*m,this._z=l*h*m+d*f*u,this._w=l*h*u-d*f*m;break;case"ZYX":this._x=d*h*u-l*f*m,this._y=l*f*u+d*h*m,this._z=l*h*m-d*f*u,this._w=l*h*u+d*f*m;break;case"YZX":this._x=d*h*u+l*f*m,this._y=l*f*u+d*h*m,this._z=l*h*m-d*f*u,this._w=l*h*u-d*f*m;break;case"XZY":this._x=d*h*u-l*f*m,this._y=l*f*u-d*h*m,this._z=l*h*m+d*f*u,this._w=l*h*u+d*f*m;break;default:console.warn("THREE.Quaternion: .setFromEuler() encountered an unknown order: "+a)}return e===!0&&this._onChangeCallback(),this}setFromAxisAngle(t,e){let n=e/2,i=Math.sin(n);return this._x=t.x*i,this._y=t.y*i,this._z=t.z*i,this._w=Math.cos(n),this._onChangeCallback(),this}setFromRotationMatrix(t){let e=t.elements,n=e[0],i=e[4],s=e[8],a=e[1],o=e[5],c=e[9],l=e[2],h=e[6],u=e[10],d=n+o+u;if(d>0){let f=.5/Math.sqrt(d+1);this._w=.25/f,this._x=(h-c)*f,this._y=(s-l)*f,this._z=(a-i)*f}else if(n>o&&n>u){let f=2*Math.sqrt(1+n-o-u);this._w=(h-c)/f,this._x=.25*f,this._y=(i+a)/f,this._z=(s+l)/f}else if(o>u){let f=2*Math.sqrt(1+o-n-u);this._w=(s-l)/f,this._x=(i+a)/f,this._y=.25*f,this._z=(c+h)/f}else{let f=2*Math.sqrt(1+u-n-o);this._w=(a-i)/f,this._x=(s+l)/f,this._y=(c+h)/f,this._z=.25*f}return this._onChangeCallback(),this}setFromUnitVectors(t,e){let n=t.dot(e)+1;return n<Number.EPSILON?(n=0,Math.abs(t.x)>Math.abs(t.z)?(this._x=-t.y,this._y=t.x,this._z=0,this._w=n):(this._x=0,this._y=-t.z,this._z=t.y,this._w=n)):(this._x=t.y*e.z-t.z*e.y,this._y=t.z*e.x-t.x*e.z,this._z=t.x*e.y-t.y*e.x,this._w=n),this.normalize()}angleTo(t){return 2*Math.acos(Math.abs(he(this.dot(t),-1,1)))}rotateTowards(t,e){let n=this.angleTo(t);if(n===0)return this;let i=Math.min(1,e/n);return this.slerp(t,i),this}identity(){return this.set(0,0,0,1)}invert(){return this.conjugate()}conjugate(){return this._x*=-1,this._y*=-1,this._z*=-1,this._onChangeCallback(),this}dot(t){return this._x*t._x+this._y*t._y+this._z*t._z+this._w*t._w}lengthSq(){return this._x*this._x+this._y*this._y+this._z*this._z+this._w*this._w}length(){return Math.sqrt(this._x*this._x+this._y*this._y+this._z*this._z+this._w*this._w)}normalize(){let t=this.length();return t===0?(this._x=0,this._y=0,this._z=0,this._w=1):(t=1/t,this._x=this._x*t,this._y=this._y*t,this._z=this._z*t,this._w=this._w*t),this._onChangeCallback(),this}multiply(t){return this.multiplyQuaternions(this,t)}premultiply(t){return this.multiplyQuaternions(t,this)}multiplyQuaternions(t,e){let n=t._x,i=t._y,s=t._z,a=t._w,o=e._x,c=e._y,l=e._z,h=e._w;return this._x=n*h+a*o+i*l-s*c,this._y=i*h+a*c+s*o-n*l,this._z=s*h+a*l+n*c-i*o,this._w=a*h-n*o-i*c-s*l,this._onChangeCallback(),this}slerp(t,e){if(e===0)return this;if(e===1)return this.copy(t);let n=this._x,i=this._y,s=this._z,a=this._w,o=a*t._w+n*t._x+i*t._y+s*t._z;if(o<0?(this._w=-t._w,this._x=-t._x,this._y=-t._y,this._z=-t._z,o=-o):this.copy(t),o>=1)return this._w=a,this._x=n,this._y=i,this._z=s,this;let c=1-o*o;if(c<=Number.EPSILON){let f=1-e;return this._w=f*a+e*this._w,this._x=f*n+e*this._x,this._y=f*i+e*this._y,this._z=f*s+e*this._z,this.normalize(),this}let l=Math.sqrt(c),h=Math.atan2(l,o),u=Math.sin((1-e)*h)/l,d=Math.sin(e*h)/l;return this._w=a*u+this._w*d,this._x=n*u+this._x*d,this._y=i*u+this._y*d,this._z=s*u+this._z*d,this._onChangeCallback(),this}slerpQuaternions(t,e,n){return this.copy(t).slerp(e,n)}random(){let t=Math.random(),e=Math.sqrt(1-t),n=Math.sqrt(t),i=2*Math.PI*Math.random(),s=2*Math.PI*Math.random();return this.set(e*Math.cos(i),n*Math.sin(s),n*Math.cos(s),e*Math.sin(i))}equals(t){return t._x===this._x&&t._y===this._y&&t._z===this._z&&t._w===this._w}fromArray(t,e=0){return this._x=t[e],this._y=t[e+1],this._z=t[e+2],this._w=t[e+3],this._onChangeCallback(),this}toArray(t=[],e=0){return t[e]=this._x,t[e+1]=this._y,t[e+2]=this._z,t[e+3]=this._w,t}fromBufferAttribute(t,e){return this._x=t.getX(e),this._y=t.getY(e),this._z=t.getZ(e),this._w=t.getW(e),this._onChangeCallback(),this}toJSON(){return this.toArray()}_onChange(t){return this._onChangeCallback=t,this}_onChangeCallback(){}*[Symbol.iterator](){yield this._x,yield this._y,yield this._z,yield this._w}},w=class r{constructor(t=0,e=0,n=0){r.prototype.isVector3=!0,this.x=t,this.y=e,this.z=n}set(t,e,n){return n===void 0&&(n=this.z),this.x=t,this.y=e,this.z=n,this}setScalar(t){return this.x=t,this.y=t,this.z=t,this}setX(t){return this.x=t,this}setY(t){return this.y=t,this}setZ(t){return this.z=t,this}setComponent(t,e){switch(t){case 0:this.x=e;break;case 1:this.y=e;break;case 2:this.z=e;break;default:throw new Error("index is out of range: "+t)}return this}getComponent(t){switch(t){case 0:return this.x;case 1:return this.y;case 2:return this.z;default:throw new Error("index is out of range: "+t)}}clone(){return new this.constructor(this.x,this.y,this.z)}copy(t){return this.x=t.x,this.y=t.y,this.z=t.z,this}add(t){return this.x+=t.x,this.y+=t.y,this.z+=t.z,this}addScalar(t){return this.x+=t,this.y+=t,this.z+=t,this}addVectors(t,e){return this.x=t.x+e.x,this.y=t.y+e.y,this.z=t.z+e.z,this}addScaledVector(t,e){return this.x+=t.x*e,this.y+=t.y*e,this.z+=t.z*e,this}sub(t){return this.x-=t.x,this.y-=t.y,this.z-=t.z,this}subScalar(t){return this.x-=t,this.y-=t,this.z-=t,this}subVectors(t,e){return this.x=t.x-e.x,this.y=t.y-e.y,this.z=t.z-e.z,this}multiply(t){return this.x*=t.x,this.y*=t.y,this.z*=t.z,this}multiplyScalar(t){return this.x*=t,this.y*=t,this.z*=t,this}multiplyVectors(t,e){return this.x=t.x*e.x,this.y=t.y*e.y,this.z=t.z*e.z,this}applyEuler(t){return this.applyQuaternion(ch.setFromEuler(t))}applyAxisAngle(t,e){return this.applyQuaternion(ch.setFromAxisAngle(t,e))}applyMatrix3(t){let e=this.x,n=this.y,i=this.z,s=t.elements;return this.x=s[0]*e+s[3]*n+s[6]*i,this.y=s[1]*e+s[4]*n+s[7]*i,this.z=s[2]*e+s[5]*n+s[8]*i,this}applyNormalMatrix(t){return this.applyMatrix3(t).normalize()}applyMatrix4(t){let e=this.x,n=this.y,i=this.z,s=t.elements,a=1/(s[3]*e+s[7]*n+s[11]*i+s[15]);return this.x=(s[0]*e+s[4]*n+s[8]*i+s[12])*a,this.y=(s[1]*e+s[5]*n+s[9]*i+s[13])*a,this.z=(s[2]*e+s[6]*n+s[10]*i+s[14])*a,this}applyQuaternion(t){let e=this.x,n=this.y,i=this.z,s=t.x,a=t.y,o=t.z,c=t.w,l=2*(a*i-o*n),h=2*(o*e-s*i),u=2*(s*n-a*e);return this.x=e+c*l+a*u-o*h,this.y=n+c*h+o*l-s*u,this.z=i+c*u+s*h-a*l,this}project(t){return this.applyMatrix4(t.matrixWorldInverse).applyMatrix4(t.projectionMatrix)}unproject(t){return this.applyMatrix4(t.projectionMatrixInverse).applyMatrix4(t.matrixWorld)}transformDirection(t){let e=this.x,n=this.y,i=this.z,s=t.elements;return this.x=s[0]*e+s[4]*n+s[8]*i,this.y=s[1]*e+s[5]*n+s[9]*i,this.z=s[2]*e+s[6]*n+s[10]*i,this.normalize()}divide(t){return this.x/=t.x,this.y/=t.y,this.z/=t.z,this}divideScalar(t){return this.multiplyScalar(1/t)}min(t){return this.x=Math.min(this.x,t.x),this.y=Math.min(this.y,t.y),this.z=Math.min(this.z,t.z),this}max(t){return this.x=Math.max(this.x,t.x),this.y=Math.max(this.y,t.y),this.z=Math.max(this.z,t.z),this}clamp(t,e){return this.x=Math.max(t.x,Math.min(e.x,this.x)),this.y=Math.max(t.y,Math.min(e.y,this.y)),this.z=Math.max(t.z,Math.min(e.z,this.z)),this}clampScalar(t,e){return this.x=Math.max(t,Math.min(e,this.x)),this.y=Math.max(t,Math.min(e,this.y)),this.z=Math.max(t,Math.min(e,this.z)),this}clampLength(t,e){let n=this.length();return this.divideScalar(n||1).multiplyScalar(Math.max(t,Math.min(e,n)))}floor(){return this.x=Math.floor(this.x),this.y=Math.floor(this.y),this.z=Math.floor(this.z),this}ceil(){return this.x=Math.ceil(this.x),this.y=Math.ceil(this.y),this.z=Math.ceil(this.z),this}round(){return this.x=Math.round(this.x),this.y=Math.round(this.y),this.z=Math.round(this.z),this}roundToZero(){return this.x=Math.trunc(this.x),this.y=Math.trunc(this.y),this.z=Math.trunc(this.z),this}negate(){return this.x=-this.x,this.y=-this.y,this.z=-this.z,this}dot(t){return this.x*t.x+this.y*t.y+this.z*t.z}lengthSq(){return this.x*this.x+this.y*this.y+this.z*this.z}length(){return Math.sqrt(this.x*this.x+this.y*this.y+this.z*this.z)}manhattanLength(){return Math.abs(this.x)+Math.abs(this.y)+Math.abs(this.z)}normalize(){return this.divideScalar(this.length()||1)}setLength(t){return this.normalize().multiplyScalar(t)}lerp(t,e){return this.x+=(t.x-this.x)*e,this.y+=(t.y-this.y)*e,this.z+=(t.z-this.z)*e,this}lerpVectors(t,e,n){return this.x=t.x+(e.x-t.x)*n,this.y=t.y+(e.y-t.y)*n,this.z=t.z+(e.z-t.z)*n,this}cross(t){return this.crossVectors(this,t)}crossVectors(t,e){let n=t.x,i=t.y,s=t.z,a=e.x,o=e.y,c=e.z;return this.x=i*c-s*o,this.y=s*a-n*c,this.z=n*o-i*a,this}projectOnVector(t){let e=t.lengthSq();if(e===0)return this.set(0,0,0);let n=t.dot(this)/e;return this.copy(t).multiplyScalar(n)}projectOnPlane(t){return Ya.copy(this).projectOnVector(t),this.sub(Ya)}reflect(t){return this.sub(Ya.copy(t).multiplyScalar(2*this.dot(t)))}angleTo(t){let e=Math.sqrt(this.lengthSq()*t.lengthSq());if(e===0)return Math.PI/2;let n=this.dot(t)/e;return Math.acos(he(n,-1,1))}distanceTo(t){return Math.sqrt(this.distanceToSquared(t))}distanceToSquared(t){let e=this.x-t.x,n=this.y-t.y,i=this.z-t.z;return e*e+n*n+i*i}manhattanDistanceTo(t){return Math.abs(this.x-t.x)+Math.abs(this.y-t.y)+Math.abs(this.z-t.z)}setFromSpherical(t){return this.setFromSphericalCoords(t.radius,t.phi,t.theta)}setFromSphericalCoords(t,e,n){let i=Math.sin(e)*t;return this.x=i*Math.sin(n),this.y=Math.cos(e)*t,this.z=i*Math.cos(n),this}setFromCylindrical(t){return this.setFromCylindricalCoords(t.radius,t.theta,t.y)}setFromCylindricalCoords(t,e,n){return this.x=t*Math.sin(e),this.y=n,this.z=t*Math.cos(e),this}setFromMatrixPosition(t){let e=t.elements;return this.x=e[12],this.y=e[13],this.z=e[14],this}setFromMatrixScale(t){let e=this.setFromMatrixColumn(t,0).length(),n=this.setFromMatrixColumn(t,1).length(),i=this.setFromMatrixColumn(t,2).length();return this.x=e,this.y=n,this.z=i,this}setFromMatrixColumn(t,e){return this.fromArray(t.elements,e*4)}setFromMatrix3Column(t,e){return this.fromArray(t.elements,e*3)}setFromEuler(t){return this.x=t._x,this.y=t._y,this.z=t._z,this}setFromColor(t){return this.x=t.r,this.y=t.g,this.z=t.b,this}equals(t){return t.x===this.x&&t.y===this.y&&t.z===this.z}fromArray(t,e=0){return this.x=t[e],this.y=t[e+1],this.z=t[e+2],this}toArray(t=[],e=0){return t[e]=this.x,t[e+1]=this.y,t[e+2]=this.z,t}fromBufferAttribute(t,e){return this.x=t.getX(e),this.y=t.getY(e),this.z=t.getZ(e),this}random(){return this.x=Math.random(),this.y=Math.random(),this.z=Math.random(),this}randomDirection(){let t=(Math.random()-.5)*2,e=Math.random()*Math.PI*2,n=Math.sqrt(1-t**2);return this.x=n*Math.cos(e),this.y=n*Math.sin(e),this.z=t,this}*[Symbol.iterator](){yield this.x,yield this.y,yield this.z}},Ya=new w,ch=new Be,Le=class{constructor(t=new w(1/0,1/0,1/0),e=new w(-1/0,-1/0,-1/0)){this.isBox3=!0,this.min=t,this.max=e}set(t,e){return this.min.copy(t),this.max.copy(e),this}setFromArray(t){this.makeEmpty();for(let e=0,n=t.length;e<n;e+=3)this.expandByPoint(tn.fromArray(t,e));return this}setFromBufferAttribute(t){this.makeEmpty();for(let e=0,n=t.count;e<n;e++)this.expandByPoint(tn.fromBufferAttribute(t,e));return this}setFromPoints(t){this.makeEmpty();for(let e=0,n=t.length;e<n;e++)this.expandByPoint(t[e]);return this}setFromCenterAndSize(t,e){let n=tn.copy(e).multiplyScalar(.5);return this.min.copy(t).sub(n),this.max.copy(t).add(n),this}setFromObject(t,e=!1){return this.makeEmpty(),this.expandByObject(t,e)}clone(){return new this.constructor().copy(this)}copy(t){return this.min.copy(t.min),this.max.copy(t.max),this}makeEmpty(){return this.min.x=this.min.y=this.min.z=1/0,this.max.x=this.max.y=this.max.z=-1/0,this}isEmpty(){return this.max.x<this.min.x||this.max.y<this.min.y||this.max.z<this.min.z}getCenter(t){return this.isEmpty()?t.set(0,0,0):t.addVectors(this.min,this.max).multiplyScalar(.5)}getSize(t){return this.isEmpty()?t.set(0,0,0):t.subVectors(this.max,this.min)}expandByPoint(t){return this.min.min(t),this.max.max(t),this}expandByVector(t){return this.min.sub(t),this.max.add(t),this}expandByScalar(t){return this.min.addScalar(-t),this.max.addScalar(t),this}expandByObject(t,e=!1){t.updateWorldMatrix(!1,!1);let n=t.geometry;if(n!==void 0){let s=n.getAttribute("position");if(e===!0&&s!==void 0&&t.isInstancedMesh!==!0)for(let a=0,o=s.count;a<o;a++)t.isMesh===!0?t.getVertexPosition(a,tn):tn.fromBufferAttribute(s,a),tn.applyMatrix4(t.matrixWorld),this.expandByPoint(tn);else t.boundingBox!==void 0?(t.boundingBox===null&&t.computeBoundingBox(),Ks.copy(t.boundingBox)):(n.boundingBox===null&&n.computeBoundingBox(),Ks.copy(n.boundingBox)),Ks.applyMatrix4(t.matrixWorld),this.union(Ks)}let i=t.children;for(let s=0,a=i.length;s<a;s++)this.expandByObject(i[s],e);return this}containsPoint(t){return!(t.x<this.min.x||t.x>this.max.x||t.y<this.min.y||t.y>this.max.y||t.z<this.min.z||t.z>this.max.z)}containsBox(t){return this.min.x<=t.min.x&&t.max.x<=this.max.x&&this.min.y<=t.min.y&&t.max.y<=this.max.y&&this.min.z<=t.min.z&&t.max.z<=this.max.z}getParameter(t,e){return e.set((t.x-this.min.x)/(this.max.x-this.min.x),(t.y-this.min.y)/(this.max.y-this.min.y),(t.z-this.min.z)/(this.max.z-this.min.z))}intersectsBox(t){return!(t.max.x<this.min.x||t.min.x>this.max.x||t.max.y<this.min.y||t.min.y>this.max.y||t.max.z<this.min.z||t.min.z>this.max.z)}intersectsSphere(t){return this.clampPoint(t.center,tn),tn.distanceToSquared(t.center)<=t.radius*t.radius}intersectsPlane(t){let e,n;return t.normal.x>0?(e=t.normal.x*this.min.x,n=t.normal.x*this.max.x):(e=t.normal.x*this.max.x,n=t.normal.x*this.min.x),t.normal.y>0?(e+=t.normal.y*this.min.y,n+=t.normal.y*this.max.y):(e+=t.normal.y*this.max.y,n+=t.normal.y*this.min.y),t.normal.z>0?(e+=t.normal.z*this.min.z,n+=t.normal.z*this.max.z):(e+=t.normal.z*this.max.z,n+=t.normal.z*this.min.z),e<=-t.constant&&n>=-t.constant}intersectsTriangle(t){if(this.isEmpty())return!1;this.getCenter(ms),Qs.subVectors(this.max,ms),Ai.subVectors(t.a,ms),Ti.subVectors(t.b,ms),wi.subVectors(t.c,ms),Rn.subVectors(Ti,Ai),Cn.subVectors(wi,Ti),$n.subVectors(Ai,wi);let e=[0,-Rn.z,Rn.y,0,-Cn.z,Cn.y,0,-$n.z,$n.y,Rn.z,0,-Rn.x,Cn.z,0,-Cn.x,$n.z,0,-$n.x,-Rn.y,Rn.x,0,-Cn.y,Cn.x,0,-$n.y,$n.x,0];return!Za(e,Ai,Ti,wi,Qs)||(e=[1,0,0,0,1,0,0,0,1],!Za(e,Ai,Ti,wi,Qs))?!1:(js.crossVectors(Rn,Cn),e=[js.x,js.y,js.z],Za(e,Ai,Ti,wi,Qs))}clampPoint(t,e){return e.copy(t).clamp(this.min,this.max)}distanceToPoint(t){return this.clampPoint(t,tn).distanceTo(t)}getBoundingSphere(t){return this.isEmpty()?t.makeEmpty():(this.getCenter(t.center),t.radius=this.getSize(tn).length()*.5),t}intersect(t){return this.min.max(t.min),this.max.min(t.max),this.isEmpty()&&this.makeEmpty(),this}union(t){return this.min.min(t.min),this.max.max(t.max),this}applyMatrix4(t){return this.isEmpty()?this:(fn[0].set(this.min.x,this.min.y,this.min.z).applyMatrix4(t),fn[1].set(this.min.x,this.min.y,this.max.z).applyMatrix4(t),fn[2].set(this.min.x,this.max.y,this.min.z).applyMatrix4(t),fn[3].set(this.min.x,this.max.y,this.max.z).applyMatrix4(t),fn[4].set(this.max.x,this.min.y,this.min.z).applyMatrix4(t),fn[5].set(this.max.x,this.min.y,this.max.z).applyMatrix4(t),fn[6].set(this.max.x,this.max.y,this.min.z).applyMatrix4(t),fn[7].set(this.max.x,this.max.y,this.max.z).applyMatrix4(t),this.setFromPoints(fn),this)}translate(t){return this.min.add(t),this.max.add(t),this}equals(t){return t.min.equals(this.min)&&t.max.equals(this.max)}},fn=[new w,new w,new w,new w,new w,new w,new w,new w],tn=new w,Ks=new Le,Ai=new w,Ti=new w,wi=new w,Rn=new w,Cn=new w,$n=new w,ms=new w,Qs=new w,js=new w,Kn=new w;function Za(r,t,e,n,i){for(let s=0,a=r.length-3;s<=a;s+=3){Kn.fromArray(r,s);let o=i.x*Math.abs(Kn.x)+i.y*Math.abs(Kn.y)+i.z*Math.abs(Kn.z),c=t.dot(Kn),l=e.dot(Kn),h=n.dot(Kn);if(Math.max(-Math.max(c,l,h),Math.min(c,l,h))>o)return!1}return!0}var Cp=new Le,gs=new w,Ja=new w,Ae=class{constructor(t=new w,e=-1){this.isSphere=!0,this.center=t,this.radius=e}set(t,e){return this.center.copy(t),this.radius=e,this}setFromPoints(t,e){let n=this.center;e!==void 0?n.copy(e):Cp.setFromPoints(t).getCenter(n);let i=0;for(let s=0,a=t.length;s<a;s++)i=Math.max(i,n.distanceToSquared(t[s]));return this.radius=Math.sqrt(i),this}copy(t){return this.center.copy(t.center),this.radius=t.radius,this}isEmpty(){return this.radius<0}makeEmpty(){return this.center.set(0,0,0),this.radius=-1,this}containsPoint(t){return t.distanceToSquared(this.center)<=this.radius*this.radius}distanceToPoint(t){return t.distanceTo(this.center)-this.radius}intersectsSphere(t){let e=this.radius+t.radius;return t.center.distanceToSquared(this.center)<=e*e}intersectsBox(t){return t.intersectsSphere(this)}intersectsPlane(t){return Math.abs(t.distanceToPoint(this.center))<=this.radius}clampPoint(t,e){let n=this.center.distanceToSquared(t);return e.copy(t),n>this.radius*this.radius&&(e.sub(this.center).normalize(),e.multiplyScalar(this.radius).add(this.center)),e}getBoundingBox(t){return this.isEmpty()?(t.makeEmpty(),t):(t.set(this.center,this.center),t.expandByScalar(this.radius),t)}applyMatrix4(t){return this.center.applyMatrix4(t),this.radius=this.radius*t.getMaxScaleOnAxis(),this}translate(t){return this.center.add(t),this}expandByPoint(t){if(this.isEmpty())return this.center.copy(t),this.radius=0,this;gs.subVectors(t,this.center);let e=gs.lengthSq();if(e>this.radius*this.radius){let n=Math.sqrt(e),i=(n-this.radius)*.5;this.center.addScaledVector(gs,i/n),this.radius+=i}return this}union(t){return t.isEmpty()?this:this.isEmpty()?(this.copy(t),this):(this.center.equals(t.center)===!0?this.radius=Math.max(this.radius,t.radius):(Ja.subVectors(t.center,this.center).setLength(t.radius),this.expandByPoint(gs.copy(t.center).add(Ja)),this.expandByPoint(gs.copy(t.center).sub(Ja))),this)}equals(t){return t.center.equals(this.center)&&t.radius===this.radius}clone(){return new this.constructor().copy(this)}},pn=new w,$a=new w,tr=new w,Pn=new w,Ka=new w,er=new w,Qa=new w,_i=class{constructor(t=new w,e=new w(0,0,-1)){this.origin=t,this.direction=e}set(t,e){return this.origin.copy(t),this.direction.copy(e),this}copy(t){return this.origin.copy(t.origin),this.direction.copy(t.direction),this}at(t,e){return e.copy(this.origin).addScaledVector(this.direction,t)}lookAt(t){return this.direction.copy(t).sub(this.origin).normalize(),this}recast(t){return this.origin.copy(this.at(t,pn)),this}closestPointToPoint(t,e){e.subVectors(t,this.origin);let n=e.dot(this.direction);return n<0?e.copy(this.origin):e.copy(this.origin).addScaledVector(this.direction,n)}distanceToPoint(t){return Math.sqrt(this.distanceSqToPoint(t))}distanceSqToPoint(t){let e=pn.subVectors(t,this.origin).dot(this.direction);return e<0?this.origin.distanceToSquared(t):(pn.copy(this.origin).addScaledVector(this.direction,e),pn.distanceToSquared(t))}distanceSqToSegment(t,e,n,i){$a.copy(t).add(e).multiplyScalar(.5),tr.copy(e).sub(t).normalize(),Pn.copy(this.origin).sub($a);let s=t.distanceTo(e)*.5,a=-this.direction.dot(tr),o=Pn.dot(this.direction),c=-Pn.dot(tr),l=Pn.lengthSq(),h=Math.abs(1-a*a),u,d,f,m;if(h>0)if(u=a*c-o,d=a*o-c,m=s*h,u>=0)if(d>=-m)if(d<=m){let _=1/h;u*=_,d*=_,f=u*(u+a*d+2*o)+d*(a*u+d+2*c)+l}else d=s,u=Math.max(0,-(a*d+o)),f=-u*u+d*(d+2*c)+l;else d=-s,u=Math.max(0,-(a*d+o)),f=-u*u+d*(d+2*c)+l;else d<=-m?(u=Math.max(0,-(-a*s+o)),d=u>0?-s:Math.min(Math.max(-s,-c),s),f=-u*u+d*(d+2*c)+l):d<=m?(u=0,d=Math.min(Math.max(-s,-c),s),f=d*(d+2*c)+l):(u=Math.max(0,-(a*s+o)),d=u>0?s:Math.min(Math.max(-s,-c),s),f=-u*u+d*(d+2*c)+l);else d=a>0?-s:s,u=Math.max(0,-(a*d+o)),f=-u*u+d*(d+2*c)+l;return n&&n.copy(this.origin).addScaledVector(this.direction,u),i&&i.copy($a).addScaledVector(tr,d),f}intersectSphere(t,e){pn.subVectors(t.center,this.origin);let n=pn.dot(this.direction),i=pn.dot(pn)-n*n,s=t.radius*t.radius;if(i>s)return null;let a=Math.sqrt(s-i),o=n-a,c=n+a;return c<0?null:o<0?this.at(c,e):this.at(o,e)}intersectsSphere(t){return this.distanceSqToPoint(t.center)<=t.radius*t.radius}distanceToPlane(t){let e=t.normal.dot(this.direction);if(e===0)return t.distanceToPoint(this.origin)===0?0:null;let n=-(this.origin.dot(t.normal)+t.constant)/e;return n>=0?n:null}intersectPlane(t,e){let n=this.distanceToPlane(t);return n===null?null:this.at(n,e)}intersectsPlane(t){let e=t.distanceToPoint(this.origin);return e===0||t.normal.dot(this.direction)*e<0}intersectBox(t,e){let n,i,s,a,o,c,l=1/this.direction.x,h=1/this.direction.y,u=1/this.direction.z,d=this.origin;return l>=0?(n=(t.min.x-d.x)*l,i=(t.max.x-d.x)*l):(n=(t.max.x-d.x)*l,i=(t.min.x-d.x)*l),h>=0?(s=(t.min.y-d.y)*h,a=(t.max.y-d.y)*h):(s=(t.max.y-d.y)*h,a=(t.min.y-d.y)*h),n>a||s>i||((s>n||isNaN(n))&&(n=s),(a<i||isNaN(i))&&(i=a),u>=0?(o=(t.min.z-d.z)*u,c=(t.max.z-d.z)*u):(o=(t.max.z-d.z)*u,c=(t.min.z-d.z)*u),n>c||o>i)||((o>n||n!==n)&&(n=o),(c<i||i!==i)&&(i=c),i<0)?null:this.at(n>=0?n:i,e)}intersectsBox(t){return this.intersectBox(t,pn)!==null}intersectTriangle(t,e,n,i,s){Ka.subVectors(e,t),er.subVectors(n,t),Qa.crossVectors(Ka,er);let a=this.direction.dot(Qa),o;if(a>0){if(i)return null;o=1}else if(a<0)o=-1,a=-a;else return null;Pn.subVectors(this.origin,t);let c=o*this.direction.dot(er.crossVectors(Pn,er));if(c<0)return null;let l=o*this.direction.dot(Ka.cross(Pn));if(l<0||c+l>a)return null;let h=-o*Pn.dot(Qa);return h<0?null:this.at(h/a,s)}applyMatrix4(t){return this.origin.applyMatrix4(t),this.direction.transformDirection(t),this}equals(t){return t.origin.equals(this.origin)&&t.direction.equals(this.direction)}clone(){return new this.constructor().copy(this)}},It=class r{constructor(t,e,n,i,s,a,o,c,l,h,u,d,f,m,_,g){r.prototype.isMatrix4=!0,this.elements=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],t!==void 0&&this.set(t,e,n,i,s,a,o,c,l,h,u,d,f,m,_,g)}set(t,e,n,i,s,a,o,c,l,h,u,d,f,m,_,g){let p=this.elements;return p[0]=t,p[4]=e,p[8]=n,p[12]=i,p[1]=s,p[5]=a,p[9]=o,p[13]=c,p[2]=l,p[6]=h,p[10]=u,p[14]=d,p[3]=f,p[7]=m,p[11]=_,p[15]=g,this}identity(){return this.set(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1),this}clone(){return new r().fromArray(this.elements)}copy(t){let e=this.elements,n=t.elements;return e[0]=n[0],e[1]=n[1],e[2]=n[2],e[3]=n[3],e[4]=n[4],e[5]=n[5],e[6]=n[6],e[7]=n[7],e[8]=n[8],e[9]=n[9],e[10]=n[10],e[11]=n[11],e[12]=n[12],e[13]=n[13],e[14]=n[14],e[15]=n[15],this}copyPosition(t){let e=this.elements,n=t.elements;return e[12]=n[12],e[13]=n[13],e[14]=n[14],this}setFromMatrix3(t){let e=t.elements;return this.set(e[0],e[3],e[6],0,e[1],e[4],e[7],0,e[2],e[5],e[8],0,0,0,0,1),this}extractBasis(t,e,n){return t.setFromMatrixColumn(this,0),e.setFromMatrixColumn(this,1),n.setFromMatrixColumn(this,2),this}makeBasis(t,e,n){return this.set(t.x,e.x,n.x,0,t.y,e.y,n.y,0,t.z,e.z,n.z,0,0,0,0,1),this}extractRotation(t){let e=this.elements,n=t.elements,i=1/Ri.setFromMatrixColumn(t,0).length(),s=1/Ri.setFromMatrixColumn(t,1).length(),a=1/Ri.setFromMatrixColumn(t,2).length();return e[0]=n[0]*i,e[1]=n[1]*i,e[2]=n[2]*i,e[3]=0,e[4]=n[4]*s,e[5]=n[5]*s,e[6]=n[6]*s,e[7]=0,e[8]=n[8]*a,e[9]=n[9]*a,e[10]=n[10]*a,e[11]=0,e[12]=0,e[13]=0,e[14]=0,e[15]=1,this}makeRotationFromEuler(t){let e=this.elements,n=t.x,i=t.y,s=t.z,a=Math.cos(n),o=Math.sin(n),c=Math.cos(i),l=Math.sin(i),h=Math.cos(s),u=Math.sin(s);if(t.order==="XYZ"){let d=a*h,f=a*u,m=o*h,_=o*u;e[0]=c*h,e[4]=-c*u,e[8]=l,e[1]=f+m*l,e[5]=d-_*l,e[9]=-o*c,e[2]=_-d*l,e[6]=m+f*l,e[10]=a*c}else if(t.order==="YXZ"){let d=c*h,f=c*u,m=l*h,_=l*u;e[0]=d+_*o,e[4]=m*o-f,e[8]=a*l,e[1]=a*u,e[5]=a*h,e[9]=-o,e[2]=f*o-m,e[6]=_+d*o,e[10]=a*c}else if(t.order==="ZXY"){let d=c*h,f=c*u,m=l*h,_=l*u;e[0]=d-_*o,e[4]=-a*u,e[8]=m+f*o,e[1]=f+m*o,e[5]=a*h,e[9]=_-d*o,e[2]=-a*l,e[6]=o,e[10]=a*c}else if(t.order==="ZYX"){let d=a*h,f=a*u,m=o*h,_=o*u;e[0]=c*h,e[4]=m*l-f,e[8]=d*l+_,e[1]=c*u,e[5]=_*l+d,e[9]=f*l-m,e[2]=-l,e[6]=o*c,e[10]=a*c}else if(t.order==="YZX"){let d=a*c,f=a*l,m=o*c,_=o*l;e[0]=c*h,e[4]=_-d*u,e[8]=m*u+f,e[1]=u,e[5]=a*h,e[9]=-o*h,e[2]=-l*h,e[6]=f*u+m,e[10]=d-_*u}else if(t.order==="XZY"){let d=a*c,f=a*l,m=o*c,_=o*l;e[0]=c*h,e[4]=-u,e[8]=l*h,e[1]=d*u+_,e[5]=a*h,e[9]=f*u-m,e[2]=m*u-f,e[6]=o*h,e[10]=_*u+d}return e[3]=0,e[7]=0,e[11]=0,e[12]=0,e[13]=0,e[14]=0,e[15]=1,this}makeRotationFromQuaternion(t){return this.compose(Pp,t,Lp)}lookAt(t,e,n){let i=this.elements;return We.subVectors(t,e),We.lengthSq()===0&&(We.z=1),We.normalize(),Ln.crossVectors(n,We),Ln.lengthSq()===0&&(Math.abs(n.z)===1?We.x+=1e-4:We.z+=1e-4,We.normalize(),Ln.crossVectors(n,We)),Ln.normalize(),nr.crossVectors(We,Ln),i[0]=Ln.x,i[4]=nr.x,i[8]=We.x,i[1]=Ln.y,i[5]=nr.y,i[9]=We.y,i[2]=Ln.z,i[6]=nr.z,i[10]=We.z,this}multiply(t){return this.multiplyMatrices(this,t)}premultiply(t){return this.multiplyMatrices(t,this)}multiplyMatrices(t,e){let n=t.elements,i=e.elements,s=this.elements,a=n[0],o=n[4],c=n[8],l=n[12],h=n[1],u=n[5],d=n[9],f=n[13],m=n[2],_=n[6],g=n[10],p=n[14],v=n[3],x=n[7],y=n[11],C=n[15],T=i[0],R=i[4],U=i[8],S=i[12],E=i[1],N=i[5],G=i[9],it=i[13],I=i[2],F=i[6],k=i[10],J=i[14],Y=i[3],W=i[7],tt=i[11],et=i[15];return s[0]=a*T+o*E+c*I+l*Y,s[4]=a*R+o*N+c*F+l*W,s[8]=a*U+o*G+c*k+l*tt,s[12]=a*S+o*it+c*J+l*et,s[1]=h*T+u*E+d*I+f*Y,s[5]=h*R+u*N+d*F+f*W,s[9]=h*U+u*G+d*k+f*tt,s[13]=h*S+u*it+d*J+f*et,s[2]=m*T+_*E+g*I+p*Y,s[6]=m*R+_*N+g*F+p*W,s[10]=m*U+_*G+g*k+p*tt,s[14]=m*S+_*it+g*J+p*et,s[3]=v*T+x*E+y*I+C*Y,s[7]=v*R+x*N+y*F+C*W,s[11]=v*U+x*G+y*k+C*tt,s[15]=v*S+x*it+y*J+C*et,this}multiplyScalar(t){let e=this.elements;return e[0]*=t,e[4]*=t,e[8]*=t,e[12]*=t,e[1]*=t,e[5]*=t,e[9]*=t,e[13]*=t,e[2]*=t,e[6]*=t,e[10]*=t,e[14]*=t,e[3]*=t,e[7]*=t,e[11]*=t,e[15]*=t,this}determinant(){let t=this.elements,e=t[0],n=t[4],i=t[8],s=t[12],a=t[1],o=t[5],c=t[9],l=t[13],h=t[2],u=t[6],d=t[10],f=t[14],m=t[3],_=t[7],g=t[11],p=t[15];return m*(+s*c*u-i*l*u-s*o*d+n*l*d+i*o*f-n*c*f)+_*(+e*c*f-e*l*d+s*a*d-i*a*f+i*l*h-s*c*h)+g*(+e*l*u-e*o*f-s*a*u+n*a*f+s*o*h-n*l*h)+p*(-i*o*h-e*c*u+e*o*d+i*a*u-n*a*d+n*c*h)}transpose(){let t=this.elements,e;return e=t[1],t[1]=t[4],t[4]=e,e=t[2],t[2]=t[8],t[8]=e,e=t[6],t[6]=t[9],t[9]=e,e=t[3],t[3]=t[12],t[12]=e,e=t[7],t[7]=t[13],t[13]=e,e=t[11],t[11]=t[14],t[14]=e,this}setPosition(t,e,n){let i=this.elements;return t.isVector3?(i[12]=t.x,i[13]=t.y,i[14]=t.z):(i[12]=t,i[13]=e,i[14]=n),this}invert(){let t=this.elements,e=t[0],n=t[1],i=t[2],s=t[3],a=t[4],o=t[5],c=t[6],l=t[7],h=t[8],u=t[9],d=t[10],f=t[11],m=t[12],_=t[13],g=t[14],p=t[15],v=u*g*l-_*d*l+_*c*f-o*g*f-u*c*p+o*d*p,x=m*d*l-h*g*l-m*c*f+a*g*f+h*c*p-a*d*p,y=h*_*l-m*u*l+m*o*f-a*_*f-h*o*p+a*u*p,C=m*u*c-h*_*c-m*o*d+a*_*d+h*o*g-a*u*g,T=e*v+n*x+i*y+s*C;if(T===0)return this.set(0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0);let R=1/T;return t[0]=v*R,t[1]=(_*d*s-u*g*s-_*i*f+n*g*f+u*i*p-n*d*p)*R,t[2]=(o*g*s-_*c*s+_*i*l-n*g*l-o*i*p+n*c*p)*R,t[3]=(u*c*s-o*d*s-u*i*l+n*d*l+o*i*f-n*c*f)*R,t[4]=x*R,t[5]=(h*g*s-m*d*s+m*i*f-e*g*f-h*i*p+e*d*p)*R,t[6]=(m*c*s-a*g*s-m*i*l+e*g*l+a*i*p-e*c*p)*R,t[7]=(a*d*s-h*c*s+h*i*l-e*d*l-a*i*f+e*c*f)*R,t[8]=y*R,t[9]=(m*u*s-h*_*s-m*n*f+e*_*f+h*n*p-e*u*p)*R,t[10]=(a*_*s-m*o*s+m*n*l-e*_*l-a*n*p+e*o*p)*R,t[11]=(h*o*s-a*u*s-h*n*l+e*u*l+a*n*f-e*o*f)*R,t[12]=C*R,t[13]=(h*_*i-m*u*i+m*n*d-e*_*d-h*n*g+e*u*g)*R,t[14]=(m*o*i-a*_*i-m*n*c+e*_*c+a*n*g-e*o*g)*R,t[15]=(a*u*i-h*o*i+h*n*c-e*u*c-a*n*d+e*o*d)*R,this}scale(t){let e=this.elements,n=t.x,i=t.y,s=t.z;return e[0]*=n,e[4]*=i,e[8]*=s,e[1]*=n,e[5]*=i,e[9]*=s,e[2]*=n,e[6]*=i,e[10]*=s,e[3]*=n,e[7]*=i,e[11]*=s,this}getMaxScaleOnAxis(){let t=this.elements,e=t[0]*t[0]+t[1]*t[1]+t[2]*t[2],n=t[4]*t[4]+t[5]*t[5]+t[6]*t[6],i=t[8]*t[8]+t[9]*t[9]+t[10]*t[10];return Math.sqrt(Math.max(e,n,i))}makeTranslation(t,e,n){return t.isVector3?this.set(1,0,0,t.x,0,1,0,t.y,0,0,1,t.z,0,0,0,1):this.set(1,0,0,t,0,1,0,e,0,0,1,n,0,0,0,1),this}makeRotationX(t){let e=Math.cos(t),n=Math.sin(t);return this.set(1,0,0,0,0,e,-n,0,0,n,e,0,0,0,0,1),this}makeRotationY(t){let e=Math.cos(t),n=Math.sin(t);return this.set(e,0,n,0,0,1,0,0,-n,0,e,0,0,0,0,1),this}makeRotationZ(t){let e=Math.cos(t),n=Math.sin(t);return this.set(e,-n,0,0,n,e,0,0,0,0,1,0,0,0,0,1),this}makeRotationAxis(t,e){let n=Math.cos(e),i=Math.sin(e),s=1-n,a=t.x,o=t.y,c=t.z,l=s*a,h=s*o;return this.set(l*a+n,l*o-i*c,l*c+i*o,0,l*o+i*c,h*o+n,h*c-i*a,0,l*c-i*o,h*c+i*a,s*c*c+n,0,0,0,0,1),this}makeScale(t,e,n){return this.set(t,0,0,0,0,e,0,0,0,0,n,0,0,0,0,1),this}makeShear(t,e,n,i,s,a){return this.set(1,n,s,0,t,1,a,0,e,i,1,0,0,0,0,1),this}compose(t,e,n){let i=this.elements,s=e._x,a=e._y,o=e._z,c=e._w,l=s+s,h=a+a,u=o+o,d=s*l,f=s*h,m=s*u,_=a*h,g=a*u,p=o*u,v=c*l,x=c*h,y=c*u,C=n.x,T=n.y,R=n.z;return i[0]=(1-(_+p))*C,i[1]=(f+y)*C,i[2]=(m-x)*C,i[3]=0,i[4]=(f-y)*T,i[5]=(1-(d+p))*T,i[6]=(g+v)*T,i[7]=0,i[8]=(m+x)*R,i[9]=(g-v)*R,i[10]=(1-(d+_))*R,i[11]=0,i[12]=t.x,i[13]=t.y,i[14]=t.z,i[15]=1,this}decompose(t,e,n){let i=this.elements,s=Ri.set(i[0],i[1],i[2]).length(),a=Ri.set(i[4],i[5],i[6]).length(),o=Ri.set(i[8],i[9],i[10]).length();this.determinant()<0&&(s=-s),t.x=i[12],t.y=i[13],t.z=i[14],en.copy(this);let l=1/s,h=1/a,u=1/o;return en.elements[0]*=l,en.elements[1]*=l,en.elements[2]*=l,en.elements[4]*=h,en.elements[5]*=h,en.elements[6]*=h,en.elements[8]*=u,en.elements[9]*=u,en.elements[10]*=u,e.setFromRotationMatrix(en),n.x=s,n.y=a,n.z=o,this}makePerspective(t,e,n,i,s,a,o=ln){let c=this.elements,l=2*s/(e-t),h=2*s/(n-i),u=(e+t)/(e-t),d=(n+i)/(n-i),f,m;if(o===ln)f=-(a+s)/(a-s),m=-2*a*s/(a-s);else if(o===Us)f=-a/(a-s),m=-a*s/(a-s);else throw new Error("THREE.Matrix4.makePerspective(): Invalid coordinate system: "+o);return c[0]=l,c[4]=0,c[8]=u,c[12]=0,c[1]=0,c[5]=h,c[9]=d,c[13]=0,c[2]=0,c[6]=0,c[10]=f,c[14]=m,c[3]=0,c[7]=0,c[11]=-1,c[15]=0,this}makeOrthographic(t,e,n,i,s,a,o=ln){let c=this.elements,l=1/(e-t),h=1/(n-i),u=1/(a-s),d=(e+t)*l,f=(n+i)*h,m,_;if(o===ln)m=(a+s)*u,_=-2*u;else if(o===Us)m=s*u,_=-1*u;else throw new Error("THREE.Matrix4.makeOrthographic(): Invalid coordinate system: "+o);return c[0]=2*l,c[4]=0,c[8]=0,c[12]=-d,c[1]=0,c[5]=2*h,c[9]=0,c[13]=-f,c[2]=0,c[6]=0,c[10]=_,c[14]=-m,c[3]=0,c[7]=0,c[11]=0,c[15]=1,this}equals(t){let e=this.elements,n=t.elements;for(let i=0;i<16;i++)if(e[i]!==n[i])return!1;return!0}fromArray(t,e=0){for(let n=0;n<16;n++)this.elements[n]=t[n+e];return this}toArray(t=[],e=0){let n=this.elements;return t[e]=n[0],t[e+1]=n[1],t[e+2]=n[2],t[e+3]=n[3],t[e+4]=n[4],t[e+5]=n[5],t[e+6]=n[6],t[e+7]=n[7],t[e+8]=n[8],t[e+9]=n[9],t[e+10]=n[10],t[e+11]=n[11],t[e+12]=n[12],t[e+13]=n[13],t[e+14]=n[14],t[e+15]=n[15],t}},Ri=new w,en=new It,Pp=new w(0,0,0),Lp=new w(1,1,1),Ln=new w,nr=new w,We=new w,lh=new It,hh=new Be,sa=class r{constructor(t=0,e=0,n=0,i=r.DEFAULT_ORDER){this.isEuler=!0,this._x=t,this._y=e,this._z=n,this._order=i}get x(){return this._x}set x(t){this._x=t,this._onChangeCallback()}get y(){return this._y}set y(t){this._y=t,this._onChangeCallback()}get z(){return this._z}set z(t){this._z=t,this._onChangeCallback()}get order(){return this._order}set order(t){this._order=t,this._onChangeCallback()}set(t,e,n,i=this._order){return this._x=t,this._y=e,this._z=n,this._order=i,this._onChangeCallback(),this}clone(){return new this.constructor(this._x,this._y,this._z,this._order)}copy(t){return this._x=t._x,this._y=t._y,this._z=t._z,this._order=t._order,this._onChangeCallback(),this}setFromRotationMatrix(t,e=this._order,n=!0){let i=t.elements,s=i[0],a=i[4],o=i[8],c=i[1],l=i[5],h=i[9],u=i[2],d=i[6],f=i[10];switch(e){case"XYZ":this._y=Math.asin(he(o,-1,1)),Math.abs(o)<.9999999?(this._x=Math.atan2(-h,f),this._z=Math.atan2(-a,s)):(this._x=Math.atan2(d,l),this._z=0);break;case"YXZ":this._x=Math.asin(-he(h,-1,1)),Math.abs(h)<.9999999?(this._y=Math.atan2(o,f),this._z=Math.atan2(c,l)):(this._y=Math.atan2(-u,s),this._z=0);break;case"ZXY":this._x=Math.asin(he(d,-1,1)),Math.abs(d)<.9999999?(this._y=Math.atan2(-u,f),this._z=Math.atan2(-a,l)):(this._y=0,this._z=Math.atan2(c,s));break;case"ZYX":this._y=Math.asin(-he(u,-1,1)),Math.abs(u)<.9999999?(this._x=Math.atan2(d,f),this._z=Math.atan2(c,s)):(this._x=0,this._z=Math.atan2(-a,l));break;case"YZX":this._z=Math.asin(he(c,-1,1)),Math.abs(c)<.9999999?(this._x=Math.atan2(-h,l),this._y=Math.atan2(-u,s)):(this._x=0,this._y=Math.atan2(o,f));break;case"XZY":this._z=Math.asin(-he(a,-1,1)),Math.abs(a)<.9999999?(this._x=Math.atan2(d,l),this._y=Math.atan2(o,s)):(this._x=Math.atan2(-h,f),this._y=0);break;default:console.warn("THREE.Euler: .setFromRotationMatrix() encountered an unknown order: "+e)}return this._order=e,n===!0&&this._onChangeCallback(),this}setFromQuaternion(t,e,n){return lh.makeRotationFromQuaternion(t),this.setFromRotationMatrix(lh,e,n)}setFromVector3(t,e=this._order){return this.set(t.x,t.y,t.z,e)}reorder(t){return hh.setFromEuler(this),this.setFromQuaternion(hh,t)}equals(t){return t._x===this._x&&t._y===this._y&&t._z===this._z&&t._order===this._order}fromArray(t){return this._x=t[0],this._y=t[1],this._z=t[2],t[3]!==void 0&&(this._order=t[3]),this._onChangeCallback(),this}toArray(t=[],e=0){return t[e]=this._x,t[e+1]=this._y,t[e+2]=this._z,t[e+3]=this._order,t}_onChange(t){return this._onChangeCallback=t,this}_onChangeCallback(){}*[Symbol.iterator](){yield this._x,yield this._y,yield this._z,yield this._order}};sa.DEFAULT_ORDER="XYZ";var Os=class{constructor(){this.mask=1}set(t){this.mask=(1<<t|0)>>>0}enable(t){this.mask|=1<<t|0}enableAll(){this.mask=-1}toggle(t){this.mask^=1<<t|0}disable(t){this.mask&=~(1<<t|0)}disableAll(){this.mask=0}test(t){return(this.mask&t.mask)!==0}isEnabled(t){return(this.mask&(1<<t|0))!==0}},Ip=0,uh=new w,Ci=new Be,mn=new It,ir=new w,_s=new w,Up=new w,Dp=new Be,dh=new w(1,0,0),fh=new w(0,1,0),ph=new w(0,0,1),Np={type:"added"},Op={type:"removed"},Kt=class r extends hn{constructor(){super(),this.isObject3D=!0,Object.defineProperty(this,"id",{value:Ip++}),this.uuid=Ye(),this.name="",this.type="Object3D",this.parent=null,this.children=[],this.up=r.DEFAULT_UP.clone();let t=new w,e=new sa,n=new Be,i=new w(1,1,1);function s(){n.setFromEuler(e,!1)}function a(){e.setFromQuaternion(n,void 0,!1)}e._onChange(s),n._onChange(a),Object.defineProperties(this,{position:{configurable:!0,enumerable:!0,value:t},rotation:{configurable:!0,enumerable:!0,value:e},quaternion:{configurable:!0,enumerable:!0,value:n},scale:{configurable:!0,enumerable:!0,value:i},modelViewMatrix:{value:new It},normalMatrix:{value:new Gt}}),this.matrix=new It,this.matrixWorld=new It,this.matrixAutoUpdate=r.DEFAULT_MATRIX_AUTO_UPDATE,this.matrixWorldAutoUpdate=r.DEFAULT_MATRIX_WORLD_AUTO_UPDATE,this.matrixWorldNeedsUpdate=!1,this.layers=new Os,this.visible=!0,this.castShadow=!1,this.receiveShadow=!1,this.frustumCulled=!0,this.renderOrder=0,this.animations=[],this.userData={}}onBeforeShadow(){}onAfterShadow(){}onBeforeRender(){}onAfterRender(){}applyMatrix4(t){this.matrixAutoUpdate&&this.updateMatrix(),this.matrix.premultiply(t),this.matrix.decompose(this.position,this.quaternion,this.scale)}applyQuaternion(t){return this.quaternion.premultiply(t),this}setRotationFromAxisAngle(t,e){this.quaternion.setFromAxisAngle(t,e)}setRotationFromEuler(t){this.quaternion.setFromEuler(t,!0)}setRotationFromMatrix(t){this.quaternion.setFromRotationMatrix(t)}setRotationFromQuaternion(t){this.quaternion.copy(t)}rotateOnAxis(t,e){return Ci.setFromAxisAngle(t,e),this.quaternion.multiply(Ci),this}rotateOnWorldAxis(t,e){return Ci.setFromAxisAngle(t,e),this.quaternion.premultiply(Ci),this}rotateX(t){return this.rotateOnAxis(dh,t)}rotateY(t){return this.rotateOnAxis(fh,t)}rotateZ(t){return this.rotateOnAxis(ph,t)}translateOnAxis(t,e){return uh.copy(t).applyQuaternion(this.quaternion),this.position.add(uh.multiplyScalar(e)),this}translateX(t){return this.translateOnAxis(dh,t)}translateY(t){return this.translateOnAxis(fh,t)}translateZ(t){return this.translateOnAxis(ph,t)}localToWorld(t){return this.updateWorldMatrix(!0,!1),t.applyMatrix4(this.matrixWorld)}worldToLocal(t){return this.updateWorldMatrix(!0,!1),t.applyMatrix4(mn.copy(this.matrixWorld).invert())}lookAt(t,e,n){t.isVector3?ir.copy(t):ir.set(t,e,n);let i=this.parent;this.updateWorldMatrix(!0,!1),_s.setFromMatrixPosition(this.matrixWorld),this.isCamera||this.isLight?mn.lookAt(_s,ir,this.up):mn.lookAt(ir,_s,this.up),this.quaternion.setFromRotationMatrix(mn),i&&(mn.extractRotation(i.matrixWorld),Ci.setFromRotationMatrix(mn),this.quaternion.premultiply(Ci.invert()))}add(t){if(arguments.length>1){for(let e=0;e<arguments.length;e++)this.add(arguments[e]);return this}return t===this?(console.error("THREE.Object3D.add: object can't be added as a child of itself.",t),this):(t&&t.isObject3D?(t.parent!==null&&t.parent.remove(t),t.parent=this,this.children.push(t),t.dispatchEvent(Np)):console.error("THREE.Object3D.add: object not an instance of THREE.Object3D.",t),this)}remove(t){if(arguments.length>1){for(let n=0;n<arguments.length;n++)this.remove(arguments[n]);return this}let e=this.children.indexOf(t);return e!==-1&&(t.parent=null,this.children.splice(e,1),t.dispatchEvent(Op)),this}removeFromParent(){let t=this.parent;return t!==null&&t.remove(this),this}clear(){return this.remove(...this.children)}attach(t){return this.updateWorldMatrix(!0,!1),mn.copy(this.matrixWorld).invert(),t.parent!==null&&(t.parent.updateWorldMatrix(!0,!1),mn.multiply(t.parent.matrixWorld)),t.applyMatrix4(mn),this.add(t),t.updateWorldMatrix(!1,!0),this}getObjectById(t){return this.getObjectByProperty("id",t)}getObjectByName(t){return this.getObjectByProperty("name",t)}getObjectByProperty(t,e){if(this[t]===e)return this;for(let n=0,i=this.children.length;n<i;n++){let a=this.children[n].getObjectByProperty(t,e);if(a!==void 0)return a}}getObjectsByProperty(t,e,n=[]){this[t]===e&&n.push(this);let i=this.children;for(let s=0,a=i.length;s<a;s++)i[s].getObjectsByProperty(t,e,n);return n}getWorldPosition(t){return this.updateWorldMatrix(!0,!1),t.setFromMatrixPosition(this.matrixWorld)}getWorldQuaternion(t){return this.updateWorldMatrix(!0,!1),this.matrixWorld.decompose(_s,t,Up),t}getWorldScale(t){return this.updateWorldMatrix(!0,!1),this.matrixWorld.decompose(_s,Dp,t),t}getWorldDirection(t){this.updateWorldMatrix(!0,!1);let e=this.matrixWorld.elements;return t.set(e[8],e[9],e[10]).normalize()}raycast(){}traverse(t){t(this);let e=this.children;for(let n=0,i=e.length;n<i;n++)e[n].traverse(t)}traverseVisible(t){if(this.visible===!1)return;t(this);let e=this.children;for(let n=0,i=e.length;n<i;n++)e[n].traverseVisible(t)}traverseAncestors(t){let e=this.parent;e!==null&&(t(e),e.traverseAncestors(t))}updateMatrix(){this.matrix.compose(this.position,this.quaternion,this.scale),this.matrixWorldNeedsUpdate=!0}updateMatrixWorld(t){this.matrixAutoUpdate&&this.updateMatrix(),(this.matrixWorldNeedsUpdate||t)&&(this.parent===null?this.matrixWorld.copy(this.matrix):this.matrixWorld.multiplyMatrices(this.parent.matrixWorld,this.matrix),this.matrixWorldNeedsUpdate=!1,t=!0);let e=this.children;for(let n=0,i=e.length;n<i;n++){let s=e[n];(s.matrixWorldAutoUpdate===!0||t===!0)&&s.updateMatrixWorld(t)}}updateWorldMatrix(t,e){let n=this.parent;if(t===!0&&n!==null&&n.matrixWorldAutoUpdate===!0&&n.updateWorldMatrix(!0,!1),this.matrixAutoUpdate&&this.updateMatrix(),this.parent===null?this.matrixWorld.copy(this.matrix):this.matrixWorld.multiplyMatrices(this.parent.matrixWorld,this.matrix),e===!0){let i=this.children;for(let s=0,a=i.length;s<a;s++){let o=i[s];o.matrixWorldAutoUpdate===!0&&o.updateWorldMatrix(!1,!0)}}}toJSON(t){let e=t===void 0||typeof t=="string",n={};e&&(t={geometries:{},materials:{},textures:{},images:{},shapes:{},skeletons:{},animations:{},nodes:{}},n.metadata={version:4.6,type:"Object",generator:"Object3D.toJSON"});let i={};i.uuid=this.uuid,i.type=this.type,this.name!==""&&(i.name=this.name),this.castShadow===!0&&(i.castShadow=!0),this.receiveShadow===!0&&(i.receiveShadow=!0),this.visible===!1&&(i.visible=!1),this.frustumCulled===!1&&(i.frustumCulled=!1),this.renderOrder!==0&&(i.renderOrder=this.renderOrder),Object.keys(this.userData).length>0&&(i.userData=this.userData),i.layers=this.layers.mask,i.matrix=this.matrix.toArray(),i.up=this.up.toArray(),this.matrixAutoUpdate===!1&&(i.matrixAutoUpdate=!1),this.isInstancedMesh&&(i.type="InstancedMesh",i.count=this.count,i.instanceMatrix=this.instanceMatrix.toJSON(),this.instanceColor!==null&&(i.instanceColor=this.instanceColor.toJSON())),this.isBatchedMesh&&(i.type="BatchedMesh",i.perObjectFrustumCulled=this.perObjectFrustumCulled,i.sortObjects=this.sortObjects,i.drawRanges=this._drawRanges,i.reservedRanges=this._reservedRanges,i.visibility=this._visibility,i.active=this._active,i.bounds=this._bounds.map(o=>({boxInitialized:o.boxInitialized,boxMin:o.box.min.toArray(),boxMax:o.box.max.toArray(),sphereInitialized:o.sphereInitialized,sphereRadius:o.sphere.radius,sphereCenter:o.sphere.center.toArray()})),i.maxGeometryCount=this._maxGeometryCount,i.maxVertexCount=this._maxVertexCount,i.maxIndexCount=this._maxIndexCount,i.geometryInitialized=this._geometryInitialized,i.geometryCount=this._geometryCount,i.matricesTexture=this._matricesTexture.toJSON(t),this.boundingSphere!==null&&(i.boundingSphere={center:i.boundingSphere.center.toArray(),radius:i.boundingSphere.radius}),this.boundingBox!==null&&(i.boundingBox={min:i.boundingBox.min.toArray(),max:i.boundingBox.max.toArray()}));function s(o,c){return o[c.uuid]===void 0&&(o[c.uuid]=c.toJSON(t)),c.uuid}if(this.isScene)this.background&&(this.background.isColor?i.background=this.background.toJSON():this.background.isTexture&&(i.background=this.background.toJSON(t).uuid)),this.environment&&this.environment.isTexture&&this.environment.isRenderTargetTexture!==!0&&(i.environment=this.environment.toJSON(t).uuid);else if(this.isMesh||this.isLine||this.isPoints){i.geometry=s(t.geometries,this.geometry);let o=this.geometry.parameters;if(o!==void 0&&o.shapes!==void 0){let c=o.shapes;if(Array.isArray(c))for(let l=0,h=c.length;l<h;l++){let u=c[l];s(t.shapes,u)}else s(t.shapes,c)}}if(this.isSkinnedMesh&&(i.bindMode=this.bindMode,i.bindMatrix=this.bindMatrix.toArray(),this.skeleton!==void 0&&(s(t.skeletons,this.skeleton),i.skeleton=this.skeleton.uuid)),this.material!==void 0)if(Array.isArray(this.material)){let o=[];for(let c=0,l=this.material.length;c<l;c++)o.push(s(t.materials,this.material[c]));i.material=o}else i.material=s(t.materials,this.material);if(this.children.length>0){i.children=[];for(let o=0;o<this.children.length;o++)i.children.push(this.children[o].toJSON(t).object)}if(this.animations.length>0){i.animations=[];for(let o=0;o<this.animations.length;o++){let c=this.animations[o];i.animations.push(s(t.animations,c))}}if(e){let o=a(t.geometries),c=a(t.materials),l=a(t.textures),h=a(t.images),u=a(t.shapes),d=a(t.skeletons),f=a(t.animations),m=a(t.nodes);o.length>0&&(n.geometries=o),c.length>0&&(n.materials=c),l.length>0&&(n.textures=l),h.length>0&&(n.images=h),u.length>0&&(n.shapes=u),d.length>0&&(n.skeletons=d),f.length>0&&(n.animations=f),m.length>0&&(n.nodes=m)}return n.object=i,n;function a(o){let c=[];for(let l in o){let h=o[l];delete h.metadata,c.push(h)}return c}}clone(t){return new this.constructor().copy(this,t)}copy(t,e=!0){if(this.name=t.name,this.up.copy(t.up),this.position.copy(t.position),this.rotation.order=t.rotation.order,this.quaternion.copy(t.quaternion),this.scale.copy(t.scale),this.matrix.copy(t.matrix),this.matrixWorld.copy(t.matrixWorld),this.matrixAutoUpdate=t.matrixAutoUpdate,this.matrixWorldAutoUpdate=t.matrixWorldAutoUpdate,this.matrixWorldNeedsUpdate=t.matrixWorldNeedsUpdate,this.layers.mask=t.layers.mask,this.visible=t.visible,this.castShadow=t.castShadow,this.receiveShadow=t.receiveShadow,this.frustumCulled=t.frustumCulled,this.renderOrder=t.renderOrder,this.animations=t.animations.slice(),this.userData=JSON.parse(JSON.stringify(t.userData)),e===!0)for(let n=0;n<t.children.length;n++){let i=t.children[n];this.add(i.clone())}return this}};Kt.DEFAULT_UP=new w(0,1,0);Kt.DEFAULT_MATRIX_AUTO_UPDATE=!0;Kt.DEFAULT_MATRIX_WORLD_AUTO_UPDATE=!0;var nn=new w,gn=new w,ja=new w,_n=new w,Pi=new w,Li=new w,mh=new w,to=new w,eo=new w,no=new w,sr=!1,Fn=class r{constructor(t=new w,e=new w,n=new w){this.a=t,this.b=e,this.c=n}static getNormal(t,e,n,i){i.subVectors(n,e),nn.subVectors(t,e),i.cross(nn);let s=i.lengthSq();return s>0?i.multiplyScalar(1/Math.sqrt(s)):i.set(0,0,0)}static getBarycoord(t,e,n,i,s){nn.subVectors(i,e),gn.subVectors(n,e),ja.subVectors(t,e);let a=nn.dot(nn),o=nn.dot(gn),c=nn.dot(ja),l=gn.dot(gn),h=gn.dot(ja),u=a*l-o*o;if(u===0)return s.set(0,0,0),null;let d=1/u,f=(l*c-o*h)*d,m=(a*h-o*c)*d;return s.set(1-f-m,m,f)}static containsPoint(t,e,n,i){return this.getBarycoord(t,e,n,i,_n)===null?!1:_n.x>=0&&_n.y>=0&&_n.x+_n.y<=1}static getUV(t,e,n,i,s,a,o,c){return sr===!1&&(console.warn("THREE.Triangle.getUV() has been renamed to THREE.Triangle.getInterpolation()."),sr=!0),this.getInterpolation(t,e,n,i,s,a,o,c)}static getInterpolation(t,e,n,i,s,a,o,c){return this.getBarycoord(t,e,n,i,_n)===null?(c.x=0,c.y=0,"z"in c&&(c.z=0),"w"in c&&(c.w=0),null):(c.setScalar(0),c.addScaledVector(s,_n.x),c.addScaledVector(a,_n.y),c.addScaledVector(o,_n.z),c)}static isFrontFacing(t,e,n,i){return nn.subVectors(n,e),gn.subVectors(t,e),nn.cross(gn).dot(i)<0}set(t,e,n){return this.a.copy(t),this.b.copy(e),this.c.copy(n),this}setFromPointsAndIndices(t,e,n,i){return this.a.copy(t[e]),this.b.copy(t[n]),this.c.copy(t[i]),this}setFromAttributeAndIndices(t,e,n,i){return this.a.fromBufferAttribute(t,e),this.b.fromBufferAttribute(t,n),this.c.fromBufferAttribute(t,i),this}clone(){return new this.constructor().copy(this)}copy(t){return this.a.copy(t.a),this.b.copy(t.b),this.c.copy(t.c),this}getArea(){return nn.subVectors(this.c,this.b),gn.subVectors(this.a,this.b),nn.cross(gn).length()*.5}getMidpoint(t){return t.addVectors(this.a,this.b).add(this.c).multiplyScalar(1/3)}getNormal(t){return r.getNormal(this.a,this.b,this.c,t)}getPlane(t){return t.setFromCoplanarPoints(this.a,this.b,this.c)}getBarycoord(t,e){return r.getBarycoord(t,this.a,this.b,this.c,e)}getUV(t,e,n,i,s){return sr===!1&&(console.warn("THREE.Triangle.getUV() has been renamed to THREE.Triangle.getInterpolation()."),sr=!0),r.getInterpolation(t,this.a,this.b,this.c,e,n,i,s)}getInterpolation(t,e,n,i,s){return r.getInterpolation(t,this.a,this.b,this.c,e,n,i,s)}containsPoint(t){return r.containsPoint(t,this.a,this.b,this.c)}isFrontFacing(t){return r.isFrontFacing(this.a,this.b,this.c,t)}intersectsBox(t){return t.intersectsTriangle(this)}closestPointToPoint(t,e){let n=this.a,i=this.b,s=this.c,a,o;Pi.subVectors(i,n),Li.subVectors(s,n),to.subVectors(t,n);let c=Pi.dot(to),l=Li.dot(to);if(c<=0&&l<=0)return e.copy(n);eo.subVectors(t,i);let h=Pi.dot(eo),u=Li.dot(eo);if(h>=0&&u<=h)return e.copy(i);let d=c*u-h*l;if(d<=0&&c>=0&&h<=0)return a=c/(c-h),e.copy(n).addScaledVector(Pi,a);no.subVectors(t,s);let f=Pi.dot(no),m=Li.dot(no);if(m>=0&&f<=m)return e.copy(s);let _=f*l-c*m;if(_<=0&&l>=0&&m<=0)return o=l/(l-m),e.copy(n).addScaledVector(Li,o);let g=h*m-f*u;if(g<=0&&u-h>=0&&f-m>=0)return mh.subVectors(s,i),o=(u-h)/(u-h+(f-m)),e.copy(i).addScaledVector(mh,o);let p=1/(g+_+d);return a=_*p,o=d*p,e.copy(n).addScaledVector(Pi,a).addScaledVector(Li,o)}equals(t){return t.a.equals(this.a)&&t.b.equals(this.b)&&t.c.equals(this.c)}},kd={aliceblue:15792383,antiquewhite:16444375,aqua:65535,aquamarine:8388564,azure:15794175,beige:16119260,bisque:16770244,black:0,blanchedalmond:16772045,blue:255,blueviolet:9055202,brown:10824234,burlywood:14596231,cadetblue:6266528,chartreuse:8388352,chocolate:13789470,coral:16744272,cornflowerblue:6591981,cornsilk:16775388,crimson:14423100,cyan:65535,darkblue:139,darkcyan:35723,darkgoldenrod:12092939,darkgray:11119017,darkgreen:25600,darkgrey:11119017,darkkhaki:12433259,darkmagenta:9109643,darkolivegreen:5597999,darkorange:16747520,darkorchid:10040012,darkred:9109504,darksalmon:15308410,darkseagreen:9419919,darkslateblue:4734347,darkslategray:3100495,darkslategrey:3100495,darkturquoise:52945,darkviolet:9699539,deeppink:16716947,deepskyblue:49151,dimgray:6908265,dimgrey:6908265,dodgerblue:2003199,firebrick:11674146,floralwhite:16775920,forestgreen:2263842,fuchsia:16711935,gainsboro:14474460,ghostwhite:16316671,gold:16766720,goldenrod:14329120,gray:8421504,green:32768,greenyellow:11403055,grey:8421504,honeydew:15794160,hotpink:16738740,indianred:13458524,indigo:4915330,ivory:16777200,khaki:15787660,lavender:15132410,lavenderblush:16773365,lawngreen:8190976,lemonchiffon:16775885,lightblue:11393254,lightcoral:15761536,lightcyan:14745599,lightgoldenrodyellow:16448210,lightgray:13882323,lightgreen:9498256,lightgrey:13882323,lightpink:16758465,lightsalmon:16752762,lightseagreen:2142890,lightskyblue:8900346,lightslategray:7833753,lightslategrey:7833753,lightsteelblue:11584734,lightyellow:16777184,lime:65280,limegreen:3329330,linen:16445670,magenta:16711935,maroon:8388608,mediumaquamarine:6737322,mediumblue:205,mediumorchid:12211667,mediumpurple:9662683,mediumseagreen:3978097,mediumslateblue:8087790,mediumspringgreen:64154,mediumturquoise:4772300,mediumvioletred:13047173,midnightblue:1644912,mintcream:16121850,mistyrose:16770273,moccasin:16770229,navajowhite:16768685,navy:128,oldlace:16643558,olive:8421376,olivedrab:7048739,orange:16753920,orangered:16729344,orchid:14315734,palegoldenrod:15657130,palegreen:10025880,paleturquoise:11529966,palevioletred:14381203,papayawhip:16773077,peachpuff:16767673,peru:13468991,pink:16761035,plum:14524637,powderblue:11591910,purple:8388736,rebeccapurple:6697881,red:16711680,rosybrown:12357519,royalblue:4286945,saddlebrown:9127187,salmon:16416882,sandybrown:16032864,seagreen:3050327,seashell:16774638,sienna:10506797,silver:12632256,skyblue:8900331,slateblue:6970061,slategray:7372944,slategrey:7372944,snow:16775930,springgreen:65407,steelblue:4620980,tan:13808780,teal:32896,thistle:14204888,tomato:16737095,turquoise:4251856,violet:15631086,wheat:16113331,white:16777215,whitesmoke:16119285,yellow:16776960,yellowgreen:10145074},In={h:0,s:0,l:0},rr={h:0,s:0,l:0};function io(r,t,e){return e<0&&(e+=1),e>1&&(e-=1),e<1/6?r+(t-r)*6*e:e<1/2?t:e<2/3?r+(t-r)*6*(2/3-e):r}var pt=class{constructor(t,e,n){return this.isColor=!0,this.r=1,this.g=1,this.b=1,this.set(t,e,n)}set(t,e,n){if(e===void 0&&n===void 0){let i=t;i&&i.isColor?this.copy(i):typeof i=="number"?this.setHex(i):typeof i=="string"&&this.setStyle(i)}else this.setRGB(t,e,n);return this}setScalar(t){return this.r=t,this.g=t,this.b=t,this}setHex(t,e=Se){return t=Math.floor(t),this.r=(t>>16&255)/255,this.g=(t>>8&255)/255,this.b=(t&255)/255,jt.toWorkingColorSpace(this,e),this}setRGB(t,e,n,i=jt.workingColorSpace){return this.r=t,this.g=e,this.b=n,jt.toWorkingColorSpace(this,i),this}setHSL(t,e,n,i=jt.workingColorSpace){if(t=ll(t,1),e=he(e,0,1),n=he(n,0,1),e===0)this.r=this.g=this.b=n;else{let s=n<=.5?n*(1+e):n+e-n*e,a=2*n-s;this.r=io(a,s,t+1/3),this.g=io(a,s,t),this.b=io(a,s,t-1/3)}return jt.toWorkingColorSpace(this,i),this}setStyle(t,e=Se){function n(s){s!==void 0&&parseFloat(s)<1&&console.warn("THREE.Color: Alpha component of "+t+" will be ignored.")}let i;if(i=/^(\w+)\(([^\)]*)\)/.exec(t)){let s,a=i[1],o=i[2];switch(a){case"rgb":case"rgba":if(s=/^\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*(\d*\.?\d+)\s*)?$/.exec(o))return n(s[4]),this.setRGB(Math.min(255,parseInt(s[1],10))/255,Math.min(255,parseInt(s[2],10))/255,Math.min(255,parseInt(s[3],10))/255,e);if(s=/^\s*(\d+)\%\s*,\s*(\d+)\%\s*,\s*(\d+)\%\s*(?:,\s*(\d*\.?\d+)\s*)?$/.exec(o))return n(s[4]),this.setRGB(Math.min(100,parseInt(s[1],10))/100,Math.min(100,parseInt(s[2],10))/100,Math.min(100,parseInt(s[3],10))/100,e);break;case"hsl":case"hsla":if(s=/^\s*(\d*\.?\d+)\s*,\s*(\d*\.?\d+)\%\s*,\s*(\d*\.?\d+)\%\s*(?:,\s*(\d*\.?\d+)\s*)?$/.exec(o))return n(s[4]),this.setHSL(parseFloat(s[1])/360,parseFloat(s[2])/100,parseFloat(s[3])/100,e);break;default:console.warn("THREE.Color: Unknown color model "+t)}}else if(i=/^\#([A-Fa-f\d]+)$/.exec(t)){let s=i[1],a=s.length;if(a===3)return this.setRGB(parseInt(s.charAt(0),16)/15,parseInt(s.charAt(1),16)/15,parseInt(s.charAt(2),16)/15,e);if(a===6)return this.setHex(parseInt(s,16),e);console.warn("THREE.Color: Invalid hex color "+t)}else if(t&&t.length>0)return this.setColorName(t,e);return this}setColorName(t,e=Se){let n=kd[t.toLowerCase()];return n!==void 0?this.setHex(n,e):console.warn("THREE.Color: Unknown color "+t),this}clone(){return new this.constructor(this.r,this.g,this.b)}copy(t){return this.r=t.r,this.g=t.g,this.b=t.b,this}copySRGBToLinear(t){return this.r=Qi(t.r),this.g=Qi(t.g),this.b=Qi(t.b),this}copyLinearToSRGB(t){return this.r=Xa(t.r),this.g=Xa(t.g),this.b=Xa(t.b),this}convertSRGBToLinear(){return this.copySRGBToLinear(this),this}convertLinearToSRGB(){return this.copyLinearToSRGB(this),this}getHex(t=Se){return jt.fromWorkingColorSpace(Ce.copy(this),t),Math.round(he(Ce.r*255,0,255))*65536+Math.round(he(Ce.g*255,0,255))*256+Math.round(he(Ce.b*255,0,255))}getHexString(t=Se){return("000000"+this.getHex(t).toString(16)).slice(-6)}getHSL(t,e=jt.workingColorSpace){jt.fromWorkingColorSpace(Ce.copy(this),e);let n=Ce.r,i=Ce.g,s=Ce.b,a=Math.max(n,i,s),o=Math.min(n,i,s),c,l,h=(o+a)/2;if(o===a)c=0,l=0;else{let u=a-o;switch(l=h<=.5?u/(a+o):u/(2-a-o),a){case n:c=(i-s)/u+(i<s?6:0);break;case i:c=(s-n)/u+2;break;case s:c=(n-i)/u+4;break}c/=6}return t.h=c,t.s=l,t.l=h,t}getRGB(t,e=jt.workingColorSpace){return jt.fromWorkingColorSpace(Ce.copy(this),e),t.r=Ce.r,t.g=Ce.g,t.b=Ce.b,t}getStyle(t=Se){jt.fromWorkingColorSpace(Ce.copy(this),t);let e=Ce.r,n=Ce.g,i=Ce.b;return t!==Se?`color(${t} ${e.toFixed(3)} ${n.toFixed(3)} ${i.toFixed(3)})`:`rgb(${Math.round(e*255)},${Math.round(n*255)},${Math.round(i*255)})`}offsetHSL(t,e,n){return this.getHSL(In),this.setHSL(In.h+t,In.s+e,In.l+n)}add(t){return this.r+=t.r,this.g+=t.g,this.b+=t.b,this}addColors(t,e){return this.r=t.r+e.r,this.g=t.g+e.g,this.b=t.b+e.b,this}addScalar(t){return this.r+=t,this.g+=t,this.b+=t,this}sub(t){return this.r=Math.max(0,this.r-t.r),this.g=Math.max(0,this.g-t.g),this.b=Math.max(0,this.b-t.b),this}multiply(t){return this.r*=t.r,this.g*=t.g,this.b*=t.b,this}multiplyScalar(t){return this.r*=t,this.g*=t,this.b*=t,this}lerp(t,e){return this.r+=(t.r-this.r)*e,this.g+=(t.g-this.g)*e,this.b+=(t.b-this.b)*e,this}lerpColors(t,e,n){return this.r=t.r+(e.r-t.r)*n,this.g=t.g+(e.g-t.g)*n,this.b=t.b+(e.b-t.b)*n,this}lerpHSL(t,e){this.getHSL(In),t.getHSL(rr);let n=ws(In.h,rr.h,e),i=ws(In.s,rr.s,e),s=ws(In.l,rr.l,e);return this.setHSL(n,i,s),this}setFromVector3(t){return this.r=t.x,this.g=t.y,this.b=t.z,this}applyMatrix3(t){let e=this.r,n=this.g,i=this.b,s=t.elements;return this.r=s[0]*e+s[3]*n+s[6]*i,this.g=s[1]*e+s[4]*n+s[7]*i,this.b=s[2]*e+s[5]*n+s[8]*i,this}equals(t){return t.r===this.r&&t.g===this.g&&t.b===this.b}fromArray(t,e=0){return this.r=t[e],this.g=t[e+1],this.b=t[e+2],this}toArray(t=[],e=0){return t[e]=this.r,t[e+1]=this.g,t[e+2]=this.b,t}fromBufferAttribute(t,e){return this.r=t.getX(e),this.g=t.getY(e),this.b=t.getZ(e),this}toJSON(){return this.getHex()}*[Symbol.iterator](){yield this.r,yield this.g,yield this.b}},Ce=new pt;pt.NAMES=kd;var Fp=0,Te=class extends hn{constructor(){super(),this.isMaterial=!0,Object.defineProperty(this,"id",{value:Fp++}),this.uuid=Ye(),this.name="",this.type="Material",this.blending=Ki,this.side=Wn,this.vertexColors=!1,this.opacity=1,this.transparent=!1,this.alphaHash=!1,this.blendSrc=wo,this.blendDst=Ro,this.blendEquation=oi,this.blendSrcAlpha=null,this.blendDstAlpha=null,this.blendEquationAlpha=null,this.blendColor=new pt(0,0,0),this.blendAlpha=0,this.depthFunc=Gr,this.depthTest=!0,this.depthWrite=!0,this.stencilWriteMask=255,this.stencilFunc=jl,this.stencilRef=0,this.stencilFuncMask=255,this.stencilFail=bi,this.stencilZFail=bi,this.stencilZPass=bi,this.stencilWrite=!1,this.clippingPlanes=null,this.clipIntersection=!1,this.clipShadows=!1,this.shadowSide=null,this.colorWrite=!0,this.precision=null,this.polygonOffset=!1,this.polygonOffsetFactor=0,this.polygonOffsetUnits=0,this.dithering=!1,this.alphaToCoverage=!1,this.premultipliedAlpha=!1,this.forceSinglePass=!1,this.visible=!0,this.toneMapped=!0,this.userData={},this.version=0,this._alphaTest=0}get alphaTest(){return this._alphaTest}set alphaTest(t){this._alphaTest>0!=t>0&&this.version++,this._alphaTest=t}onBuild(){}onBeforeRender(){}onBeforeCompile(){}customProgramCacheKey(){return this.onBeforeCompile.toString()}setValues(t){if(t!==void 0)for(let e in t){let n=t[e];if(n===void 0){console.warn(`THREE.Material: parameter '${e}' has value of undefined.`);continue}let i=this[e];if(i===void 0){console.warn(`THREE.Material: '${e}' is not a property of THREE.${this.type}.`);continue}i&&i.isColor?i.set(n):i&&i.isVector3&&n&&n.isVector3?i.copy(n):this[e]=n}}toJSON(t){let e=t===void 0||typeof t=="string";e&&(t={textures:{},images:{}});let n={metadata:{version:4.6,type:"Material",generator:"Material.toJSON"}};n.uuid=this.uuid,n.type=this.type,this.name!==""&&(n.name=this.name),this.color&&this.color.isColor&&(n.color=this.color.getHex()),this.roughness!==void 0&&(n.roughness=this.roughness),this.metalness!==void 0&&(n.metalness=this.metalness),this.sheen!==void 0&&(n.sheen=this.sheen),this.sheenColor&&this.sheenColor.isColor&&(n.sheenColor=this.sheenColor.getHex()),this.sheenRoughness!==void 0&&(n.sheenRoughness=this.sheenRoughness),this.emissive&&this.emissive.isColor&&(n.emissive=this.emissive.getHex()),this.emissiveIntensity&&this.emissiveIntensity!==1&&(n.emissiveIntensity=this.emissiveIntensity),this.specular&&this.specular.isColor&&(n.specular=this.specular.getHex()),this.specularIntensity!==void 0&&(n.specularIntensity=this.specularIntensity),this.specularColor&&this.specularColor.isColor&&(n.specularColor=this.specularColor.getHex()),this.shininess!==void 0&&(n.shininess=this.shininess),this.clearcoat!==void 0&&(n.clearcoat=this.clearcoat),this.clearcoatRoughness!==void 0&&(n.clearcoatRoughness=this.clearcoatRoughness),this.clearcoatMap&&this.clearcoatMap.isTexture&&(n.clearcoatMap=this.clearcoatMap.toJSON(t).uuid),this.clearcoatRoughnessMap&&this.clearcoatRoughnessMap.isTexture&&(n.clearcoatRoughnessMap=this.clearcoatRoughnessMap.toJSON(t).uuid),this.clearcoatNormalMap&&this.clearcoatNormalMap.isTexture&&(n.clearcoatNormalMap=this.clearcoatNormalMap.toJSON(t).uuid,n.clearcoatNormalScale=this.clearcoatNormalScale.toArray()),this.iridescence!==void 0&&(n.iridescence=this.iridescence),this.iridescenceIOR!==void 0&&(n.iridescenceIOR=this.iridescenceIOR),this.iridescenceThicknessRange!==void 0&&(n.iridescenceThicknessRange=this.iridescenceThicknessRange),this.iridescenceMap&&this.iridescenceMap.isTexture&&(n.iridescenceMap=this.iridescenceMap.toJSON(t).uuid),this.iridescenceThicknessMap&&this.iridescenceThicknessMap.isTexture&&(n.iridescenceThicknessMap=this.iridescenceThicknessMap.toJSON(t).uuid),this.anisotropy!==void 0&&(n.anisotropy=this.anisotropy),this.anisotropyRotation!==void 0&&(n.anisotropyRotation=this.anisotropyRotation),this.anisotropyMap&&this.anisotropyMap.isTexture&&(n.anisotropyMap=this.anisotropyMap.toJSON(t).uuid),this.map&&this.map.isTexture&&(n.map=this.map.toJSON(t).uuid),this.matcap&&this.matcap.isTexture&&(n.matcap=this.matcap.toJSON(t).uuid),this.alphaMap&&this.alphaMap.isTexture&&(n.alphaMap=this.alphaMap.toJSON(t).uuid),this.lightMap&&this.lightMap.isTexture&&(n.lightMap=this.lightMap.toJSON(t).uuid,n.lightMapIntensity=this.lightMapIntensity),this.aoMap&&this.aoMap.isTexture&&(n.aoMap=this.aoMap.toJSON(t).uuid,n.aoMapIntensity=this.aoMapIntensity),this.bumpMap&&this.bumpMap.isTexture&&(n.bumpMap=this.bumpMap.toJSON(t).uuid,n.bumpScale=this.bumpScale),this.normalMap&&this.normalMap.isTexture&&(n.normalMap=this.normalMap.toJSON(t).uuid,n.normalMapType=this.normalMapType,n.normalScale=this.normalScale.toArray()),this.displacementMap&&this.displacementMap.isTexture&&(n.displacementMap=this.displacementMap.toJSON(t).uuid,n.displacementScale=this.displacementScale,n.displacementBias=this.displacementBias),this.roughnessMap&&this.roughnessMap.isTexture&&(n.roughnessMap=this.roughnessMap.toJSON(t).uuid),this.metalnessMap&&this.metalnessMap.isTexture&&(n.metalnessMap=this.metalnessMap.toJSON(t).uuid),this.emissiveMap&&this.emissiveMap.isTexture&&(n.emissiveMap=this.emissiveMap.toJSON(t).uuid),this.specularMap&&this.specularMap.isTexture&&(n.specularMap=this.specularMap.toJSON(t).uuid),this.specularIntensityMap&&this.specularIntensityMap.isTexture&&(n.specularIntensityMap=this.specularIntensityMap.toJSON(t).uuid),this.specularColorMap&&this.specularColorMap.isTexture&&(n.specularColorMap=this.specularColorMap.toJSON(t).uuid),this.envMap&&this.envMap.isTexture&&(n.envMap=this.envMap.toJSON(t).uuid,this.combine!==void 0&&(n.combine=this.combine)),this.envMapIntensity!==void 0&&(n.envMapIntensity=this.envMapIntensity),this.reflectivity!==void 0&&(n.reflectivity=this.reflectivity),this.refractionRatio!==void 0&&(n.refractionRatio=this.refractionRatio),this.gradientMap&&this.gradientMap.isTexture&&(n.gradientMap=this.gradientMap.toJSON(t).uuid),this.transmission!==void 0&&(n.transmission=this.transmission),this.transmissionMap&&this.transmissionMap.isTexture&&(n.transmissionMap=this.transmissionMap.toJSON(t).uuid),this.thickness!==void 0&&(n.thickness=this.thickness),this.thicknessMap&&this.thicknessMap.isTexture&&(n.thicknessMap=this.thicknessMap.toJSON(t).uuid),this.attenuationDistance!==void 0&&this.attenuationDistance!==1/0&&(n.attenuationDistance=this.attenuationDistance),this.attenuationColor!==void 0&&(n.attenuationColor=this.attenuationColor.getHex()),this.size!==void 0&&(n.size=this.size),this.shadowSide!==null&&(n.shadowSide=this.shadowSide),this.sizeAttenuation!==void 0&&(n.sizeAttenuation=this.sizeAttenuation),this.blending!==Ki&&(n.blending=this.blending),this.side!==Wn&&(n.side=this.side),this.vertexColors===!0&&(n.vertexColors=!0),this.opacity<1&&(n.opacity=this.opacity),this.transparent===!0&&(n.transparent=!0),this.blendSrc!==wo&&(n.blendSrc=this.blendSrc),this.blendDst!==Ro&&(n.blendDst=this.blendDst),this.blendEquation!==oi&&(n.blendEquation=this.blendEquation),this.blendSrcAlpha!==null&&(n.blendSrcAlpha=this.blendSrcAlpha),this.blendDstAlpha!==null&&(n.blendDstAlpha=this.blendDstAlpha),this.blendEquationAlpha!==null&&(n.blendEquationAlpha=this.blendEquationAlpha),this.blendColor&&this.blendColor.isColor&&(n.blendColor=this.blendColor.getHex()),this.blendAlpha!==0&&(n.blendAlpha=this.blendAlpha),this.depthFunc!==Gr&&(n.depthFunc=this.depthFunc),this.depthTest===!1&&(n.depthTest=this.depthTest),this.depthWrite===!1&&(n.depthWrite=this.depthWrite),this.colorWrite===!1&&(n.colorWrite=this.colorWrite),this.stencilWriteMask!==255&&(n.stencilWriteMask=this.stencilWriteMask),this.stencilFunc!==jl&&(n.stencilFunc=this.stencilFunc),this.stencilRef!==0&&(n.stencilRef=this.stencilRef),this.stencilFuncMask!==255&&(n.stencilFuncMask=this.stencilFuncMask),this.stencilFail!==bi&&(n.stencilFail=this.stencilFail),this.stencilZFail!==bi&&(n.stencilZFail=this.stencilZFail),this.stencilZPass!==bi&&(n.stencilZPass=this.stencilZPass),this.stencilWrite===!0&&(n.stencilWrite=this.stencilWrite),this.rotation!==void 0&&this.rotation!==0&&(n.rotation=this.rotation),this.polygonOffset===!0&&(n.polygonOffset=!0),this.polygonOffsetFactor!==0&&(n.polygonOffsetFactor=this.polygonOffsetFactor),this.polygonOffsetUnits!==0&&(n.polygonOffsetUnits=this.polygonOffsetUnits),this.linewidth!==void 0&&this.linewidth!==1&&(n.linewidth=this.linewidth),this.dashSize!==void 0&&(n.dashSize=this.dashSize),this.gapSize!==void 0&&(n.gapSize=this.gapSize),this.scale!==void 0&&(n.scale=this.scale),this.dithering===!0&&(n.dithering=!0),this.alphaTest>0&&(n.alphaTest=this.alphaTest),this.alphaHash===!0&&(n.alphaHash=!0),this.alphaToCoverage===!0&&(n.alphaToCoverage=!0),this.premultipliedAlpha===!0&&(n.premultipliedAlpha=!0),this.forceSinglePass===!0&&(n.forceSinglePass=!0),this.wireframe===!0&&(n.wireframe=!0),this.wireframeLinewidth>1&&(n.wireframeLinewidth=this.wireframeLinewidth),this.wireframeLinecap!=="round"&&(n.wireframeLinecap=this.wireframeLinecap),this.wireframeLinejoin!=="round"&&(n.wireframeLinejoin=this.wireframeLinejoin),this.flatShading===!0&&(n.flatShading=!0),this.visible===!1&&(n.visible=!1),this.toneMapped===!1&&(n.toneMapped=!1),this.fog===!1&&(n.fog=!1),Object.keys(this.userData).length>0&&(n.userData=this.userData);function i(s){let a=[];for(let o in s){let c=s[o];delete c.metadata,a.push(c)}return a}if(e){let s=i(t.textures),a=i(t.images);s.length>0&&(n.textures=s),a.length>0&&(n.images=a)}return n}clone(){return new this.constructor().copy(this)}copy(t){this.name=t.name,this.blending=t.blending,this.side=t.side,this.vertexColors=t.vertexColors,this.opacity=t.opacity,this.transparent=t.transparent,this.blendSrc=t.blendSrc,this.blendDst=t.blendDst,this.blendEquation=t.blendEquation,this.blendSrcAlpha=t.blendSrcAlpha,this.blendDstAlpha=t.blendDstAlpha,this.blendEquationAlpha=t.blendEquationAlpha,this.blendColor.copy(t.blendColor),this.blendAlpha=t.blendAlpha,this.depthFunc=t.depthFunc,this.depthTest=t.depthTest,this.depthWrite=t.depthWrite,this.stencilWriteMask=t.stencilWriteMask,this.stencilFunc=t.stencilFunc,this.stencilRef=t.stencilRef,this.stencilFuncMask=t.stencilFuncMask,this.stencilFail=t.stencilFail,this.stencilZFail=t.stencilZFail,this.stencilZPass=t.stencilZPass,this.stencilWrite=t.stencilWrite;let e=t.clippingPlanes,n=null;if(e!==null){let i=e.length;n=new Array(i);for(let s=0;s!==i;++s)n[s]=e[s].clone()}return this.clippingPlanes=n,this.clipIntersection=t.clipIntersection,this.clipShadows=t.clipShadows,this.shadowSide=t.shadowSide,this.colorWrite=t.colorWrite,this.precision=t.precision,this.polygonOffset=t.polygonOffset,this.polygonOffsetFactor=t.polygonOffsetFactor,this.polygonOffsetUnits=t.polygonOffsetUnits,this.dithering=t.dithering,this.alphaTest=t.alphaTest,this.alphaHash=t.alphaHash,this.alphaToCoverage=t.alphaToCoverage,this.premultipliedAlpha=t.premultipliedAlpha,this.forceSinglePass=t.forceSinglePass,this.visible=t.visible,this.toneMapped=t.toneMapped,this.userData=JSON.parse(JSON.stringify(t.userData)),this}dispose(){this.dispatchEvent({type:"dispose"})}set needsUpdate(t){t===!0&&this.version++}},An=class extends Te{constructor(t){super(),this.isMeshBasicMaterial=!0,this.type="MeshBasicMaterial",this.color=new pt(16777215),this.map=null,this.lightMap=null,this.lightMapIntensity=1,this.aoMap=null,this.aoMapIntensity=1,this.specularMap=null,this.alphaMap=null,this.envMap=null,this.combine=Pa,this.reflectivity=1,this.refractionRatio=.98,this.wireframe=!1,this.wireframeLinewidth=1,this.wireframeLinecap="round",this.wireframeLinejoin="round",this.fog=!0,this.setValues(t)}copy(t){return super.copy(t),this.color.copy(t.color),this.map=t.map,this.lightMap=t.lightMap,this.lightMapIntensity=t.lightMapIntensity,this.aoMap=t.aoMap,this.aoMapIntensity=t.aoMapIntensity,this.specularMap=t.specularMap,this.alphaMap=t.alphaMap,this.envMap=t.envMap,this.combine=t.combine,this.reflectivity=t.reflectivity,this.refractionRatio=t.refractionRatio,this.wireframe=t.wireframe,this.wireframeLinewidth=t.wireframeLinewidth,this.wireframeLinecap=t.wireframeLinecap,this.wireframeLinejoin=t.wireframeLinejoin,this.fog=t.fog,this}},Sn=Bp();function Bp(){let r=new ArrayBuffer(4),t=new Float32Array(r),e=new Uint32Array(r),n=new Uint32Array(512),i=new Uint32Array(512);for(let c=0;c<256;++c){let l=c-127;l<-27?(n[c]=0,n[c|256]=32768,i[c]=24,i[c|256]=24):l<-14?(n[c]=1024>>-l-14,n[c|256]=1024>>-l-14|32768,i[c]=-l-1,i[c|256]=-l-1):l<=15?(n[c]=l+15<<10,n[c|256]=l+15<<10|32768,i[c]=13,i[c|256]=13):l<128?(n[c]=31744,n[c|256]=64512,i[c]=24,i[c|256]=24):(n[c]=31744,n[c|256]=64512,i[c]=13,i[c|256]=13)}let s=new Uint32Array(2048),a=new Uint32Array(64),o=new Uint32Array(64);for(let c=1;c<1024;++c){let l=c<<13,h=0;for(;(l&8388608)===0;)l<<=1,h-=8388608;l&=-8388609,h+=947912704,s[c]=l|h}for(let c=1024;c<2048;++c)s[c]=939524096+(c-1024<<13);for(let c=1;c<31;++c)a[c]=c<<23;a[31]=1199570944,a[32]=2147483648;for(let c=33;c<63;++c)a[c]=2147483648+(c-32<<23);a[63]=3347054592;for(let c=1;c<64;++c)c!==32&&(o[c]=1024);return{floatView:t,uint32View:e,baseTable:n,shiftTable:i,mantissaTable:s,exponentTable:a,offsetTable:o}}function Ve(r){Math.abs(r)>65504&&console.warn("THREE.DataUtils.toHalfFloat(): Value out of range."),r=he(r,-65504,65504),Sn.floatView[0]=r;let t=Sn.uint32View[0],e=t>>23&511;return Sn.baseTable[e]+((t&8388607)>>Sn.shiftTable[e])}function Ts(r){let t=r>>10;return Sn.uint32View[0]=Sn.mantissaTable[Sn.offsetTable[t]+(r&1023)]+Sn.exponentTable[t],Sn.floatView[0]}var ty={toHalfFloat:Ve,fromHalfFloat:Ts},fe=new w,ar=new Z,Jt=class{constructor(t,e,n=!1){if(Array.isArray(t))throw new TypeError("THREE.BufferAttribute: array should be a Typed Array.");this.isBufferAttribute=!0,this.name="",this.array=t,this.itemSize=e,this.count=t!==void 0?t.length/e:0,this.normalized=n,this.usage=ta,this._updateRange={offset:0,count:-1},this.updateRanges=[],this.gpuType=cn,this.version=0}onUploadCallback(){}set needsUpdate(t){t===!0&&this.version++}get updateRange(){return console.warn("THREE.BufferAttribute: updateRange() is deprecated and will be removed in r169. Use addUpdateRange() instead."),this._updateRange}setUsage(t){return this.usage=t,this}addUpdateRange(t,e){this.updateRanges.push({start:t,count:e})}clearUpdateRanges(){this.updateRanges.length=0}copy(t){return this.name=t.name,this.array=new t.array.constructor(t.array),this.itemSize=t.itemSize,this.count=t.count,this.normalized=t.normalized,this.usage=t.usage,this.gpuType=t.gpuType,this}copyAt(t,e,n){t*=this.itemSize,n*=e.itemSize;for(let i=0,s=this.itemSize;i<s;i++)this.array[t+i]=e.array[n+i];return this}copyArray(t){return this.array.set(t),this}applyMatrix3(t){if(this.itemSize===2)for(let e=0,n=this.count;e<n;e++)ar.fromBufferAttribute(this,e),ar.applyMatrix3(t),this.setXY(e,ar.x,ar.y);else if(this.itemSize===3)for(let e=0,n=this.count;e<n;e++)fe.fromBufferAttribute(this,e),fe.applyMatrix3(t),this.setXYZ(e,fe.x,fe.y,fe.z);return this}applyMatrix4(t){for(let e=0,n=this.count;e<n;e++)fe.fromBufferAttribute(this,e),fe.applyMatrix4(t),this.setXYZ(e,fe.x,fe.y,fe.z);return this}applyNormalMatrix(t){for(let e=0,n=this.count;e<n;e++)fe.fromBufferAttribute(this,e),fe.applyNormalMatrix(t),this.setXYZ(e,fe.x,fe.y,fe.z);return this}transformDirection(t){for(let e=0,n=this.count;e<n;e++)fe.fromBufferAttribute(this,e),fe.transformDirection(t),this.setXYZ(e,fe.x,fe.y,fe.z);return this}set(t,e=0){return this.array.set(t,e),this}getComponent(t,e){let n=this.array[t*this.itemSize+e];return this.normalized&&(n=ke(n,this.array)),n}setComponent(t,e,n){return this.normalized&&(n=zt(n,this.array)),this.array[t*this.itemSize+e]=n,this}getX(t){let e=this.array[t*this.itemSize];return this.normalized&&(e=ke(e,this.array)),e}setX(t,e){return this.normalized&&(e=zt(e,this.array)),this.array[t*this.itemSize]=e,this}getY(t){let e=this.array[t*this.itemSize+1];return this.normalized&&(e=ke(e,this.array)),e}setY(t,e){return this.normalized&&(e=zt(e,this.array)),this.array[t*this.itemSize+1]=e,this}getZ(t){let e=this.array[t*this.itemSize+2];return this.normalized&&(e=ke(e,this.array)),e}setZ(t,e){return this.normalized&&(e=zt(e,this.array)),this.array[t*this.itemSize+2]=e,this}getW(t){let e=this.array[t*this.itemSize+3];return this.normalized&&(e=ke(e,this.array)),e}setW(t,e){return this.normalized&&(e=zt(e,this.array)),this.array[t*this.itemSize+3]=e,this}setXY(t,e,n){return t*=this.itemSize,this.normalized&&(e=zt(e,this.array),n=zt(n,this.array)),this.array[t+0]=e,this.array[t+1]=n,this}setXYZ(t,e,n,i){return t*=this.itemSize,this.normalized&&(e=zt(e,this.array),n=zt(n,this.array),i=zt(i,this.array)),this.array[t+0]=e,this.array[t+1]=n,this.array[t+2]=i,this}setXYZW(t,e,n,i,s){return t*=this.itemSize,this.normalized&&(e=zt(e,this.array),n=zt(n,this.array),i=zt(i,this.array),s=zt(s,this.array)),this.array[t+0]=e,this.array[t+1]=n,this.array[t+2]=i,this.array[t+3]=s,this}onUpload(t){return this.onUploadCallback=t,this}clone(){return new this.constructor(this.array,this.itemSize).copy(this)}toJSON(){let t={itemSize:this.itemSize,type:this.array.constructor.name,array:Array.from(this.array),normalized:this.normalized};return this.name!==""&&(t.name=this.name),this.usage!==ta&&(t.usage=this.usage),t}},gh=class extends Jt{constructor(t,e,n){super(new Int8Array(t),e,n)}},_h=class extends Jt{constructor(t,e,n){super(new Uint8Array(t),e,n)}},xh=class extends Jt{constructor(t,e,n){super(new Uint8ClampedArray(t),e,n)}},vh=class extends Jt{constructor(t,e,n){super(new Int16Array(t),e,n)}},ra=class extends Jt{constructor(t,e,n){super(new Uint16Array(t),e,n)}},yh=class extends Jt{constructor(t,e,n){super(new Int32Array(t),e,n)}},aa=class extends Jt{constructor(t,e,n){super(new Uint32Array(t),e,n)}},Mh=class extends Jt{constructor(t,e,n){super(new Uint16Array(t),e,n),this.isFloat16BufferAttribute=!0}getX(t){let e=Ts(this.array[t*this.itemSize]);return this.normalized&&(e=ke(e,this.array)),e}setX(t,e){return this.normalized&&(e=zt(e,this.array)),this.array[t*this.itemSize]=Ve(e),this}getY(t){let e=Ts(this.array[t*this.itemSize+1]);return this.normalized&&(e=ke(e,this.array)),e}setY(t,e){return this.normalized&&(e=zt(e,this.array)),this.array[t*this.itemSize+1]=Ve(e),this}getZ(t){let e=Ts(this.array[t*this.itemSize+2]);return this.normalized&&(e=ke(e,this.array)),e}setZ(t,e){return this.normalized&&(e=zt(e,this.array)),this.array[t*this.itemSize+2]=Ve(e),this}getW(t){let e=Ts(this.array[t*this.itemSize+3]);return this.normalized&&(e=ke(e,this.array)),e}setW(t,e){return this.normalized&&(e=zt(e,this.array)),this.array[t*this.itemSize+3]=Ve(e),this}setXY(t,e,n){return t*=this.itemSize,this.normalized&&(e=zt(e,this.array),n=zt(n,this.array)),this.array[t+0]=Ve(e),this.array[t+1]=Ve(n),this}setXYZ(t,e,n,i){return t*=this.itemSize,this.normalized&&(e=zt(e,this.array),n=zt(n,this.array),i=zt(i,this.array)),this.array[t+0]=Ve(e),this.array[t+1]=Ve(n),this.array[t+2]=Ve(i),this}setXYZW(t,e,n,i,s){return t*=this.itemSize,this.normalized&&(e=zt(e,this.array),n=zt(n,this.array),i=zt(i,this.array),s=zt(s,this.array)),this.array[t+0]=Ve(e),this.array[t+1]=Ve(n),this.array[t+2]=Ve(i),this.array[t+3]=Ve(s),this}},xt=class extends Jt{constructor(t,e,n){super(new Float32Array(t),e,n)}},Sh=class extends Jt{constructor(t,e,n){super(new Float64Array(t),e,n)}},zp=0,Je=new It,so=new Kt,Ii=new w,Xe=new Le,xs=new Le,Me=new w,Wt=class r extends hn{constructor(){super(),this.isBufferGeometry=!0,Object.defineProperty(this,"id",{value:zp++}),this.uuid=Ye(),this.name="",this.type="BufferGeometry",this.index=null,this.attributes={},this.morphAttributes={},this.morphTargetsRelative=!1,this.groups=[],this.boundingBox=null,this.boundingSphere=null,this.drawRange={start:0,count:1/0},this.userData={}}getIndex(){return this.index}setIndex(t){return Array.isArray(t)?this.index=new(Vd(t)?aa:ra)(t,1):this.index=t,this}getAttribute(t){return this.attributes[t]}setAttribute(t,e){return this.attributes[t]=e,this}deleteAttribute(t){return delete this.attributes[t],this}hasAttribute(t){return this.attributes[t]!==void 0}addGroup(t,e,n=0){this.groups.push({start:t,count:e,materialIndex:n})}clearGroups(){this.groups=[]}setDrawRange(t,e){this.drawRange.start=t,this.drawRange.count=e}applyMatrix4(t){let e=this.attributes.position;e!==void 0&&(e.applyMatrix4(t),e.needsUpdate=!0);let n=this.attributes.normal;if(n!==void 0){let s=new Gt().getNormalMatrix(t);n.applyNormalMatrix(s),n.needsUpdate=!0}let i=this.attributes.tangent;return i!==void 0&&(i.transformDirection(t),i.needsUpdate=!0),this.boundingBox!==null&&this.computeBoundingBox(),this.boundingSphere!==null&&this.computeBoundingSphere(),this}applyQuaternion(t){return Je.makeRotationFromQuaternion(t),this.applyMatrix4(Je),this}rotateX(t){return Je.makeRotationX(t),this.applyMatrix4(Je),this}rotateY(t){return Je.makeRotationY(t),this.applyMatrix4(Je),this}rotateZ(t){return Je.makeRotationZ(t),this.applyMatrix4(Je),this}translate(t,e,n){return Je.makeTranslation(t,e,n),this.applyMatrix4(Je),this}scale(t,e,n){return Je.makeScale(t,e,n),this.applyMatrix4(Je),this}lookAt(t){return so.lookAt(t),so.updateMatrix(),this.applyMatrix4(so.matrix),this}center(){return this.computeBoundingBox(),this.boundingBox.getCenter(Ii).negate(),this.translate(Ii.x,Ii.y,Ii.z),this}setFromPoints(t){let e=[];for(let n=0,i=t.length;n<i;n++){let s=t[n];e.push(s.x,s.y,s.z||0)}return this.setAttribute("position",new xt(e,3)),this}computeBoundingBox(){this.boundingBox===null&&(this.boundingBox=new Le);let t=this.attributes.position,e=this.morphAttributes.position;if(t&&t.isGLBufferAttribute){console.error('THREE.BufferGeometry.computeBoundingBox(): GLBufferAttribute requires a manual bounding box. Alternatively set "mesh.frustumCulled" to "false".',this),this.boundingBox.set(new w(-1/0,-1/0,-1/0),new w(1/0,1/0,1/0));return}if(t!==void 0){if(this.boundingBox.setFromBufferAttribute(t),e)for(let n=0,i=e.length;n<i;n++){let s=e[n];Xe.setFromBufferAttribute(s),this.morphTargetsRelative?(Me.addVectors(this.boundingBox.min,Xe.min),this.boundingBox.expandByPoint(Me),Me.addVectors(this.boundingBox.max,Xe.max),this.boundingBox.expandByPoint(Me)):(this.boundingBox.expandByPoint(Xe.min),this.boundingBox.expandByPoint(Xe.max))}}else this.boundingBox.makeEmpty();(isNaN(this.boundingBox.min.x)||isNaN(this.boundingBox.min.y)||isNaN(this.boundingBox.min.z))&&console.error('THREE.BufferGeometry.computeBoundingBox(): Computed min/max have NaN values. The "position" attribute is likely to have NaN values.',this)}computeBoundingSphere(){this.boundingSphere===null&&(this.boundingSphere=new Ae);let t=this.attributes.position,e=this.morphAttributes.position;if(t&&t.isGLBufferAttribute){console.error('THREE.BufferGeometry.computeBoundingSphere(): GLBufferAttribute requires a manual bounding sphere. Alternatively set "mesh.frustumCulled" to "false".',this),this.boundingSphere.set(new w,1/0);return}if(t){let n=this.boundingSphere.center;if(Xe.setFromBufferAttribute(t),e)for(let s=0,a=e.length;s<a;s++){let o=e[s];xs.setFromBufferAttribute(o),this.morphTargetsRelative?(Me.addVectors(Xe.min,xs.min),Xe.expandByPoint(Me),Me.addVectors(Xe.max,xs.max),Xe.expandByPoint(Me)):(Xe.expandByPoint(xs.min),Xe.expandByPoint(xs.max))}Xe.getCenter(n);let i=0;for(let s=0,a=t.count;s<a;s++)Me.fromBufferAttribute(t,s),i=Math.max(i,n.distanceToSquared(Me));if(e)for(let s=0,a=e.length;s<a;s++){let o=e[s],c=this.morphTargetsRelative;for(let l=0,h=o.count;l<h;l++)Me.fromBufferAttribute(o,l),c&&(Ii.fromBufferAttribute(t,l),Me.add(Ii)),i=Math.max(i,n.distanceToSquared(Me))}this.boundingSphere.radius=Math.sqrt(i),isNaN(this.boundingSphere.radius)&&console.error('THREE.BufferGeometry.computeBoundingSphere(): Computed radius is NaN. The "position" attribute is likely to have NaN values.',this)}}computeTangents(){let t=this.index,e=this.attributes;if(t===null||e.position===void 0||e.normal===void 0||e.uv===void 0){console.error("THREE.BufferGeometry: .computeTangents() failed. Missing required attributes (index, position, normal or uv)");return}let n=t.array,i=e.position.array,s=e.normal.array,a=e.uv.array,o=i.length/3;this.hasAttribute("tangent")===!1&&this.setAttribute("tangent",new Jt(new Float32Array(4*o),4));let c=this.getAttribute("tangent").array,l=[],h=[];for(let E=0;E<o;E++)l[E]=new w,h[E]=new w;let u=new w,d=new w,f=new w,m=new Z,_=new Z,g=new Z,p=new w,v=new w;function x(E,N,G){u.fromArray(i,E*3),d.fromArray(i,N*3),f.fromArray(i,G*3),m.fromArray(a,E*2),_.fromArray(a,N*2),g.fromArray(a,G*2),d.sub(u),f.sub(u),_.sub(m),g.sub(m);let it=1/(_.x*g.y-g.x*_.y);isFinite(it)&&(p.copy(d).multiplyScalar(g.y).addScaledVector(f,-_.y).multiplyScalar(it),v.copy(f).multiplyScalar(_.x).addScaledVector(d,-g.x).multiplyScalar(it),l[E].add(p),l[N].add(p),l[G].add(p),h[E].add(v),h[N].add(v),h[G].add(v))}let y=this.groups;y.length===0&&(y=[{start:0,count:n.length}]);for(let E=0,N=y.length;E<N;++E){let G=y[E],it=G.start,I=G.count;for(let F=it,k=it+I;F<k;F+=3)x(n[F+0],n[F+1],n[F+2])}let C=new w,T=new w,R=new w,U=new w;function S(E){R.fromArray(s,E*3),U.copy(R);let N=l[E];C.copy(N),C.sub(R.multiplyScalar(R.dot(N))).normalize(),T.crossVectors(U,N);let it=T.dot(h[E])<0?-1:1;c[E*4]=C.x,c[E*4+1]=C.y,c[E*4+2]=C.z,c[E*4+3]=it}for(let E=0,N=y.length;E<N;++E){let G=y[E],it=G.start,I=G.count;for(let F=it,k=it+I;F<k;F+=3)S(n[F+0]),S(n[F+1]),S(n[F+2])}}computeVertexNormals(){let t=this.index,e=this.getAttribute("position");if(e!==void 0){let n=this.getAttribute("normal");if(n===void 0)n=new Jt(new Float32Array(e.count*3),3),this.setAttribute("normal",n);else for(let d=0,f=n.count;d<f;d++)n.setXYZ(d,0,0,0);let i=new w,s=new w,a=new w,o=new w,c=new w,l=new w,h=new w,u=new w;if(t)for(let d=0,f=t.count;d<f;d+=3){let m=t.getX(d+0),_=t.getX(d+1),g=t.getX(d+2);i.fromBufferAttribute(e,m),s.fromBufferAttribute(e,_),a.fromBufferAttribute(e,g),h.subVectors(a,s),u.subVectors(i,s),h.cross(u),o.fromBufferAttribute(n,m),c.fromBufferAttribute(n,_),l.fromBufferAttribute(n,g),o.add(h),c.add(h),l.add(h),n.setXYZ(m,o.x,o.y,o.z),n.setXYZ(_,c.x,c.y,c.z),n.setXYZ(g,l.x,l.y,l.z)}else for(let d=0,f=e.count;d<f;d+=3)i.fromBufferAttribute(e,d+0),s.fromBufferAttribute(e,d+1),a.fromBufferAttribute(e,d+2),h.subVectors(a,s),u.subVectors(i,s),h.cross(u),n.setXYZ(d+0,h.x,h.y,h.z),n.setXYZ(d+1,h.x,h.y,h.z),n.setXYZ(d+2,h.x,h.y,h.z);this.normalizeNormals(),n.needsUpdate=!0}}normalizeNormals(){let t=this.attributes.normal;for(let e=0,n=t.count;e<n;e++)Me.fromBufferAttribute(t,e),Me.normalize(),t.setXYZ(e,Me.x,Me.y,Me.z)}toNonIndexed(){function t(o,c){let l=o.array,h=o.itemSize,u=o.normalized,d=new l.constructor(c.length*h),f=0,m=0;for(let _=0,g=c.length;_<g;_++){o.isInterleavedBufferAttribute?f=c[_]*o.data.stride+o.offset:f=c[_]*h;for(let p=0;p<h;p++)d[m++]=l[f++]}return new Jt(d,h,u)}if(this.index===null)return console.warn("THREE.BufferGeometry.toNonIndexed(): BufferGeometry is already non-indexed."),this;let e=new r,n=this.index.array,i=this.attributes;for(let o in i){let c=i[o],l=t(c,n);e.setAttribute(o,l)}let s=this.morphAttributes;for(let o in s){let c=[],l=s[o];for(let h=0,u=l.length;h<u;h++){let d=l[h],f=t(d,n);c.push(f)}e.morphAttributes[o]=c}e.morphTargetsRelative=this.morphTargetsRelative;let a=this.groups;for(let o=0,c=a.length;o<c;o++){let l=a[o];e.addGroup(l.start,l.count,l.materialIndex)}return e}toJSON(){let t={metadata:{version:4.6,type:"BufferGeometry",generator:"BufferGeometry.toJSON"}};if(t.uuid=this.uuid,t.type=this.type,this.name!==""&&(t.name=this.name),Object.keys(this.userData).length>0&&(t.userData=this.userData),this.parameters!==void 0){let c=this.parameters;for(let l in c)c[l]!==void 0&&(t[l]=c[l]);return t}t.data={attributes:{}};let e=this.index;e!==null&&(t.data.index={type:e.array.constructor.name,array:Array.prototype.slice.call(e.array)});let n=this.attributes;for(let c in n){let l=n[c];t.data.attributes[c]=l.toJSON(t.data)}let i={},s=!1;for(let c in this.morphAttributes){let l=this.morphAttributes[c],h=[];for(let u=0,d=l.length;u<d;u++){let f=l[u];h.push(f.toJSON(t.data))}h.length>0&&(i[c]=h,s=!0)}s&&(t.data.morphAttributes=i,t.data.morphTargetsRelative=this.morphTargetsRelative);let a=this.groups;a.length>0&&(t.data.groups=JSON.parse(JSON.stringify(a)));let o=this.boundingSphere;return o!==null&&(t.data.boundingSphere={center:o.center.toArray(),radius:o.radius}),t}clone(){return new this.constructor().copy(this)}copy(t){this.index=null,this.attributes={},this.morphAttributes={},this.groups=[],this.boundingBox=null,this.boundingSphere=null;let e={};this.name=t.name;let n=t.index;n!==null&&this.setIndex(n.clone(e));let i=t.attributes;for(let l in i){let h=i[l];this.setAttribute(l,h.clone(e))}let s=t.morphAttributes;for(let l in s){let h=[],u=s[l];for(let d=0,f=u.length;d<f;d++)h.push(u[d].clone(e));this.morphAttributes[l]=h}this.morphTargetsRelative=t.morphTargetsRelative;let a=t.groups;for(let l=0,h=a.length;l<h;l++){let u=a[l];this.addGroup(u.start,u.count,u.materialIndex)}let o=t.boundingBox;o!==null&&(this.boundingBox=o.clone());let c=t.boundingSphere;return c!==null&&(this.boundingSphere=c.clone()),this.drawRange.start=t.drawRange.start,this.drawRange.count=t.drawRange.count,this.userData=t.userData,this}dispose(){this.dispatchEvent({type:"dispose"})}},bh=new It,Qn=new _i,or=new Ae,Eh=new w,Ui=new w,Di=new w,Ni=new w,ro=new w,cr=new w,lr=new Z,hr=new Z,ur=new Z,Ah=new w,Th=new w,wh=new w,dr=new w,fr=new w,ge=class extends Kt{constructor(t=new Wt,e=new An){super(),this.isMesh=!0,this.type="Mesh",this.geometry=t,this.material=e,this.updateMorphTargets()}copy(t,e){return super.copy(t,e),t.morphTargetInfluences!==void 0&&(this.morphTargetInfluences=t.morphTargetInfluences.slice()),t.morphTargetDictionary!==void 0&&(this.morphTargetDictionary=Object.assign({},t.morphTargetDictionary)),this.material=Array.isArray(t.material)?t.material.slice():t.material,this.geometry=t.geometry,this}updateMorphTargets(){let e=this.geometry.morphAttributes,n=Object.keys(e);if(n.length>0){let i=e[n[0]];if(i!==void 0){this.morphTargetInfluences=[],this.morphTargetDictionary={};for(let s=0,a=i.length;s<a;s++){let o=i[s].name||String(s);this.morphTargetInfluences.push(0),this.morphTargetDictionary[o]=s}}}}getVertexPosition(t,e){let n=this.geometry,i=n.attributes.position,s=n.morphAttributes.position,a=n.morphTargetsRelative;e.fromBufferAttribute(i,t);let o=this.morphTargetInfluences;if(s&&o){cr.set(0,0,0);for(let c=0,l=s.length;c<l;c++){let h=o[c],u=s[c];h!==0&&(ro.fromBufferAttribute(u,t),a?cr.addScaledVector(ro,h):cr.addScaledVector(ro.sub(e),h))}e.add(cr)}return e}raycast(t,e){let n=this.geometry,i=this.material,s=this.matrixWorld;i!==void 0&&(n.boundingSphere===null&&n.computeBoundingSphere(),or.copy(n.boundingSphere),or.applyMatrix4(s),Qn.copy(t.ray).recast(t.near),!(or.containsPoint(Qn.origin)===!1&&(Qn.intersectSphere(or,Eh)===null||Qn.origin.distanceToSquared(Eh)>(t.far-t.near)**2))&&(bh.copy(s).invert(),Qn.copy(t.ray).applyMatrix4(bh),!(n.boundingBox!==null&&Qn.intersectsBox(n.boundingBox)===!1)&&this._computeIntersections(t,e,Qn)))}_computeIntersections(t,e,n){let i,s=this.geometry,a=this.material,o=s.index,c=s.attributes.position,l=s.attributes.uv,h=s.attributes.uv1,u=s.attributes.normal,d=s.groups,f=s.drawRange;if(o!==null)if(Array.isArray(a))for(let m=0,_=d.length;m<_;m++){let g=d[m],p=a[g.materialIndex],v=Math.max(g.start,f.start),x=Math.min(o.count,Math.min(g.start+g.count,f.start+f.count));for(let y=v,C=x;y<C;y+=3){let T=o.getX(y),R=o.getX(y+1),U=o.getX(y+2);i=pr(this,p,t,n,l,h,u,T,R,U),i&&(i.faceIndex=Math.floor(y/3),i.face.materialIndex=g.materialIndex,e.push(i))}}else{let m=Math.max(0,f.start),_=Math.min(o.count,f.start+f.count);for(let g=m,p=_;g<p;g+=3){let v=o.getX(g),x=o.getX(g+1),y=o.getX(g+2);i=pr(this,a,t,n,l,h,u,v,x,y),i&&(i.faceIndex=Math.floor(g/3),e.push(i))}}else if(c!==void 0)if(Array.isArray(a))for(let m=0,_=d.length;m<_;m++){let g=d[m],p=a[g.materialIndex],v=Math.max(g.start,f.start),x=Math.min(c.count,Math.min(g.start+g.count,f.start+f.count));for(let y=v,C=x;y<C;y+=3){let T=y,R=y+1,U=y+2;i=pr(this,p,t,n,l,h,u,T,R,U),i&&(i.faceIndex=Math.floor(y/3),i.face.materialIndex=g.materialIndex,e.push(i))}}else{let m=Math.max(0,f.start),_=Math.min(c.count,f.start+f.count);for(let g=m,p=_;g<p;g+=3){let v=g,x=g+1,y=g+2;i=pr(this,a,t,n,l,h,u,v,x,y),i&&(i.faceIndex=Math.floor(g/3),e.push(i))}}}};function Vp(r,t,e,n,i,s,a,o){let c;if(t.side===He?c=n.intersectTriangle(a,s,i,!0,o):c=n.intersectTriangle(i,s,a,t.side===Wn,o),c===null)return null;fr.copy(o),fr.applyMatrix4(r.matrixWorld);let l=e.ray.origin.distanceTo(fr);return l<e.near||l>e.far?null:{distance:l,point:fr.clone(),object:r}}function pr(r,t,e,n,i,s,a,o,c,l){r.getVertexPosition(o,Ui),r.getVertexPosition(c,Di),r.getVertexPosition(l,Ni);let h=Vp(r,t,e,n,Ui,Di,Ni,dr);if(h){i&&(lr.fromBufferAttribute(i,o),hr.fromBufferAttribute(i,c),ur.fromBufferAttribute(i,l),h.uv=Fn.getInterpolation(dr,Ui,Di,Ni,lr,hr,ur,new Z)),s&&(lr.fromBufferAttribute(s,o),hr.fromBufferAttribute(s,c),ur.fromBufferAttribute(s,l),h.uv1=Fn.getInterpolation(dr,Ui,Di,Ni,lr,hr,ur,new Z),h.uv2=h.uv1),a&&(Ah.fromBufferAttribute(a,o),Th.fromBufferAttribute(a,c),wh.fromBufferAttribute(a,l),h.normal=Fn.getInterpolation(dr,Ui,Di,Ni,Ah,Th,wh,new w),h.normal.dot(n.direction)>0&&h.normal.multiplyScalar(-1));let u={a:o,b:c,c:l,normal:new w,materialIndex:0};Fn.getNormal(Ui,Di,Ni,u.normal),h.face=u}return h}var ns=class r extends Wt{constructor(t=1,e=1,n=1,i=1,s=1,a=1){super(),this.type="BoxGeometry",this.parameters={width:t,height:e,depth:n,widthSegments:i,heightSegments:s,depthSegments:a};let o=this;i=Math.floor(i),s=Math.floor(s),a=Math.floor(a);let c=[],l=[],h=[],u=[],d=0,f=0;m("z","y","x",-1,-1,n,e,t,a,s,0),m("z","y","x",1,-1,n,e,-t,a,s,1),m("x","z","y",1,1,t,n,e,i,a,2),m("x","z","y",1,-1,t,n,-e,i,a,3),m("x","y","z",1,-1,t,e,n,i,s,4),m("x","y","z",-1,-1,t,e,-n,i,s,5),this.setIndex(c),this.setAttribute("position",new xt(l,3)),this.setAttribute("normal",new xt(h,3)),this.setAttribute("uv",new xt(u,2));function m(_,g,p,v,x,y,C,T,R,U,S){let E=y/R,N=C/U,G=y/2,it=C/2,I=T/2,F=R+1,k=U+1,J=0,Y=0,W=new w;for(let tt=0;tt<k;tt++){let et=tt*N-it;for(let ut=0;ut<F;ut++){let H=ut*E-G;W[_]=H*v,W[g]=et*x,W[p]=I,l.push(W.x,W.y,W.z),W[_]=0,W[g]=0,W[p]=T>0?1:-1,h.push(W.x,W.y,W.z),u.push(ut/R),u.push(1-tt/U),J+=1}}for(let tt=0;tt<U;tt++)for(let et=0;et<R;et++){let ut=d+et+F*tt,H=d+et+F*(tt+1),K=d+(et+1)+F*(tt+1),dt=d+(et+1)+F*tt;c.push(ut,H,dt),c.push(H,K,dt),Y+=6}o.addGroup(f,Y,S),f+=Y,d+=J}}copy(t){return super.copy(t),this.parameters=Object.assign({},t.parameters),this}static fromJSON(t){return new r(t.width,t.height,t.depth,t.widthSegments,t.heightSegments,t.depthSegments)}};function is(r){let t={};for(let e in r){t[e]={};for(let n in r[e]){let i=r[e][n];i&&(i.isColor||i.isMatrix3||i.isMatrix4||i.isVector2||i.isVector3||i.isVector4||i.isTexture||i.isQuaternion)?i.isRenderTargetTexture?(console.warn("UniformsUtils: Textures of render targets cannot be cloned via cloneUniforms() or mergeUniforms()."),t[e][n]=null):t[e][n]=i.clone():Array.isArray(i)?t[e][n]=i.slice():t[e][n]=i}}return t}function Oe(r){let t={};for(let e=0;e<r.length;e++){let n=is(r[e]);for(let i in n)t[i]=n[i]}return t}function kp(r){let t=[];for(let e=0;e<r.length;e++)t.push(r[e].clone());return t}function Hd(r){return r.getRenderTarget()===null?r.outputColorSpace:jt.workingColorSpace}var Hp={clone:is,merge:Oe},Gp=`void main() {
	gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}`,Wp=`void main() {
	gl_FragColor = vec4( 1.0, 0.0, 0.0, 1.0 );
}`,sn=class extends Te{constructor(t){super(),this.isShaderMaterial=!0,this.type="ShaderMaterial",this.defines={},this.uniforms={},this.uniformsGroups=[],this.vertexShader=Gp,this.fragmentShader=Wp,this.linewidth=1,this.wireframe=!1,this.wireframeLinewidth=1,this.fog=!1,this.lights=!1,this.clipping=!1,this.forceSinglePass=!0,this.extensions={derivatives:!1,fragDepth:!1,drawBuffers:!1,shaderTextureLOD:!1,clipCullDistance:!1},this.defaultAttributeValues={color:[1,1,1],uv:[0,0],uv1:[0,0]},this.index0AttributeName=void 0,this.uniformsNeedUpdate=!1,this.glslVersion=null,t!==void 0&&this.setValues(t)}copy(t){return super.copy(t),this.fragmentShader=t.fragmentShader,this.vertexShader=t.vertexShader,this.uniforms=is(t.uniforms),this.uniformsGroups=kp(t.uniformsGroups),this.defines=Object.assign({},t.defines),this.wireframe=t.wireframe,this.wireframeLinewidth=t.wireframeLinewidth,this.fog=t.fog,this.lights=t.lights,this.clipping=t.clipping,this.extensions=Object.assign({},t.extensions),this.glslVersion=t.glslVersion,this}toJSON(t){let e=super.toJSON(t);e.glslVersion=this.glslVersion,e.uniforms={};for(let i in this.uniforms){let a=this.uniforms[i].value;a&&a.isTexture?e.uniforms[i]={type:"t",value:a.toJSON(t).uuid}:a&&a.isColor?e.uniforms[i]={type:"c",value:a.getHex()}:a&&a.isVector2?e.uniforms[i]={type:"v2",value:a.toArray()}:a&&a.isVector3?e.uniforms[i]={type:"v3",value:a.toArray()}:a&&a.isVector4?e.uniforms[i]={type:"v4",value:a.toArray()}:a&&a.isMatrix3?e.uniforms[i]={type:"m3",value:a.toArray()}:a&&a.isMatrix4?e.uniforms[i]={type:"m4",value:a.toArray()}:e.uniforms[i]={value:a}}Object.keys(this.defines).length>0&&(e.defines=this.defines),e.vertexShader=this.vertexShader,e.fragmentShader=this.fragmentShader,e.lights=this.lights,e.clipping=this.clipping;let n={};for(let i in this.extensions)this.extensions[i]===!0&&(n[i]=!0);return Object.keys(n).length>0&&(e.extensions=n),e}},Fs=class extends Kt{constructor(){super(),this.isCamera=!0,this.type="Camera",this.matrixWorldInverse=new It,this.projectionMatrix=new It,this.projectionMatrixInverse=new It,this.coordinateSystem=ln}copy(t,e){return super.copy(t,e),this.matrixWorldInverse.copy(t.matrixWorldInverse),this.projectionMatrix.copy(t.projectionMatrix),this.projectionMatrixInverse.copy(t.projectionMatrixInverse),this.coordinateSystem=t.coordinateSystem,this}getWorldDirection(t){return super.getWorldDirection(t).negate()}updateMatrixWorld(t){super.updateMatrixWorld(t),this.matrixWorldInverse.copy(this.matrixWorld).invert()}updateWorldMatrix(t,e){super.updateWorldMatrix(t,e),this.matrixWorldInverse.copy(this.matrixWorld).invert()}clone(){return new this.constructor().copy(this)}},be=class extends Fs{constructor(t=50,e=1,n=.1,i=2e3){super(),this.isPerspectiveCamera=!0,this.type="PerspectiveCamera",this.fov=t,this.zoom=1,this.near=n,this.far=i,this.focus=10,this.aspect=e,this.view=null,this.filmGauge=35,this.filmOffset=0,this.updateProjectionMatrix()}copy(t,e){return super.copy(t,e),this.fov=t.fov,this.zoom=t.zoom,this.near=t.near,this.far=t.far,this.focus=t.focus,this.aspect=t.aspect,this.view=t.view===null?null:Object.assign({},t.view),this.filmGauge=t.filmGauge,this.filmOffset=t.filmOffset,this}setFocalLength(t){let e=.5*this.getFilmHeight()/t;this.fov=es*2*Math.atan(e),this.updateProjectionMatrix()}getFocalLength(){let t=Math.tan(pi*.5*this.fov);return .5*this.getFilmHeight()/t}getEffectiveFOV(){return es*2*Math.atan(Math.tan(pi*.5*this.fov)/this.zoom)}getFilmWidth(){return this.filmGauge*Math.min(this.aspect,1)}getFilmHeight(){return this.filmGauge/Math.max(this.aspect,1)}setViewOffset(t,e,n,i,s,a){this.aspect=t/e,this.view===null&&(this.view={enabled:!0,fullWidth:1,fullHeight:1,offsetX:0,offsetY:0,width:1,height:1}),this.view.enabled=!0,this.view.fullWidth=t,this.view.fullHeight=e,this.view.offsetX=n,this.view.offsetY=i,this.view.width=s,this.view.height=a,this.updateProjectionMatrix()}clearViewOffset(){this.view!==null&&(this.view.enabled=!1),this.updateProjectionMatrix()}updateProjectionMatrix(){let t=this.near,e=t*Math.tan(pi*.5*this.fov)/this.zoom,n=2*e,i=this.aspect*n,s=-.5*i,a=this.view;if(this.view!==null&&this.view.enabled){let c=a.fullWidth,l=a.fullHeight;s+=a.offsetX*i/c,e-=a.offsetY*n/l,i*=a.width/c,n*=a.height/l}let o=this.filmOffset;o!==0&&(s+=t*o/this.getFilmWidth()),this.projectionMatrix.makePerspective(s,s+i,e,e-n,t,this.far,this.coordinateSystem),this.projectionMatrixInverse.copy(this.projectionMatrix).invert()}toJSON(t){let e=super.toJSON(t);return e.object.fov=this.fov,e.object.zoom=this.zoom,e.object.near=this.near,e.object.far=this.far,e.object.focus=this.focus,e.object.aspect=this.aspect,this.view!==null&&(e.object.view=Object.assign({},this.view)),e.object.filmGauge=this.filmGauge,e.object.filmOffset=this.filmOffset,e}},Oi=-90,Fi=1,Uo=class extends Kt{constructor(t,e,n){super(),this.type="CubeCamera",this.renderTarget=n,this.coordinateSystem=null,this.activeMipmapLevel=0;let i=new be(Oi,Fi,t,e);i.layers=this.layers,this.add(i);let s=new be(Oi,Fi,t,e);s.layers=this.layers,this.add(s);let a=new be(Oi,Fi,t,e);a.layers=this.layers,this.add(a);let o=new be(Oi,Fi,t,e);o.layers=this.layers,this.add(o);let c=new be(Oi,Fi,t,e);c.layers=this.layers,this.add(c);let l=new be(Oi,Fi,t,e);l.layers=this.layers,this.add(l)}updateCoordinateSystem(){let t=this.coordinateSystem,e=this.children.concat(),[n,i,s,a,o,c]=e;for(let l of e)this.remove(l);if(t===ln)n.up.set(0,1,0),n.lookAt(1,0,0),i.up.set(0,1,0),i.lookAt(-1,0,0),s.up.set(0,0,-1),s.lookAt(0,1,0),a.up.set(0,0,1),a.lookAt(0,-1,0),o.up.set(0,1,0),o.lookAt(0,0,1),c.up.set(0,1,0),c.lookAt(0,0,-1);else if(t===Us)n.up.set(0,-1,0),n.lookAt(-1,0,0),i.up.set(0,-1,0),i.lookAt(1,0,0),s.up.set(0,0,1),s.lookAt(0,1,0),a.up.set(0,0,-1),a.lookAt(0,-1,0),o.up.set(0,-1,0),o.lookAt(0,0,1),c.up.set(0,-1,0),c.lookAt(0,0,-1);else throw new Error("THREE.CubeCamera.updateCoordinateSystem(): Invalid coordinate system: "+t);for(let l of e)this.add(l),l.updateMatrixWorld()}update(t,e){this.parent===null&&this.updateMatrixWorld();let{renderTarget:n,activeMipmapLevel:i}=this;this.coordinateSystem!==t.coordinateSystem&&(this.coordinateSystem=t.coordinateSystem,this.updateCoordinateSystem());let[s,a,o,c,l,h]=this.children,u=t.getRenderTarget(),d=t.getActiveCubeFace(),f=t.getActiveMipmapLevel(),m=t.xr.enabled;t.xr.enabled=!1;let _=n.texture.generateMipmaps;n.texture.generateMipmaps=!1,t.setRenderTarget(n,0,i),t.render(e,s),t.setRenderTarget(n,1,i),t.render(e,a),t.setRenderTarget(n,2,i),t.render(e,o),t.setRenderTarget(n,3,i),t.render(e,c),t.setRenderTarget(n,4,i),t.render(e,l),n.texture.generateMipmaps=_,t.setRenderTarget(n,5,i),t.render(e,h),t.setRenderTarget(u,d,f),t.xr.enabled=m,n.texture.needsPMREMUpdate=!0}},ss=class extends Ee{constructor(t,e,n,i,s,a,o,c,l,h){t=t!==void 0?t:[],e=e!==void 0?e:Xn,super(t,e,n,i,s,a,o,c,l,h),this.isCubeTexture=!0,this.flipY=!1}get images(){return this.image}set images(t){this.image=t}},Do=class extends Ke{constructor(t=1,e={}){super(t,t,e),this.isWebGLCubeRenderTarget=!0;let n={width:t,height:t,depth:1},i=[n,n,n,n,n,n];e.encoding!==void 0&&(Rs("THREE.WebGLCubeRenderTarget: option.encoding has been replaced by option.colorSpace."),e.colorSpace=e.encoding===fi?Se:$e),this.texture=new ss(i,e.mapping,e.wrapS,e.wrapT,e.magFilter,e.minFilter,e.format,e.type,e.anisotropy,e.colorSpace),this.texture.isRenderTargetTexture=!0,this.texture.generateMipmaps=e.generateMipmaps!==void 0?e.generateMipmaps:!1,this.texture.minFilter=e.minFilter!==void 0?e.minFilter:me}fromEquirectangularTexture(t,e){this.texture.type=e.type,this.texture.colorSpace=e.colorSpace,this.texture.generateMipmaps=e.generateMipmaps,this.texture.minFilter=e.minFilter,this.texture.magFilter=e.magFilter;let n={uniforms:{tEquirect:{value:null}},vertexShader:`

				varying vec3 vWorldDirection;

				vec3 transformDirection( in vec3 dir, in mat4 matrix ) {

					return normalize( ( matrix * vec4( dir, 0.0 ) ).xyz );

				}

				void main() {

					vWorldDirection = transformDirection( position, modelMatrix );

					#include <begin_vertex>
					#include <project_vertex>

				}
			`,fragmentShader:`

				uniform sampler2D tEquirect;

				varying vec3 vWorldDirection;

				#include <common>

				void main() {

					vec3 direction = normalize( vWorldDirection );

					vec2 sampleUV = equirectUv( direction );

					gl_FragColor = texture2D( tEquirect, sampleUV );

				}
			`},i=new ns(5,5,5),s=new sn({name:"CubemapFromEquirect",uniforms:is(n.uniforms),vertexShader:n.vertexShader,fragmentShader:n.fragmentShader,side:He,blending:zn});s.uniforms.tEquirect.value=e;let a=new ge(i,s),o=e.minFilter;return e.minFilter===gi&&(e.minFilter=me),new Uo(1,10,this).update(t,a),e.minFilter=o,a.geometry.dispose(),a.material.dispose(),this}clear(t,e,n,i){let s=t.getRenderTarget();for(let a=0;a<6;a++)t.setRenderTarget(this,a),t.clear(e,n,i);t.setRenderTarget(s)}},ao=new w,Xp=new w,qp=new Gt,yn=class{constructor(t=new w(1,0,0),e=0){this.isPlane=!0,this.normal=t,this.constant=e}set(t,e){return this.normal.copy(t),this.constant=e,this}setComponents(t,e,n,i){return this.normal.set(t,e,n),this.constant=i,this}setFromNormalAndCoplanarPoint(t,e){return this.normal.copy(t),this.constant=-e.dot(this.normal),this}setFromCoplanarPoints(t,e,n){let i=ao.subVectors(n,e).cross(Xp.subVectors(t,e)).normalize();return this.setFromNormalAndCoplanarPoint(i,t),this}copy(t){return this.normal.copy(t.normal),this.constant=t.constant,this}normalize(){let t=1/this.normal.length();return this.normal.multiplyScalar(t),this.constant*=t,this}negate(){return this.constant*=-1,this.normal.negate(),this}distanceToPoint(t){return this.normal.dot(t)+this.constant}distanceToSphere(t){return this.distanceToPoint(t.center)-t.radius}projectPoint(t,e){return e.copy(t).addScaledVector(this.normal,-this.distanceToPoint(t))}intersectLine(t,e){let n=t.delta(ao),i=this.normal.dot(n);if(i===0)return this.distanceToPoint(t.start)===0?e.copy(t.start):null;let s=-(t.start.dot(this.normal)+this.constant)/i;return s<0||s>1?null:e.copy(t.start).addScaledVector(n,s)}intersectsLine(t){let e=this.distanceToPoint(t.start),n=this.distanceToPoint(t.end);return e<0&&n>0||n<0&&e>0}intersectsBox(t){return t.intersectsPlane(this)}intersectsSphere(t){return t.intersectsPlane(this)}coplanarPoint(t){return t.copy(this.normal).multiplyScalar(-this.constant)}applyMatrix4(t,e){let n=e||qp.getNormalMatrix(t),i=this.coplanarPoint(ao).applyMatrix4(t),s=this.normal.applyMatrix3(n).normalize();return this.constant=-i.dot(s),this}translate(t){return this.constant-=t.dot(this.normal),this}equals(t){return t.normal.equals(this.normal)&&t.constant===this.constant}clone(){return new this.constructor().copy(this)}},jn=new Ae,mr=new w,rs=class{constructor(t=new yn,e=new yn,n=new yn,i=new yn,s=new yn,a=new yn){this.planes=[t,e,n,i,s,a]}set(t,e,n,i,s,a){let o=this.planes;return o[0].copy(t),o[1].copy(e),o[2].copy(n),o[3].copy(i),o[4].copy(s),o[5].copy(a),this}copy(t){let e=this.planes;for(let n=0;n<6;n++)e[n].copy(t.planes[n]);return this}setFromProjectionMatrix(t,e=ln){let n=this.planes,i=t.elements,s=i[0],a=i[1],o=i[2],c=i[3],l=i[4],h=i[5],u=i[6],d=i[7],f=i[8],m=i[9],_=i[10],g=i[11],p=i[12],v=i[13],x=i[14],y=i[15];if(n[0].setComponents(c-s,d-l,g-f,y-p).normalize(),n[1].setComponents(c+s,d+l,g+f,y+p).normalize(),n[2].setComponents(c+a,d+h,g+m,y+v).normalize(),n[3].setComponents(c-a,d-h,g-m,y-v).normalize(),n[4].setComponents(c-o,d-u,g-_,y-x).normalize(),e===ln)n[5].setComponents(c+o,d+u,g+_,y+x).normalize();else if(e===Us)n[5].setComponents(o,u,_,x).normalize();else throw new Error("THREE.Frustum.setFromProjectionMatrix(): Invalid coordinate system: "+e);return this}intersectsObject(t){if(t.boundingSphere!==void 0)t.boundingSphere===null&&t.computeBoundingSphere(),jn.copy(t.boundingSphere).applyMatrix4(t.matrixWorld);else{let e=t.geometry;e.boundingSphere===null&&e.computeBoundingSphere(),jn.copy(e.boundingSphere).applyMatrix4(t.matrixWorld)}return this.intersectsSphere(jn)}intersectsSprite(t){return jn.center.set(0,0,0),jn.radius=.7071067811865476,jn.applyMatrix4(t.matrixWorld),this.intersectsSphere(jn)}intersectsSphere(t){let e=this.planes,n=t.center,i=-t.radius;for(let s=0;s<6;s++)if(e[s].distanceToPoint(n)<i)return!1;return!0}intersectsBox(t){let e=this.planes;for(let n=0;n<6;n++){let i=e[n];if(mr.x=i.normal.x>0?t.max.x:t.min.x,mr.y=i.normal.y>0?t.max.y:t.min.y,mr.z=i.normal.z>0?t.max.z:t.min.z,i.distanceToPoint(mr)<0)return!1}return!0}containsPoint(t){let e=this.planes;for(let n=0;n<6;n++)if(e[n].distanceToPoint(t)<0)return!1;return!0}clone(){return new this.constructor().copy(this)}};function Gd(){let r=null,t=!1,e=null,n=null;function i(s,a){e(s,a),n=r.requestAnimationFrame(i)}return{start:function(){t!==!0&&e!==null&&(n=r.requestAnimationFrame(i),t=!0)},stop:function(){r.cancelAnimationFrame(n),t=!1},setAnimationLoop:function(s){e=s},setContext:function(s){r=s}}}function Yp(r,t){let e=t.isWebGL2,n=new WeakMap;function i(l,h){let u=l.array,d=l.usage,f=u.byteLength,m=r.createBuffer();r.bindBuffer(h,m),r.bufferData(h,u,d),l.onUploadCallback();let _;if(u instanceof Float32Array)_=r.FLOAT;else if(u instanceof Uint16Array)if(l.isFloat16BufferAttribute)if(e)_=r.HALF_FLOAT;else throw new Error("THREE.WebGLAttributes: Usage of Float16BufferAttribute requires WebGL2.");else _=r.UNSIGNED_SHORT;else if(u instanceof Int16Array)_=r.SHORT;else if(u instanceof Uint32Array)_=r.UNSIGNED_INT;else if(u instanceof Int32Array)_=r.INT;else if(u instanceof Int8Array)_=r.BYTE;else if(u instanceof Uint8Array)_=r.UNSIGNED_BYTE;else if(u instanceof Uint8ClampedArray)_=r.UNSIGNED_BYTE;else throw new Error("THREE.WebGLAttributes: Unsupported buffer data format: "+u);return{buffer:m,type:_,bytesPerElement:u.BYTES_PER_ELEMENT,version:l.version,size:f}}function s(l,h,u){let d=h.array,f=h._updateRange,m=h.updateRanges;if(r.bindBuffer(u,l),f.count===-1&&m.length===0&&r.bufferSubData(u,0,d),m.length!==0){for(let _=0,g=m.length;_<g;_++){let p=m[_];e?r.bufferSubData(u,p.start*d.BYTES_PER_ELEMENT,d,p.start,p.count):r.bufferSubData(u,p.start*d.BYTES_PER_ELEMENT,d.subarray(p.start,p.start+p.count))}h.clearUpdateRanges()}f.count!==-1&&(e?r.bufferSubData(u,f.offset*d.BYTES_PER_ELEMENT,d,f.offset,f.count):r.bufferSubData(u,f.offset*d.BYTES_PER_ELEMENT,d.subarray(f.offset,f.offset+f.count)),f.count=-1),h.onUploadCallback()}function a(l){return l.isInterleavedBufferAttribute&&(l=l.data),n.get(l)}function o(l){l.isInterleavedBufferAttribute&&(l=l.data);let h=n.get(l);h&&(r.deleteBuffer(h.buffer),n.delete(l))}function c(l,h){if(l.isGLBufferAttribute){let d=n.get(l);(!d||d.version<l.version)&&n.set(l,{buffer:l.buffer,type:l.type,bytesPerElement:l.elementSize,version:l.version});return}l.isInterleavedBufferAttribute&&(l=l.data);let u=n.get(l);if(u===void 0)n.set(l,i(l,h));else if(u.version<l.version){if(u.size!==l.array.byteLength)throw new Error("THREE.WebGLAttributes: The size of the buffer attribute's array buffer does not match the original size. Resizing buffer attributes is not supported.");s(u.buffer,l,h),u.version=l.version}}return{get:a,remove:o,update:c}}var oa=class r extends Wt{constructor(t=1,e=1,n=1,i=1){super(),this.type="PlaneGeometry",this.parameters={width:t,height:e,widthSegments:n,heightSegments:i};let s=t/2,a=e/2,o=Math.floor(n),c=Math.floor(i),l=o+1,h=c+1,u=t/o,d=e/c,f=[],m=[],_=[],g=[];for(let p=0;p<h;p++){let v=p*d-a;for(let x=0;x<l;x++){let y=x*u-s;m.push(y,-v,0),_.push(0,0,1),g.push(x/o),g.push(1-p/c)}}for(let p=0;p<c;p++)for(let v=0;v<o;v++){let x=v+l*p,y=v+l*(p+1),C=v+1+l*(p+1),T=v+1+l*p;f.push(x,y,T),f.push(y,C,T)}this.setIndex(f),this.setAttribute("position",new xt(m,3)),this.setAttribute("normal",new xt(_,3)),this.setAttribute("uv",new xt(g,2))}copy(t){return super.copy(t),this.parameters=Object.assign({},t.parameters),this}static fromJSON(t){return new r(t.width,t.height,t.widthSegments,t.heightSegments)}},Zp=`#ifdef USE_ALPHAHASH
	if ( diffuseColor.a < getAlphaHashThreshold( vPosition ) ) discard;
#endif`,Jp=`#ifdef USE_ALPHAHASH
	const float ALPHA_HASH_SCALE = 0.05;
	float hash2D( vec2 value ) {
		return fract( 1.0e4 * sin( 17.0 * value.x + 0.1 * value.y ) * ( 0.1 + abs( sin( 13.0 * value.y + value.x ) ) ) );
	}
	float hash3D( vec3 value ) {
		return hash2D( vec2( hash2D( value.xy ), value.z ) );
	}
	float getAlphaHashThreshold( vec3 position ) {
		float maxDeriv = max(
			length( dFdx( position.xyz ) ),
			length( dFdy( position.xyz ) )
		);
		float pixScale = 1.0 / ( ALPHA_HASH_SCALE * maxDeriv );
		vec2 pixScales = vec2(
			exp2( floor( log2( pixScale ) ) ),
			exp2( ceil( log2( pixScale ) ) )
		);
		vec2 alpha = vec2(
			hash3D( floor( pixScales.x * position.xyz ) ),
			hash3D( floor( pixScales.y * position.xyz ) )
		);
		float lerpFactor = fract( log2( pixScale ) );
		float x = ( 1.0 - lerpFactor ) * alpha.x + lerpFactor * alpha.y;
		float a = min( lerpFactor, 1.0 - lerpFactor );
		vec3 cases = vec3(
			x * x / ( 2.0 * a * ( 1.0 - a ) ),
			( x - 0.5 * a ) / ( 1.0 - a ),
			1.0 - ( ( 1.0 - x ) * ( 1.0 - x ) / ( 2.0 * a * ( 1.0 - a ) ) )
		);
		float threshold = ( x < ( 1.0 - a ) )
			? ( ( x < a ) ? cases.x : cases.y )
			: cases.z;
		return clamp( threshold , 1.0e-6, 1.0 );
	}
#endif`,$p=`#ifdef USE_ALPHAMAP
	diffuseColor.a *= texture2D( alphaMap, vAlphaMapUv ).g;
#endif`,Kp=`#ifdef USE_ALPHAMAP
	uniform sampler2D alphaMap;
#endif`,Qp=`#ifdef USE_ALPHATEST
	if ( diffuseColor.a < alphaTest ) discard;
#endif`,jp=`#ifdef USE_ALPHATEST
	uniform float alphaTest;
#endif`,tm=`#ifdef USE_AOMAP
	float ambientOcclusion = ( texture2D( aoMap, vAoMapUv ).r - 1.0 ) * aoMapIntensity + 1.0;
	reflectedLight.indirectDiffuse *= ambientOcclusion;
	#if defined( USE_CLEARCOAT ) 
		clearcoatSpecularIndirect *= ambientOcclusion;
	#endif
	#if defined( USE_SHEEN ) 
		sheenSpecularIndirect *= ambientOcclusion;
	#endif
	#if defined( USE_ENVMAP ) && defined( STANDARD )
		float dotNV = saturate( dot( geometryNormal, geometryViewDir ) );
		reflectedLight.indirectSpecular *= computeSpecularOcclusion( dotNV, ambientOcclusion, material.roughness );
	#endif
#endif`,em=`#ifdef USE_AOMAP
	uniform sampler2D aoMap;
	uniform float aoMapIntensity;
#endif`,nm=`#ifdef USE_BATCHING
	attribute float batchId;
	uniform highp sampler2D batchingTexture;
	mat4 getBatchingMatrix( const in float i ) {
		int size = textureSize( batchingTexture, 0 ).x;
		int j = int( i ) * 4;
		int x = j % size;
		int y = j / size;
		vec4 v1 = texelFetch( batchingTexture, ivec2( x, y ), 0 );
		vec4 v2 = texelFetch( batchingTexture, ivec2( x + 1, y ), 0 );
		vec4 v3 = texelFetch( batchingTexture, ivec2( x + 2, y ), 0 );
		vec4 v4 = texelFetch( batchingTexture, ivec2( x + 3, y ), 0 );
		return mat4( v1, v2, v3, v4 );
	}
#endif`,im=`#ifdef USE_BATCHING
	mat4 batchingMatrix = getBatchingMatrix( batchId );
#endif`,sm=`vec3 transformed = vec3( position );
#ifdef USE_ALPHAHASH
	vPosition = vec3( position );
#endif`,rm=`vec3 objectNormal = vec3( normal );
#ifdef USE_TANGENT
	vec3 objectTangent = vec3( tangent.xyz );
#endif`,am=`float G_BlinnPhong_Implicit( ) {
	return 0.25;
}
float D_BlinnPhong( const in float shininess, const in float dotNH ) {
	return RECIPROCAL_PI * ( shininess * 0.5 + 1.0 ) * pow( dotNH, shininess );
}
vec3 BRDF_BlinnPhong( const in vec3 lightDir, const in vec3 viewDir, const in vec3 normal, const in vec3 specularColor, const in float shininess ) {
	vec3 halfDir = normalize( lightDir + viewDir );
	float dotNH = saturate( dot( normal, halfDir ) );
	float dotVH = saturate( dot( viewDir, halfDir ) );
	vec3 F = F_Schlick( specularColor, 1.0, dotVH );
	float G = G_BlinnPhong_Implicit( );
	float D = D_BlinnPhong( shininess, dotNH );
	return F * ( G * D );
} // validated`,om=`#ifdef USE_IRIDESCENCE
	const mat3 XYZ_TO_REC709 = mat3(
		 3.2404542, -0.9692660,  0.0556434,
		-1.5371385,  1.8760108, -0.2040259,
		-0.4985314,  0.0415560,  1.0572252
	);
	vec3 Fresnel0ToIor( vec3 fresnel0 ) {
		vec3 sqrtF0 = sqrt( fresnel0 );
		return ( vec3( 1.0 ) + sqrtF0 ) / ( vec3( 1.0 ) - sqrtF0 );
	}
	vec3 IorToFresnel0( vec3 transmittedIor, float incidentIor ) {
		return pow2( ( transmittedIor - vec3( incidentIor ) ) / ( transmittedIor + vec3( incidentIor ) ) );
	}
	float IorToFresnel0( float transmittedIor, float incidentIor ) {
		return pow2( ( transmittedIor - incidentIor ) / ( transmittedIor + incidentIor ));
	}
	vec3 evalSensitivity( float OPD, vec3 shift ) {
		float phase = 2.0 * PI * OPD * 1.0e-9;
		vec3 val = vec3( 5.4856e-13, 4.4201e-13, 5.2481e-13 );
		vec3 pos = vec3( 1.6810e+06, 1.7953e+06, 2.2084e+06 );
		vec3 var = vec3( 4.3278e+09, 9.3046e+09, 6.6121e+09 );
		vec3 xyz = val * sqrt( 2.0 * PI * var ) * cos( pos * phase + shift ) * exp( - pow2( phase ) * var );
		xyz.x += 9.7470e-14 * sqrt( 2.0 * PI * 4.5282e+09 ) * cos( 2.2399e+06 * phase + shift[ 0 ] ) * exp( - 4.5282e+09 * pow2( phase ) );
		xyz /= 1.0685e-7;
		vec3 rgb = XYZ_TO_REC709 * xyz;
		return rgb;
	}
	vec3 evalIridescence( float outsideIOR, float eta2, float cosTheta1, float thinFilmThickness, vec3 baseF0 ) {
		vec3 I;
		float iridescenceIOR = mix( outsideIOR, eta2, smoothstep( 0.0, 0.03, thinFilmThickness ) );
		float sinTheta2Sq = pow2( outsideIOR / iridescenceIOR ) * ( 1.0 - pow2( cosTheta1 ) );
		float cosTheta2Sq = 1.0 - sinTheta2Sq;
		if ( cosTheta2Sq < 0.0 ) {
			return vec3( 1.0 );
		}
		float cosTheta2 = sqrt( cosTheta2Sq );
		float R0 = IorToFresnel0( iridescenceIOR, outsideIOR );
		float R12 = F_Schlick( R0, 1.0, cosTheta1 );
		float T121 = 1.0 - R12;
		float phi12 = 0.0;
		if ( iridescenceIOR < outsideIOR ) phi12 = PI;
		float phi21 = PI - phi12;
		vec3 baseIOR = Fresnel0ToIor( clamp( baseF0, 0.0, 0.9999 ) );		vec3 R1 = IorToFresnel0( baseIOR, iridescenceIOR );
		vec3 R23 = F_Schlick( R1, 1.0, cosTheta2 );
		vec3 phi23 = vec3( 0.0 );
		if ( baseIOR[ 0 ] < iridescenceIOR ) phi23[ 0 ] = PI;
		if ( baseIOR[ 1 ] < iridescenceIOR ) phi23[ 1 ] = PI;
		if ( baseIOR[ 2 ] < iridescenceIOR ) phi23[ 2 ] = PI;
		float OPD = 2.0 * iridescenceIOR * thinFilmThickness * cosTheta2;
		vec3 phi = vec3( phi21 ) + phi23;
		vec3 R123 = clamp( R12 * R23, 1e-5, 0.9999 );
		vec3 r123 = sqrt( R123 );
		vec3 Rs = pow2( T121 ) * R23 / ( vec3( 1.0 ) - R123 );
		vec3 C0 = R12 + Rs;
		I = C0;
		vec3 Cm = Rs - T121;
		for ( int m = 1; m <= 2; ++ m ) {
			Cm *= r123;
			vec3 Sm = 2.0 * evalSensitivity( float( m ) * OPD, float( m ) * phi );
			I += Cm * Sm;
		}
		return max( I, vec3( 0.0 ) );
	}
#endif`,cm=`#ifdef USE_BUMPMAP
	uniform sampler2D bumpMap;
	uniform float bumpScale;
	vec2 dHdxy_fwd() {
		vec2 dSTdx = dFdx( vBumpMapUv );
		vec2 dSTdy = dFdy( vBumpMapUv );
		float Hll = bumpScale * texture2D( bumpMap, vBumpMapUv ).x;
		float dBx = bumpScale * texture2D( bumpMap, vBumpMapUv + dSTdx ).x - Hll;
		float dBy = bumpScale * texture2D( bumpMap, vBumpMapUv + dSTdy ).x - Hll;
		return vec2( dBx, dBy );
	}
	vec3 perturbNormalArb( vec3 surf_pos, vec3 surf_norm, vec2 dHdxy, float faceDirection ) {
		vec3 vSigmaX = normalize( dFdx( surf_pos.xyz ) );
		vec3 vSigmaY = normalize( dFdy( surf_pos.xyz ) );
		vec3 vN = surf_norm;
		vec3 R1 = cross( vSigmaY, vN );
		vec3 R2 = cross( vN, vSigmaX );
		float fDet = dot( vSigmaX, R1 ) * faceDirection;
		vec3 vGrad = sign( fDet ) * ( dHdxy.x * R1 + dHdxy.y * R2 );
		return normalize( abs( fDet ) * surf_norm - vGrad );
	}
#endif`,lm=`#if NUM_CLIPPING_PLANES > 0
	vec4 plane;
	#pragma unroll_loop_start
	for ( int i = 0; i < UNION_CLIPPING_PLANES; i ++ ) {
		plane = clippingPlanes[ i ];
		if ( dot( vClipPosition, plane.xyz ) > plane.w ) discard;
	}
	#pragma unroll_loop_end
	#if UNION_CLIPPING_PLANES < NUM_CLIPPING_PLANES
		bool clipped = true;
		#pragma unroll_loop_start
		for ( int i = UNION_CLIPPING_PLANES; i < NUM_CLIPPING_PLANES; i ++ ) {
			plane = clippingPlanes[ i ];
			clipped = ( dot( vClipPosition, plane.xyz ) > plane.w ) && clipped;
		}
		#pragma unroll_loop_end
		if ( clipped ) discard;
	#endif
#endif`,hm=`#if NUM_CLIPPING_PLANES > 0
	varying vec3 vClipPosition;
	uniform vec4 clippingPlanes[ NUM_CLIPPING_PLANES ];
#endif`,um=`#if NUM_CLIPPING_PLANES > 0
	varying vec3 vClipPosition;
#endif`,dm=`#if NUM_CLIPPING_PLANES > 0
	vClipPosition = - mvPosition.xyz;
#endif`,fm=`#if defined( USE_COLOR_ALPHA )
	diffuseColor *= vColor;
#elif defined( USE_COLOR )
	diffuseColor.rgb *= vColor;
#endif`,pm=`#if defined( USE_COLOR_ALPHA )
	varying vec4 vColor;
#elif defined( USE_COLOR )
	varying vec3 vColor;
#endif`,mm=`#if defined( USE_COLOR_ALPHA )
	varying vec4 vColor;
#elif defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
	varying vec3 vColor;
#endif`,gm=`#if defined( USE_COLOR_ALPHA )
	vColor = vec4( 1.0 );
#elif defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
	vColor = vec3( 1.0 );
#endif
#ifdef USE_COLOR
	vColor *= color;
#endif
#ifdef USE_INSTANCING_COLOR
	vColor.xyz *= instanceColor.xyz;
#endif`,_m=`#define PI 3.141592653589793
#define PI2 6.283185307179586
#define PI_HALF 1.5707963267948966
#define RECIPROCAL_PI 0.3183098861837907
#define RECIPROCAL_PI2 0.15915494309189535
#define EPSILON 1e-6
#ifndef saturate
#define saturate( a ) clamp( a, 0.0, 1.0 )
#endif
#define whiteComplement( a ) ( 1.0 - saturate( a ) )
float pow2( const in float x ) { return x*x; }
vec3 pow2( const in vec3 x ) { return x*x; }
float pow3( const in float x ) { return x*x*x; }
float pow4( const in float x ) { float x2 = x*x; return x2*x2; }
float max3( const in vec3 v ) { return max( max( v.x, v.y ), v.z ); }
float average( const in vec3 v ) { return dot( v, vec3( 0.3333333 ) ); }
highp float rand( const in vec2 uv ) {
	const highp float a = 12.9898, b = 78.233, c = 43758.5453;
	highp float dt = dot( uv.xy, vec2( a,b ) ), sn = mod( dt, PI );
	return fract( sin( sn ) * c );
}
#ifdef HIGH_PRECISION
	float precisionSafeLength( vec3 v ) { return length( v ); }
#else
	float precisionSafeLength( vec3 v ) {
		float maxComponent = max3( abs( v ) );
		return length( v / maxComponent ) * maxComponent;
	}
#endif
struct IncidentLight {
	vec3 color;
	vec3 direction;
	bool visible;
};
struct ReflectedLight {
	vec3 directDiffuse;
	vec3 directSpecular;
	vec3 indirectDiffuse;
	vec3 indirectSpecular;
};
#ifdef USE_ALPHAHASH
	varying vec3 vPosition;
#endif
vec3 transformDirection( in vec3 dir, in mat4 matrix ) {
	return normalize( ( matrix * vec4( dir, 0.0 ) ).xyz );
}
vec3 inverseTransformDirection( in vec3 dir, in mat4 matrix ) {
	return normalize( ( vec4( dir, 0.0 ) * matrix ).xyz );
}
mat3 transposeMat3( const in mat3 m ) {
	mat3 tmp;
	tmp[ 0 ] = vec3( m[ 0 ].x, m[ 1 ].x, m[ 2 ].x );
	tmp[ 1 ] = vec3( m[ 0 ].y, m[ 1 ].y, m[ 2 ].y );
	tmp[ 2 ] = vec3( m[ 0 ].z, m[ 1 ].z, m[ 2 ].z );
	return tmp;
}
float luminance( const in vec3 rgb ) {
	const vec3 weights = vec3( 0.2126729, 0.7151522, 0.0721750 );
	return dot( weights, rgb );
}
bool isPerspectiveMatrix( mat4 m ) {
	return m[ 2 ][ 3 ] == - 1.0;
}
vec2 equirectUv( in vec3 dir ) {
	float u = atan( dir.z, dir.x ) * RECIPROCAL_PI2 + 0.5;
	float v = asin( clamp( dir.y, - 1.0, 1.0 ) ) * RECIPROCAL_PI + 0.5;
	return vec2( u, v );
}
vec3 BRDF_Lambert( const in vec3 diffuseColor ) {
	return RECIPROCAL_PI * diffuseColor;
}
vec3 F_Schlick( const in vec3 f0, const in float f90, const in float dotVH ) {
	float fresnel = exp2( ( - 5.55473 * dotVH - 6.98316 ) * dotVH );
	return f0 * ( 1.0 - fresnel ) + ( f90 * fresnel );
}
float F_Schlick( const in float f0, const in float f90, const in float dotVH ) {
	float fresnel = exp2( ( - 5.55473 * dotVH - 6.98316 ) * dotVH );
	return f0 * ( 1.0 - fresnel ) + ( f90 * fresnel );
} // validated`,xm=`#ifdef ENVMAP_TYPE_CUBE_UV
	#define cubeUV_minMipLevel 4.0
	#define cubeUV_minTileSize 16.0
	float getFace( vec3 direction ) {
		vec3 absDirection = abs( direction );
		float face = - 1.0;
		if ( absDirection.x > absDirection.z ) {
			if ( absDirection.x > absDirection.y )
				face = direction.x > 0.0 ? 0.0 : 3.0;
			else
				face = direction.y > 0.0 ? 1.0 : 4.0;
		} else {
			if ( absDirection.z > absDirection.y )
				face = direction.z > 0.0 ? 2.0 : 5.0;
			else
				face = direction.y > 0.0 ? 1.0 : 4.0;
		}
		return face;
	}
	vec2 getUV( vec3 direction, float face ) {
		vec2 uv;
		if ( face == 0.0 ) {
			uv = vec2( direction.z, direction.y ) / abs( direction.x );
		} else if ( face == 1.0 ) {
			uv = vec2( - direction.x, - direction.z ) / abs( direction.y );
		} else if ( face == 2.0 ) {
			uv = vec2( - direction.x, direction.y ) / abs( direction.z );
		} else if ( face == 3.0 ) {
			uv = vec2( - direction.z, direction.y ) / abs( direction.x );
		} else if ( face == 4.0 ) {
			uv = vec2( - direction.x, direction.z ) / abs( direction.y );
		} else {
			uv = vec2( direction.x, direction.y ) / abs( direction.z );
		}
		return 0.5 * ( uv + 1.0 );
	}
	vec3 bilinearCubeUV( sampler2D envMap, vec3 direction, float mipInt ) {
		float face = getFace( direction );
		float filterInt = max( cubeUV_minMipLevel - mipInt, 0.0 );
		mipInt = max( mipInt, cubeUV_minMipLevel );
		float faceSize = exp2( mipInt );
		highp vec2 uv = getUV( direction, face ) * ( faceSize - 2.0 ) + 1.0;
		if ( face > 2.0 ) {
			uv.y += faceSize;
			face -= 3.0;
		}
		uv.x += face * faceSize;
		uv.x += filterInt * 3.0 * cubeUV_minTileSize;
		uv.y += 4.0 * ( exp2( CUBEUV_MAX_MIP ) - faceSize );
		uv.x *= CUBEUV_TEXEL_WIDTH;
		uv.y *= CUBEUV_TEXEL_HEIGHT;
		#ifdef texture2DGradEXT
			return texture2DGradEXT( envMap, uv, vec2( 0.0 ), vec2( 0.0 ) ).rgb;
		#else
			return texture2D( envMap, uv ).rgb;
		#endif
	}
	#define cubeUV_r0 1.0
	#define cubeUV_m0 - 2.0
	#define cubeUV_r1 0.8
	#define cubeUV_m1 - 1.0
	#define cubeUV_r4 0.4
	#define cubeUV_m4 2.0
	#define cubeUV_r5 0.305
	#define cubeUV_m5 3.0
	#define cubeUV_r6 0.21
	#define cubeUV_m6 4.0
	float roughnessToMip( float roughness ) {
		float mip = 0.0;
		if ( roughness >= cubeUV_r1 ) {
			mip = ( cubeUV_r0 - roughness ) * ( cubeUV_m1 - cubeUV_m0 ) / ( cubeUV_r0 - cubeUV_r1 ) + cubeUV_m0;
		} else if ( roughness >= cubeUV_r4 ) {
			mip = ( cubeUV_r1 - roughness ) * ( cubeUV_m4 - cubeUV_m1 ) / ( cubeUV_r1 - cubeUV_r4 ) + cubeUV_m1;
		} else if ( roughness >= cubeUV_r5 ) {
			mip = ( cubeUV_r4 - roughness ) * ( cubeUV_m5 - cubeUV_m4 ) / ( cubeUV_r4 - cubeUV_r5 ) + cubeUV_m4;
		} else if ( roughness >= cubeUV_r6 ) {
			mip = ( cubeUV_r5 - roughness ) * ( cubeUV_m6 - cubeUV_m5 ) / ( cubeUV_r5 - cubeUV_r6 ) + cubeUV_m5;
		} else {
			mip = - 2.0 * log2( 1.16 * roughness );		}
		return mip;
	}
	vec4 textureCubeUV( sampler2D envMap, vec3 sampleDir, float roughness ) {
		float mip = clamp( roughnessToMip( roughness ), cubeUV_m0, CUBEUV_MAX_MIP );
		float mipF = fract( mip );
		float mipInt = floor( mip );
		vec3 color0 = bilinearCubeUV( envMap, sampleDir, mipInt );
		if ( mipF == 0.0 ) {
			return vec4( color0, 1.0 );
		} else {
			vec3 color1 = bilinearCubeUV( envMap, sampleDir, mipInt + 1.0 );
			return vec4( mix( color0, color1, mipF ), 1.0 );
		}
	}
#endif`,vm=`vec3 transformedNormal = objectNormal;
#ifdef USE_TANGENT
	vec3 transformedTangent = objectTangent;
#endif
#ifdef USE_BATCHING
	mat3 bm = mat3( batchingMatrix );
	transformedNormal /= vec3( dot( bm[ 0 ], bm[ 0 ] ), dot( bm[ 1 ], bm[ 1 ] ), dot( bm[ 2 ], bm[ 2 ] ) );
	transformedNormal = bm * transformedNormal;
	#ifdef USE_TANGENT
		transformedTangent = bm * transformedTangent;
	#endif
#endif
#ifdef USE_INSTANCING
	mat3 im = mat3( instanceMatrix );
	transformedNormal /= vec3( dot( im[ 0 ], im[ 0 ] ), dot( im[ 1 ], im[ 1 ] ), dot( im[ 2 ], im[ 2 ] ) );
	transformedNormal = im * transformedNormal;
	#ifdef USE_TANGENT
		transformedTangent = im * transformedTangent;
	#endif
#endif
transformedNormal = normalMatrix * transformedNormal;
#ifdef FLIP_SIDED
	transformedNormal = - transformedNormal;
#endif
#ifdef USE_TANGENT
	transformedTangent = ( modelViewMatrix * vec4( transformedTangent, 0.0 ) ).xyz;
	#ifdef FLIP_SIDED
		transformedTangent = - transformedTangent;
	#endif
#endif`,ym=`#ifdef USE_DISPLACEMENTMAP
	uniform sampler2D displacementMap;
	uniform float displacementScale;
	uniform float displacementBias;
#endif`,Mm=`#ifdef USE_DISPLACEMENTMAP
	transformed += normalize( objectNormal ) * ( texture2D( displacementMap, vDisplacementMapUv ).x * displacementScale + displacementBias );
#endif`,Sm=`#ifdef USE_EMISSIVEMAP
	vec4 emissiveColor = texture2D( emissiveMap, vEmissiveMapUv );
	totalEmissiveRadiance *= emissiveColor.rgb;
#endif`,bm=`#ifdef USE_EMISSIVEMAP
	uniform sampler2D emissiveMap;
#endif`,Em="gl_FragColor = linearToOutputTexel( gl_FragColor );",Am=`
const mat3 LINEAR_SRGB_TO_LINEAR_DISPLAY_P3 = mat3(
	vec3( 0.8224621, 0.177538, 0.0 ),
	vec3( 0.0331941, 0.9668058, 0.0 ),
	vec3( 0.0170827, 0.0723974, 0.9105199 )
);
const mat3 LINEAR_DISPLAY_P3_TO_LINEAR_SRGB = mat3(
	vec3( 1.2249401, - 0.2249404, 0.0 ),
	vec3( - 0.0420569, 1.0420571, 0.0 ),
	vec3( - 0.0196376, - 0.0786361, 1.0982735 )
);
vec4 LinearSRGBToLinearDisplayP3( in vec4 value ) {
	return vec4( value.rgb * LINEAR_SRGB_TO_LINEAR_DISPLAY_P3, value.a );
}
vec4 LinearDisplayP3ToLinearSRGB( in vec4 value ) {
	return vec4( value.rgb * LINEAR_DISPLAY_P3_TO_LINEAR_SRGB, value.a );
}
vec4 LinearTransferOETF( in vec4 value ) {
	return value;
}
vec4 sRGBTransferOETF( in vec4 value ) {
	return vec4( mix( pow( value.rgb, vec3( 0.41666 ) ) * 1.055 - vec3( 0.055 ), value.rgb * 12.92, vec3( lessThanEqual( value.rgb, vec3( 0.0031308 ) ) ) ), value.a );
}
vec4 LinearToLinear( in vec4 value ) {
	return value;
}
vec4 LinearTosRGB( in vec4 value ) {
	return sRGBTransferOETF( value );
}`,Tm=`#ifdef USE_ENVMAP
	#ifdef ENV_WORLDPOS
		vec3 cameraToFrag;
		if ( isOrthographic ) {
			cameraToFrag = normalize( vec3( - viewMatrix[ 0 ][ 2 ], - viewMatrix[ 1 ][ 2 ], - viewMatrix[ 2 ][ 2 ] ) );
		} else {
			cameraToFrag = normalize( vWorldPosition - cameraPosition );
		}
		vec3 worldNormal = inverseTransformDirection( normal, viewMatrix );
		#ifdef ENVMAP_MODE_REFLECTION
			vec3 reflectVec = reflect( cameraToFrag, worldNormal );
		#else
			vec3 reflectVec = refract( cameraToFrag, worldNormal, refractionRatio );
		#endif
	#else
		vec3 reflectVec = vReflect;
	#endif
	#ifdef ENVMAP_TYPE_CUBE
		vec4 envColor = textureCube( envMap, vec3( flipEnvMap * reflectVec.x, reflectVec.yz ) );
	#else
		vec4 envColor = vec4( 0.0 );
	#endif
	#ifdef ENVMAP_BLENDING_MULTIPLY
		outgoingLight = mix( outgoingLight, outgoingLight * envColor.xyz, specularStrength * reflectivity );
	#elif defined( ENVMAP_BLENDING_MIX )
		outgoingLight = mix( outgoingLight, envColor.xyz, specularStrength * reflectivity );
	#elif defined( ENVMAP_BLENDING_ADD )
		outgoingLight += envColor.xyz * specularStrength * reflectivity;
	#endif
#endif`,wm=`#ifdef USE_ENVMAP
	uniform float envMapIntensity;
	uniform float flipEnvMap;
	#ifdef ENVMAP_TYPE_CUBE
		uniform samplerCube envMap;
	#else
		uniform sampler2D envMap;
	#endif
	
#endif`,Rm=`#ifdef USE_ENVMAP
	uniform float reflectivity;
	#if defined( USE_BUMPMAP ) || defined( USE_NORMALMAP ) || defined( PHONG ) || defined( LAMBERT )
		#define ENV_WORLDPOS
	#endif
	#ifdef ENV_WORLDPOS
		varying vec3 vWorldPosition;
		uniform float refractionRatio;
	#else
		varying vec3 vReflect;
	#endif
#endif`,Cm=`#ifdef USE_ENVMAP
	#if defined( USE_BUMPMAP ) || defined( USE_NORMALMAP ) || defined( PHONG ) || defined( LAMBERT )
		#define ENV_WORLDPOS
	#endif
	#ifdef ENV_WORLDPOS
		
		varying vec3 vWorldPosition;
	#else
		varying vec3 vReflect;
		uniform float refractionRatio;
	#endif
#endif`,Pm=`#ifdef USE_ENVMAP
	#ifdef ENV_WORLDPOS
		vWorldPosition = worldPosition.xyz;
	#else
		vec3 cameraToVertex;
		if ( isOrthographic ) {
			cameraToVertex = normalize( vec3( - viewMatrix[ 0 ][ 2 ], - viewMatrix[ 1 ][ 2 ], - viewMatrix[ 2 ][ 2 ] ) );
		} else {
			cameraToVertex = normalize( worldPosition.xyz - cameraPosition );
		}
		vec3 worldNormal = inverseTransformDirection( transformedNormal, viewMatrix );
		#ifdef ENVMAP_MODE_REFLECTION
			vReflect = reflect( cameraToVertex, worldNormal );
		#else
			vReflect = refract( cameraToVertex, worldNormal, refractionRatio );
		#endif
	#endif
#endif`,Lm=`#ifdef USE_FOG
	vFogDepth = - mvPosition.z;
#endif`,Im=`#ifdef USE_FOG
	varying float vFogDepth;
#endif`,Um=`#ifdef USE_FOG
	#ifdef FOG_EXP2
		float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
	#else
		float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
	#endif
	gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
#endif`,Dm=`#ifdef USE_FOG
	uniform vec3 fogColor;
	varying float vFogDepth;
	#ifdef FOG_EXP2
		uniform float fogDensity;
	#else
		uniform float fogNear;
		uniform float fogFar;
	#endif
#endif`,Nm=`#ifdef USE_GRADIENTMAP
	uniform sampler2D gradientMap;
#endif
vec3 getGradientIrradiance( vec3 normal, vec3 lightDirection ) {
	float dotNL = dot( normal, lightDirection );
	vec2 coord = vec2( dotNL * 0.5 + 0.5, 0.0 );
	#ifdef USE_GRADIENTMAP
		return vec3( texture2D( gradientMap, coord ).r );
	#else
		vec2 fw = fwidth( coord ) * 0.5;
		return mix( vec3( 0.7 ), vec3( 1.0 ), smoothstep( 0.7 - fw.x, 0.7 + fw.x, coord.x ) );
	#endif
}`,Om=`#ifdef USE_LIGHTMAP
	vec4 lightMapTexel = texture2D( lightMap, vLightMapUv );
	vec3 lightMapIrradiance = lightMapTexel.rgb * lightMapIntensity;
	reflectedLight.indirectDiffuse += lightMapIrradiance;
#endif`,Fm=`#ifdef USE_LIGHTMAP
	uniform sampler2D lightMap;
	uniform float lightMapIntensity;
#endif`,Bm=`LambertMaterial material;
material.diffuseColor = diffuseColor.rgb;
material.specularStrength = specularStrength;`,zm=`varying vec3 vViewPosition;
struct LambertMaterial {
	vec3 diffuseColor;
	float specularStrength;
};
void RE_Direct_Lambert( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in LambertMaterial material, inout ReflectedLight reflectedLight ) {
	float dotNL = saturate( dot( geometryNormal, directLight.direction ) );
	vec3 irradiance = dotNL * directLight.color;
	reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
}
void RE_IndirectDiffuse_Lambert( const in vec3 irradiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in LambertMaterial material, inout ReflectedLight reflectedLight ) {
	reflectedLight.indirectDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
}
#define RE_Direct				RE_Direct_Lambert
#define RE_IndirectDiffuse		RE_IndirectDiffuse_Lambert`,Vm=`uniform bool receiveShadow;
uniform vec3 ambientLightColor;
#if defined( USE_LIGHT_PROBES )
	uniform vec3 lightProbe[ 9 ];
#endif
vec3 shGetIrradianceAt( in vec3 normal, in vec3 shCoefficients[ 9 ] ) {
	float x = normal.x, y = normal.y, z = normal.z;
	vec3 result = shCoefficients[ 0 ] * 0.886227;
	result += shCoefficients[ 1 ] * 2.0 * 0.511664 * y;
	result += shCoefficients[ 2 ] * 2.0 * 0.511664 * z;
	result += shCoefficients[ 3 ] * 2.0 * 0.511664 * x;
	result += shCoefficients[ 4 ] * 2.0 * 0.429043 * x * y;
	result += shCoefficients[ 5 ] * 2.0 * 0.429043 * y * z;
	result += shCoefficients[ 6 ] * ( 0.743125 * z * z - 0.247708 );
	result += shCoefficients[ 7 ] * 2.0 * 0.429043 * x * z;
	result += shCoefficients[ 8 ] * 0.429043 * ( x * x - y * y );
	return result;
}
vec3 getLightProbeIrradiance( const in vec3 lightProbe[ 9 ], const in vec3 normal ) {
	vec3 worldNormal = inverseTransformDirection( normal, viewMatrix );
	vec3 irradiance = shGetIrradianceAt( worldNormal, lightProbe );
	return irradiance;
}
vec3 getAmbientLightIrradiance( const in vec3 ambientLightColor ) {
	vec3 irradiance = ambientLightColor;
	return irradiance;
}
float getDistanceAttenuation( const in float lightDistance, const in float cutoffDistance, const in float decayExponent ) {
	#if defined ( LEGACY_LIGHTS )
		if ( cutoffDistance > 0.0 && decayExponent > 0.0 ) {
			return pow( saturate( - lightDistance / cutoffDistance + 1.0 ), decayExponent );
		}
		return 1.0;
	#else
		float distanceFalloff = 1.0 / max( pow( lightDistance, decayExponent ), 0.01 );
		if ( cutoffDistance > 0.0 ) {
			distanceFalloff *= pow2( saturate( 1.0 - pow4( lightDistance / cutoffDistance ) ) );
		}
		return distanceFalloff;
	#endif
}
float getSpotAttenuation( const in float coneCosine, const in float penumbraCosine, const in float angleCosine ) {
	return smoothstep( coneCosine, penumbraCosine, angleCosine );
}
#if NUM_DIR_LIGHTS > 0
	struct DirectionalLight {
		vec3 direction;
		vec3 color;
	};
	uniform DirectionalLight directionalLights[ NUM_DIR_LIGHTS ];
	void getDirectionalLightInfo( const in DirectionalLight directionalLight, out IncidentLight light ) {
		light.color = directionalLight.color;
		light.direction = directionalLight.direction;
		light.visible = true;
	}
#endif
#if NUM_POINT_LIGHTS > 0
	struct PointLight {
		vec3 position;
		vec3 color;
		float distance;
		float decay;
	};
	uniform PointLight pointLights[ NUM_POINT_LIGHTS ];
	void getPointLightInfo( const in PointLight pointLight, const in vec3 geometryPosition, out IncidentLight light ) {
		vec3 lVector = pointLight.position - geometryPosition;
		light.direction = normalize( lVector );
		float lightDistance = length( lVector );
		light.color = pointLight.color;
		light.color *= getDistanceAttenuation( lightDistance, pointLight.distance, pointLight.decay );
		light.visible = ( light.color != vec3( 0.0 ) );
	}
#endif
#if NUM_SPOT_LIGHTS > 0
	struct SpotLight {
		vec3 position;
		vec3 direction;
		vec3 color;
		float distance;
		float decay;
		float coneCos;
		float penumbraCos;
	};
	uniform SpotLight spotLights[ NUM_SPOT_LIGHTS ];
	void getSpotLightInfo( const in SpotLight spotLight, const in vec3 geometryPosition, out IncidentLight light ) {
		vec3 lVector = spotLight.position - geometryPosition;
		light.direction = normalize( lVector );
		float angleCos = dot( light.direction, spotLight.direction );
		float spotAttenuation = getSpotAttenuation( spotLight.coneCos, spotLight.penumbraCos, angleCos );
		if ( spotAttenuation > 0.0 ) {
			float lightDistance = length( lVector );
			light.color = spotLight.color * spotAttenuation;
			light.color *= getDistanceAttenuation( lightDistance, spotLight.distance, spotLight.decay );
			light.visible = ( light.color != vec3( 0.0 ) );
		} else {
			light.color = vec3( 0.0 );
			light.visible = false;
		}
	}
#endif
#if NUM_RECT_AREA_LIGHTS > 0
	struct RectAreaLight {
		vec3 color;
		vec3 position;
		vec3 halfWidth;
		vec3 halfHeight;
	};
	uniform sampler2D ltc_1;	uniform sampler2D ltc_2;
	uniform RectAreaLight rectAreaLights[ NUM_RECT_AREA_LIGHTS ];
#endif
#if NUM_HEMI_LIGHTS > 0
	struct HemisphereLight {
		vec3 direction;
		vec3 skyColor;
		vec3 groundColor;
	};
	uniform HemisphereLight hemisphereLights[ NUM_HEMI_LIGHTS ];
	vec3 getHemisphereLightIrradiance( const in HemisphereLight hemiLight, const in vec3 normal ) {
		float dotNL = dot( normal, hemiLight.direction );
		float hemiDiffuseWeight = 0.5 * dotNL + 0.5;
		vec3 irradiance = mix( hemiLight.groundColor, hemiLight.skyColor, hemiDiffuseWeight );
		return irradiance;
	}
#endif`,km=`#ifdef USE_ENVMAP
	vec3 getIBLIrradiance( const in vec3 normal ) {
		#ifdef ENVMAP_TYPE_CUBE_UV
			vec3 worldNormal = inverseTransformDirection( normal, viewMatrix );
			vec4 envMapColor = textureCubeUV( envMap, worldNormal, 1.0 );
			return PI * envMapColor.rgb * envMapIntensity;
		#else
			return vec3( 0.0 );
		#endif
	}
	vec3 getIBLRadiance( const in vec3 viewDir, const in vec3 normal, const in float roughness ) {
		#ifdef ENVMAP_TYPE_CUBE_UV
			vec3 reflectVec = reflect( - viewDir, normal );
			reflectVec = normalize( mix( reflectVec, normal, roughness * roughness) );
			reflectVec = inverseTransformDirection( reflectVec, viewMatrix );
			vec4 envMapColor = textureCubeUV( envMap, reflectVec, roughness );
			return envMapColor.rgb * envMapIntensity;
		#else
			return vec3( 0.0 );
		#endif
	}
	#ifdef USE_ANISOTROPY
		vec3 getIBLAnisotropyRadiance( const in vec3 viewDir, const in vec3 normal, const in float roughness, const in vec3 bitangent, const in float anisotropy ) {
			#ifdef ENVMAP_TYPE_CUBE_UV
				vec3 bentNormal = cross( bitangent, viewDir );
				bentNormal = normalize( cross( bentNormal, bitangent ) );
				bentNormal = normalize( mix( bentNormal, normal, pow2( pow2( 1.0 - anisotropy * ( 1.0 - roughness ) ) ) ) );
				return getIBLRadiance( viewDir, bentNormal, roughness );
			#else
				return vec3( 0.0 );
			#endif
		}
	#endif
#endif`,Hm=`ToonMaterial material;
material.diffuseColor = diffuseColor.rgb;`,Gm=`varying vec3 vViewPosition;
struct ToonMaterial {
	vec3 diffuseColor;
};
void RE_Direct_Toon( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in ToonMaterial material, inout ReflectedLight reflectedLight ) {
	vec3 irradiance = getGradientIrradiance( geometryNormal, directLight.direction ) * directLight.color;
	reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
}
void RE_IndirectDiffuse_Toon( const in vec3 irradiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in ToonMaterial material, inout ReflectedLight reflectedLight ) {
	reflectedLight.indirectDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
}
#define RE_Direct				RE_Direct_Toon
#define RE_IndirectDiffuse		RE_IndirectDiffuse_Toon`,Wm=`BlinnPhongMaterial material;
material.diffuseColor = diffuseColor.rgb;
material.specularColor = specular;
material.specularShininess = shininess;
material.specularStrength = specularStrength;`,Xm=`varying vec3 vViewPosition;
struct BlinnPhongMaterial {
	vec3 diffuseColor;
	vec3 specularColor;
	float specularShininess;
	float specularStrength;
};
void RE_Direct_BlinnPhong( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in BlinnPhongMaterial material, inout ReflectedLight reflectedLight ) {
	float dotNL = saturate( dot( geometryNormal, directLight.direction ) );
	vec3 irradiance = dotNL * directLight.color;
	reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
	reflectedLight.directSpecular += irradiance * BRDF_BlinnPhong( directLight.direction, geometryViewDir, geometryNormal, material.specularColor, material.specularShininess ) * material.specularStrength;
}
void RE_IndirectDiffuse_BlinnPhong( const in vec3 irradiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in BlinnPhongMaterial material, inout ReflectedLight reflectedLight ) {
	reflectedLight.indirectDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
}
#define RE_Direct				RE_Direct_BlinnPhong
#define RE_IndirectDiffuse		RE_IndirectDiffuse_BlinnPhong`,qm=`PhysicalMaterial material;
material.diffuseColor = diffuseColor.rgb * ( 1.0 - metalnessFactor );
vec3 dxy = max( abs( dFdx( nonPerturbedNormal ) ), abs( dFdy( nonPerturbedNormal ) ) );
float geometryRoughness = max( max( dxy.x, dxy.y ), dxy.z );
material.roughness = max( roughnessFactor, 0.0525 );material.roughness += geometryRoughness;
material.roughness = min( material.roughness, 1.0 );
#ifdef IOR
	material.ior = ior;
	#ifdef USE_SPECULAR
		float specularIntensityFactor = specularIntensity;
		vec3 specularColorFactor = specularColor;
		#ifdef USE_SPECULAR_COLORMAP
			specularColorFactor *= texture2D( specularColorMap, vSpecularColorMapUv ).rgb;
		#endif
		#ifdef USE_SPECULAR_INTENSITYMAP
			specularIntensityFactor *= texture2D( specularIntensityMap, vSpecularIntensityMapUv ).a;
		#endif
		material.specularF90 = mix( specularIntensityFactor, 1.0, metalnessFactor );
	#else
		float specularIntensityFactor = 1.0;
		vec3 specularColorFactor = vec3( 1.0 );
		material.specularF90 = 1.0;
	#endif
	material.specularColor = mix( min( pow2( ( material.ior - 1.0 ) / ( material.ior + 1.0 ) ) * specularColorFactor, vec3( 1.0 ) ) * specularIntensityFactor, diffuseColor.rgb, metalnessFactor );
#else
	material.specularColor = mix( vec3( 0.04 ), diffuseColor.rgb, metalnessFactor );
	material.specularF90 = 1.0;
#endif
#ifdef USE_CLEARCOAT
	material.clearcoat = clearcoat;
	material.clearcoatRoughness = clearcoatRoughness;
	material.clearcoatF0 = vec3( 0.04 );
	material.clearcoatF90 = 1.0;
	#ifdef USE_CLEARCOATMAP
		material.clearcoat *= texture2D( clearcoatMap, vClearcoatMapUv ).x;
	#endif
	#ifdef USE_CLEARCOAT_ROUGHNESSMAP
		material.clearcoatRoughness *= texture2D( clearcoatRoughnessMap, vClearcoatRoughnessMapUv ).y;
	#endif
	material.clearcoat = saturate( material.clearcoat );	material.clearcoatRoughness = max( material.clearcoatRoughness, 0.0525 );
	material.clearcoatRoughness += geometryRoughness;
	material.clearcoatRoughness = min( material.clearcoatRoughness, 1.0 );
#endif
#ifdef USE_IRIDESCENCE
	material.iridescence = iridescence;
	material.iridescenceIOR = iridescenceIOR;
	#ifdef USE_IRIDESCENCEMAP
		material.iridescence *= texture2D( iridescenceMap, vIridescenceMapUv ).r;
	#endif
	#ifdef USE_IRIDESCENCE_THICKNESSMAP
		material.iridescenceThickness = (iridescenceThicknessMaximum - iridescenceThicknessMinimum) * texture2D( iridescenceThicknessMap, vIridescenceThicknessMapUv ).g + iridescenceThicknessMinimum;
	#else
		material.iridescenceThickness = iridescenceThicknessMaximum;
	#endif
#endif
#ifdef USE_SHEEN
	material.sheenColor = sheenColor;
	#ifdef USE_SHEEN_COLORMAP
		material.sheenColor *= texture2D( sheenColorMap, vSheenColorMapUv ).rgb;
	#endif
	material.sheenRoughness = clamp( sheenRoughness, 0.07, 1.0 );
	#ifdef USE_SHEEN_ROUGHNESSMAP
		material.sheenRoughness *= texture2D( sheenRoughnessMap, vSheenRoughnessMapUv ).a;
	#endif
#endif
#ifdef USE_ANISOTROPY
	#ifdef USE_ANISOTROPYMAP
		mat2 anisotropyMat = mat2( anisotropyVector.x, anisotropyVector.y, - anisotropyVector.y, anisotropyVector.x );
		vec3 anisotropyPolar = texture2D( anisotropyMap, vAnisotropyMapUv ).rgb;
		vec2 anisotropyV = anisotropyMat * normalize( 2.0 * anisotropyPolar.rg - vec2( 1.0 ) ) * anisotropyPolar.b;
	#else
		vec2 anisotropyV = anisotropyVector;
	#endif
	material.anisotropy = length( anisotropyV );
	if( material.anisotropy == 0.0 ) {
		anisotropyV = vec2( 1.0, 0.0 );
	} else {
		anisotropyV /= material.anisotropy;
		material.anisotropy = saturate( material.anisotropy );
	}
	material.alphaT = mix( pow2( material.roughness ), 1.0, pow2( material.anisotropy ) );
	material.anisotropyT = tbn[ 0 ] * anisotropyV.x + tbn[ 1 ] * anisotropyV.y;
	material.anisotropyB = tbn[ 1 ] * anisotropyV.x - tbn[ 0 ] * anisotropyV.y;
#endif`,Ym=`struct PhysicalMaterial {
	vec3 diffuseColor;
	float roughness;
	vec3 specularColor;
	float specularF90;
	#ifdef USE_CLEARCOAT
		float clearcoat;
		float clearcoatRoughness;
		vec3 clearcoatF0;
		float clearcoatF90;
	#endif
	#ifdef USE_IRIDESCENCE
		float iridescence;
		float iridescenceIOR;
		float iridescenceThickness;
		vec3 iridescenceFresnel;
		vec3 iridescenceF0;
	#endif
	#ifdef USE_SHEEN
		vec3 sheenColor;
		float sheenRoughness;
	#endif
	#ifdef IOR
		float ior;
	#endif
	#ifdef USE_TRANSMISSION
		float transmission;
		float transmissionAlpha;
		float thickness;
		float attenuationDistance;
		vec3 attenuationColor;
	#endif
	#ifdef USE_ANISOTROPY
		float anisotropy;
		float alphaT;
		vec3 anisotropyT;
		vec3 anisotropyB;
	#endif
};
vec3 clearcoatSpecularDirect = vec3( 0.0 );
vec3 clearcoatSpecularIndirect = vec3( 0.0 );
vec3 sheenSpecularDirect = vec3( 0.0 );
vec3 sheenSpecularIndirect = vec3(0.0 );
vec3 Schlick_to_F0( const in vec3 f, const in float f90, const in float dotVH ) {
    float x = clamp( 1.0 - dotVH, 0.0, 1.0 );
    float x2 = x * x;
    float x5 = clamp( x * x2 * x2, 0.0, 0.9999 );
    return ( f - vec3( f90 ) * x5 ) / ( 1.0 - x5 );
}
float V_GGX_SmithCorrelated( const in float alpha, const in float dotNL, const in float dotNV ) {
	float a2 = pow2( alpha );
	float gv = dotNL * sqrt( a2 + ( 1.0 - a2 ) * pow2( dotNV ) );
	float gl = dotNV * sqrt( a2 + ( 1.0 - a2 ) * pow2( dotNL ) );
	return 0.5 / max( gv + gl, EPSILON );
}
float D_GGX( const in float alpha, const in float dotNH ) {
	float a2 = pow2( alpha );
	float denom = pow2( dotNH ) * ( a2 - 1.0 ) + 1.0;
	return RECIPROCAL_PI * a2 / pow2( denom );
}
#ifdef USE_ANISOTROPY
	float V_GGX_SmithCorrelated_Anisotropic( const in float alphaT, const in float alphaB, const in float dotTV, const in float dotBV, const in float dotTL, const in float dotBL, const in float dotNV, const in float dotNL ) {
		float gv = dotNL * length( vec3( alphaT * dotTV, alphaB * dotBV, dotNV ) );
		float gl = dotNV * length( vec3( alphaT * dotTL, alphaB * dotBL, dotNL ) );
		float v = 0.5 / ( gv + gl );
		return saturate(v);
	}
	float D_GGX_Anisotropic( const in float alphaT, const in float alphaB, const in float dotNH, const in float dotTH, const in float dotBH ) {
		float a2 = alphaT * alphaB;
		highp vec3 v = vec3( alphaB * dotTH, alphaT * dotBH, a2 * dotNH );
		highp float v2 = dot( v, v );
		float w2 = a2 / v2;
		return RECIPROCAL_PI * a2 * pow2 ( w2 );
	}
#endif
#ifdef USE_CLEARCOAT
	vec3 BRDF_GGX_Clearcoat( const in vec3 lightDir, const in vec3 viewDir, const in vec3 normal, const in PhysicalMaterial material) {
		vec3 f0 = material.clearcoatF0;
		float f90 = material.clearcoatF90;
		float roughness = material.clearcoatRoughness;
		float alpha = pow2( roughness );
		vec3 halfDir = normalize( lightDir + viewDir );
		float dotNL = saturate( dot( normal, lightDir ) );
		float dotNV = saturate( dot( normal, viewDir ) );
		float dotNH = saturate( dot( normal, halfDir ) );
		float dotVH = saturate( dot( viewDir, halfDir ) );
		vec3 F = F_Schlick( f0, f90, dotVH );
		float V = V_GGX_SmithCorrelated( alpha, dotNL, dotNV );
		float D = D_GGX( alpha, dotNH );
		return F * ( V * D );
	}
#endif
vec3 BRDF_GGX( const in vec3 lightDir, const in vec3 viewDir, const in vec3 normal, const in PhysicalMaterial material ) {
	vec3 f0 = material.specularColor;
	float f90 = material.specularF90;
	float roughness = material.roughness;
	float alpha = pow2( roughness );
	vec3 halfDir = normalize( lightDir + viewDir );
	float dotNL = saturate( dot( normal, lightDir ) );
	float dotNV = saturate( dot( normal, viewDir ) );
	float dotNH = saturate( dot( normal, halfDir ) );
	float dotVH = saturate( dot( viewDir, halfDir ) );
	vec3 F = F_Schlick( f0, f90, dotVH );
	#ifdef USE_IRIDESCENCE
		F = mix( F, material.iridescenceFresnel, material.iridescence );
	#endif
	#ifdef USE_ANISOTROPY
		float dotTL = dot( material.anisotropyT, lightDir );
		float dotTV = dot( material.anisotropyT, viewDir );
		float dotTH = dot( material.anisotropyT, halfDir );
		float dotBL = dot( material.anisotropyB, lightDir );
		float dotBV = dot( material.anisotropyB, viewDir );
		float dotBH = dot( material.anisotropyB, halfDir );
		float V = V_GGX_SmithCorrelated_Anisotropic( material.alphaT, alpha, dotTV, dotBV, dotTL, dotBL, dotNV, dotNL );
		float D = D_GGX_Anisotropic( material.alphaT, alpha, dotNH, dotTH, dotBH );
	#else
		float V = V_GGX_SmithCorrelated( alpha, dotNL, dotNV );
		float D = D_GGX( alpha, dotNH );
	#endif
	return F * ( V * D );
}
vec2 LTC_Uv( const in vec3 N, const in vec3 V, const in float roughness ) {
	const float LUT_SIZE = 64.0;
	const float LUT_SCALE = ( LUT_SIZE - 1.0 ) / LUT_SIZE;
	const float LUT_BIAS = 0.5 / LUT_SIZE;
	float dotNV = saturate( dot( N, V ) );
	vec2 uv = vec2( roughness, sqrt( 1.0 - dotNV ) );
	uv = uv * LUT_SCALE + LUT_BIAS;
	return uv;
}
float LTC_ClippedSphereFormFactor( const in vec3 f ) {
	float l = length( f );
	return max( ( l * l + f.z ) / ( l + 1.0 ), 0.0 );
}
vec3 LTC_EdgeVectorFormFactor( const in vec3 v1, const in vec3 v2 ) {
	float x = dot( v1, v2 );
	float y = abs( x );
	float a = 0.8543985 + ( 0.4965155 + 0.0145206 * y ) * y;
	float b = 3.4175940 + ( 4.1616724 + y ) * y;
	float v = a / b;
	float theta_sintheta = ( x > 0.0 ) ? v : 0.5 * inversesqrt( max( 1.0 - x * x, 1e-7 ) ) - v;
	return cross( v1, v2 ) * theta_sintheta;
}
vec3 LTC_Evaluate( const in vec3 N, const in vec3 V, const in vec3 P, const in mat3 mInv, const in vec3 rectCoords[ 4 ] ) {
	vec3 v1 = rectCoords[ 1 ] - rectCoords[ 0 ];
	vec3 v2 = rectCoords[ 3 ] - rectCoords[ 0 ];
	vec3 lightNormal = cross( v1, v2 );
	if( dot( lightNormal, P - rectCoords[ 0 ] ) < 0.0 ) return vec3( 0.0 );
	vec3 T1, T2;
	T1 = normalize( V - N * dot( V, N ) );
	T2 = - cross( N, T1 );
	mat3 mat = mInv * transposeMat3( mat3( T1, T2, N ) );
	vec3 coords[ 4 ];
	coords[ 0 ] = mat * ( rectCoords[ 0 ] - P );
	coords[ 1 ] = mat * ( rectCoords[ 1 ] - P );
	coords[ 2 ] = mat * ( rectCoords[ 2 ] - P );
	coords[ 3 ] = mat * ( rectCoords[ 3 ] - P );
	coords[ 0 ] = normalize( coords[ 0 ] );
	coords[ 1 ] = normalize( coords[ 1 ] );
	coords[ 2 ] = normalize( coords[ 2 ] );
	coords[ 3 ] = normalize( coords[ 3 ] );
	vec3 vectorFormFactor = vec3( 0.0 );
	vectorFormFactor += LTC_EdgeVectorFormFactor( coords[ 0 ], coords[ 1 ] );
	vectorFormFactor += LTC_EdgeVectorFormFactor( coords[ 1 ], coords[ 2 ] );
	vectorFormFactor += LTC_EdgeVectorFormFactor( coords[ 2 ], coords[ 3 ] );
	vectorFormFactor += LTC_EdgeVectorFormFactor( coords[ 3 ], coords[ 0 ] );
	float result = LTC_ClippedSphereFormFactor( vectorFormFactor );
	return vec3( result );
}
#if defined( USE_SHEEN )
float D_Charlie( float roughness, float dotNH ) {
	float alpha = pow2( roughness );
	float invAlpha = 1.0 / alpha;
	float cos2h = dotNH * dotNH;
	float sin2h = max( 1.0 - cos2h, 0.0078125 );
	return ( 2.0 + invAlpha ) * pow( sin2h, invAlpha * 0.5 ) / ( 2.0 * PI );
}
float V_Neubelt( float dotNV, float dotNL ) {
	return saturate( 1.0 / ( 4.0 * ( dotNL + dotNV - dotNL * dotNV ) ) );
}
vec3 BRDF_Sheen( const in vec3 lightDir, const in vec3 viewDir, const in vec3 normal, vec3 sheenColor, const in float sheenRoughness ) {
	vec3 halfDir = normalize( lightDir + viewDir );
	float dotNL = saturate( dot( normal, lightDir ) );
	float dotNV = saturate( dot( normal, viewDir ) );
	float dotNH = saturate( dot( normal, halfDir ) );
	float D = D_Charlie( sheenRoughness, dotNH );
	float V = V_Neubelt( dotNV, dotNL );
	return sheenColor * ( D * V );
}
#endif
float IBLSheenBRDF( const in vec3 normal, const in vec3 viewDir, const in float roughness ) {
	float dotNV = saturate( dot( normal, viewDir ) );
	float r2 = roughness * roughness;
	float a = roughness < 0.25 ? -339.2 * r2 + 161.4 * roughness - 25.9 : -8.48 * r2 + 14.3 * roughness - 9.95;
	float b = roughness < 0.25 ? 44.0 * r2 - 23.7 * roughness + 3.26 : 1.97 * r2 - 3.27 * roughness + 0.72;
	float DG = exp( a * dotNV + b ) + ( roughness < 0.25 ? 0.0 : 0.1 * ( roughness - 0.25 ) );
	return saturate( DG * RECIPROCAL_PI );
}
vec2 DFGApprox( const in vec3 normal, const in vec3 viewDir, const in float roughness ) {
	float dotNV = saturate( dot( normal, viewDir ) );
	const vec4 c0 = vec4( - 1, - 0.0275, - 0.572, 0.022 );
	const vec4 c1 = vec4( 1, 0.0425, 1.04, - 0.04 );
	vec4 r = roughness * c0 + c1;
	float a004 = min( r.x * r.x, exp2( - 9.28 * dotNV ) ) * r.x + r.y;
	vec2 fab = vec2( - 1.04, 1.04 ) * a004 + r.zw;
	return fab;
}
vec3 EnvironmentBRDF( const in vec3 normal, const in vec3 viewDir, const in vec3 specularColor, const in float specularF90, const in float roughness ) {
	vec2 fab = DFGApprox( normal, viewDir, roughness );
	return specularColor * fab.x + specularF90 * fab.y;
}
#ifdef USE_IRIDESCENCE
void computeMultiscatteringIridescence( const in vec3 normal, const in vec3 viewDir, const in vec3 specularColor, const in float specularF90, const in float iridescence, const in vec3 iridescenceF0, const in float roughness, inout vec3 singleScatter, inout vec3 multiScatter ) {
#else
void computeMultiscattering( const in vec3 normal, const in vec3 viewDir, const in vec3 specularColor, const in float specularF90, const in float roughness, inout vec3 singleScatter, inout vec3 multiScatter ) {
#endif
	vec2 fab = DFGApprox( normal, viewDir, roughness );
	#ifdef USE_IRIDESCENCE
		vec3 Fr = mix( specularColor, iridescenceF0, iridescence );
	#else
		vec3 Fr = specularColor;
	#endif
	vec3 FssEss = Fr * fab.x + specularF90 * fab.y;
	float Ess = fab.x + fab.y;
	float Ems = 1.0 - Ess;
	vec3 Favg = Fr + ( 1.0 - Fr ) * 0.047619;	vec3 Fms = FssEss * Favg / ( 1.0 - Ems * Favg );
	singleScatter += FssEss;
	multiScatter += Fms * Ems;
}
#if NUM_RECT_AREA_LIGHTS > 0
	void RE_Direct_RectArea_Physical( const in RectAreaLight rectAreaLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
		vec3 normal = geometryNormal;
		vec3 viewDir = geometryViewDir;
		vec3 position = geometryPosition;
		vec3 lightPos = rectAreaLight.position;
		vec3 halfWidth = rectAreaLight.halfWidth;
		vec3 halfHeight = rectAreaLight.halfHeight;
		vec3 lightColor = rectAreaLight.color;
		float roughness = material.roughness;
		vec3 rectCoords[ 4 ];
		rectCoords[ 0 ] = lightPos + halfWidth - halfHeight;		rectCoords[ 1 ] = lightPos - halfWidth - halfHeight;
		rectCoords[ 2 ] = lightPos - halfWidth + halfHeight;
		rectCoords[ 3 ] = lightPos + halfWidth + halfHeight;
		vec2 uv = LTC_Uv( normal, viewDir, roughness );
		vec4 t1 = texture2D( ltc_1, uv );
		vec4 t2 = texture2D( ltc_2, uv );
		mat3 mInv = mat3(
			vec3( t1.x, 0, t1.y ),
			vec3(    0, 1,    0 ),
			vec3( t1.z, 0, t1.w )
		);
		vec3 fresnel = ( material.specularColor * t2.x + ( vec3( 1.0 ) - material.specularColor ) * t2.y );
		reflectedLight.directSpecular += lightColor * fresnel * LTC_Evaluate( normal, viewDir, position, mInv, rectCoords );
		reflectedLight.directDiffuse += lightColor * material.diffuseColor * LTC_Evaluate( normal, viewDir, position, mat3( 1.0 ), rectCoords );
	}
#endif
void RE_Direct_Physical( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
	float dotNL = saturate( dot( geometryNormal, directLight.direction ) );
	vec3 irradiance = dotNL * directLight.color;
	#ifdef USE_CLEARCOAT
		float dotNLcc = saturate( dot( geometryClearcoatNormal, directLight.direction ) );
		vec3 ccIrradiance = dotNLcc * directLight.color;
		clearcoatSpecularDirect += ccIrradiance * BRDF_GGX_Clearcoat( directLight.direction, geometryViewDir, geometryClearcoatNormal, material );
	#endif
	#ifdef USE_SHEEN
		sheenSpecularDirect += irradiance * BRDF_Sheen( directLight.direction, geometryViewDir, geometryNormal, material.sheenColor, material.sheenRoughness );
	#endif
	reflectedLight.directSpecular += irradiance * BRDF_GGX( directLight.direction, geometryViewDir, geometryNormal, material );
	reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
}
void RE_IndirectDiffuse_Physical( const in vec3 irradiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
	reflectedLight.indirectDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
}
void RE_IndirectSpecular_Physical( const in vec3 radiance, const in vec3 irradiance, const in vec3 clearcoatRadiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight) {
	#ifdef USE_CLEARCOAT
		clearcoatSpecularIndirect += clearcoatRadiance * EnvironmentBRDF( geometryClearcoatNormal, geometryViewDir, material.clearcoatF0, material.clearcoatF90, material.clearcoatRoughness );
	#endif
	#ifdef USE_SHEEN
		sheenSpecularIndirect += irradiance * material.sheenColor * IBLSheenBRDF( geometryNormal, geometryViewDir, material.sheenRoughness );
	#endif
	vec3 singleScattering = vec3( 0.0 );
	vec3 multiScattering = vec3( 0.0 );
	vec3 cosineWeightedIrradiance = irradiance * RECIPROCAL_PI;
	#ifdef USE_IRIDESCENCE
		computeMultiscatteringIridescence( geometryNormal, geometryViewDir, material.specularColor, material.specularF90, material.iridescence, material.iridescenceFresnel, material.roughness, singleScattering, multiScattering );
	#else
		computeMultiscattering( geometryNormal, geometryViewDir, material.specularColor, material.specularF90, material.roughness, singleScattering, multiScattering );
	#endif
	vec3 totalScattering = singleScattering + multiScattering;
	vec3 diffuse = material.diffuseColor * ( 1.0 - max( max( totalScattering.r, totalScattering.g ), totalScattering.b ) );
	reflectedLight.indirectSpecular += radiance * singleScattering;
	reflectedLight.indirectSpecular += multiScattering * cosineWeightedIrradiance;
	reflectedLight.indirectDiffuse += diffuse * cosineWeightedIrradiance;
}
#define RE_Direct				RE_Direct_Physical
#define RE_Direct_RectArea		RE_Direct_RectArea_Physical
#define RE_IndirectDiffuse		RE_IndirectDiffuse_Physical
#define RE_IndirectSpecular		RE_IndirectSpecular_Physical
float computeSpecularOcclusion( const in float dotNV, const in float ambientOcclusion, const in float roughness ) {
	return saturate( pow( dotNV + ambientOcclusion, exp2( - 16.0 * roughness - 1.0 ) ) - 1.0 + ambientOcclusion );
}`,Zm=`
vec3 geometryPosition = - vViewPosition;
vec3 geometryNormal = normal;
vec3 geometryViewDir = ( isOrthographic ) ? vec3( 0, 0, 1 ) : normalize( vViewPosition );
vec3 geometryClearcoatNormal = vec3( 0.0 );
#ifdef USE_CLEARCOAT
	geometryClearcoatNormal = clearcoatNormal;
#endif
#ifdef USE_IRIDESCENCE
	float dotNVi = saturate( dot( normal, geometryViewDir ) );
	if ( material.iridescenceThickness == 0.0 ) {
		material.iridescence = 0.0;
	} else {
		material.iridescence = saturate( material.iridescence );
	}
	if ( material.iridescence > 0.0 ) {
		material.iridescenceFresnel = evalIridescence( 1.0, material.iridescenceIOR, dotNVi, material.iridescenceThickness, material.specularColor );
		material.iridescenceF0 = Schlick_to_F0( material.iridescenceFresnel, 1.0, dotNVi );
	}
#endif
IncidentLight directLight;
#if ( NUM_POINT_LIGHTS > 0 ) && defined( RE_Direct )
	PointLight pointLight;
	#if defined( USE_SHADOWMAP ) && NUM_POINT_LIGHT_SHADOWS > 0
	PointLightShadow pointLightShadow;
	#endif
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_POINT_LIGHTS; i ++ ) {
		pointLight = pointLights[ i ];
		getPointLightInfo( pointLight, geometryPosition, directLight );
		#if defined( USE_SHADOWMAP ) && ( UNROLLED_LOOP_INDEX < NUM_POINT_LIGHT_SHADOWS )
		pointLightShadow = pointLightShadows[ i ];
		directLight.color *= ( directLight.visible && receiveShadow ) ? getPointShadow( pointShadowMap[ i ], pointLightShadow.shadowMapSize, pointLightShadow.shadowBias, pointLightShadow.shadowRadius, vPointShadowCoord[ i ], pointLightShadow.shadowCameraNear, pointLightShadow.shadowCameraFar ) : 1.0;
		#endif
		RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
	}
	#pragma unroll_loop_end
#endif
#if ( NUM_SPOT_LIGHTS > 0 ) && defined( RE_Direct )
	SpotLight spotLight;
	vec4 spotColor;
	vec3 spotLightCoord;
	bool inSpotLightMap;
	#if defined( USE_SHADOWMAP ) && NUM_SPOT_LIGHT_SHADOWS > 0
	SpotLightShadow spotLightShadow;
	#endif
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_SPOT_LIGHTS; i ++ ) {
		spotLight = spotLights[ i ];
		getSpotLightInfo( spotLight, geometryPosition, directLight );
		#if ( UNROLLED_LOOP_INDEX < NUM_SPOT_LIGHT_SHADOWS_WITH_MAPS )
		#define SPOT_LIGHT_MAP_INDEX UNROLLED_LOOP_INDEX
		#elif ( UNROLLED_LOOP_INDEX < NUM_SPOT_LIGHT_SHADOWS )
		#define SPOT_LIGHT_MAP_INDEX NUM_SPOT_LIGHT_MAPS
		#else
		#define SPOT_LIGHT_MAP_INDEX ( UNROLLED_LOOP_INDEX - NUM_SPOT_LIGHT_SHADOWS + NUM_SPOT_LIGHT_SHADOWS_WITH_MAPS )
		#endif
		#if ( SPOT_LIGHT_MAP_INDEX < NUM_SPOT_LIGHT_MAPS )
			spotLightCoord = vSpotLightCoord[ i ].xyz / vSpotLightCoord[ i ].w;
			inSpotLightMap = all( lessThan( abs( spotLightCoord * 2. - 1. ), vec3( 1.0 ) ) );
			spotColor = texture2D( spotLightMap[ SPOT_LIGHT_MAP_INDEX ], spotLightCoord.xy );
			directLight.color = inSpotLightMap ? directLight.color * spotColor.rgb : directLight.color;
		#endif
		#undef SPOT_LIGHT_MAP_INDEX
		#if defined( USE_SHADOWMAP ) && ( UNROLLED_LOOP_INDEX < NUM_SPOT_LIGHT_SHADOWS )
		spotLightShadow = spotLightShadows[ i ];
		directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( spotShadowMap[ i ], spotLightShadow.shadowMapSize, spotLightShadow.shadowBias, spotLightShadow.shadowRadius, vSpotLightCoord[ i ] ) : 1.0;
		#endif
		RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
	}
	#pragma unroll_loop_end
#endif
#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )
	DirectionalLight directionalLight;
	#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
	DirectionalLightShadow directionalLightShadow;
	#endif
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {
		directionalLight = directionalLights[ i ];
		getDirectionalLightInfo( directionalLight, directLight );
		#if defined( USE_SHADOWMAP ) && ( UNROLLED_LOOP_INDEX < NUM_DIR_LIGHT_SHADOWS )
		directionalLightShadow = directionalLightShadows[ i ];
		directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;
		#endif
		RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
	}
	#pragma unroll_loop_end
#endif
#if ( NUM_RECT_AREA_LIGHTS > 0 ) && defined( RE_Direct_RectArea )
	RectAreaLight rectAreaLight;
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_RECT_AREA_LIGHTS; i ++ ) {
		rectAreaLight = rectAreaLights[ i ];
		RE_Direct_RectArea( rectAreaLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
	}
	#pragma unroll_loop_end
#endif
#if defined( RE_IndirectDiffuse )
	vec3 iblIrradiance = vec3( 0.0 );
	vec3 irradiance = getAmbientLightIrradiance( ambientLightColor );
	#if defined( USE_LIGHT_PROBES )
		irradiance += getLightProbeIrradiance( lightProbe, geometryNormal );
	#endif
	#if ( NUM_HEMI_LIGHTS > 0 )
		#pragma unroll_loop_start
		for ( int i = 0; i < NUM_HEMI_LIGHTS; i ++ ) {
			irradiance += getHemisphereLightIrradiance( hemisphereLights[ i ], geometryNormal );
		}
		#pragma unroll_loop_end
	#endif
#endif
#if defined( RE_IndirectSpecular )
	vec3 radiance = vec3( 0.0 );
	vec3 clearcoatRadiance = vec3( 0.0 );
#endif`,Jm=`#if defined( RE_IndirectDiffuse )
	#ifdef USE_LIGHTMAP
		vec4 lightMapTexel = texture2D( lightMap, vLightMapUv );
		vec3 lightMapIrradiance = lightMapTexel.rgb * lightMapIntensity;
		irradiance += lightMapIrradiance;
	#endif
	#if defined( USE_ENVMAP ) && defined( STANDARD ) && defined( ENVMAP_TYPE_CUBE_UV )
		iblIrradiance += getIBLIrradiance( geometryNormal );
	#endif
#endif
#if defined( USE_ENVMAP ) && defined( RE_IndirectSpecular )
	#ifdef USE_ANISOTROPY
		radiance += getIBLAnisotropyRadiance( geometryViewDir, geometryNormal, material.roughness, material.anisotropyB, material.anisotropy );
	#else
		radiance += getIBLRadiance( geometryViewDir, geometryNormal, material.roughness );
	#endif
	#ifdef USE_CLEARCOAT
		clearcoatRadiance += getIBLRadiance( geometryViewDir, geometryClearcoatNormal, material.clearcoatRoughness );
	#endif
#endif`,$m=`#if defined( RE_IndirectDiffuse )
	RE_IndirectDiffuse( irradiance, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
#endif
#if defined( RE_IndirectSpecular )
	RE_IndirectSpecular( radiance, iblIrradiance, clearcoatRadiance, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
#endif`,Km=`#if defined( USE_LOGDEPTHBUF ) && defined( USE_LOGDEPTHBUF_EXT )
	gl_FragDepthEXT = vIsPerspective == 0.0 ? gl_FragCoord.z : log2( vFragDepth ) * logDepthBufFC * 0.5;
#endif`,Qm=`#if defined( USE_LOGDEPTHBUF ) && defined( USE_LOGDEPTHBUF_EXT )
	uniform float logDepthBufFC;
	varying float vFragDepth;
	varying float vIsPerspective;
#endif`,jm=`#ifdef USE_LOGDEPTHBUF
	#ifdef USE_LOGDEPTHBUF_EXT
		varying float vFragDepth;
		varying float vIsPerspective;
	#else
		uniform float logDepthBufFC;
	#endif
#endif`,tg=`#ifdef USE_LOGDEPTHBUF
	#ifdef USE_LOGDEPTHBUF_EXT
		vFragDepth = 1.0 + gl_Position.w;
		vIsPerspective = float( isPerspectiveMatrix( projectionMatrix ) );
	#else
		if ( isPerspectiveMatrix( projectionMatrix ) ) {
			gl_Position.z = log2( max( EPSILON, gl_Position.w + 1.0 ) ) * logDepthBufFC - 1.0;
			gl_Position.z *= gl_Position.w;
		}
	#endif
#endif`,eg=`#ifdef USE_MAP
	vec4 sampledDiffuseColor = texture2D( map, vMapUv );
	#ifdef DECODE_VIDEO_TEXTURE
		sampledDiffuseColor = vec4( mix( pow( sampledDiffuseColor.rgb * 0.9478672986 + vec3( 0.0521327014 ), vec3( 2.4 ) ), sampledDiffuseColor.rgb * 0.0773993808, vec3( lessThanEqual( sampledDiffuseColor.rgb, vec3( 0.04045 ) ) ) ), sampledDiffuseColor.w );
	
	#endif
	diffuseColor *= sampledDiffuseColor;
#endif`,ng=`#ifdef USE_MAP
	uniform sampler2D map;
#endif`,ig=`#if defined( USE_MAP ) || defined( USE_ALPHAMAP )
	#if defined( USE_POINTS_UV )
		vec2 uv = vUv;
	#else
		vec2 uv = ( uvTransform * vec3( gl_PointCoord.x, 1.0 - gl_PointCoord.y, 1 ) ).xy;
	#endif
#endif
#ifdef USE_MAP
	diffuseColor *= texture2D( map, uv );
#endif
#ifdef USE_ALPHAMAP
	diffuseColor.a *= texture2D( alphaMap, uv ).g;
#endif`,sg=`#if defined( USE_POINTS_UV )
	varying vec2 vUv;
#else
	#if defined( USE_MAP ) || defined( USE_ALPHAMAP )
		uniform mat3 uvTransform;
	#endif
#endif
#ifdef USE_MAP
	uniform sampler2D map;
#endif
#ifdef USE_ALPHAMAP
	uniform sampler2D alphaMap;
#endif`,rg=`float metalnessFactor = metalness;
#ifdef USE_METALNESSMAP
	vec4 texelMetalness = texture2D( metalnessMap, vMetalnessMapUv );
	metalnessFactor *= texelMetalness.b;
#endif`,ag=`#ifdef USE_METALNESSMAP
	uniform sampler2D metalnessMap;
#endif`,og=`#if defined( USE_MORPHCOLORS ) && defined( MORPHTARGETS_TEXTURE )
	vColor *= morphTargetBaseInfluence;
	for ( int i = 0; i < MORPHTARGETS_COUNT; i ++ ) {
		#if defined( USE_COLOR_ALPHA )
			if ( morphTargetInfluences[ i ] != 0.0 ) vColor += getMorph( gl_VertexID, i, 2 ) * morphTargetInfluences[ i ];
		#elif defined( USE_COLOR )
			if ( morphTargetInfluences[ i ] != 0.0 ) vColor += getMorph( gl_VertexID, i, 2 ).rgb * morphTargetInfluences[ i ];
		#endif
	}
#endif`,cg=`#ifdef USE_MORPHNORMALS
	objectNormal *= morphTargetBaseInfluence;
	#ifdef MORPHTARGETS_TEXTURE
		for ( int i = 0; i < MORPHTARGETS_COUNT; i ++ ) {
			if ( morphTargetInfluences[ i ] != 0.0 ) objectNormal += getMorph( gl_VertexID, i, 1 ).xyz * morphTargetInfluences[ i ];
		}
	#else
		objectNormal += morphNormal0 * morphTargetInfluences[ 0 ];
		objectNormal += morphNormal1 * morphTargetInfluences[ 1 ];
		objectNormal += morphNormal2 * morphTargetInfluences[ 2 ];
		objectNormal += morphNormal3 * morphTargetInfluences[ 3 ];
	#endif
#endif`,lg=`#ifdef USE_MORPHTARGETS
	uniform float morphTargetBaseInfluence;
	#ifdef MORPHTARGETS_TEXTURE
		uniform float morphTargetInfluences[ MORPHTARGETS_COUNT ];
		uniform sampler2DArray morphTargetsTexture;
		uniform ivec2 morphTargetsTextureSize;
		vec4 getMorph( const in int vertexIndex, const in int morphTargetIndex, const in int offset ) {
			int texelIndex = vertexIndex * MORPHTARGETS_TEXTURE_STRIDE + offset;
			int y = texelIndex / morphTargetsTextureSize.x;
			int x = texelIndex - y * morphTargetsTextureSize.x;
			ivec3 morphUV = ivec3( x, y, morphTargetIndex );
			return texelFetch( morphTargetsTexture, morphUV, 0 );
		}
	#else
		#ifndef USE_MORPHNORMALS
			uniform float morphTargetInfluences[ 8 ];
		#else
			uniform float morphTargetInfluences[ 4 ];
		#endif
	#endif
#endif`,hg=`#ifdef USE_MORPHTARGETS
	transformed *= morphTargetBaseInfluence;
	#ifdef MORPHTARGETS_TEXTURE
		for ( int i = 0; i < MORPHTARGETS_COUNT; i ++ ) {
			if ( morphTargetInfluences[ i ] != 0.0 ) transformed += getMorph( gl_VertexID, i, 0 ).xyz * morphTargetInfluences[ i ];
		}
	#else
		transformed += morphTarget0 * morphTargetInfluences[ 0 ];
		transformed += morphTarget1 * morphTargetInfluences[ 1 ];
		transformed += morphTarget2 * morphTargetInfluences[ 2 ];
		transformed += morphTarget3 * morphTargetInfluences[ 3 ];
		#ifndef USE_MORPHNORMALS
			transformed += morphTarget4 * morphTargetInfluences[ 4 ];
			transformed += morphTarget5 * morphTargetInfluences[ 5 ];
			transformed += morphTarget6 * morphTargetInfluences[ 6 ];
			transformed += morphTarget7 * morphTargetInfluences[ 7 ];
		#endif
	#endif
#endif`,ug=`float faceDirection = gl_FrontFacing ? 1.0 : - 1.0;
#ifdef FLAT_SHADED
	vec3 fdx = dFdx( vViewPosition );
	vec3 fdy = dFdy( vViewPosition );
	vec3 normal = normalize( cross( fdx, fdy ) );
#else
	vec3 normal = normalize( vNormal );
	#ifdef DOUBLE_SIDED
		normal *= faceDirection;
	#endif
#endif
#if defined( USE_NORMALMAP_TANGENTSPACE ) || defined( USE_CLEARCOAT_NORMALMAP ) || defined( USE_ANISOTROPY )
	#ifdef USE_TANGENT
		mat3 tbn = mat3( normalize( vTangent ), normalize( vBitangent ), normal );
	#else
		mat3 tbn = getTangentFrame( - vViewPosition, normal,
		#if defined( USE_NORMALMAP )
			vNormalMapUv
		#elif defined( USE_CLEARCOAT_NORMALMAP )
			vClearcoatNormalMapUv
		#else
			vUv
		#endif
		);
	#endif
	#if defined( DOUBLE_SIDED ) && ! defined( FLAT_SHADED )
		tbn[0] *= faceDirection;
		tbn[1] *= faceDirection;
	#endif
#endif
#ifdef USE_CLEARCOAT_NORMALMAP
	#ifdef USE_TANGENT
		mat3 tbn2 = mat3( normalize( vTangent ), normalize( vBitangent ), normal );
	#else
		mat3 tbn2 = getTangentFrame( - vViewPosition, normal, vClearcoatNormalMapUv );
	#endif
	#if defined( DOUBLE_SIDED ) && ! defined( FLAT_SHADED )
		tbn2[0] *= faceDirection;
		tbn2[1] *= faceDirection;
	#endif
#endif
vec3 nonPerturbedNormal = normal;`,dg=`#ifdef USE_NORMALMAP_OBJECTSPACE
	normal = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
	#ifdef FLIP_SIDED
		normal = - normal;
	#endif
	#ifdef DOUBLE_SIDED
		normal = normal * faceDirection;
	#endif
	normal = normalize( normalMatrix * normal );
#elif defined( USE_NORMALMAP_TANGENTSPACE )
	vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
	mapN.xy *= normalScale;
	normal = normalize( tbn * mapN );
#elif defined( USE_BUMPMAP )
	normal = perturbNormalArb( - vViewPosition, normal, dHdxy_fwd(), faceDirection );
#endif`,fg=`#ifndef FLAT_SHADED
	varying vec3 vNormal;
	#ifdef USE_TANGENT
		varying vec3 vTangent;
		varying vec3 vBitangent;
	#endif
#endif`,pg=`#ifndef FLAT_SHADED
	varying vec3 vNormal;
	#ifdef USE_TANGENT
		varying vec3 vTangent;
		varying vec3 vBitangent;
	#endif
#endif`,mg=`#ifndef FLAT_SHADED
	vNormal = normalize( transformedNormal );
	#ifdef USE_TANGENT
		vTangent = normalize( transformedTangent );
		vBitangent = normalize( cross( vNormal, vTangent ) * tangent.w );
	#endif
#endif`,gg=`#ifdef USE_NORMALMAP
	uniform sampler2D normalMap;
	uniform vec2 normalScale;
#endif
#ifdef USE_NORMALMAP_OBJECTSPACE
	uniform mat3 normalMatrix;
#endif
#if ! defined ( USE_TANGENT ) && ( defined ( USE_NORMALMAP_TANGENTSPACE ) || defined ( USE_CLEARCOAT_NORMALMAP ) || defined( USE_ANISOTROPY ) )
	mat3 getTangentFrame( vec3 eye_pos, vec3 surf_norm, vec2 uv ) {
		vec3 q0 = dFdx( eye_pos.xyz );
		vec3 q1 = dFdy( eye_pos.xyz );
		vec2 st0 = dFdx( uv.st );
		vec2 st1 = dFdy( uv.st );
		vec3 N = surf_norm;
		vec3 q1perp = cross( q1, N );
		vec3 q0perp = cross( N, q0 );
		vec3 T = q1perp * st0.x + q0perp * st1.x;
		vec3 B = q1perp * st0.y + q0perp * st1.y;
		float det = max( dot( T, T ), dot( B, B ) );
		float scale = ( det == 0.0 ) ? 0.0 : inversesqrt( det );
		return mat3( T * scale, B * scale, N );
	}
#endif`,_g=`#ifdef USE_CLEARCOAT
	vec3 clearcoatNormal = nonPerturbedNormal;
#endif`,xg=`#ifdef USE_CLEARCOAT_NORMALMAP
	vec3 clearcoatMapN = texture2D( clearcoatNormalMap, vClearcoatNormalMapUv ).xyz * 2.0 - 1.0;
	clearcoatMapN.xy *= clearcoatNormalScale;
	clearcoatNormal = normalize( tbn2 * clearcoatMapN );
#endif`,vg=`#ifdef USE_CLEARCOATMAP
	uniform sampler2D clearcoatMap;
#endif
#ifdef USE_CLEARCOAT_NORMALMAP
	uniform sampler2D clearcoatNormalMap;
	uniform vec2 clearcoatNormalScale;
#endif
#ifdef USE_CLEARCOAT_ROUGHNESSMAP
	uniform sampler2D clearcoatRoughnessMap;
#endif`,yg=`#ifdef USE_IRIDESCENCEMAP
	uniform sampler2D iridescenceMap;
#endif
#ifdef USE_IRIDESCENCE_THICKNESSMAP
	uniform sampler2D iridescenceThicknessMap;
#endif`,Mg=`#ifdef OPAQUE
diffuseColor.a = 1.0;
#endif
#ifdef USE_TRANSMISSION
diffuseColor.a *= material.transmissionAlpha;
#endif
gl_FragColor = vec4( outgoingLight, diffuseColor.a );`,Sg=`vec3 packNormalToRGB( const in vec3 normal ) {
	return normalize( normal ) * 0.5 + 0.5;
}
vec3 unpackRGBToNormal( const in vec3 rgb ) {
	return 2.0 * rgb.xyz - 1.0;
}
const float PackUpscale = 256. / 255.;const float UnpackDownscale = 255. / 256.;
const vec3 PackFactors = vec3( 256. * 256. * 256., 256. * 256., 256. );
const vec4 UnpackFactors = UnpackDownscale / vec4( PackFactors, 1. );
const float ShiftRight8 = 1. / 256.;
vec4 packDepthToRGBA( const in float v ) {
	vec4 r = vec4( fract( v * PackFactors ), v );
	r.yzw -= r.xyz * ShiftRight8;	return r * PackUpscale;
}
float unpackRGBAToDepth( const in vec4 v ) {
	return dot( v, UnpackFactors );
}
vec2 packDepthToRG( in highp float v ) {
	return packDepthToRGBA( v ).yx;
}
float unpackRGToDepth( const in highp vec2 v ) {
	return unpackRGBAToDepth( vec4( v.xy, 0.0, 0.0 ) );
}
vec4 pack2HalfToRGBA( vec2 v ) {
	vec4 r = vec4( v.x, fract( v.x * 255.0 ), v.y, fract( v.y * 255.0 ) );
	return vec4( r.x - r.y / 255.0, r.y, r.z - r.w / 255.0, r.w );
}
vec2 unpackRGBATo2Half( vec4 v ) {
	return vec2( v.x + ( v.y / 255.0 ), v.z + ( v.w / 255.0 ) );
}
float viewZToOrthographicDepth( const in float viewZ, const in float near, const in float far ) {
	return ( viewZ + near ) / ( near - far );
}
float orthographicDepthToViewZ( const in float depth, const in float near, const in float far ) {
	return depth * ( near - far ) - near;
}
float viewZToPerspectiveDepth( const in float viewZ, const in float near, const in float far ) {
	return ( ( near + viewZ ) * far ) / ( ( far - near ) * viewZ );
}
float perspectiveDepthToViewZ( const in float depth, const in float near, const in float far ) {
	return ( near * far ) / ( ( far - near ) * depth - far );
}`,bg=`#ifdef PREMULTIPLIED_ALPHA
	gl_FragColor.rgb *= gl_FragColor.a;
#endif`,Eg=`vec4 mvPosition = vec4( transformed, 1.0 );
#ifdef USE_BATCHING
	mvPosition = batchingMatrix * mvPosition;
#endif
#ifdef USE_INSTANCING
	mvPosition = instanceMatrix * mvPosition;
#endif
mvPosition = modelViewMatrix * mvPosition;
gl_Position = projectionMatrix * mvPosition;`,Ag=`#ifdef DITHERING
	gl_FragColor.rgb = dithering( gl_FragColor.rgb );
#endif`,Tg=`#ifdef DITHERING
	vec3 dithering( vec3 color ) {
		float grid_position = rand( gl_FragCoord.xy );
		vec3 dither_shift_RGB = vec3( 0.25 / 255.0, -0.25 / 255.0, 0.25 / 255.0 );
		dither_shift_RGB = mix( 2.0 * dither_shift_RGB, -2.0 * dither_shift_RGB, grid_position );
		return color + dither_shift_RGB;
	}
#endif`,wg=`float roughnessFactor = roughness;
#ifdef USE_ROUGHNESSMAP
	vec4 texelRoughness = texture2D( roughnessMap, vRoughnessMapUv );
	roughnessFactor *= texelRoughness.g;
#endif`,Rg=`#ifdef USE_ROUGHNESSMAP
	uniform sampler2D roughnessMap;
#endif`,Cg=`#if NUM_SPOT_LIGHT_COORDS > 0
	varying vec4 vSpotLightCoord[ NUM_SPOT_LIGHT_COORDS ];
#endif
#if NUM_SPOT_LIGHT_MAPS > 0
	uniform sampler2D spotLightMap[ NUM_SPOT_LIGHT_MAPS ];
#endif
#ifdef USE_SHADOWMAP
	#if NUM_DIR_LIGHT_SHADOWS > 0
		uniform sampler2D directionalShadowMap[ NUM_DIR_LIGHT_SHADOWS ];
		varying vec4 vDirectionalShadowCoord[ NUM_DIR_LIGHT_SHADOWS ];
		struct DirectionalLightShadow {
			float shadowBias;
			float shadowNormalBias;
			float shadowRadius;
			vec2 shadowMapSize;
		};
		uniform DirectionalLightShadow directionalLightShadows[ NUM_DIR_LIGHT_SHADOWS ];
	#endif
	#if NUM_SPOT_LIGHT_SHADOWS > 0
		uniform sampler2D spotShadowMap[ NUM_SPOT_LIGHT_SHADOWS ];
		struct SpotLightShadow {
			float shadowBias;
			float shadowNormalBias;
			float shadowRadius;
			vec2 shadowMapSize;
		};
		uniform SpotLightShadow spotLightShadows[ NUM_SPOT_LIGHT_SHADOWS ];
	#endif
	#if NUM_POINT_LIGHT_SHADOWS > 0
		uniform sampler2D pointShadowMap[ NUM_POINT_LIGHT_SHADOWS ];
		varying vec4 vPointShadowCoord[ NUM_POINT_LIGHT_SHADOWS ];
		struct PointLightShadow {
			float shadowBias;
			float shadowNormalBias;
			float shadowRadius;
			vec2 shadowMapSize;
			float shadowCameraNear;
			float shadowCameraFar;
		};
		uniform PointLightShadow pointLightShadows[ NUM_POINT_LIGHT_SHADOWS ];
	#endif
	float texture2DCompare( sampler2D depths, vec2 uv, float compare ) {
		return step( compare, unpackRGBAToDepth( texture2D( depths, uv ) ) );
	}
	vec2 texture2DDistribution( sampler2D shadow, vec2 uv ) {
		return unpackRGBATo2Half( texture2D( shadow, uv ) );
	}
	float VSMShadow (sampler2D shadow, vec2 uv, float compare ){
		float occlusion = 1.0;
		vec2 distribution = texture2DDistribution( shadow, uv );
		float hard_shadow = step( compare , distribution.x );
		if (hard_shadow != 1.0 ) {
			float distance = compare - distribution.x ;
			float variance = max( 0.00000, distribution.y * distribution.y );
			float softness_probability = variance / (variance + distance * distance );			softness_probability = clamp( ( softness_probability - 0.3 ) / ( 0.95 - 0.3 ), 0.0, 1.0 );			occlusion = clamp( max( hard_shadow, softness_probability ), 0.0, 1.0 );
		}
		return occlusion;
	}
	float getShadow( sampler2D shadowMap, vec2 shadowMapSize, float shadowBias, float shadowRadius, vec4 shadowCoord ) {
		float shadow = 1.0;
		shadowCoord.xyz /= shadowCoord.w;
		shadowCoord.z += shadowBias;
		bool inFrustum = shadowCoord.x >= 0.0 && shadowCoord.x <= 1.0 && shadowCoord.y >= 0.0 && shadowCoord.y <= 1.0;
		bool frustumTest = inFrustum && shadowCoord.z <= 1.0;
		if ( frustumTest ) {
		#if defined( SHADOWMAP_TYPE_PCF )
			vec2 texelSize = vec2( 1.0 ) / shadowMapSize;
			float dx0 = - texelSize.x * shadowRadius;
			float dy0 = - texelSize.y * shadowRadius;
			float dx1 = + texelSize.x * shadowRadius;
			float dy1 = + texelSize.y * shadowRadius;
			float dx2 = dx0 / 2.0;
			float dy2 = dy0 / 2.0;
			float dx3 = dx1 / 2.0;
			float dy3 = dy1 / 2.0;
			shadow = (
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( dx0, dy0 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( 0.0, dy0 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( dx1, dy0 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( dx2, dy2 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( 0.0, dy2 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( dx3, dy2 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( dx0, 0.0 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( dx2, 0.0 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy, shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( dx3, 0.0 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( dx1, 0.0 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( dx2, dy3 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( 0.0, dy3 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( dx3, dy3 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( dx0, dy1 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( 0.0, dy1 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( dx1, dy1 ), shadowCoord.z )
			) * ( 1.0 / 17.0 );
		#elif defined( SHADOWMAP_TYPE_PCF_SOFT )
			vec2 texelSize = vec2( 1.0 ) / shadowMapSize;
			float dx = texelSize.x;
			float dy = texelSize.y;
			vec2 uv = shadowCoord.xy;
			vec2 f = fract( uv * shadowMapSize + 0.5 );
			uv -= f * texelSize;
			shadow = (
				texture2DCompare( shadowMap, uv, shadowCoord.z ) +
				texture2DCompare( shadowMap, uv + vec2( dx, 0.0 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, uv + vec2( 0.0, dy ), shadowCoord.z ) +
				texture2DCompare( shadowMap, uv + texelSize, shadowCoord.z ) +
				mix( texture2DCompare( shadowMap, uv + vec2( -dx, 0.0 ), shadowCoord.z ),
					 texture2DCompare( shadowMap, uv + vec2( 2.0 * dx, 0.0 ), shadowCoord.z ),
					 f.x ) +
				mix( texture2DCompare( shadowMap, uv + vec2( -dx, dy ), shadowCoord.z ),
					 texture2DCompare( shadowMap, uv + vec2( 2.0 * dx, dy ), shadowCoord.z ),
					 f.x ) +
				mix( texture2DCompare( shadowMap, uv + vec2( 0.0, -dy ), shadowCoord.z ),
					 texture2DCompare( shadowMap, uv + vec2( 0.0, 2.0 * dy ), shadowCoord.z ),
					 f.y ) +
				mix( texture2DCompare( shadowMap, uv + vec2( dx, -dy ), shadowCoord.z ),
					 texture2DCompare( shadowMap, uv + vec2( dx, 2.0 * dy ), shadowCoord.z ),
					 f.y ) +
				mix( mix( texture2DCompare( shadowMap, uv + vec2( -dx, -dy ), shadowCoord.z ),
						  texture2DCompare( shadowMap, uv + vec2( 2.0 * dx, -dy ), shadowCoord.z ),
						  f.x ),
					 mix( texture2DCompare( shadowMap, uv + vec2( -dx, 2.0 * dy ), shadowCoord.z ),
						  texture2DCompare( shadowMap, uv + vec2( 2.0 * dx, 2.0 * dy ), shadowCoord.z ),
						  f.x ),
					 f.y )
			) * ( 1.0 / 9.0 );
		#elif defined( SHADOWMAP_TYPE_VSM )
			shadow = VSMShadow( shadowMap, shadowCoord.xy, shadowCoord.z );
		#else
			shadow = texture2DCompare( shadowMap, shadowCoord.xy, shadowCoord.z );
		#endif
		}
		return shadow;
	}
	vec2 cubeToUV( vec3 v, float texelSizeY ) {
		vec3 absV = abs( v );
		float scaleToCube = 1.0 / max( absV.x, max( absV.y, absV.z ) );
		absV *= scaleToCube;
		v *= scaleToCube * ( 1.0 - 2.0 * texelSizeY );
		vec2 planar = v.xy;
		float almostATexel = 1.5 * texelSizeY;
		float almostOne = 1.0 - almostATexel;
		if ( absV.z >= almostOne ) {
			if ( v.z > 0.0 )
				planar.x = 4.0 - v.x;
		} else if ( absV.x >= almostOne ) {
			float signX = sign( v.x );
			planar.x = v.z * signX + 2.0 * signX;
		} else if ( absV.y >= almostOne ) {
			float signY = sign( v.y );
			planar.x = v.x + 2.0 * signY + 2.0;
			planar.y = v.z * signY - 2.0;
		}
		return vec2( 0.125, 0.25 ) * planar + vec2( 0.375, 0.75 );
	}
	float getPointShadow( sampler2D shadowMap, vec2 shadowMapSize, float shadowBias, float shadowRadius, vec4 shadowCoord, float shadowCameraNear, float shadowCameraFar ) {
		vec2 texelSize = vec2( 1.0 ) / ( shadowMapSize * vec2( 4.0, 2.0 ) );
		vec3 lightToPosition = shadowCoord.xyz;
		float dp = ( length( lightToPosition ) - shadowCameraNear ) / ( shadowCameraFar - shadowCameraNear );		dp += shadowBias;
		vec3 bd3D = normalize( lightToPosition );
		#if defined( SHADOWMAP_TYPE_PCF ) || defined( SHADOWMAP_TYPE_PCF_SOFT ) || defined( SHADOWMAP_TYPE_VSM )
			vec2 offset = vec2( - 1, 1 ) * shadowRadius * texelSize.y;
			return (
				texture2DCompare( shadowMap, cubeToUV( bd3D + offset.xyy, texelSize.y ), dp ) +
				texture2DCompare( shadowMap, cubeToUV( bd3D + offset.yyy, texelSize.y ), dp ) +
				texture2DCompare( shadowMap, cubeToUV( bd3D + offset.xyx, texelSize.y ), dp ) +
				texture2DCompare( shadowMap, cubeToUV( bd3D + offset.yyx, texelSize.y ), dp ) +
				texture2DCompare( shadowMap, cubeToUV( bd3D, texelSize.y ), dp ) +
				texture2DCompare( shadowMap, cubeToUV( bd3D + offset.xxy, texelSize.y ), dp ) +
				texture2DCompare( shadowMap, cubeToUV( bd3D + offset.yxy, texelSize.y ), dp ) +
				texture2DCompare( shadowMap, cubeToUV( bd3D + offset.xxx, texelSize.y ), dp ) +
				texture2DCompare( shadowMap, cubeToUV( bd3D + offset.yxx, texelSize.y ), dp )
			) * ( 1.0 / 9.0 );
		#else
			return texture2DCompare( shadowMap, cubeToUV( bd3D, texelSize.y ), dp );
		#endif
	}
#endif`,Pg=`#if NUM_SPOT_LIGHT_COORDS > 0
	uniform mat4 spotLightMatrix[ NUM_SPOT_LIGHT_COORDS ];
	varying vec4 vSpotLightCoord[ NUM_SPOT_LIGHT_COORDS ];
#endif
#ifdef USE_SHADOWMAP
	#if NUM_DIR_LIGHT_SHADOWS > 0
		uniform mat4 directionalShadowMatrix[ NUM_DIR_LIGHT_SHADOWS ];
		varying vec4 vDirectionalShadowCoord[ NUM_DIR_LIGHT_SHADOWS ];
		struct DirectionalLightShadow {
			float shadowBias;
			float shadowNormalBias;
			float shadowRadius;
			vec2 shadowMapSize;
		};
		uniform DirectionalLightShadow directionalLightShadows[ NUM_DIR_LIGHT_SHADOWS ];
	#endif
	#if NUM_SPOT_LIGHT_SHADOWS > 0
		struct SpotLightShadow {
			float shadowBias;
			float shadowNormalBias;
			float shadowRadius;
			vec2 shadowMapSize;
		};
		uniform SpotLightShadow spotLightShadows[ NUM_SPOT_LIGHT_SHADOWS ];
	#endif
	#if NUM_POINT_LIGHT_SHADOWS > 0
		uniform mat4 pointShadowMatrix[ NUM_POINT_LIGHT_SHADOWS ];
		varying vec4 vPointShadowCoord[ NUM_POINT_LIGHT_SHADOWS ];
		struct PointLightShadow {
			float shadowBias;
			float shadowNormalBias;
			float shadowRadius;
			vec2 shadowMapSize;
			float shadowCameraNear;
			float shadowCameraFar;
		};
		uniform PointLightShadow pointLightShadows[ NUM_POINT_LIGHT_SHADOWS ];
	#endif
#endif`,Lg=`#if ( defined( USE_SHADOWMAP ) && ( NUM_DIR_LIGHT_SHADOWS > 0 || NUM_POINT_LIGHT_SHADOWS > 0 ) ) || ( NUM_SPOT_LIGHT_COORDS > 0 )
	vec3 shadowWorldNormal = inverseTransformDirection( transformedNormal, viewMatrix );
	vec4 shadowWorldPosition;
#endif
#if defined( USE_SHADOWMAP )
	#if NUM_DIR_LIGHT_SHADOWS > 0
		#pragma unroll_loop_start
		for ( int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i ++ ) {
			shadowWorldPosition = worldPosition + vec4( shadowWorldNormal * directionalLightShadows[ i ].shadowNormalBias, 0 );
			vDirectionalShadowCoord[ i ] = directionalShadowMatrix[ i ] * shadowWorldPosition;
		}
		#pragma unroll_loop_end
	#endif
	#if NUM_POINT_LIGHT_SHADOWS > 0
		#pragma unroll_loop_start
		for ( int i = 0; i < NUM_POINT_LIGHT_SHADOWS; i ++ ) {
			shadowWorldPosition = worldPosition + vec4( shadowWorldNormal * pointLightShadows[ i ].shadowNormalBias, 0 );
			vPointShadowCoord[ i ] = pointShadowMatrix[ i ] * shadowWorldPosition;
		}
		#pragma unroll_loop_end
	#endif
#endif
#if NUM_SPOT_LIGHT_COORDS > 0
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_SPOT_LIGHT_COORDS; i ++ ) {
		shadowWorldPosition = worldPosition;
		#if ( defined( USE_SHADOWMAP ) && UNROLLED_LOOP_INDEX < NUM_SPOT_LIGHT_SHADOWS )
			shadowWorldPosition.xyz += shadowWorldNormal * spotLightShadows[ i ].shadowNormalBias;
		#endif
		vSpotLightCoord[ i ] = spotLightMatrix[ i ] * shadowWorldPosition;
	}
	#pragma unroll_loop_end
#endif`,Ig=`float getShadowMask() {
	float shadow = 1.0;
	#ifdef USE_SHADOWMAP
	#if NUM_DIR_LIGHT_SHADOWS > 0
	DirectionalLightShadow directionalLight;
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i ++ ) {
		directionalLight = directionalLightShadows[ i ];
		shadow *= receiveShadow ? getShadow( directionalShadowMap[ i ], directionalLight.shadowMapSize, directionalLight.shadowBias, directionalLight.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;
	}
	#pragma unroll_loop_end
	#endif
	#if NUM_SPOT_LIGHT_SHADOWS > 0
	SpotLightShadow spotLight;
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_SPOT_LIGHT_SHADOWS; i ++ ) {
		spotLight = spotLightShadows[ i ];
		shadow *= receiveShadow ? getShadow( spotShadowMap[ i ], spotLight.shadowMapSize, spotLight.shadowBias, spotLight.shadowRadius, vSpotLightCoord[ i ] ) : 1.0;
	}
	#pragma unroll_loop_end
	#endif
	#if NUM_POINT_LIGHT_SHADOWS > 0
	PointLightShadow pointLight;
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_POINT_LIGHT_SHADOWS; i ++ ) {
		pointLight = pointLightShadows[ i ];
		shadow *= receiveShadow ? getPointShadow( pointShadowMap[ i ], pointLight.shadowMapSize, pointLight.shadowBias, pointLight.shadowRadius, vPointShadowCoord[ i ], pointLight.shadowCameraNear, pointLight.shadowCameraFar ) : 1.0;
	}
	#pragma unroll_loop_end
	#endif
	#endif
	return shadow;
}`,Ug=`#ifdef USE_SKINNING
	mat4 boneMatX = getBoneMatrix( skinIndex.x );
	mat4 boneMatY = getBoneMatrix( skinIndex.y );
	mat4 boneMatZ = getBoneMatrix( skinIndex.z );
	mat4 boneMatW = getBoneMatrix( skinIndex.w );
#endif`,Dg=`#ifdef USE_SKINNING
	uniform mat4 bindMatrix;
	uniform mat4 bindMatrixInverse;
	uniform highp sampler2D boneTexture;
	mat4 getBoneMatrix( const in float i ) {
		int size = textureSize( boneTexture, 0 ).x;
		int j = int( i ) * 4;
		int x = j % size;
		int y = j / size;
		vec4 v1 = texelFetch( boneTexture, ivec2( x, y ), 0 );
		vec4 v2 = texelFetch( boneTexture, ivec2( x + 1, y ), 0 );
		vec4 v3 = texelFetch( boneTexture, ivec2( x + 2, y ), 0 );
		vec4 v4 = texelFetch( boneTexture, ivec2( x + 3, y ), 0 );
		return mat4( v1, v2, v3, v4 );
	}
#endif`,Ng=`#ifdef USE_SKINNING
	vec4 skinVertex = bindMatrix * vec4( transformed, 1.0 );
	vec4 skinned = vec4( 0.0 );
	skinned += boneMatX * skinVertex * skinWeight.x;
	skinned += boneMatY * skinVertex * skinWeight.y;
	skinned += boneMatZ * skinVertex * skinWeight.z;
	skinned += boneMatW * skinVertex * skinWeight.w;
	transformed = ( bindMatrixInverse * skinned ).xyz;
#endif`,Og=`#ifdef USE_SKINNING
	mat4 skinMatrix = mat4( 0.0 );
	skinMatrix += skinWeight.x * boneMatX;
	skinMatrix += skinWeight.y * boneMatY;
	skinMatrix += skinWeight.z * boneMatZ;
	skinMatrix += skinWeight.w * boneMatW;
	skinMatrix = bindMatrixInverse * skinMatrix * bindMatrix;
	objectNormal = vec4( skinMatrix * vec4( objectNormal, 0.0 ) ).xyz;
	#ifdef USE_TANGENT
		objectTangent = vec4( skinMatrix * vec4( objectTangent, 0.0 ) ).xyz;
	#endif
#endif`,Fg=`float specularStrength;
#ifdef USE_SPECULARMAP
	vec4 texelSpecular = texture2D( specularMap, vSpecularMapUv );
	specularStrength = texelSpecular.r;
#else
	specularStrength = 1.0;
#endif`,Bg=`#ifdef USE_SPECULARMAP
	uniform sampler2D specularMap;
#endif`,zg=`#if defined( TONE_MAPPING )
	gl_FragColor.rgb = toneMapping( gl_FragColor.rgb );
#endif`,Vg=`#ifndef saturate
#define saturate( a ) clamp( a, 0.0, 1.0 )
#endif
uniform float toneMappingExposure;
vec3 LinearToneMapping( vec3 color ) {
	return saturate( toneMappingExposure * color );
}
vec3 ReinhardToneMapping( vec3 color ) {
	color *= toneMappingExposure;
	return saturate( color / ( vec3( 1.0 ) + color ) );
}
vec3 OptimizedCineonToneMapping( vec3 color ) {
	color *= toneMappingExposure;
	color = max( vec3( 0.0 ), color - 0.004 );
	return pow( ( color * ( 6.2 * color + 0.5 ) ) / ( color * ( 6.2 * color + 1.7 ) + 0.06 ), vec3( 2.2 ) );
}
vec3 RRTAndODTFit( vec3 v ) {
	vec3 a = v * ( v + 0.0245786 ) - 0.000090537;
	vec3 b = v * ( 0.983729 * v + 0.4329510 ) + 0.238081;
	return a / b;
}
vec3 ACESFilmicToneMapping( vec3 color ) {
	const mat3 ACESInputMat = mat3(
		vec3( 0.59719, 0.07600, 0.02840 ),		vec3( 0.35458, 0.90834, 0.13383 ),
		vec3( 0.04823, 0.01566, 0.83777 )
	);
	const mat3 ACESOutputMat = mat3(
		vec3(  1.60475, -0.10208, -0.00327 ),		vec3( -0.53108,  1.10813, -0.07276 ),
		vec3( -0.07367, -0.00605,  1.07602 )
	);
	color *= toneMappingExposure / 0.6;
	color = ACESInputMat * color;
	color = RRTAndODTFit( color );
	color = ACESOutputMat * color;
	return saturate( color );
}
const mat3 LINEAR_REC2020_TO_LINEAR_SRGB = mat3(
	vec3( 1.6605, - 0.1246, - 0.0182 ),
	vec3( - 0.5876, 1.1329, - 0.1006 ),
	vec3( - 0.0728, - 0.0083, 1.1187 )
);
const mat3 LINEAR_SRGB_TO_LINEAR_REC2020 = mat3(
	vec3( 0.6274, 0.0691, 0.0164 ),
	vec3( 0.3293, 0.9195, 0.0880 ),
	vec3( 0.0433, 0.0113, 0.8956 )
);
vec3 agxDefaultContrastApprox( vec3 x ) {
	vec3 x2 = x * x;
	vec3 x4 = x2 * x2;
	return + 15.5 * x4 * x2
		- 40.14 * x4 * x
		+ 31.96 * x4
		- 6.868 * x2 * x
		+ 0.4298 * x2
		+ 0.1191 * x
		- 0.00232;
}
vec3 AgXToneMapping( vec3 color ) {
	const mat3 AgXInsetMatrix = mat3(
		vec3( 0.856627153315983, 0.137318972929847, 0.11189821299995 ),
		vec3( 0.0951212405381588, 0.761241990602591, 0.0767994186031903 ),
		vec3( 0.0482516061458583, 0.101439036467562, 0.811302368396859 )
	);
	const mat3 AgXOutsetMatrix = mat3(
		vec3( 1.1271005818144368, - 0.1413297634984383, - 0.14132976349843826 ),
		vec3( - 0.11060664309660323, 1.157823702216272, - 0.11060664309660294 ),
		vec3( - 0.016493938717834573, - 0.016493938717834257, 1.2519364065950405 )
	);
	const float AgxMinEv = - 12.47393;	const float AgxMaxEv = 4.026069;
	color = LINEAR_SRGB_TO_LINEAR_REC2020 * color;
	color *= toneMappingExposure;
	color = AgXInsetMatrix * color;
	color = max( color, 1e-10 );	color = log2( color );
	color = ( color - AgxMinEv ) / ( AgxMaxEv - AgxMinEv );
	color = clamp( color, 0.0, 1.0 );
	color = agxDefaultContrastApprox( color );
	color = AgXOutsetMatrix * color;
	color = pow( max( vec3( 0.0 ), color ), vec3( 2.2 ) );
	color = LINEAR_REC2020_TO_LINEAR_SRGB * color;
	return color;
}
vec3 CustomToneMapping( vec3 color ) { return color; }`,kg=`#ifdef USE_TRANSMISSION
	material.transmission = transmission;
	material.transmissionAlpha = 1.0;
	material.thickness = thickness;
	material.attenuationDistance = attenuationDistance;
	material.attenuationColor = attenuationColor;
	#ifdef USE_TRANSMISSIONMAP
		material.transmission *= texture2D( transmissionMap, vTransmissionMapUv ).r;
	#endif
	#ifdef USE_THICKNESSMAP
		material.thickness *= texture2D( thicknessMap, vThicknessMapUv ).g;
	#endif
	vec3 pos = vWorldPosition;
	vec3 v = normalize( cameraPosition - pos );
	vec3 n = inverseTransformDirection( normal, viewMatrix );
	vec4 transmitted = getIBLVolumeRefraction(
		n, v, material.roughness, material.diffuseColor, material.specularColor, material.specularF90,
		pos, modelMatrix, viewMatrix, projectionMatrix, material.ior, material.thickness,
		material.attenuationColor, material.attenuationDistance );
	material.transmissionAlpha = mix( material.transmissionAlpha, transmitted.a, material.transmission );
	totalDiffuse = mix( totalDiffuse, transmitted.rgb, material.transmission );
#endif`,Hg=`#ifdef USE_TRANSMISSION
	uniform float transmission;
	uniform float thickness;
	uniform float attenuationDistance;
	uniform vec3 attenuationColor;
	#ifdef USE_TRANSMISSIONMAP
		uniform sampler2D transmissionMap;
	#endif
	#ifdef USE_THICKNESSMAP
		uniform sampler2D thicknessMap;
	#endif
	uniform vec2 transmissionSamplerSize;
	uniform sampler2D transmissionSamplerMap;
	uniform mat4 modelMatrix;
	uniform mat4 projectionMatrix;
	varying vec3 vWorldPosition;
	float w0( float a ) {
		return ( 1.0 / 6.0 ) * ( a * ( a * ( - a + 3.0 ) - 3.0 ) + 1.0 );
	}
	float w1( float a ) {
		return ( 1.0 / 6.0 ) * ( a *  a * ( 3.0 * a - 6.0 ) + 4.0 );
	}
	float w2( float a ){
		return ( 1.0 / 6.0 ) * ( a * ( a * ( - 3.0 * a + 3.0 ) + 3.0 ) + 1.0 );
	}
	float w3( float a ) {
		return ( 1.0 / 6.0 ) * ( a * a * a );
	}
	float g0( float a ) {
		return w0( a ) + w1( a );
	}
	float g1( float a ) {
		return w2( a ) + w3( a );
	}
	float h0( float a ) {
		return - 1.0 + w1( a ) / ( w0( a ) + w1( a ) );
	}
	float h1( float a ) {
		return 1.0 + w3( a ) / ( w2( a ) + w3( a ) );
	}
	vec4 bicubic( sampler2D tex, vec2 uv, vec4 texelSize, float lod ) {
		uv = uv * texelSize.zw + 0.5;
		vec2 iuv = floor( uv );
		vec2 fuv = fract( uv );
		float g0x = g0( fuv.x );
		float g1x = g1( fuv.x );
		float h0x = h0( fuv.x );
		float h1x = h1( fuv.x );
		float h0y = h0( fuv.y );
		float h1y = h1( fuv.y );
		vec2 p0 = ( vec2( iuv.x + h0x, iuv.y + h0y ) - 0.5 ) * texelSize.xy;
		vec2 p1 = ( vec2( iuv.x + h1x, iuv.y + h0y ) - 0.5 ) * texelSize.xy;
		vec2 p2 = ( vec2( iuv.x + h0x, iuv.y + h1y ) - 0.5 ) * texelSize.xy;
		vec2 p3 = ( vec2( iuv.x + h1x, iuv.y + h1y ) - 0.5 ) * texelSize.xy;
		return g0( fuv.y ) * ( g0x * textureLod( tex, p0, lod ) + g1x * textureLod( tex, p1, lod ) ) +
			g1( fuv.y ) * ( g0x * textureLod( tex, p2, lod ) + g1x * textureLod( tex, p3, lod ) );
	}
	vec4 textureBicubic( sampler2D sampler, vec2 uv, float lod ) {
		vec2 fLodSize = vec2( textureSize( sampler, int( lod ) ) );
		vec2 cLodSize = vec2( textureSize( sampler, int( lod + 1.0 ) ) );
		vec2 fLodSizeInv = 1.0 / fLodSize;
		vec2 cLodSizeInv = 1.0 / cLodSize;
		vec4 fSample = bicubic( sampler, uv, vec4( fLodSizeInv, fLodSize ), floor( lod ) );
		vec4 cSample = bicubic( sampler, uv, vec4( cLodSizeInv, cLodSize ), ceil( lod ) );
		return mix( fSample, cSample, fract( lod ) );
	}
	vec3 getVolumeTransmissionRay( const in vec3 n, const in vec3 v, const in float thickness, const in float ior, const in mat4 modelMatrix ) {
		vec3 refractionVector = refract( - v, normalize( n ), 1.0 / ior );
		vec3 modelScale;
		modelScale.x = length( vec3( modelMatrix[ 0 ].xyz ) );
		modelScale.y = length( vec3( modelMatrix[ 1 ].xyz ) );
		modelScale.z = length( vec3( modelMatrix[ 2 ].xyz ) );
		return normalize( refractionVector ) * thickness * modelScale;
	}
	float applyIorToRoughness( const in float roughness, const in float ior ) {
		return roughness * clamp( ior * 2.0 - 2.0, 0.0, 1.0 );
	}
	vec4 getTransmissionSample( const in vec2 fragCoord, const in float roughness, const in float ior ) {
		float lod = log2( transmissionSamplerSize.x ) * applyIorToRoughness( roughness, ior );
		return textureBicubic( transmissionSamplerMap, fragCoord.xy, lod );
	}
	vec3 volumeAttenuation( const in float transmissionDistance, const in vec3 attenuationColor, const in float attenuationDistance ) {
		if ( isinf( attenuationDistance ) ) {
			return vec3( 1.0 );
		} else {
			vec3 attenuationCoefficient = -log( attenuationColor ) / attenuationDistance;
			vec3 transmittance = exp( - attenuationCoefficient * transmissionDistance );			return transmittance;
		}
	}
	vec4 getIBLVolumeRefraction( const in vec3 n, const in vec3 v, const in float roughness, const in vec3 diffuseColor,
		const in vec3 specularColor, const in float specularF90, const in vec3 position, const in mat4 modelMatrix,
		const in mat4 viewMatrix, const in mat4 projMatrix, const in float ior, const in float thickness,
		const in vec3 attenuationColor, const in float attenuationDistance ) {
		vec3 transmissionRay = getVolumeTransmissionRay( n, v, thickness, ior, modelMatrix );
		vec3 refractedRayExit = position + transmissionRay;
		vec4 ndcPos = projMatrix * viewMatrix * vec4( refractedRayExit, 1.0 );
		vec2 refractionCoords = ndcPos.xy / ndcPos.w;
		refractionCoords += 1.0;
		refractionCoords /= 2.0;
		vec4 transmittedLight = getTransmissionSample( refractionCoords, roughness, ior );
		vec3 transmittance = diffuseColor * volumeAttenuation( length( transmissionRay ), attenuationColor, attenuationDistance );
		vec3 attenuatedColor = transmittance * transmittedLight.rgb;
		vec3 F = EnvironmentBRDF( n, v, specularColor, specularF90, roughness );
		float transmittanceFactor = ( transmittance.r + transmittance.g + transmittance.b ) / 3.0;
		return vec4( ( 1.0 - F ) * attenuatedColor, 1.0 - ( 1.0 - transmittedLight.a ) * transmittanceFactor );
	}
#endif`,Gg=`#if defined( USE_UV ) || defined( USE_ANISOTROPY )
	varying vec2 vUv;
#endif
#ifdef USE_MAP
	varying vec2 vMapUv;
#endif
#ifdef USE_ALPHAMAP
	varying vec2 vAlphaMapUv;
#endif
#ifdef USE_LIGHTMAP
	varying vec2 vLightMapUv;
#endif
#ifdef USE_AOMAP
	varying vec2 vAoMapUv;
#endif
#ifdef USE_BUMPMAP
	varying vec2 vBumpMapUv;
#endif
#ifdef USE_NORMALMAP
	varying vec2 vNormalMapUv;
#endif
#ifdef USE_EMISSIVEMAP
	varying vec2 vEmissiveMapUv;
#endif
#ifdef USE_METALNESSMAP
	varying vec2 vMetalnessMapUv;
#endif
#ifdef USE_ROUGHNESSMAP
	varying vec2 vRoughnessMapUv;
#endif
#ifdef USE_ANISOTROPYMAP
	varying vec2 vAnisotropyMapUv;
#endif
#ifdef USE_CLEARCOATMAP
	varying vec2 vClearcoatMapUv;
#endif
#ifdef USE_CLEARCOAT_NORMALMAP
	varying vec2 vClearcoatNormalMapUv;
#endif
#ifdef USE_CLEARCOAT_ROUGHNESSMAP
	varying vec2 vClearcoatRoughnessMapUv;
#endif
#ifdef USE_IRIDESCENCEMAP
	varying vec2 vIridescenceMapUv;
#endif
#ifdef USE_IRIDESCENCE_THICKNESSMAP
	varying vec2 vIridescenceThicknessMapUv;
#endif
#ifdef USE_SHEEN_COLORMAP
	varying vec2 vSheenColorMapUv;
#endif
#ifdef USE_SHEEN_ROUGHNESSMAP
	varying vec2 vSheenRoughnessMapUv;
#endif
#ifdef USE_SPECULARMAP
	varying vec2 vSpecularMapUv;
#endif
#ifdef USE_SPECULAR_COLORMAP
	varying vec2 vSpecularColorMapUv;
#endif
#ifdef USE_SPECULAR_INTENSITYMAP
	varying vec2 vSpecularIntensityMapUv;
#endif
#ifdef USE_TRANSMISSIONMAP
	uniform mat3 transmissionMapTransform;
	varying vec2 vTransmissionMapUv;
#endif
#ifdef USE_THICKNESSMAP
	uniform mat3 thicknessMapTransform;
	varying vec2 vThicknessMapUv;
#endif`,Wg=`#if defined( USE_UV ) || defined( USE_ANISOTROPY )
	varying vec2 vUv;
#endif
#ifdef USE_MAP
	uniform mat3 mapTransform;
	varying vec2 vMapUv;
#endif
#ifdef USE_ALPHAMAP
	uniform mat3 alphaMapTransform;
	varying vec2 vAlphaMapUv;
#endif
#ifdef USE_LIGHTMAP
	uniform mat3 lightMapTransform;
	varying vec2 vLightMapUv;
#endif
#ifdef USE_AOMAP
	uniform mat3 aoMapTransform;
	varying vec2 vAoMapUv;
#endif
#ifdef USE_BUMPMAP
	uniform mat3 bumpMapTransform;
	varying vec2 vBumpMapUv;
#endif
#ifdef USE_NORMALMAP
	uniform mat3 normalMapTransform;
	varying vec2 vNormalMapUv;
#endif
#ifdef USE_DISPLACEMENTMAP
	uniform mat3 displacementMapTransform;
	varying vec2 vDisplacementMapUv;
#endif
#ifdef USE_EMISSIVEMAP
	uniform mat3 emissiveMapTransform;
	varying vec2 vEmissiveMapUv;
#endif
#ifdef USE_METALNESSMAP
	uniform mat3 metalnessMapTransform;
	varying vec2 vMetalnessMapUv;
#endif
#ifdef USE_ROUGHNESSMAP
	uniform mat3 roughnessMapTransform;
	varying vec2 vRoughnessMapUv;
#endif
#ifdef USE_ANISOTROPYMAP
	uniform mat3 anisotropyMapTransform;
	varying vec2 vAnisotropyMapUv;
#endif
#ifdef USE_CLEARCOATMAP
	uniform mat3 clearcoatMapTransform;
	varying vec2 vClearcoatMapUv;
#endif
#ifdef USE_CLEARCOAT_NORMALMAP
	uniform mat3 clearcoatNormalMapTransform;
	varying vec2 vClearcoatNormalMapUv;
#endif
#ifdef USE_CLEARCOAT_ROUGHNESSMAP
	uniform mat3 clearcoatRoughnessMapTransform;
	varying vec2 vClearcoatRoughnessMapUv;
#endif
#ifdef USE_SHEEN_COLORMAP
	uniform mat3 sheenColorMapTransform;
	varying vec2 vSheenColorMapUv;
#endif
#ifdef USE_SHEEN_ROUGHNESSMAP
	uniform mat3 sheenRoughnessMapTransform;
	varying vec2 vSheenRoughnessMapUv;
#endif
#ifdef USE_IRIDESCENCEMAP
	uniform mat3 iridescenceMapTransform;
	varying vec2 vIridescenceMapUv;
#endif
#ifdef USE_IRIDESCENCE_THICKNESSMAP
	uniform mat3 iridescenceThicknessMapTransform;
	varying vec2 vIridescenceThicknessMapUv;
#endif
#ifdef USE_SPECULARMAP
	uniform mat3 specularMapTransform;
	varying vec2 vSpecularMapUv;
#endif
#ifdef USE_SPECULAR_COLORMAP
	uniform mat3 specularColorMapTransform;
	varying vec2 vSpecularColorMapUv;
#endif
#ifdef USE_SPECULAR_INTENSITYMAP
	uniform mat3 specularIntensityMapTransform;
	varying vec2 vSpecularIntensityMapUv;
#endif
#ifdef USE_TRANSMISSIONMAP
	uniform mat3 transmissionMapTransform;
	varying vec2 vTransmissionMapUv;
#endif
#ifdef USE_THICKNESSMAP
	uniform mat3 thicknessMapTransform;
	varying vec2 vThicknessMapUv;
#endif`,Xg=`#if defined( USE_UV ) || defined( USE_ANISOTROPY )
	vUv = vec3( uv, 1 ).xy;
#endif
#ifdef USE_MAP
	vMapUv = ( mapTransform * vec3( MAP_UV, 1 ) ).xy;
#endif
#ifdef USE_ALPHAMAP
	vAlphaMapUv = ( alphaMapTransform * vec3( ALPHAMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_LIGHTMAP
	vLightMapUv = ( lightMapTransform * vec3( LIGHTMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_AOMAP
	vAoMapUv = ( aoMapTransform * vec3( AOMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_BUMPMAP
	vBumpMapUv = ( bumpMapTransform * vec3( BUMPMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_NORMALMAP
	vNormalMapUv = ( normalMapTransform * vec3( NORMALMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_DISPLACEMENTMAP
	vDisplacementMapUv = ( displacementMapTransform * vec3( DISPLACEMENTMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_EMISSIVEMAP
	vEmissiveMapUv = ( emissiveMapTransform * vec3( EMISSIVEMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_METALNESSMAP
	vMetalnessMapUv = ( metalnessMapTransform * vec3( METALNESSMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_ROUGHNESSMAP
	vRoughnessMapUv = ( roughnessMapTransform * vec3( ROUGHNESSMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_ANISOTROPYMAP
	vAnisotropyMapUv = ( anisotropyMapTransform * vec3( ANISOTROPYMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_CLEARCOATMAP
	vClearcoatMapUv = ( clearcoatMapTransform * vec3( CLEARCOATMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_CLEARCOAT_NORMALMAP
	vClearcoatNormalMapUv = ( clearcoatNormalMapTransform * vec3( CLEARCOAT_NORMALMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_CLEARCOAT_ROUGHNESSMAP
	vClearcoatRoughnessMapUv = ( clearcoatRoughnessMapTransform * vec3( CLEARCOAT_ROUGHNESSMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_IRIDESCENCEMAP
	vIridescenceMapUv = ( iridescenceMapTransform * vec3( IRIDESCENCEMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_IRIDESCENCE_THICKNESSMAP
	vIridescenceThicknessMapUv = ( iridescenceThicknessMapTransform * vec3( IRIDESCENCE_THICKNESSMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_SHEEN_COLORMAP
	vSheenColorMapUv = ( sheenColorMapTransform * vec3( SHEEN_COLORMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_SHEEN_ROUGHNESSMAP
	vSheenRoughnessMapUv = ( sheenRoughnessMapTransform * vec3( SHEEN_ROUGHNESSMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_SPECULARMAP
	vSpecularMapUv = ( specularMapTransform * vec3( SPECULARMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_SPECULAR_COLORMAP
	vSpecularColorMapUv = ( specularColorMapTransform * vec3( SPECULAR_COLORMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_SPECULAR_INTENSITYMAP
	vSpecularIntensityMapUv = ( specularIntensityMapTransform * vec3( SPECULAR_INTENSITYMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_TRANSMISSIONMAP
	vTransmissionMapUv = ( transmissionMapTransform * vec3( TRANSMISSIONMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_THICKNESSMAP
	vThicknessMapUv = ( thicknessMapTransform * vec3( THICKNESSMAP_UV, 1 ) ).xy;
#endif`,qg=`#if defined( USE_ENVMAP ) || defined( DISTANCE ) || defined ( USE_SHADOWMAP ) || defined ( USE_TRANSMISSION ) || NUM_SPOT_LIGHT_COORDS > 0
	vec4 worldPosition = vec4( transformed, 1.0 );
	#ifdef USE_BATCHING
		worldPosition = batchingMatrix * worldPosition;
	#endif
	#ifdef USE_INSTANCING
		worldPosition = instanceMatrix * worldPosition;
	#endif
	worldPosition = modelMatrix * worldPosition;
#endif`,Yg=`varying vec2 vUv;
uniform mat3 uvTransform;
void main() {
	vUv = ( uvTransform * vec3( uv, 1 ) ).xy;
	gl_Position = vec4( position.xy, 1.0, 1.0 );
}`,Zg=`uniform sampler2D t2D;
uniform float backgroundIntensity;
varying vec2 vUv;
void main() {
	vec4 texColor = texture2D( t2D, vUv );
	#ifdef DECODE_VIDEO_TEXTURE
		texColor = vec4( mix( pow( texColor.rgb * 0.9478672986 + vec3( 0.0521327014 ), vec3( 2.4 ) ), texColor.rgb * 0.0773993808, vec3( lessThanEqual( texColor.rgb, vec3( 0.04045 ) ) ) ), texColor.w );
	#endif
	texColor.rgb *= backgroundIntensity;
	gl_FragColor = texColor;
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}`,Jg=`varying vec3 vWorldDirection;
#include <common>
void main() {
	vWorldDirection = transformDirection( position, modelMatrix );
	#include <begin_vertex>
	#include <project_vertex>
	gl_Position.z = gl_Position.w;
}`,$g=`#ifdef ENVMAP_TYPE_CUBE
	uniform samplerCube envMap;
#elif defined( ENVMAP_TYPE_CUBE_UV )
	uniform sampler2D envMap;
#endif
uniform float flipEnvMap;
uniform float backgroundBlurriness;
uniform float backgroundIntensity;
varying vec3 vWorldDirection;
#include <cube_uv_reflection_fragment>
void main() {
	#ifdef ENVMAP_TYPE_CUBE
		vec4 texColor = textureCube( envMap, vec3( flipEnvMap * vWorldDirection.x, vWorldDirection.yz ) );
	#elif defined( ENVMAP_TYPE_CUBE_UV )
		vec4 texColor = textureCubeUV( envMap, vWorldDirection, backgroundBlurriness );
	#else
		vec4 texColor = vec4( 0.0, 0.0, 0.0, 1.0 );
	#endif
	texColor.rgb *= backgroundIntensity;
	gl_FragColor = texColor;
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}`,Kg=`varying vec3 vWorldDirection;
#include <common>
void main() {
	vWorldDirection = transformDirection( position, modelMatrix );
	#include <begin_vertex>
	#include <project_vertex>
	gl_Position.z = gl_Position.w;
}`,Qg=`uniform samplerCube tCube;
uniform float tFlip;
uniform float opacity;
varying vec3 vWorldDirection;
void main() {
	vec4 texColor = textureCube( tCube, vec3( tFlip * vWorldDirection.x, vWorldDirection.yz ) );
	gl_FragColor = texColor;
	gl_FragColor.a *= opacity;
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}`,jg=`#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <displacementmap_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
varying vec2 vHighPrecisionZW;
void main() {
	#include <uv_vertex>
	#include <batching_vertex>
	#include <skinbase_vertex>
	#ifdef USE_DISPLACEMENTMAP
		#include <beginnormal_vertex>
		#include <morphnormal_vertex>
		#include <skinnormal_vertex>
	#endif
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <displacementmap_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	vHighPrecisionZW = gl_Position.zw;
}`,t_=`#if DEPTH_PACKING == 3200
	uniform float opacity;
#endif
#include <common>
#include <packing>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
varying vec2 vHighPrecisionZW;
void main() {
	#include <clipping_planes_fragment>
	vec4 diffuseColor = vec4( 1.0 );
	#if DEPTH_PACKING == 3200
		diffuseColor.a = opacity;
	#endif
	#include <map_fragment>
	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	#include <logdepthbuf_fragment>
	float fragCoordZ = 0.5 * vHighPrecisionZW[0] / vHighPrecisionZW[1] + 0.5;
	#if DEPTH_PACKING == 3200
		gl_FragColor = vec4( vec3( 1.0 - fragCoordZ ), opacity );
	#elif DEPTH_PACKING == 3201
		gl_FragColor = packDepthToRGBA( fragCoordZ );
	#endif
}`,e_=`#define DISTANCE
varying vec3 vWorldPosition;
#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <displacementmap_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	#include <uv_vertex>
	#include <batching_vertex>
	#include <skinbase_vertex>
	#ifdef USE_DISPLACEMENTMAP
		#include <beginnormal_vertex>
		#include <morphnormal_vertex>
		#include <skinnormal_vertex>
	#endif
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <displacementmap_vertex>
	#include <project_vertex>
	#include <worldpos_vertex>
	#include <clipping_planes_vertex>
	vWorldPosition = worldPosition.xyz;
}`,n_=`#define DISTANCE
uniform vec3 referencePosition;
uniform float nearDistance;
uniform float farDistance;
varying vec3 vWorldPosition;
#include <common>
#include <packing>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <clipping_planes_pars_fragment>
void main () {
	#include <clipping_planes_fragment>
	vec4 diffuseColor = vec4( 1.0 );
	#include <map_fragment>
	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	float dist = length( vWorldPosition - referencePosition );
	dist = ( dist - nearDistance ) / ( farDistance - nearDistance );
	dist = saturate( dist );
	gl_FragColor = packDepthToRGBA( dist );
}`,i_=`varying vec3 vWorldDirection;
#include <common>
void main() {
	vWorldDirection = transformDirection( position, modelMatrix );
	#include <begin_vertex>
	#include <project_vertex>
}`,s_=`uniform sampler2D tEquirect;
varying vec3 vWorldDirection;
#include <common>
void main() {
	vec3 direction = normalize( vWorldDirection );
	vec2 sampleUV = equirectUv( direction );
	gl_FragColor = texture2D( tEquirect, sampleUV );
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}`,r_=`uniform float scale;
attribute float lineDistance;
varying float vLineDistance;
#include <common>
#include <uv_pars_vertex>
#include <color_pars_vertex>
#include <fog_pars_vertex>
#include <morphtarget_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	vLineDistance = scale * lineDistance;
	#include <uv_vertex>
	#include <color_vertex>
	#include <morphcolor_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	#include <fog_vertex>
}`,a_=`uniform vec3 diffuse;
uniform float opacity;
uniform float dashSize;
uniform float totalSize;
varying float vLineDistance;
#include <common>
#include <color_pars_fragment>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	#include <clipping_planes_fragment>
	if ( mod( vLineDistance, totalSize ) > dashSize ) {
		discard;
	}
	vec3 outgoingLight = vec3( 0.0 );
	vec4 diffuseColor = vec4( diffuse, opacity );
	#include <logdepthbuf_fragment>
	#include <map_fragment>
	#include <color_fragment>
	outgoingLight = diffuseColor.rgb;
	#include <opaque_fragment>
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
	#include <premultiplied_alpha_fragment>
}`,o_=`#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <envmap_pars_vertex>
#include <color_pars_vertex>
#include <fog_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	#include <uv_vertex>
	#include <color_vertex>
	#include <morphcolor_vertex>
	#include <batching_vertex>
	#if defined ( USE_ENVMAP ) || defined ( USE_SKINNING )
		#include <beginnormal_vertex>
		#include <morphnormal_vertex>
		#include <skinbase_vertex>
		#include <skinnormal_vertex>
		#include <defaultnormal_vertex>
	#endif
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	#include <worldpos_vertex>
	#include <envmap_vertex>
	#include <fog_vertex>
}`,c_=`uniform vec3 diffuse;
uniform float opacity;
#ifndef FLAT_SHADED
	varying vec3 vNormal;
#endif
#include <common>
#include <dithering_pars_fragment>
#include <color_pars_fragment>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <aomap_pars_fragment>
#include <lightmap_pars_fragment>
#include <envmap_common_pars_fragment>
#include <envmap_pars_fragment>
#include <fog_pars_fragment>
#include <specularmap_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	#include <clipping_planes_fragment>
	vec4 diffuseColor = vec4( diffuse, opacity );
	#include <logdepthbuf_fragment>
	#include <map_fragment>
	#include <color_fragment>
	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	#include <specularmap_fragment>
	ReflectedLight reflectedLight = ReflectedLight( vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ) );
	#ifdef USE_LIGHTMAP
		vec4 lightMapTexel = texture2D( lightMap, vLightMapUv );
		reflectedLight.indirectDiffuse += lightMapTexel.rgb * lightMapIntensity * RECIPROCAL_PI;
	#else
		reflectedLight.indirectDiffuse += vec3( 1.0 );
	#endif
	#include <aomap_fragment>
	reflectedLight.indirectDiffuse *= diffuseColor.rgb;
	vec3 outgoingLight = reflectedLight.indirectDiffuse;
	#include <envmap_fragment>
	#include <opaque_fragment>
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
	#include <premultiplied_alpha_fragment>
	#include <dithering_fragment>
}`,l_=`#define LAMBERT
varying vec3 vViewPosition;
#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <displacementmap_pars_vertex>
#include <envmap_pars_vertex>
#include <color_pars_vertex>
#include <fog_pars_vertex>
#include <normal_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <shadowmap_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	#include <uv_vertex>
	#include <color_vertex>
	#include <morphcolor_vertex>
	#include <batching_vertex>
	#include <beginnormal_vertex>
	#include <morphnormal_vertex>
	#include <skinbase_vertex>
	#include <skinnormal_vertex>
	#include <defaultnormal_vertex>
	#include <normal_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <displacementmap_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	vViewPosition = - mvPosition.xyz;
	#include <worldpos_vertex>
	#include <envmap_vertex>
	#include <shadowmap_vertex>
	#include <fog_vertex>
}`,h_=`#define LAMBERT
uniform vec3 diffuse;
uniform vec3 emissive;
uniform float opacity;
#include <common>
#include <packing>
#include <dithering_pars_fragment>
#include <color_pars_fragment>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <aomap_pars_fragment>
#include <lightmap_pars_fragment>
#include <emissivemap_pars_fragment>
#include <envmap_common_pars_fragment>
#include <envmap_pars_fragment>
#include <fog_pars_fragment>
#include <bsdfs>
#include <lights_pars_begin>
#include <normal_pars_fragment>
#include <lights_lambert_pars_fragment>
#include <shadowmap_pars_fragment>
#include <bumpmap_pars_fragment>
#include <normalmap_pars_fragment>
#include <specularmap_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	#include <clipping_planes_fragment>
	vec4 diffuseColor = vec4( diffuse, opacity );
	ReflectedLight reflectedLight = ReflectedLight( vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ) );
	vec3 totalEmissiveRadiance = emissive;
	#include <logdepthbuf_fragment>
	#include <map_fragment>
	#include <color_fragment>
	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	#include <specularmap_fragment>
	#include <normal_fragment_begin>
	#include <normal_fragment_maps>
	#include <emissivemap_fragment>
	#include <lights_lambert_fragment>
	#include <lights_fragment_begin>
	#include <lights_fragment_maps>
	#include <lights_fragment_end>
	#include <aomap_fragment>
	vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;
	#include <envmap_fragment>
	#include <opaque_fragment>
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
	#include <premultiplied_alpha_fragment>
	#include <dithering_fragment>
}`,u_=`#define MATCAP
varying vec3 vViewPosition;
#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <color_pars_vertex>
#include <displacementmap_pars_vertex>
#include <fog_pars_vertex>
#include <normal_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	#include <uv_vertex>
	#include <color_vertex>
	#include <morphcolor_vertex>
	#include <batching_vertex>
	#include <beginnormal_vertex>
	#include <morphnormal_vertex>
	#include <skinbase_vertex>
	#include <skinnormal_vertex>
	#include <defaultnormal_vertex>
	#include <normal_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <displacementmap_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	#include <fog_vertex>
	vViewPosition = - mvPosition.xyz;
}`,d_=`#define MATCAP
uniform vec3 diffuse;
uniform float opacity;
uniform sampler2D matcap;
varying vec3 vViewPosition;
#include <common>
#include <dithering_pars_fragment>
#include <color_pars_fragment>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <fog_pars_fragment>
#include <normal_pars_fragment>
#include <bumpmap_pars_fragment>
#include <normalmap_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	#include <clipping_planes_fragment>
	vec4 diffuseColor = vec4( diffuse, opacity );
	#include <logdepthbuf_fragment>
	#include <map_fragment>
	#include <color_fragment>
	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	#include <normal_fragment_begin>
	#include <normal_fragment_maps>
	vec3 viewDir = normalize( vViewPosition );
	vec3 x = normalize( vec3( viewDir.z, 0.0, - viewDir.x ) );
	vec3 y = cross( viewDir, x );
	vec2 uv = vec2( dot( x, normal ), dot( y, normal ) ) * 0.495 + 0.5;
	#ifdef USE_MATCAP
		vec4 matcapColor = texture2D( matcap, uv );
	#else
		vec4 matcapColor = vec4( vec3( mix( 0.2, 0.8, uv.y ) ), 1.0 );
	#endif
	vec3 outgoingLight = diffuseColor.rgb * matcapColor.rgb;
	#include <opaque_fragment>
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
	#include <premultiplied_alpha_fragment>
	#include <dithering_fragment>
}`,f_=`#define NORMAL
#if defined( FLAT_SHADED ) || defined( USE_BUMPMAP ) || defined( USE_NORMALMAP_TANGENTSPACE )
	varying vec3 vViewPosition;
#endif
#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <displacementmap_pars_vertex>
#include <normal_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	#include <uv_vertex>
	#include <batching_vertex>
	#include <beginnormal_vertex>
	#include <morphnormal_vertex>
	#include <skinbase_vertex>
	#include <skinnormal_vertex>
	#include <defaultnormal_vertex>
	#include <normal_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <displacementmap_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
#if defined( FLAT_SHADED ) || defined( USE_BUMPMAP ) || defined( USE_NORMALMAP_TANGENTSPACE )
	vViewPosition = - mvPosition.xyz;
#endif
}`,p_=`#define NORMAL
uniform float opacity;
#if defined( FLAT_SHADED ) || defined( USE_BUMPMAP ) || defined( USE_NORMALMAP_TANGENTSPACE )
	varying vec3 vViewPosition;
#endif
#include <packing>
#include <uv_pars_fragment>
#include <normal_pars_fragment>
#include <bumpmap_pars_fragment>
#include <normalmap_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	#include <clipping_planes_fragment>
	#include <logdepthbuf_fragment>
	#include <normal_fragment_begin>
	#include <normal_fragment_maps>
	gl_FragColor = vec4( packNormalToRGB( normal ), opacity );
	#ifdef OPAQUE
		gl_FragColor.a = 1.0;
	#endif
}`,m_=`#define PHONG
varying vec3 vViewPosition;
#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <displacementmap_pars_vertex>
#include <envmap_pars_vertex>
#include <color_pars_vertex>
#include <fog_pars_vertex>
#include <normal_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <shadowmap_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	#include <uv_vertex>
	#include <color_vertex>
	#include <morphcolor_vertex>
	#include <batching_vertex>
	#include <beginnormal_vertex>
	#include <morphnormal_vertex>
	#include <skinbase_vertex>
	#include <skinnormal_vertex>
	#include <defaultnormal_vertex>
	#include <normal_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <displacementmap_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	vViewPosition = - mvPosition.xyz;
	#include <worldpos_vertex>
	#include <envmap_vertex>
	#include <shadowmap_vertex>
	#include <fog_vertex>
}`,g_=`#define PHONG
uniform vec3 diffuse;
uniform vec3 emissive;
uniform vec3 specular;
uniform float shininess;
uniform float opacity;
#include <common>
#include <packing>
#include <dithering_pars_fragment>
#include <color_pars_fragment>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <aomap_pars_fragment>
#include <lightmap_pars_fragment>
#include <emissivemap_pars_fragment>
#include <envmap_common_pars_fragment>
#include <envmap_pars_fragment>
#include <fog_pars_fragment>
#include <bsdfs>
#include <lights_pars_begin>
#include <normal_pars_fragment>
#include <lights_phong_pars_fragment>
#include <shadowmap_pars_fragment>
#include <bumpmap_pars_fragment>
#include <normalmap_pars_fragment>
#include <specularmap_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	#include <clipping_planes_fragment>
	vec4 diffuseColor = vec4( diffuse, opacity );
	ReflectedLight reflectedLight = ReflectedLight( vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ) );
	vec3 totalEmissiveRadiance = emissive;
	#include <logdepthbuf_fragment>
	#include <map_fragment>
	#include <color_fragment>
	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	#include <specularmap_fragment>
	#include <normal_fragment_begin>
	#include <normal_fragment_maps>
	#include <emissivemap_fragment>
	#include <lights_phong_fragment>
	#include <lights_fragment_begin>
	#include <lights_fragment_maps>
	#include <lights_fragment_end>
	#include <aomap_fragment>
	vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + reflectedLight.directSpecular + reflectedLight.indirectSpecular + totalEmissiveRadiance;
	#include <envmap_fragment>
	#include <opaque_fragment>
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
	#include <premultiplied_alpha_fragment>
	#include <dithering_fragment>
}`,__=`#define STANDARD
varying vec3 vViewPosition;
#ifdef USE_TRANSMISSION
	varying vec3 vWorldPosition;
#endif
#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <displacementmap_pars_vertex>
#include <color_pars_vertex>
#include <fog_pars_vertex>
#include <normal_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <shadowmap_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	#include <uv_vertex>
	#include <color_vertex>
	#include <morphcolor_vertex>
	#include <batching_vertex>
	#include <beginnormal_vertex>
	#include <morphnormal_vertex>
	#include <skinbase_vertex>
	#include <skinnormal_vertex>
	#include <defaultnormal_vertex>
	#include <normal_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <displacementmap_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	vViewPosition = - mvPosition.xyz;
	#include <worldpos_vertex>
	#include <shadowmap_vertex>
	#include <fog_vertex>
#ifdef USE_TRANSMISSION
	vWorldPosition = worldPosition.xyz;
#endif
}`,x_=`#define STANDARD
#ifdef PHYSICAL
	#define IOR
	#define USE_SPECULAR
#endif
uniform vec3 diffuse;
uniform vec3 emissive;
uniform float roughness;
uniform float metalness;
uniform float opacity;
#ifdef IOR
	uniform float ior;
#endif
#ifdef USE_SPECULAR
	uniform float specularIntensity;
	uniform vec3 specularColor;
	#ifdef USE_SPECULAR_COLORMAP
		uniform sampler2D specularColorMap;
	#endif
	#ifdef USE_SPECULAR_INTENSITYMAP
		uniform sampler2D specularIntensityMap;
	#endif
#endif
#ifdef USE_CLEARCOAT
	uniform float clearcoat;
	uniform float clearcoatRoughness;
#endif
#ifdef USE_IRIDESCENCE
	uniform float iridescence;
	uniform float iridescenceIOR;
	uniform float iridescenceThicknessMinimum;
	uniform float iridescenceThicknessMaximum;
#endif
#ifdef USE_SHEEN
	uniform vec3 sheenColor;
	uniform float sheenRoughness;
	#ifdef USE_SHEEN_COLORMAP
		uniform sampler2D sheenColorMap;
	#endif
	#ifdef USE_SHEEN_ROUGHNESSMAP
		uniform sampler2D sheenRoughnessMap;
	#endif
#endif
#ifdef USE_ANISOTROPY
	uniform vec2 anisotropyVector;
	#ifdef USE_ANISOTROPYMAP
		uniform sampler2D anisotropyMap;
	#endif
#endif
varying vec3 vViewPosition;
#include <common>
#include <packing>
#include <dithering_pars_fragment>
#include <color_pars_fragment>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <aomap_pars_fragment>
#include <lightmap_pars_fragment>
#include <emissivemap_pars_fragment>
#include <iridescence_fragment>
#include <cube_uv_reflection_fragment>
#include <envmap_common_pars_fragment>
#include <envmap_physical_pars_fragment>
#include <fog_pars_fragment>
#include <lights_pars_begin>
#include <normal_pars_fragment>
#include <lights_physical_pars_fragment>
#include <transmission_pars_fragment>
#include <shadowmap_pars_fragment>
#include <bumpmap_pars_fragment>
#include <normalmap_pars_fragment>
#include <clearcoat_pars_fragment>
#include <iridescence_pars_fragment>
#include <roughnessmap_pars_fragment>
#include <metalnessmap_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	#include <clipping_planes_fragment>
	vec4 diffuseColor = vec4( diffuse, opacity );
	ReflectedLight reflectedLight = ReflectedLight( vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ) );
	vec3 totalEmissiveRadiance = emissive;
	#include <logdepthbuf_fragment>
	#include <map_fragment>
	#include <color_fragment>
	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	#include <roughnessmap_fragment>
	#include <metalnessmap_fragment>
	#include <normal_fragment_begin>
	#include <normal_fragment_maps>
	#include <clearcoat_normal_fragment_begin>
	#include <clearcoat_normal_fragment_maps>
	#include <emissivemap_fragment>
	#include <lights_physical_fragment>
	#include <lights_fragment_begin>
	#include <lights_fragment_maps>
	#include <lights_fragment_end>
	#include <aomap_fragment>
	vec3 totalDiffuse = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse;
	vec3 totalSpecular = reflectedLight.directSpecular + reflectedLight.indirectSpecular;
	#include <transmission_fragment>
	vec3 outgoingLight = totalDiffuse + totalSpecular + totalEmissiveRadiance;
	#ifdef USE_SHEEN
		float sheenEnergyComp = 1.0 - 0.157 * max3( material.sheenColor );
		outgoingLight = outgoingLight * sheenEnergyComp + sheenSpecularDirect + sheenSpecularIndirect;
	#endif
	#ifdef USE_CLEARCOAT
		float dotNVcc = saturate( dot( geometryClearcoatNormal, geometryViewDir ) );
		vec3 Fcc = F_Schlick( material.clearcoatF0, material.clearcoatF90, dotNVcc );
		outgoingLight = outgoingLight * ( 1.0 - material.clearcoat * Fcc ) + ( clearcoatSpecularDirect + clearcoatSpecularIndirect ) * material.clearcoat;
	#endif
	#include <opaque_fragment>
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
	#include <premultiplied_alpha_fragment>
	#include <dithering_fragment>
}`,v_=`#define TOON
varying vec3 vViewPosition;
#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <displacementmap_pars_vertex>
#include <color_pars_vertex>
#include <fog_pars_vertex>
#include <normal_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <shadowmap_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	#include <uv_vertex>
	#include <color_vertex>
	#include <morphcolor_vertex>
	#include <batching_vertex>
	#include <beginnormal_vertex>
	#include <morphnormal_vertex>
	#include <skinbase_vertex>
	#include <skinnormal_vertex>
	#include <defaultnormal_vertex>
	#include <normal_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <displacementmap_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	vViewPosition = - mvPosition.xyz;
	#include <worldpos_vertex>
	#include <shadowmap_vertex>
	#include <fog_vertex>
}`,y_=`#define TOON
uniform vec3 diffuse;
uniform vec3 emissive;
uniform float opacity;
#include <common>
#include <packing>
#include <dithering_pars_fragment>
#include <color_pars_fragment>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <aomap_pars_fragment>
#include <lightmap_pars_fragment>
#include <emissivemap_pars_fragment>
#include <gradientmap_pars_fragment>
#include <fog_pars_fragment>
#include <bsdfs>
#include <lights_pars_begin>
#include <normal_pars_fragment>
#include <lights_toon_pars_fragment>
#include <shadowmap_pars_fragment>
#include <bumpmap_pars_fragment>
#include <normalmap_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	#include <clipping_planes_fragment>
	vec4 diffuseColor = vec4( diffuse, opacity );
	ReflectedLight reflectedLight = ReflectedLight( vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ) );
	vec3 totalEmissiveRadiance = emissive;
	#include <logdepthbuf_fragment>
	#include <map_fragment>
	#include <color_fragment>
	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	#include <normal_fragment_begin>
	#include <normal_fragment_maps>
	#include <emissivemap_fragment>
	#include <lights_toon_fragment>
	#include <lights_fragment_begin>
	#include <lights_fragment_maps>
	#include <lights_fragment_end>
	#include <aomap_fragment>
	vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;
	#include <opaque_fragment>
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
	#include <premultiplied_alpha_fragment>
	#include <dithering_fragment>
}`,M_=`uniform float size;
uniform float scale;
#include <common>
#include <color_pars_vertex>
#include <fog_pars_vertex>
#include <morphtarget_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
#ifdef USE_POINTS_UV
	varying vec2 vUv;
	uniform mat3 uvTransform;
#endif
void main() {
	#ifdef USE_POINTS_UV
		vUv = ( uvTransform * vec3( uv, 1 ) ).xy;
	#endif
	#include <color_vertex>
	#include <morphcolor_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <project_vertex>
	gl_PointSize = size;
	#ifdef USE_SIZEATTENUATION
		bool isPerspective = isPerspectiveMatrix( projectionMatrix );
		if ( isPerspective ) gl_PointSize *= ( scale / - mvPosition.z );
	#endif
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	#include <worldpos_vertex>
	#include <fog_vertex>
}`,S_=`uniform vec3 diffuse;
uniform float opacity;
#include <common>
#include <color_pars_fragment>
#include <map_particle_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	#include <clipping_planes_fragment>
	vec3 outgoingLight = vec3( 0.0 );
	vec4 diffuseColor = vec4( diffuse, opacity );
	#include <logdepthbuf_fragment>
	#include <map_particle_fragment>
	#include <color_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	outgoingLight = diffuseColor.rgb;
	#include <opaque_fragment>
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
	#include <premultiplied_alpha_fragment>
}`,b_=`#include <common>
#include <batching_pars_vertex>
#include <fog_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <shadowmap_pars_vertex>
void main() {
	#include <batching_vertex>
	#include <beginnormal_vertex>
	#include <morphnormal_vertex>
	#include <skinbase_vertex>
	#include <skinnormal_vertex>
	#include <defaultnormal_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <worldpos_vertex>
	#include <shadowmap_vertex>
	#include <fog_vertex>
}`,E_=`uniform vec3 color;
uniform float opacity;
#include <common>
#include <packing>
#include <fog_pars_fragment>
#include <bsdfs>
#include <lights_pars_begin>
#include <logdepthbuf_pars_fragment>
#include <shadowmap_pars_fragment>
#include <shadowmask_pars_fragment>
void main() {
	#include <logdepthbuf_fragment>
	gl_FragColor = vec4( color, opacity * ( 1.0 - getShadowMask() ) );
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
}`,A_=`uniform float rotation;
uniform vec2 center;
#include <common>
#include <uv_pars_vertex>
#include <fog_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	#include <uv_vertex>
	vec4 mvPosition = modelViewMatrix * vec4( 0.0, 0.0, 0.0, 1.0 );
	vec2 scale;
	scale.x = length( vec3( modelMatrix[ 0 ].x, modelMatrix[ 0 ].y, modelMatrix[ 0 ].z ) );
	scale.y = length( vec3( modelMatrix[ 1 ].x, modelMatrix[ 1 ].y, modelMatrix[ 1 ].z ) );
	#ifndef USE_SIZEATTENUATION
		bool isPerspective = isPerspectiveMatrix( projectionMatrix );
		if ( isPerspective ) scale *= - mvPosition.z;
	#endif
	vec2 alignedPosition = ( position.xy - ( center - vec2( 0.5 ) ) ) * scale;
	vec2 rotatedPosition;
	rotatedPosition.x = cos( rotation ) * alignedPosition.x - sin( rotation ) * alignedPosition.y;
	rotatedPosition.y = sin( rotation ) * alignedPosition.x + cos( rotation ) * alignedPosition.y;
	mvPosition.xy += rotatedPosition;
	gl_Position = projectionMatrix * mvPosition;
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	#include <fog_vertex>
}`,T_=`uniform vec3 diffuse;
uniform float opacity;
#include <common>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	#include <clipping_planes_fragment>
	vec3 outgoingLight = vec3( 0.0 );
	vec4 diffuseColor = vec4( diffuse, opacity );
	#include <logdepthbuf_fragment>
	#include <map_fragment>
	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	outgoingLight = diffuseColor.rgb;
	#include <opaque_fragment>
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
}`,kt={alphahash_fragment:Zp,alphahash_pars_fragment:Jp,alphamap_fragment:$p,alphamap_pars_fragment:Kp,alphatest_fragment:Qp,alphatest_pars_fragment:jp,aomap_fragment:tm,aomap_pars_fragment:em,batching_pars_vertex:nm,batching_vertex:im,begin_vertex:sm,beginnormal_vertex:rm,bsdfs:am,iridescence_fragment:om,bumpmap_pars_fragment:cm,clipping_planes_fragment:lm,clipping_planes_pars_fragment:hm,clipping_planes_pars_vertex:um,clipping_planes_vertex:dm,color_fragment:fm,color_pars_fragment:pm,color_pars_vertex:mm,color_vertex:gm,common:_m,cube_uv_reflection_fragment:xm,defaultnormal_vertex:vm,displacementmap_pars_vertex:ym,displacementmap_vertex:Mm,emissivemap_fragment:Sm,emissivemap_pars_fragment:bm,colorspace_fragment:Em,colorspace_pars_fragment:Am,envmap_fragment:Tm,envmap_common_pars_fragment:wm,envmap_pars_fragment:Rm,envmap_pars_vertex:Cm,envmap_physical_pars_fragment:km,envmap_vertex:Pm,fog_vertex:Lm,fog_pars_vertex:Im,fog_fragment:Um,fog_pars_fragment:Dm,gradientmap_pars_fragment:Nm,lightmap_fragment:Om,lightmap_pars_fragment:Fm,lights_lambert_fragment:Bm,lights_lambert_pars_fragment:zm,lights_pars_begin:Vm,lights_toon_fragment:Hm,lights_toon_pars_fragment:Gm,lights_phong_fragment:Wm,lights_phong_pars_fragment:Xm,lights_physical_fragment:qm,lights_physical_pars_fragment:Ym,lights_fragment_begin:Zm,lights_fragment_maps:Jm,lights_fragment_end:$m,logdepthbuf_fragment:Km,logdepthbuf_pars_fragment:Qm,logdepthbuf_pars_vertex:jm,logdepthbuf_vertex:tg,map_fragment:eg,map_pars_fragment:ng,map_particle_fragment:ig,map_particle_pars_fragment:sg,metalnessmap_fragment:rg,metalnessmap_pars_fragment:ag,morphcolor_vertex:og,morphnormal_vertex:cg,morphtarget_pars_vertex:lg,morphtarget_vertex:hg,normal_fragment_begin:ug,normal_fragment_maps:dg,normal_pars_fragment:fg,normal_pars_vertex:pg,normal_vertex:mg,normalmap_pars_fragment:gg,clearcoat_normal_fragment_begin:_g,clearcoat_normal_fragment_maps:xg,clearcoat_pars_fragment:vg,iridescence_pars_fragment:yg,opaque_fragment:Mg,packing:Sg,premultiplied_alpha_fragment:bg,project_vertex:Eg,dithering_fragment:Ag,dithering_pars_fragment:Tg,roughnessmap_fragment:wg,roughnessmap_pars_fragment:Rg,shadowmap_pars_fragment:Cg,shadowmap_pars_vertex:Pg,shadowmap_vertex:Lg,shadowmask_pars_fragment:Ig,skinbase_vertex:Ug,skinning_pars_vertex:Dg,skinning_vertex:Ng,skinnormal_vertex:Og,specularmap_fragment:Fg,specularmap_pars_fragment:Bg,tonemapping_fragment:zg,tonemapping_pars_fragment:Vg,transmission_fragment:kg,transmission_pars_fragment:Hg,uv_pars_fragment:Gg,uv_pars_vertex:Wg,uv_vertex:Xg,worldpos_vertex:qg,background_vert:Yg,background_frag:Zg,backgroundCube_vert:Jg,backgroundCube_frag:$g,cube_vert:Kg,cube_frag:Qg,depth_vert:jg,depth_frag:t_,distanceRGBA_vert:e_,distanceRGBA_frag:n_,equirect_vert:i_,equirect_frag:s_,linedashed_vert:r_,linedashed_frag:a_,meshbasic_vert:o_,meshbasic_frag:c_,meshlambert_vert:l_,meshlambert_frag:h_,meshmatcap_vert:u_,meshmatcap_frag:d_,meshnormal_vert:f_,meshnormal_frag:p_,meshphong_vert:m_,meshphong_frag:g_,meshphysical_vert:__,meshphysical_frag:x_,meshtoon_vert:v_,meshtoon_frag:y_,points_vert:M_,points_frag:S_,shadow_vert:b_,shadow_frag:E_,sprite_vert:A_,sprite_frag:T_},ot={common:{diffuse:{value:new pt(16777215)},opacity:{value:1},map:{value:null},mapTransform:{value:new Gt},alphaMap:{value:null},alphaMapTransform:{value:new Gt},alphaTest:{value:0}},specularmap:{specularMap:{value:null},specularMapTransform:{value:new Gt}},envmap:{envMap:{value:null},flipEnvMap:{value:-1},reflectivity:{value:1},ior:{value:1.5},refractionRatio:{value:.98}},aomap:{aoMap:{value:null},aoMapIntensity:{value:1},aoMapTransform:{value:new Gt}},lightmap:{lightMap:{value:null},lightMapIntensity:{value:1},lightMapTransform:{value:new Gt}},bumpmap:{bumpMap:{value:null},bumpMapTransform:{value:new Gt},bumpScale:{value:1}},normalmap:{normalMap:{value:null},normalMapTransform:{value:new Gt},normalScale:{value:new Z(1,1)}},displacementmap:{displacementMap:{value:null},displacementMapTransform:{value:new Gt},displacementScale:{value:1},displacementBias:{value:0}},emissivemap:{emissiveMap:{value:null},emissiveMapTransform:{value:new Gt}},metalnessmap:{metalnessMap:{value:null},metalnessMapTransform:{value:new Gt}},roughnessmap:{roughnessMap:{value:null},roughnessMapTransform:{value:new Gt}},gradientmap:{gradientMap:{value:null}},fog:{fogDensity:{value:25e-5},fogNear:{value:1},fogFar:{value:2e3},fogColor:{value:new pt(16777215)}},lights:{ambientLightColor:{value:[]},lightProbe:{value:[]},directionalLights:{value:[],properties:{direction:{},color:{}}},directionalLightShadows:{value:[],properties:{shadowBias:{},shadowNormalBias:{},shadowRadius:{},shadowMapSize:{}}},directionalShadowMap:{value:[]},directionalShadowMatrix:{value:[]},spotLights:{value:[],properties:{color:{},position:{},direction:{},distance:{},coneCos:{},penumbraCos:{},decay:{}}},spotLightShadows:{value:[],properties:{shadowBias:{},shadowNormalBias:{},shadowRadius:{},shadowMapSize:{}}},spotLightMap:{value:[]},spotShadowMap:{value:[]},spotLightMatrix:{value:[]},pointLights:{value:[],properties:{color:{},position:{},decay:{},distance:{}}},pointLightShadows:{value:[],properties:{shadowBias:{},shadowNormalBias:{},shadowRadius:{},shadowMapSize:{},shadowCameraNear:{},shadowCameraFar:{}}},pointShadowMap:{value:[]},pointShadowMatrix:{value:[]},hemisphereLights:{value:[],properties:{direction:{},skyColor:{},groundColor:{}}},rectAreaLights:{value:[],properties:{color:{},position:{},width:{},height:{}}},ltc_1:{value:null},ltc_2:{value:null}},points:{diffuse:{value:new pt(16777215)},opacity:{value:1},size:{value:1},scale:{value:1},map:{value:null},alphaMap:{value:null},alphaMapTransform:{value:new Gt},alphaTest:{value:0},uvTransform:{value:new Gt}},sprite:{diffuse:{value:new pt(16777215)},opacity:{value:1},center:{value:new Z(.5,.5)},rotation:{value:0},map:{value:null},mapTransform:{value:new Gt},alphaMap:{value:null},alphaMapTransform:{value:new Gt},alphaTest:{value:0}}},on={basic:{uniforms:Oe([ot.common,ot.specularmap,ot.envmap,ot.aomap,ot.lightmap,ot.fog]),vertexShader:kt.meshbasic_vert,fragmentShader:kt.meshbasic_frag},lambert:{uniforms:Oe([ot.common,ot.specularmap,ot.envmap,ot.aomap,ot.lightmap,ot.emissivemap,ot.bumpmap,ot.normalmap,ot.displacementmap,ot.fog,ot.lights,{emissive:{value:new pt(0)}}]),vertexShader:kt.meshlambert_vert,fragmentShader:kt.meshlambert_frag},phong:{uniforms:Oe([ot.common,ot.specularmap,ot.envmap,ot.aomap,ot.lightmap,ot.emissivemap,ot.bumpmap,ot.normalmap,ot.displacementmap,ot.fog,ot.lights,{emissive:{value:new pt(0)},specular:{value:new pt(1118481)},shininess:{value:30}}]),vertexShader:kt.meshphong_vert,fragmentShader:kt.meshphong_frag},standard:{uniforms:Oe([ot.common,ot.envmap,ot.aomap,ot.lightmap,ot.emissivemap,ot.bumpmap,ot.normalmap,ot.displacementmap,ot.roughnessmap,ot.metalnessmap,ot.fog,ot.lights,{emissive:{value:new pt(0)},roughness:{value:1},metalness:{value:0},envMapIntensity:{value:1}}]),vertexShader:kt.meshphysical_vert,fragmentShader:kt.meshphysical_frag},toon:{uniforms:Oe([ot.common,ot.aomap,ot.lightmap,ot.emissivemap,ot.bumpmap,ot.normalmap,ot.displacementmap,ot.gradientmap,ot.fog,ot.lights,{emissive:{value:new pt(0)}}]),vertexShader:kt.meshtoon_vert,fragmentShader:kt.meshtoon_frag},matcap:{uniforms:Oe([ot.common,ot.bumpmap,ot.normalmap,ot.displacementmap,ot.fog,{matcap:{value:null}}]),vertexShader:kt.meshmatcap_vert,fragmentShader:kt.meshmatcap_frag},points:{uniforms:Oe([ot.points,ot.fog]),vertexShader:kt.points_vert,fragmentShader:kt.points_frag},dashed:{uniforms:Oe([ot.common,ot.fog,{scale:{value:1},dashSize:{value:1},totalSize:{value:2}}]),vertexShader:kt.linedashed_vert,fragmentShader:kt.linedashed_frag},depth:{uniforms:Oe([ot.common,ot.displacementmap]),vertexShader:kt.depth_vert,fragmentShader:kt.depth_frag},normal:{uniforms:Oe([ot.common,ot.bumpmap,ot.normalmap,ot.displacementmap,{opacity:{value:1}}]),vertexShader:kt.meshnormal_vert,fragmentShader:kt.meshnormal_frag},sprite:{uniforms:Oe([ot.sprite,ot.fog]),vertexShader:kt.sprite_vert,fragmentShader:kt.sprite_frag},background:{uniforms:{uvTransform:{value:new Gt},t2D:{value:null},backgroundIntensity:{value:1}},vertexShader:kt.background_vert,fragmentShader:kt.background_frag},backgroundCube:{uniforms:{envMap:{value:null},flipEnvMap:{value:-1},backgroundBlurriness:{value:0},backgroundIntensity:{value:1}},vertexShader:kt.backgroundCube_vert,fragmentShader:kt.backgroundCube_frag},cube:{uniforms:{tCube:{value:null},tFlip:{value:-1},opacity:{value:1}},vertexShader:kt.cube_vert,fragmentShader:kt.cube_frag},equirect:{uniforms:{tEquirect:{value:null}},vertexShader:kt.equirect_vert,fragmentShader:kt.equirect_frag},distanceRGBA:{uniforms:Oe([ot.common,ot.displacementmap,{referencePosition:{value:new w},nearDistance:{value:1},farDistance:{value:1e3}}]),vertexShader:kt.distanceRGBA_vert,fragmentShader:kt.distanceRGBA_frag},shadow:{uniforms:Oe([ot.lights,ot.fog,{color:{value:new pt(0)},opacity:{value:1}}]),vertexShader:kt.shadow_vert,fragmentShader:kt.shadow_frag}};on.physical={uniforms:Oe([on.standard.uniforms,{clearcoat:{value:0},clearcoatMap:{value:null},clearcoatMapTransform:{value:new Gt},clearcoatNormalMap:{value:null},clearcoatNormalMapTransform:{value:new Gt},clearcoatNormalScale:{value:new Z(1,1)},clearcoatRoughness:{value:0},clearcoatRoughnessMap:{value:null},clearcoatRoughnessMapTransform:{value:new Gt},iridescence:{value:0},iridescenceMap:{value:null},iridescenceMapTransform:{value:new Gt},iridescenceIOR:{value:1.3},iridescenceThicknessMinimum:{value:100},iridescenceThicknessMaximum:{value:400},iridescenceThicknessMap:{value:null},iridescenceThicknessMapTransform:{value:new Gt},sheen:{value:0},sheenColor:{value:new pt(0)},sheenColorMap:{value:null},sheenColorMapTransform:{value:new Gt},sheenRoughness:{value:1},sheenRoughnessMap:{value:null},sheenRoughnessMapTransform:{value:new Gt},transmission:{value:0},transmissionMap:{value:null},transmissionMapTransform:{value:new Gt},transmissionSamplerSize:{value:new Z},transmissionSamplerMap:{value:null},thickness:{value:0},thicknessMap:{value:null},thicknessMapTransform:{value:new Gt},attenuationDistance:{value:0},attenuationColor:{value:new pt(0)},specularColor:{value:new pt(1,1,1)},specularColorMap:{value:null},specularColorMapTransform:{value:new Gt},specularIntensity:{value:1},specularIntensityMap:{value:null},specularIntensityMapTransform:{value:new Gt},anisotropyVector:{value:new Z},anisotropyMap:{value:null},anisotropyMapTransform:{value:new Gt}}]),vertexShader:kt.meshphysical_vert,fragmentShader:kt.meshphysical_frag};var gr={r:0,b:0,g:0};function w_(r,t,e,n,i,s,a){let o=new pt(0),c=s===!0?0:1,l,h,u=null,d=0,f=null;function m(g,p){let v=!1,x=p.isScene===!0?p.background:null;x&&x.isTexture&&(x=(p.backgroundBlurriness>0?e:t).get(x)),x===null?_(o,c):x&&x.isColor&&(_(x,1),v=!0);let y=r.xr.getEnvironmentBlendMode();y==="additive"?n.buffers.color.setClear(0,0,0,1,a):y==="alpha-blend"&&n.buffers.color.setClear(0,0,0,0,a),(r.autoClear||v)&&r.clear(r.autoClearColor,r.autoClearDepth,r.autoClearStencil),x&&(x.isCubeTexture||x.mapping===Ys)?(h===void 0&&(h=new ge(new ns(1,1,1),new sn({name:"BackgroundCubeMaterial",uniforms:is(on.backgroundCube.uniforms),vertexShader:on.backgroundCube.vertexShader,fragmentShader:on.backgroundCube.fragmentShader,side:He,depthTest:!1,depthWrite:!1,fog:!1})),h.geometry.deleteAttribute("normal"),h.geometry.deleteAttribute("uv"),h.onBeforeRender=function(C,T,R){this.matrixWorld.copyPosition(R.matrixWorld)},Object.defineProperty(h.material,"envMap",{get:function(){return this.uniforms.envMap.value}}),i.update(h)),h.material.uniforms.envMap.value=x,h.material.uniforms.flipEnvMap.value=x.isCubeTexture&&x.isRenderTargetTexture===!1?-1:1,h.material.uniforms.backgroundBlurriness.value=p.backgroundBlurriness,h.material.uniforms.backgroundIntensity.value=p.backgroundIntensity,h.material.toneMapped=jt.getTransfer(x.colorSpace)!==se,(u!==x||d!==x.version||f!==r.toneMapping)&&(h.material.needsUpdate=!0,u=x,d=x.version,f=r.toneMapping),h.layers.enableAll(),g.unshift(h,h.geometry,h.material,0,0,null)):x&&x.isTexture&&(l===void 0&&(l=new ge(new oa(2,2),new sn({name:"BackgroundMaterial",uniforms:is(on.background.uniforms),vertexShader:on.background.vertexShader,fragmentShader:on.background.fragmentShader,side:Wn,depthTest:!1,depthWrite:!1,fog:!1})),l.geometry.deleteAttribute("normal"),Object.defineProperty(l.material,"map",{get:function(){return this.uniforms.t2D.value}}),i.update(l)),l.material.uniforms.t2D.value=x,l.material.uniforms.backgroundIntensity.value=p.backgroundIntensity,l.material.toneMapped=jt.getTransfer(x.colorSpace)!==se,x.matrixAutoUpdate===!0&&x.updateMatrix(),l.material.uniforms.uvTransform.value.copy(x.matrix),(u!==x||d!==x.version||f!==r.toneMapping)&&(l.material.needsUpdate=!0,u=x,d=x.version,f=r.toneMapping),l.layers.enableAll(),g.unshift(l,l.geometry,l.material,0,0,null))}function _(g,p){g.getRGB(gr,Hd(r)),n.buffers.color.setClear(gr.r,gr.g,gr.b,p,a)}return{getClearColor:function(){return o},setClearColor:function(g,p=1){o.set(g),c=p,_(o,c)},getClearAlpha:function(){return c},setClearAlpha:function(g){c=g,_(o,c)},render:m}}function R_(r,t,e,n){let i=r.getParameter(r.MAX_VERTEX_ATTRIBS),s=n.isWebGL2?null:t.get("OES_vertex_array_object"),a=n.isWebGL2||s!==null,o={},c=g(null),l=c,h=!1;function u(I,F,k,J,Y){let W=!1;if(a){let tt=_(J,k,F);l!==tt&&(l=tt,f(l.object)),W=p(I,J,k,Y),W&&v(I,J,k,Y)}else{let tt=F.wireframe===!0;(l.geometry!==J.id||l.program!==k.id||l.wireframe!==tt)&&(l.geometry=J.id,l.program=k.id,l.wireframe=tt,W=!0)}Y!==null&&e.update(Y,r.ELEMENT_ARRAY_BUFFER),(W||h)&&(h=!1,U(I,F,k,J),Y!==null&&r.bindBuffer(r.ELEMENT_ARRAY_BUFFER,e.get(Y).buffer))}function d(){return n.isWebGL2?r.createVertexArray():s.createVertexArrayOES()}function f(I){return n.isWebGL2?r.bindVertexArray(I):s.bindVertexArrayOES(I)}function m(I){return n.isWebGL2?r.deleteVertexArray(I):s.deleteVertexArrayOES(I)}function _(I,F,k){let J=k.wireframe===!0,Y=o[I.id];Y===void 0&&(Y={},o[I.id]=Y);let W=Y[F.id];W===void 0&&(W={},Y[F.id]=W);let tt=W[J];return tt===void 0&&(tt=g(d()),W[J]=tt),tt}function g(I){let F=[],k=[],J=[];for(let Y=0;Y<i;Y++)F[Y]=0,k[Y]=0,J[Y]=0;return{geometry:null,program:null,wireframe:!1,newAttributes:F,enabledAttributes:k,attributeDivisors:J,object:I,attributes:{},index:null}}function p(I,F,k,J){let Y=l.attributes,W=F.attributes,tt=0,et=k.getAttributes();for(let ut in et)if(et[ut].location>=0){let K=Y[ut],dt=W[ut];if(dt===void 0&&(ut==="instanceMatrix"&&I.instanceMatrix&&(dt=I.instanceMatrix),ut==="instanceColor"&&I.instanceColor&&(dt=I.instanceColor)),K===void 0||K.attribute!==dt||dt&&K.data!==dt.data)return!0;tt++}return l.attributesNum!==tt||l.index!==J}function v(I,F,k,J){let Y={},W=F.attributes,tt=0,et=k.getAttributes();for(let ut in et)if(et[ut].location>=0){let K=W[ut];K===void 0&&(ut==="instanceMatrix"&&I.instanceMatrix&&(K=I.instanceMatrix),ut==="instanceColor"&&I.instanceColor&&(K=I.instanceColor));let dt={};dt.attribute=K,K&&K.data&&(dt.data=K.data),Y[ut]=dt,tt++}l.attributes=Y,l.attributesNum=tt,l.index=J}function x(){let I=l.newAttributes;for(let F=0,k=I.length;F<k;F++)I[F]=0}function y(I){C(I,0)}function C(I,F){let k=l.newAttributes,J=l.enabledAttributes,Y=l.attributeDivisors;k[I]=1,J[I]===0&&(r.enableVertexAttribArray(I),J[I]=1),Y[I]!==F&&((n.isWebGL2?r:t.get("ANGLE_instanced_arrays"))[n.isWebGL2?"vertexAttribDivisor":"vertexAttribDivisorANGLE"](I,F),Y[I]=F)}function T(){let I=l.newAttributes,F=l.enabledAttributes;for(let k=0,J=F.length;k<J;k++)F[k]!==I[k]&&(r.disableVertexAttribArray(k),F[k]=0)}function R(I,F,k,J,Y,W,tt){tt===!0?r.vertexAttribIPointer(I,F,k,Y,W):r.vertexAttribPointer(I,F,k,J,Y,W)}function U(I,F,k,J){if(n.isWebGL2===!1&&(I.isInstancedMesh||J.isInstancedBufferGeometry)&&t.get("ANGLE_instanced_arrays")===null)return;x();let Y=J.attributes,W=k.getAttributes(),tt=F.defaultAttributeValues;for(let et in W){let ut=W[et];if(ut.location>=0){let H=Y[et];if(H===void 0&&(et==="instanceMatrix"&&I.instanceMatrix&&(H=I.instanceMatrix),et==="instanceColor"&&I.instanceColor&&(H=I.instanceColor)),H!==void 0){let K=H.normalized,dt=H.itemSize,Mt=e.get(H);if(Mt===void 0)continue;let gt=Mt.buffer,Ct=Mt.type,Nt=Mt.bytesPerElement,St=n.isWebGL2===!0&&(Ct===r.INT||Ct===r.UNSIGNED_INT||H.gpuType===Pd);if(H.isInterleavedBufferAttribute){let Ut=H.data,P=Ut.stride,rt=H.offset;if(Ut.isInstancedInterleavedBuffer){for(let q=0;q<ut.locationSize;q++)C(ut.location+q,Ut.meshPerAttribute);I.isInstancedMesh!==!0&&J._maxInstanceCount===void 0&&(J._maxInstanceCount=Ut.meshPerAttribute*Ut.count)}else for(let q=0;q<ut.locationSize;q++)y(ut.location+q);r.bindBuffer(r.ARRAY_BUFFER,gt);for(let q=0;q<ut.locationSize;q++)R(ut.location+q,dt/ut.locationSize,Ct,K,P*Nt,(rt+dt/ut.locationSize*q)*Nt,St)}else{if(H.isInstancedBufferAttribute){for(let Ut=0;Ut<ut.locationSize;Ut++)C(ut.location+Ut,H.meshPerAttribute);I.isInstancedMesh!==!0&&J._maxInstanceCount===void 0&&(J._maxInstanceCount=H.meshPerAttribute*H.count)}else for(let Ut=0;Ut<ut.locationSize;Ut++)y(ut.location+Ut);r.bindBuffer(r.ARRAY_BUFFER,gt);for(let Ut=0;Ut<ut.locationSize;Ut++)R(ut.location+Ut,dt/ut.locationSize,Ct,K,dt*Nt,dt/ut.locationSize*Ut*Nt,St)}}else if(tt!==void 0){let K=tt[et];if(K!==void 0)switch(K.length){case 2:r.vertexAttrib2fv(ut.location,K);break;case 3:r.vertexAttrib3fv(ut.location,K);break;case 4:r.vertexAttrib4fv(ut.location,K);break;default:r.vertexAttrib1fv(ut.location,K)}}}}T()}function S(){G();for(let I in o){let F=o[I];for(let k in F){let J=F[k];for(let Y in J)m(J[Y].object),delete J[Y];delete F[k]}delete o[I]}}function E(I){if(o[I.id]===void 0)return;let F=o[I.id];for(let k in F){let J=F[k];for(let Y in J)m(J[Y].object),delete J[Y];delete F[k]}delete o[I.id]}function N(I){for(let F in o){let k=o[F];if(k[I.id]===void 0)continue;let J=k[I.id];for(let Y in J)m(J[Y].object),delete J[Y];delete k[I.id]}}function G(){it(),h=!0,l!==c&&(l=c,f(l.object))}function it(){c.geometry=null,c.program=null,c.wireframe=!1}return{setup:u,reset:G,resetDefaultState:it,dispose:S,releaseStatesOfGeometry:E,releaseStatesOfProgram:N,initAttributes:x,enableAttribute:y,disableUnusedAttributes:T}}function C_(r,t,e,n){let i=n.isWebGL2,s;function a(h){s=h}function o(h,u){r.drawArrays(s,h,u),e.update(u,s,1)}function c(h,u,d){if(d===0)return;let f,m;if(i)f=r,m="drawArraysInstanced";else if(f=t.get("ANGLE_instanced_arrays"),m="drawArraysInstancedANGLE",f===null){console.error("THREE.WebGLBufferRenderer: using THREE.InstancedBufferGeometry but hardware does not support extension ANGLE_instanced_arrays.");return}f[m](s,h,u,d),e.update(u,s,d)}function l(h,u,d){if(d===0)return;let f=t.get("WEBGL_multi_draw");if(f===null)for(let m=0;m<d;m++)this.render(h[m],u[m]);else{f.multiDrawArraysWEBGL(s,h,0,u,0,d);let m=0;for(let _=0;_<d;_++)m+=u[_];e.update(m,s,1)}}this.setMode=a,this.render=o,this.renderInstances=c,this.renderMultiDraw=l}function P_(r,t,e){let n;function i(){if(n!==void 0)return n;if(t.has("EXT_texture_filter_anisotropic")===!0){let R=t.get("EXT_texture_filter_anisotropic");n=r.getParameter(R.MAX_TEXTURE_MAX_ANISOTROPY_EXT)}else n=0;return n}function s(R){if(R==="highp"){if(r.getShaderPrecisionFormat(r.VERTEX_SHADER,r.HIGH_FLOAT).precision>0&&r.getShaderPrecisionFormat(r.FRAGMENT_SHADER,r.HIGH_FLOAT).precision>0)return"highp";R="mediump"}return R==="mediump"&&r.getShaderPrecisionFormat(r.VERTEX_SHADER,r.MEDIUM_FLOAT).precision>0&&r.getShaderPrecisionFormat(r.FRAGMENT_SHADER,r.MEDIUM_FLOAT).precision>0?"mediump":"lowp"}let a=typeof WebGL2RenderingContext<"u"&&r.constructor.name==="WebGL2RenderingContext",o=e.precision!==void 0?e.precision:"highp",c=s(o);c!==o&&(console.warn("THREE.WebGLRenderer:",o,"not supported, using",c,"instead."),o=c);let l=a||t.has("WEBGL_draw_buffers"),h=e.logarithmicDepthBuffer===!0,u=r.getParameter(r.MAX_TEXTURE_IMAGE_UNITS),d=r.getParameter(r.MAX_VERTEX_TEXTURE_IMAGE_UNITS),f=r.getParameter(r.MAX_TEXTURE_SIZE),m=r.getParameter(r.MAX_CUBE_MAP_TEXTURE_SIZE),_=r.getParameter(r.MAX_VERTEX_ATTRIBS),g=r.getParameter(r.MAX_VERTEX_UNIFORM_VECTORS),p=r.getParameter(r.MAX_VARYING_VECTORS),v=r.getParameter(r.MAX_FRAGMENT_UNIFORM_VECTORS),x=d>0,y=a||t.has("OES_texture_float"),C=x&&y,T=a?r.getParameter(r.MAX_SAMPLES):0;return{isWebGL2:a,drawBuffers:l,getMaxAnisotropy:i,getMaxPrecision:s,precision:o,logarithmicDepthBuffer:h,maxTextures:u,maxVertexTextures:d,maxTextureSize:f,maxCubemapSize:m,maxAttributes:_,maxVertexUniforms:g,maxVaryings:p,maxFragmentUniforms:v,vertexTextures:x,floatFragmentTextures:y,floatVertexTextures:C,maxSamples:T}}function L_(r){let t=this,e=null,n=0,i=!1,s=!1,a=new yn,o=new Gt,c={value:null,needsUpdate:!1};this.uniform=c,this.numPlanes=0,this.numIntersection=0,this.init=function(u,d){let f=u.length!==0||d||n!==0||i;return i=d,n=u.length,f},this.beginShadows=function(){s=!0,h(null)},this.endShadows=function(){s=!1},this.setGlobalState=function(u,d){e=h(u,d,0)},this.setState=function(u,d,f){let m=u.clippingPlanes,_=u.clipIntersection,g=u.clipShadows,p=r.get(u);if(!i||m===null||m.length===0||s&&!g)s?h(null):l();else{let v=s?0:n,x=v*4,y=p.clippingState||null;c.value=y,y=h(m,d,x,f);for(let C=0;C!==x;++C)y[C]=e[C];p.clippingState=y,this.numIntersection=_?this.numPlanes:0,this.numPlanes+=v}};function l(){c.value!==e&&(c.value=e,c.needsUpdate=n>0),t.numPlanes=n,t.numIntersection=0}function h(u,d,f,m){let _=u!==null?u.length:0,g=null;if(_!==0){if(g=c.value,m!==!0||g===null){let p=f+_*4,v=d.matrixWorldInverse;o.getNormalMatrix(v),(g===null||g.length<p)&&(g=new Float32Array(p));for(let x=0,y=f;x!==_;++x,y+=4)a.copy(u[x]).applyMatrix4(v,o),a.normal.toArray(g,y),g[y+3]=a.constant}c.value=g,c.needsUpdate=!0}return t.numPlanes=_,t.numIntersection=0,g}}function I_(r){let t=new WeakMap;function e(a,o){return o===Wr?a.mapping=Xn:o===Xr&&(a.mapping=mi),a}function n(a){if(a&&a.isTexture){let o=a.mapping;if(o===Wr||o===Xr)if(t.has(a)){let c=t.get(a).texture;return e(c,a.mapping)}else{let c=a.image;if(c&&c.height>0){let l=new Do(c.height/2);return l.fromEquirectangularTexture(r,a),t.set(a,l),a.addEventListener("dispose",i),e(l.texture,a.mapping)}else return null}}return a}function i(a){let o=a.target;o.removeEventListener("dispose",i);let c=t.get(o);c!==void 0&&(t.delete(o),c.dispose())}function s(){t=new WeakMap}return{get:n,dispose:s}}var Bs=class extends Fs{constructor(t=-1,e=1,n=1,i=-1,s=.1,a=2e3){super(),this.isOrthographicCamera=!0,this.type="OrthographicCamera",this.zoom=1,this.view=null,this.left=t,this.right=e,this.top=n,this.bottom=i,this.near=s,this.far=a,this.updateProjectionMatrix()}copy(t,e){return super.copy(t,e),this.left=t.left,this.right=t.right,this.top=t.top,this.bottom=t.bottom,this.near=t.near,this.far=t.far,this.zoom=t.zoom,this.view=t.view===null?null:Object.assign({},t.view),this}setViewOffset(t,e,n,i,s,a){this.view===null&&(this.view={enabled:!0,fullWidth:1,fullHeight:1,offsetX:0,offsetY:0,width:1,height:1}),this.view.enabled=!0,this.view.fullWidth=t,this.view.fullHeight=e,this.view.offsetX=n,this.view.offsetY=i,this.view.width=s,this.view.height=a,this.updateProjectionMatrix()}clearViewOffset(){this.view!==null&&(this.view.enabled=!1),this.updateProjectionMatrix()}updateProjectionMatrix(){let t=(this.right-this.left)/(2*this.zoom),e=(this.top-this.bottom)/(2*this.zoom),n=(this.right+this.left)/2,i=(this.top+this.bottom)/2,s=n-t,a=n+t,o=i+e,c=i-e;if(this.view!==null&&this.view.enabled){let l=(this.right-this.left)/this.view.fullWidth/this.zoom,h=(this.top-this.bottom)/this.view.fullHeight/this.zoom;s+=l*this.view.offsetX,a=s+l*this.view.width,o-=h*this.view.offsetY,c=o-h*this.view.height}this.projectionMatrix.makeOrthographic(s,a,o,c,this.near,this.far,this.coordinateSystem),this.projectionMatrixInverse.copy(this.projectionMatrix).invert()}toJSON(t){let e=super.toJSON(t);return e.object.zoom=this.zoom,e.object.left=this.left,e.object.right=this.right,e.object.top=this.top,e.object.bottom=this.bottom,e.object.near=this.near,e.object.far=this.far,this.view!==null&&(e.object.view=Object.assign({},this.view)),e}},Zi=4,Rh=[.125,.215,.35,.446,.526,.582],ci=20,oo=new Bs,Ch=new pt,co=null,lo=0,ho=0,ai=(1+Math.sqrt(5))/2,Bi=1/ai,Ph=[new w(1,1,1),new w(-1,1,1),new w(1,1,-1),new w(-1,1,-1),new w(0,ai,Bi),new w(0,ai,-Bi),new w(Bi,0,ai),new w(-Bi,0,ai),new w(ai,Bi,0),new w(-ai,Bi,0)],ca=class{constructor(t){this._renderer=t,this._pingPongRenderTarget=null,this._lodMax=0,this._cubeSize=0,this._lodPlanes=[],this._sizeLods=[],this._sigmas=[],this._blurMaterial=null,this._cubemapMaterial=null,this._equirectMaterial=null,this._compileMaterial(this._blurMaterial)}fromScene(t,e=0,n=.1,i=100){co=this._renderer.getRenderTarget(),lo=this._renderer.getActiveCubeFace(),ho=this._renderer.getActiveMipmapLevel(),this._setSize(256);let s=this._allocateTargets();return s.depthBuffer=!0,this._sceneToCubeUV(t,n,i,s),e>0&&this._blur(s,0,0,e),this._applyPMREM(s),this._cleanup(s),s}fromEquirectangular(t,e=null){return this._fromTexture(t,e)}fromCubemap(t,e=null){return this._fromTexture(t,e)}compileCubemapShader(){this._cubemapMaterial===null&&(this._cubemapMaterial=Uh(),this._compileMaterial(this._cubemapMaterial))}compileEquirectangularShader(){this._equirectMaterial===null&&(this._equirectMaterial=Ih(),this._compileMaterial(this._equirectMaterial))}dispose(){this._dispose(),this._cubemapMaterial!==null&&this._cubemapMaterial.dispose(),this._equirectMaterial!==null&&this._equirectMaterial.dispose()}_setSize(t){this._lodMax=Math.floor(Math.log2(t)),this._cubeSize=Math.pow(2,this._lodMax)}_dispose(){this._blurMaterial!==null&&this._blurMaterial.dispose(),this._pingPongRenderTarget!==null&&this._pingPongRenderTarget.dispose();for(let t=0;t<this._lodPlanes.length;t++)this._lodPlanes[t].dispose()}_cleanup(t){this._renderer.setRenderTarget(co,lo,ho),t.scissorTest=!1,_r(t,0,0,t.width,t.height)}_fromTexture(t,e){t.mapping===Xn||t.mapping===mi?this._setSize(t.image.length===0?16:t.image[0].width||t.image[0].image.width):this._setSize(t.image.width/4),co=this._renderer.getRenderTarget(),lo=this._renderer.getActiveCubeFace(),ho=this._renderer.getActiveMipmapLevel();let n=e||this._allocateTargets();return this._textureToCubeUV(t,n),this._applyPMREM(n),this._cleanup(n),n}_allocateTargets(){let t=3*Math.max(this._cubeSize,112),e=4*this._cubeSize,n={magFilter:me,minFilter:me,generateMipmaps:!1,type:Is,format:qe,colorSpace:En,depthBuffer:!1},i=Lh(t,e,n);if(this._pingPongRenderTarget===null||this._pingPongRenderTarget.width!==t||this._pingPongRenderTarget.height!==e){this._pingPongRenderTarget!==null&&this._dispose(),this._pingPongRenderTarget=Lh(t,e,n);let{_lodMax:s}=this;({sizeLods:this._sizeLods,lodPlanes:this._lodPlanes,sigmas:this._sigmas}=U_(s)),this._blurMaterial=D_(s,t,e)}return i}_compileMaterial(t){let e=new ge(this._lodPlanes[0],t);this._renderer.compile(e,oo)}_sceneToCubeUV(t,e,n,i){let o=new be(90,1,e,n),c=[1,-1,1,1,1,1],l=[1,1,1,-1,-1,-1],h=this._renderer,u=h.autoClear,d=h.toneMapping;h.getClearColor(Ch),h.toneMapping=Vn,h.autoClear=!1;let f=new An({name:"PMREM.Background",side:He,depthWrite:!1,depthTest:!1}),m=new ge(new ns,f),_=!1,g=t.background;g?g.isColor&&(f.color.copy(g),t.background=null,_=!0):(f.color.copy(Ch),_=!0);for(let p=0;p<6;p++){let v=p%3;v===0?(o.up.set(0,c[p],0),o.lookAt(l[p],0,0)):v===1?(o.up.set(0,0,c[p]),o.lookAt(0,l[p],0)):(o.up.set(0,c[p],0),o.lookAt(0,0,l[p]));let x=this._cubeSize;_r(i,v*x,p>2?x:0,x,x),h.setRenderTarget(i),_&&h.render(m,o),h.render(t,o)}m.geometry.dispose(),m.material.dispose(),h.toneMapping=d,h.autoClear=u,t.background=g}_textureToCubeUV(t,e){let n=this._renderer,i=t.mapping===Xn||t.mapping===mi;i?(this._cubemapMaterial===null&&(this._cubemapMaterial=Uh()),this._cubemapMaterial.uniforms.flipEnvMap.value=t.isRenderTargetTexture===!1?-1:1):this._equirectMaterial===null&&(this._equirectMaterial=Ih());let s=i?this._cubemapMaterial:this._equirectMaterial,a=new ge(this._lodPlanes[0],s),o=s.uniforms;o.envMap.value=t;let c=this._cubeSize;_r(e,0,0,3*c,2*c),n.setRenderTarget(e),n.render(a,oo)}_applyPMREM(t){let e=this._renderer,n=e.autoClear;e.autoClear=!1;for(let i=1;i<this._lodPlanes.length;i++){let s=Math.sqrt(this._sigmas[i]*this._sigmas[i]-this._sigmas[i-1]*this._sigmas[i-1]),a=Ph[(i-1)%Ph.length];this._blur(t,i-1,i,s,a)}e.autoClear=n}_blur(t,e,n,i,s){let a=this._pingPongRenderTarget;this._halfBlur(t,a,e,n,i,"latitudinal",s),this._halfBlur(a,t,n,n,i,"longitudinal",s)}_halfBlur(t,e,n,i,s,a,o){let c=this._renderer,l=this._blurMaterial;a!=="latitudinal"&&a!=="longitudinal"&&console.error("blur direction must be either latitudinal or longitudinal!");let h=3,u=new ge(this._lodPlanes[i],l),d=l.uniforms,f=this._sizeLods[n]-1,m=isFinite(s)?Math.PI/(2*f):2*Math.PI/(2*ci-1),_=s/m,g=isFinite(s)?1+Math.floor(h*_):ci;g>ci&&console.warn(`sigmaRadians, ${s}, is too large and will clip, as it requested ${g} samples when the maximum is set to ${ci}`);let p=[],v=0;for(let R=0;R<ci;++R){let U=R/_,S=Math.exp(-U*U/2);p.push(S),R===0?v+=S:R<g&&(v+=2*S)}for(let R=0;R<p.length;R++)p[R]=p[R]/v;d.envMap.value=t.texture,d.samples.value=g,d.weights.value=p,d.latitudinal.value=a==="latitudinal",o&&(d.poleAxis.value=o);let{_lodMax:x}=this;d.dTheta.value=m,d.mipInt.value=x-n;let y=this._sizeLods[i],C=3*y*(i>x-Zi?i-x+Zi:0),T=4*(this._cubeSize-y);_r(e,C,T,3*y,2*y),c.setRenderTarget(e),c.render(u,oo)}};function U_(r){let t=[],e=[],n=[],i=r,s=r-Zi+1+Rh.length;for(let a=0;a<s;a++){let o=Math.pow(2,i);e.push(o);let c=1/o;a>r-Zi?c=Rh[a-r+Zi-1]:a===0&&(c=0),n.push(c);let l=1/(o-2),h=-l,u=1+l,d=[h,h,u,h,u,u,h,h,u,u,h,u],f=6,m=6,_=3,g=2,p=1,v=new Float32Array(_*m*f),x=new Float32Array(g*m*f),y=new Float32Array(p*m*f);for(let T=0;T<f;T++){let R=T%3*2/3-1,U=T>2?0:-1,S=[R,U,0,R+2/3,U,0,R+2/3,U+1,0,R,U,0,R+2/3,U+1,0,R,U+1,0];v.set(S,_*m*T),x.set(d,g*m*T);let E=[T,T,T,T,T,T];y.set(E,p*m*T)}let C=new Wt;C.setAttribute("position",new Jt(v,_)),C.setAttribute("uv",new Jt(x,g)),C.setAttribute("faceIndex",new Jt(y,p)),t.push(C),i>Zi&&i--}return{lodPlanes:t,sizeLods:e,sigmas:n}}function Lh(r,t,e){let n=new Ke(r,t,e);return n.texture.mapping=Ys,n.texture.name="PMREM.cubeUv",n.scissorTest=!0,n}function _r(r,t,e,n,i){r.viewport.set(t,e,n,i),r.scissor.set(t,e,n,i)}function D_(r,t,e){let n=new Float32Array(ci),i=new w(0,1,0);return new sn({name:"SphericalGaussianBlur",defines:{n:ci,CUBEUV_TEXEL_WIDTH:1/t,CUBEUV_TEXEL_HEIGHT:1/e,CUBEUV_MAX_MIP:`${r}.0`},uniforms:{envMap:{value:null},samples:{value:1},weights:{value:n},latitudinal:{value:!1},dTheta:{value:0},mipInt:{value:0},poleAxis:{value:i}},vertexShader:hl(),fragmentShader:`

			precision mediump float;
			precision mediump int;

			varying vec3 vOutputDirection;

			uniform sampler2D envMap;
			uniform int samples;
			uniform float weights[ n ];
			uniform bool latitudinal;
			uniform float dTheta;
			uniform float mipInt;
			uniform vec3 poleAxis;

			#define ENVMAP_TYPE_CUBE_UV
			#include <cube_uv_reflection_fragment>

			vec3 getSample( float theta, vec3 axis ) {

				float cosTheta = cos( theta );
				// Rodrigues' axis-angle rotation
				vec3 sampleDirection = vOutputDirection * cosTheta
					+ cross( axis, vOutputDirection ) * sin( theta )
					+ axis * dot( axis, vOutputDirection ) * ( 1.0 - cosTheta );

				return bilinearCubeUV( envMap, sampleDirection, mipInt );

			}

			void main() {

				vec3 axis = latitudinal ? poleAxis : cross( poleAxis, vOutputDirection );

				if ( all( equal( axis, vec3( 0.0 ) ) ) ) {

					axis = vec3( vOutputDirection.z, 0.0, - vOutputDirection.x );

				}

				axis = normalize( axis );

				gl_FragColor = vec4( 0.0, 0.0, 0.0, 1.0 );
				gl_FragColor.rgb += weights[ 0 ] * getSample( 0.0, axis );

				for ( int i = 1; i < n; i++ ) {

					if ( i >= samples ) {

						break;

					}

					float theta = dTheta * float( i );
					gl_FragColor.rgb += weights[ i ] * getSample( -1.0 * theta, axis );
					gl_FragColor.rgb += weights[ i ] * getSample( theta, axis );

				}

			}
		`,blending:zn,depthTest:!1,depthWrite:!1})}function Ih(){return new sn({name:"EquirectangularToCubeUV",uniforms:{envMap:{value:null}},vertexShader:hl(),fragmentShader:`

			precision mediump float;
			precision mediump int;

			varying vec3 vOutputDirection;

			uniform sampler2D envMap;

			#include <common>

			void main() {

				vec3 outputDirection = normalize( vOutputDirection );
				vec2 uv = equirectUv( outputDirection );

				gl_FragColor = vec4( texture2D ( envMap, uv ).rgb, 1.0 );

			}
		`,blending:zn,depthTest:!1,depthWrite:!1})}function Uh(){return new sn({name:"CubemapToCubeUV",uniforms:{envMap:{value:null},flipEnvMap:{value:-1}},vertexShader:hl(),fragmentShader:`

			precision mediump float;
			precision mediump int;

			uniform float flipEnvMap;

			varying vec3 vOutputDirection;

			uniform samplerCube envMap;

			void main() {

				gl_FragColor = textureCube( envMap, vec3( flipEnvMap * vOutputDirection.x, vOutputDirection.yz ) );

			}
		`,blending:zn,depthTest:!1,depthWrite:!1})}function hl(){return`

		precision mediump float;
		precision mediump int;

		attribute float faceIndex;

		varying vec3 vOutputDirection;

		// RH coordinate system; PMREM face-indexing convention
		vec3 getDirection( vec2 uv, float face ) {

			uv = 2.0 * uv - 1.0;

			vec3 direction = vec3( uv, 1.0 );

			if ( face == 0.0 ) {

				direction = direction.zyx; // ( 1, v, u ) pos x

			} else if ( face == 1.0 ) {

				direction = direction.xzy;
				direction.xz *= -1.0; // ( -u, 1, -v ) pos y

			} else if ( face == 2.0 ) {

				direction.x *= -1.0; // ( -u, v, 1 ) pos z

			} else if ( face == 3.0 ) {

				direction = direction.zyx;
				direction.xz *= -1.0; // ( -1, v, -u ) neg x

			} else if ( face == 4.0 ) {

				direction = direction.xzy;
				direction.xy *= -1.0; // ( -u, -1, v ) neg y

			} else if ( face == 5.0 ) {

				direction.z *= -1.0; // ( u, v, -1 ) neg z

			}

			return direction;

		}

		void main() {

			vOutputDirection = getDirection( uv, faceIndex );
			gl_Position = vec4( position, 1.0 );

		}
	`}function N_(r){let t=new WeakMap,e=null;function n(o){if(o&&o.isTexture){let c=o.mapping,l=c===Wr||c===Xr,h=c===Xn||c===mi;if(l||h)if(o.isRenderTargetTexture&&o.needsPMREMUpdate===!0){o.needsPMREMUpdate=!1;let u=t.get(o);return e===null&&(e=new ca(r)),u=l?e.fromEquirectangular(o,u):e.fromCubemap(o,u),t.set(o,u),u.texture}else{if(t.has(o))return t.get(o).texture;{let u=o.image;if(l&&u&&u.height>0||h&&u&&i(u)){e===null&&(e=new ca(r));let d=l?e.fromEquirectangular(o):e.fromCubemap(o);return t.set(o,d),o.addEventListener("dispose",s),d.texture}else return null}}}return o}function i(o){let c=0,l=6;for(let h=0;h<l;h++)o[h]!==void 0&&c++;return c===l}function s(o){let c=o.target;c.removeEventListener("dispose",s);let l=t.get(c);l!==void 0&&(t.delete(c),l.dispose())}function a(){t=new WeakMap,e!==null&&(e.dispose(),e=null)}return{get:n,dispose:a}}function O_(r){let t={};function e(n){if(t[n]!==void 0)return t[n];let i;switch(n){case"WEBGL_depth_texture":i=r.getExtension("WEBGL_depth_texture")||r.getExtension("MOZ_WEBGL_depth_texture")||r.getExtension("WEBKIT_WEBGL_depth_texture");break;case"EXT_texture_filter_anisotropic":i=r.getExtension("EXT_texture_filter_anisotropic")||r.getExtension("MOZ_EXT_texture_filter_anisotropic")||r.getExtension("WEBKIT_EXT_texture_filter_anisotropic");break;case"WEBGL_compressed_texture_s3tc":i=r.getExtension("WEBGL_compressed_texture_s3tc")||r.getExtension("MOZ_WEBGL_compressed_texture_s3tc")||r.getExtension("WEBKIT_WEBGL_compressed_texture_s3tc");break;case"WEBGL_compressed_texture_pvrtc":i=r.getExtension("WEBGL_compressed_texture_pvrtc")||r.getExtension("WEBKIT_WEBGL_compressed_texture_pvrtc");break;default:i=r.getExtension(n)}return t[n]=i,i}return{has:function(n){return e(n)!==null},init:function(n){n.isWebGL2?(e("EXT_color_buffer_float"),e("WEBGL_clip_cull_distance")):(e("WEBGL_depth_texture"),e("OES_texture_float"),e("OES_texture_half_float"),e("OES_texture_half_float_linear"),e("OES_standard_derivatives"),e("OES_element_index_uint"),e("OES_vertex_array_object"),e("ANGLE_instanced_arrays")),e("OES_texture_float_linear"),e("EXT_color_buffer_half_float"),e("WEBGL_multisampled_render_to_texture")},get:function(n){let i=e(n);return i===null&&console.warn("THREE.WebGLRenderer: "+n+" extension not supported."),i}}}function F_(r,t,e,n){let i={},s=new WeakMap;function a(u){let d=u.target;d.index!==null&&t.remove(d.index);for(let m in d.attributes)t.remove(d.attributes[m]);for(let m in d.morphAttributes){let _=d.morphAttributes[m];for(let g=0,p=_.length;g<p;g++)t.remove(_[g])}d.removeEventListener("dispose",a),delete i[d.id];let f=s.get(d);f&&(t.remove(f),s.delete(d)),n.releaseStatesOfGeometry(d),d.isInstancedBufferGeometry===!0&&delete d._maxInstanceCount,e.memory.geometries--}function o(u,d){return i[d.id]===!0||(d.addEventListener("dispose",a),i[d.id]=!0,e.memory.geometries++),d}function c(u){let d=u.attributes;for(let m in d)t.update(d[m],r.ARRAY_BUFFER);let f=u.morphAttributes;for(let m in f){let _=f[m];for(let g=0,p=_.length;g<p;g++)t.update(_[g],r.ARRAY_BUFFER)}}function l(u){let d=[],f=u.index,m=u.attributes.position,_=0;if(f!==null){let v=f.array;_=f.version;for(let x=0,y=v.length;x<y;x+=3){let C=v[x+0],T=v[x+1],R=v[x+2];d.push(C,T,T,R,R,C)}}else if(m!==void 0){let v=m.array;_=m.version;for(let x=0,y=v.length/3-1;x<y;x+=3){let C=x+0,T=x+1,R=x+2;d.push(C,T,T,R,R,C)}}else return;let g=new(Vd(d)?aa:ra)(d,1);g.version=_;let p=s.get(u);p&&t.remove(p),s.set(u,g)}function h(u){let d=s.get(u);if(d){let f=u.index;f!==null&&d.version<f.version&&l(u)}else l(u);return s.get(u)}return{get:o,update:c,getWireframeAttribute:h}}function B_(r,t,e,n){let i=n.isWebGL2,s;function a(f){s=f}let o,c;function l(f){o=f.type,c=f.bytesPerElement}function h(f,m){r.drawElements(s,m,o,f*c),e.update(m,s,1)}function u(f,m,_){if(_===0)return;let g,p;if(i)g=r,p="drawElementsInstanced";else if(g=t.get("ANGLE_instanced_arrays"),p="drawElementsInstancedANGLE",g===null){console.error("THREE.WebGLIndexedBufferRenderer: using THREE.InstancedBufferGeometry but hardware does not support extension ANGLE_instanced_arrays.");return}g[p](s,m,o,f*c,_),e.update(m,s,_)}function d(f,m,_){if(_===0)return;let g=t.get("WEBGL_multi_draw");if(g===null)for(let p=0;p<_;p++)this.render(f[p]/c,m[p]);else{g.multiDrawElementsWEBGL(s,m,0,o,f,0,_);let p=0;for(let v=0;v<_;v++)p+=m[v];e.update(p,s,1)}}this.setMode=a,this.setIndex=l,this.render=h,this.renderInstances=u,this.renderMultiDraw=d}function z_(r){let t={geometries:0,textures:0},e={frame:0,calls:0,triangles:0,points:0,lines:0};function n(s,a,o){switch(e.calls++,a){case r.TRIANGLES:e.triangles+=o*(s/3);break;case r.LINES:e.lines+=o*(s/2);break;case r.LINE_STRIP:e.lines+=o*(s-1);break;case r.LINE_LOOP:e.lines+=o*s;break;case r.POINTS:e.points+=o*s;break;default:console.error("THREE.WebGLInfo: Unknown draw mode:",a);break}}function i(){e.calls=0,e.triangles=0,e.points=0,e.lines=0}return{memory:t,render:e,programs:null,autoReset:!0,reset:i,update:n}}function V_(r,t){return r[0]-t[0]}function k_(r,t){return Math.abs(t[1])-Math.abs(r[1])}function H_(r,t,e){let n={},i=new Float32Array(8),s=new WeakMap,a=new te,o=[];for(let l=0;l<8;l++)o[l]=[l,0];function c(l,h,u){let d=l.morphTargetInfluences;if(t.isWebGL2===!0){let f=h.morphAttributes.position||h.morphAttributes.normal||h.morphAttributes.color,m=f!==void 0?f.length:0,_=s.get(h);if(_===void 0||_.count!==m){let I=function(){G.dispose(),s.delete(h),h.removeEventListener("dispose",I)};_!==void 0&&_.texture.dispose();let v=h.morphAttributes.position!==void 0,x=h.morphAttributes.normal!==void 0,y=h.morphAttributes.color!==void 0,C=h.morphAttributes.position||[],T=h.morphAttributes.normal||[],R=h.morphAttributes.color||[],U=0;v===!0&&(U=1),x===!0&&(U=2),y===!0&&(U=3);let S=h.attributes.position.count*U,E=1;S>t.maxTextureSize&&(E=Math.ceil(S/t.maxTextureSize),S=t.maxTextureSize);let N=new Float32Array(S*E*4*m),G=new Ns(N,S,E,m);G.type=cn,G.needsUpdate=!0;let it=U*4;for(let F=0;F<m;F++){let k=C[F],J=T[F],Y=R[F],W=S*E*4*F;for(let tt=0;tt<k.count;tt++){let et=tt*it;v===!0&&(a.fromBufferAttribute(k,tt),N[W+et+0]=a.x,N[W+et+1]=a.y,N[W+et+2]=a.z,N[W+et+3]=0),x===!0&&(a.fromBufferAttribute(J,tt),N[W+et+4]=a.x,N[W+et+5]=a.y,N[W+et+6]=a.z,N[W+et+7]=0),y===!0&&(a.fromBufferAttribute(Y,tt),N[W+et+8]=a.x,N[W+et+9]=a.y,N[W+et+10]=a.z,N[W+et+11]=Y.itemSize===4?a.w:1)}}_={count:m,texture:G,size:new Z(S,E)},s.set(h,_),h.addEventListener("dispose",I)}let g=0;for(let v=0;v<d.length;v++)g+=d[v];let p=h.morphTargetsRelative?1:1-g;u.getUniforms().setValue(r,"morphTargetBaseInfluence",p),u.getUniforms().setValue(r,"morphTargetInfluences",d),u.getUniforms().setValue(r,"morphTargetsTexture",_.texture,e),u.getUniforms().setValue(r,"morphTargetsTextureSize",_.size)}else{let f=d===void 0?0:d.length,m=n[h.id];if(m===void 0||m.length!==f){m=[];for(let x=0;x<f;x++)m[x]=[x,0];n[h.id]=m}for(let x=0;x<f;x++){let y=m[x];y[0]=x,y[1]=d[x]}m.sort(k_);for(let x=0;x<8;x++)x<f&&m[x][1]?(o[x][0]=m[x][0],o[x][1]=m[x][1]):(o[x][0]=Number.MAX_SAFE_INTEGER,o[x][1]=0);o.sort(V_);let _=h.morphAttributes.position,g=h.morphAttributes.normal,p=0;for(let x=0;x<8;x++){let y=o[x],C=y[0],T=y[1];C!==Number.MAX_SAFE_INTEGER&&T?(_&&h.getAttribute("morphTarget"+x)!==_[C]&&h.setAttribute("morphTarget"+x,_[C]),g&&h.getAttribute("morphNormal"+x)!==g[C]&&h.setAttribute("morphNormal"+x,g[C]),i[x]=T,p+=T):(_&&h.hasAttribute("morphTarget"+x)===!0&&h.deleteAttribute("morphTarget"+x),g&&h.hasAttribute("morphNormal"+x)===!0&&h.deleteAttribute("morphNormal"+x),i[x]=0)}let v=h.morphTargetsRelative?1:1-p;u.getUniforms().setValue(r,"morphTargetBaseInfluence",v),u.getUniforms().setValue(r,"morphTargetInfluences",i)}}return{update:c}}function G_(r,t,e,n){let i=new WeakMap;function s(c){let l=n.render.frame,h=c.geometry,u=t.get(c,h);if(i.get(u)!==l&&(t.update(u),i.set(u,l)),c.isInstancedMesh&&(c.hasEventListener("dispose",o)===!1&&c.addEventListener("dispose",o),i.get(c)!==l&&(e.update(c.instanceMatrix,r.ARRAY_BUFFER),c.instanceColor!==null&&e.update(c.instanceColor,r.ARRAY_BUFFER),i.set(c,l))),c.isSkinnedMesh){let d=c.skeleton;i.get(d)!==l&&(d.update(),i.set(d,l))}return u}function a(){i=new WeakMap}function o(c){let l=c.target;l.removeEventListener("dispose",o),e.remove(l.instanceMatrix),l.instanceColor!==null&&e.remove(l.instanceColor)}return{update:s,dispose:a}}var la=class extends Ee{constructor(t,e,n,i,s,a,o,c,l,h){if(h=h!==void 0?h:di,h!==di&&h!==ts)throw new Error("DepthTexture format must be either THREE.DepthFormat or THREE.DepthStencilFormat");n===void 0&&h===di&&(n=Nn),n===void 0&&h===ts&&(n=ui),super(null,i,s,a,o,c,h,n,l),this.isDepthTexture=!0,this.image={width:t,height:e},this.magFilter=o!==void 0?o:pe,this.minFilter=c!==void 0?c:pe,this.flipY=!1,this.generateMipmaps=!1,this.compareFunction=null}copy(t){return super.copy(t),this.compareFunction=t.compareFunction,this}toJSON(t){let e=super.toJSON(t);return this.compareFunction!==null&&(e.compareFunction=this.compareFunction),e}},Wd=new Ee,Xd=new la(1,1);Xd.compareFunction=zd;var qd=new Ns,Yd=new ia,Zd=new ss,Dh=[],Nh=[],Oh=new Float32Array(16),Fh=new Float32Array(9),Bh=new Float32Array(4);function fs(r,t,e){let n=r[0];if(n<=0||n>0)return r;let i=t*e,s=Dh[i];if(s===void 0&&(s=new Float32Array(i),Dh[i]=s),t!==0){n.toArray(s,0);for(let a=1,o=0;a!==t;++a)o+=e,r[a].toArray(s,o)}return s}function _e(r,t){if(r.length!==t.length)return!1;for(let e=0,n=r.length;e<n;e++)if(r[e]!==t[e])return!1;return!0}function xe(r,t){for(let e=0,n=t.length;e<n;e++)r[e]=t[e]}function Ia(r,t){let e=Nh[t];e===void 0&&(e=new Int32Array(t),Nh[t]=e);for(let n=0;n!==t;++n)e[n]=r.allocateTextureUnit();return e}function W_(r,t){let e=this.cache;e[0]!==t&&(r.uniform1f(this.addr,t),e[0]=t)}function X_(r,t){let e=this.cache;if(t.x!==void 0)(e[0]!==t.x||e[1]!==t.y)&&(r.uniform2f(this.addr,t.x,t.y),e[0]=t.x,e[1]=t.y);else{if(_e(e,t))return;r.uniform2fv(this.addr,t),xe(e,t)}}function q_(r,t){let e=this.cache;if(t.x!==void 0)(e[0]!==t.x||e[1]!==t.y||e[2]!==t.z)&&(r.uniform3f(this.addr,t.x,t.y,t.z),e[0]=t.x,e[1]=t.y,e[2]=t.z);else if(t.r!==void 0)(e[0]!==t.r||e[1]!==t.g||e[2]!==t.b)&&(r.uniform3f(this.addr,t.r,t.g,t.b),e[0]=t.r,e[1]=t.g,e[2]=t.b);else{if(_e(e,t))return;r.uniform3fv(this.addr,t),xe(e,t)}}function Y_(r,t){let e=this.cache;if(t.x!==void 0)(e[0]!==t.x||e[1]!==t.y||e[2]!==t.z||e[3]!==t.w)&&(r.uniform4f(this.addr,t.x,t.y,t.z,t.w),e[0]=t.x,e[1]=t.y,e[2]=t.z,e[3]=t.w);else{if(_e(e,t))return;r.uniform4fv(this.addr,t),xe(e,t)}}function Z_(r,t){let e=this.cache,n=t.elements;if(n===void 0){if(_e(e,t))return;r.uniformMatrix2fv(this.addr,!1,t),xe(e,t)}else{if(_e(e,n))return;Bh.set(n),r.uniformMatrix2fv(this.addr,!1,Bh),xe(e,n)}}function J_(r,t){let e=this.cache,n=t.elements;if(n===void 0){if(_e(e,t))return;r.uniformMatrix3fv(this.addr,!1,t),xe(e,t)}else{if(_e(e,n))return;Fh.set(n),r.uniformMatrix3fv(this.addr,!1,Fh),xe(e,n)}}function $_(r,t){let e=this.cache,n=t.elements;if(n===void 0){if(_e(e,t))return;r.uniformMatrix4fv(this.addr,!1,t),xe(e,t)}else{if(_e(e,n))return;Oh.set(n),r.uniformMatrix4fv(this.addr,!1,Oh),xe(e,n)}}function K_(r,t){let e=this.cache;e[0]!==t&&(r.uniform1i(this.addr,t),e[0]=t)}function Q_(r,t){let e=this.cache;if(t.x!==void 0)(e[0]!==t.x||e[1]!==t.y)&&(r.uniform2i(this.addr,t.x,t.y),e[0]=t.x,e[1]=t.y);else{if(_e(e,t))return;r.uniform2iv(this.addr,t),xe(e,t)}}function j_(r,t){let e=this.cache;if(t.x!==void 0)(e[0]!==t.x||e[1]!==t.y||e[2]!==t.z)&&(r.uniform3i(this.addr,t.x,t.y,t.z),e[0]=t.x,e[1]=t.y,e[2]=t.z);else{if(_e(e,t))return;r.uniform3iv(this.addr,t),xe(e,t)}}function t0(r,t){let e=this.cache;if(t.x!==void 0)(e[0]!==t.x||e[1]!==t.y||e[2]!==t.z||e[3]!==t.w)&&(r.uniform4i(this.addr,t.x,t.y,t.z,t.w),e[0]=t.x,e[1]=t.y,e[2]=t.z,e[3]=t.w);else{if(_e(e,t))return;r.uniform4iv(this.addr,t),xe(e,t)}}function e0(r,t){let e=this.cache;e[0]!==t&&(r.uniform1ui(this.addr,t),e[0]=t)}function n0(r,t){let e=this.cache;if(t.x!==void 0)(e[0]!==t.x||e[1]!==t.y)&&(r.uniform2ui(this.addr,t.x,t.y),e[0]=t.x,e[1]=t.y);else{if(_e(e,t))return;r.uniform2uiv(this.addr,t),xe(e,t)}}function i0(r,t){let e=this.cache;if(t.x!==void 0)(e[0]!==t.x||e[1]!==t.y||e[2]!==t.z)&&(r.uniform3ui(this.addr,t.x,t.y,t.z),e[0]=t.x,e[1]=t.y,e[2]=t.z);else{if(_e(e,t))return;r.uniform3uiv(this.addr,t),xe(e,t)}}function s0(r,t){let e=this.cache;if(t.x!==void 0)(e[0]!==t.x||e[1]!==t.y||e[2]!==t.z||e[3]!==t.w)&&(r.uniform4ui(this.addr,t.x,t.y,t.z,t.w),e[0]=t.x,e[1]=t.y,e[2]=t.z,e[3]=t.w);else{if(_e(e,t))return;r.uniform4uiv(this.addr,t),xe(e,t)}}function r0(r,t,e){let n=this.cache,i=e.allocateTextureUnit();n[0]!==i&&(r.uniform1i(this.addr,i),n[0]=i);let s=this.type===r.SAMPLER_2D_SHADOW?Xd:Wd;e.setTexture2D(t||s,i)}function a0(r,t,e){let n=this.cache,i=e.allocateTextureUnit();n[0]!==i&&(r.uniform1i(this.addr,i),n[0]=i),e.setTexture3D(t||Yd,i)}function o0(r,t,e){let n=this.cache,i=e.allocateTextureUnit();n[0]!==i&&(r.uniform1i(this.addr,i),n[0]=i),e.setTextureCube(t||Zd,i)}function c0(r,t,e){let n=this.cache,i=e.allocateTextureUnit();n[0]!==i&&(r.uniform1i(this.addr,i),n[0]=i),e.setTexture2DArray(t||qd,i)}function l0(r){switch(r){case 5126:return W_;case 35664:return X_;case 35665:return q_;case 35666:return Y_;case 35674:return Z_;case 35675:return J_;case 35676:return $_;case 5124:case 35670:return K_;case 35667:case 35671:return Q_;case 35668:case 35672:return j_;case 35669:case 35673:return t0;case 5125:return e0;case 36294:return n0;case 36295:return i0;case 36296:return s0;case 35678:case 36198:case 36298:case 36306:case 35682:return r0;case 35679:case 36299:case 36307:return a0;case 35680:case 36300:case 36308:case 36293:return o0;case 36289:case 36303:case 36311:case 36292:return c0}}function h0(r,t){r.uniform1fv(this.addr,t)}function u0(r,t){let e=fs(t,this.size,2);r.uniform2fv(this.addr,e)}function d0(r,t){let e=fs(t,this.size,3);r.uniform3fv(this.addr,e)}function f0(r,t){let e=fs(t,this.size,4);r.uniform4fv(this.addr,e)}function p0(r,t){let e=fs(t,this.size,4);r.uniformMatrix2fv(this.addr,!1,e)}function m0(r,t){let e=fs(t,this.size,9);r.uniformMatrix3fv(this.addr,!1,e)}function g0(r,t){let e=fs(t,this.size,16);r.uniformMatrix4fv(this.addr,!1,e)}function _0(r,t){r.uniform1iv(this.addr,t)}function x0(r,t){r.uniform2iv(this.addr,t)}function v0(r,t){r.uniform3iv(this.addr,t)}function y0(r,t){r.uniform4iv(this.addr,t)}function M0(r,t){r.uniform1uiv(this.addr,t)}function S0(r,t){r.uniform2uiv(this.addr,t)}function b0(r,t){r.uniform3uiv(this.addr,t)}function E0(r,t){r.uniform4uiv(this.addr,t)}function A0(r,t,e){let n=this.cache,i=t.length,s=Ia(e,i);_e(n,s)||(r.uniform1iv(this.addr,s),xe(n,s));for(let a=0;a!==i;++a)e.setTexture2D(t[a]||Wd,s[a])}function T0(r,t,e){let n=this.cache,i=t.length,s=Ia(e,i);_e(n,s)||(r.uniform1iv(this.addr,s),xe(n,s));for(let a=0;a!==i;++a)e.setTexture3D(t[a]||Yd,s[a])}function w0(r,t,e){let n=this.cache,i=t.length,s=Ia(e,i);_e(n,s)||(r.uniform1iv(this.addr,s),xe(n,s));for(let a=0;a!==i;++a)e.setTextureCube(t[a]||Zd,s[a])}function R0(r,t,e){let n=this.cache,i=t.length,s=Ia(e,i);_e(n,s)||(r.uniform1iv(this.addr,s),xe(n,s));for(let a=0;a!==i;++a)e.setTexture2DArray(t[a]||qd,s[a])}function C0(r){switch(r){case 5126:return h0;case 35664:return u0;case 35665:return d0;case 35666:return f0;case 35674:return p0;case 35675:return m0;case 35676:return g0;case 5124:case 35670:return _0;case 35667:case 35671:return x0;case 35668:case 35672:return v0;case 35669:case 35673:return y0;case 5125:return M0;case 36294:return S0;case 36295:return b0;case 36296:return E0;case 35678:case 36198:case 36298:case 36306:case 35682:return A0;case 35679:case 36299:case 36307:return T0;case 35680:case 36300:case 36308:case 36293:return w0;case 36289:case 36303:case 36311:case 36292:return R0}}var No=class{constructor(t,e,n){this.id=t,this.addr=n,this.cache=[],this.type=e.type,this.setValue=l0(e.type)}},Oo=class{constructor(t,e,n){this.id=t,this.addr=n,this.cache=[],this.type=e.type,this.size=e.size,this.setValue=C0(e.type)}},Fo=class{constructor(t){this.id=t,this.seq=[],this.map={}}setValue(t,e,n){let i=this.seq;for(let s=0,a=i.length;s!==a;++s){let o=i[s];o.setValue(t,e[o.id],n)}}},uo=/(\w+)(\])?(\[|\.)?/g;function zh(r,t){r.seq.push(t),r.map[t.id]=t}function P0(r,t,e){let n=r.name,i=n.length;for(uo.lastIndex=0;;){let s=uo.exec(n),a=uo.lastIndex,o=s[1],c=s[2]==="]",l=s[3];if(c&&(o=o|0),l===void 0||l==="["&&a+2===i){zh(e,l===void 0?new No(o,r,t):new Oo(o,r,t));break}else{let u=e.map[o];u===void 0&&(u=new Fo(o),zh(e,u)),e=u}}}var ji=class{constructor(t,e){this.seq=[],this.map={};let n=t.getProgramParameter(e,t.ACTIVE_UNIFORMS);for(let i=0;i<n;++i){let s=t.getActiveUniform(e,i),a=t.getUniformLocation(e,s.name);P0(s,a,this)}}setValue(t,e,n,i){let s=this.map[e];s!==void 0&&s.setValue(t,n,i)}setOptional(t,e,n){let i=e[n];i!==void 0&&this.setValue(t,n,i)}static upload(t,e,n,i){for(let s=0,a=e.length;s!==a;++s){let o=e[s],c=n[o.id];c.needsUpdate!==!1&&o.setValue(t,c.value,i)}}static seqWithValue(t,e){let n=[];for(let i=0,s=t.length;i!==s;++i){let a=t[i];a.id in e&&n.push(a)}return n}};function Vh(r,t,e){let n=r.createShader(t);return r.shaderSource(n,e),r.compileShader(n),n}var L0=37297,I0=0;function U0(r,t){let e=r.split(`
`),n=[],i=Math.max(t-6,0),s=Math.min(t+6,e.length);for(let a=i;a<s;a++){let o=a+1;n.push(`${o===t?">":" "} ${o}: ${e[a]}`)}return n.join(`
`)}function D0(r){let t=jt.getPrimaries(jt.workingColorSpace),e=jt.getPrimaries(r),n;switch(t===e?n="":t===jr&&e===Qr?n="LinearDisplayP3ToLinearSRGB":t===Qr&&e===jr&&(n="LinearSRGBToLinearDisplayP3"),r){case En:case La:return[n,"LinearTransferOETF"];case Se:case cl:return[n,"sRGBTransferOETF"];default:return console.warn("THREE.WebGLProgram: Unsupported color space:",r),[n,"LinearTransferOETF"]}}function kh(r,t,e){let n=r.getShaderParameter(t,r.COMPILE_STATUS),i=r.getShaderInfoLog(t).trim();if(n&&i==="")return"";let s=/ERROR: 0:(\d+)/.exec(i);if(s){let a=parseInt(s[1]);return e.toUpperCase()+`

`+i+`

`+U0(r.getShaderSource(t),a)}else return i}function N0(r,t){let e=D0(t);return`vec4 ${r}( vec4 value ) { return ${e[0]}( ${e[1]}( value ) ); }`}function O0(r,t){let e;switch(t){case Of:e="Linear";break;case Ff:e="Reinhard";break;case Bf:e="OptimizedCineon";break;case zf:e="ACESFilmic";break;case kf:e="AgX";break;case Vf:e="Custom";break;default:console.warn("THREE.WebGLProgram: Unsupported toneMapping:",t),e="Linear"}return"vec3 "+r+"( vec3 color ) { return "+e+"ToneMapping( color ); }"}function F0(r){return[r.extensionDerivatives||r.envMapCubeUVHeight||r.bumpMap||r.normalMapTangentSpace||r.clearcoatNormalMap||r.flatShading||r.shaderID==="physical"?"#extension GL_OES_standard_derivatives : enable":"",(r.extensionFragDepth||r.logarithmicDepthBuffer)&&r.rendererExtensionFragDepth?"#extension GL_EXT_frag_depth : enable":"",r.extensionDrawBuffers&&r.rendererExtensionDrawBuffers?"#extension GL_EXT_draw_buffers : require":"",(r.extensionShaderTextureLOD||r.envMap||r.transmission)&&r.rendererExtensionShaderTextureLod?"#extension GL_EXT_shader_texture_lod : enable":""].filter(Ji).join(`
`)}function B0(r){return[r.extensionClipCullDistance?"#extension GL_ANGLE_clip_cull_distance : require":""].filter(Ji).join(`
`)}function z0(r){let t=[];for(let e in r){let n=r[e];n!==!1&&t.push("#define "+e+" "+n)}return t.join(`
`)}function V0(r,t){let e={},n=r.getProgramParameter(t,r.ACTIVE_ATTRIBUTES);for(let i=0;i<n;i++){let s=r.getActiveAttrib(t,i),a=s.name,o=1;s.type===r.FLOAT_MAT2&&(o=2),s.type===r.FLOAT_MAT3&&(o=3),s.type===r.FLOAT_MAT4&&(o=4),e[a]={type:s.type,location:r.getAttribLocation(t,a),locationSize:o}}return e}function Ji(r){return r!==""}function Hh(r,t){let e=t.numSpotLightShadows+t.numSpotLightMaps-t.numSpotLightShadowsWithMaps;return r.replace(/NUM_DIR_LIGHTS/g,t.numDirLights).replace(/NUM_SPOT_LIGHTS/g,t.numSpotLights).replace(/NUM_SPOT_LIGHT_MAPS/g,t.numSpotLightMaps).replace(/NUM_SPOT_LIGHT_COORDS/g,e).replace(/NUM_RECT_AREA_LIGHTS/g,t.numRectAreaLights).replace(/NUM_POINT_LIGHTS/g,t.numPointLights).replace(/NUM_HEMI_LIGHTS/g,t.numHemiLights).replace(/NUM_DIR_LIGHT_SHADOWS/g,t.numDirLightShadows).replace(/NUM_SPOT_LIGHT_SHADOWS_WITH_MAPS/g,t.numSpotLightShadowsWithMaps).replace(/NUM_SPOT_LIGHT_SHADOWS/g,t.numSpotLightShadows).replace(/NUM_POINT_LIGHT_SHADOWS/g,t.numPointLightShadows)}function Gh(r,t){return r.replace(/NUM_CLIPPING_PLANES/g,t.numClippingPlanes).replace(/UNION_CLIPPING_PLANES/g,t.numClippingPlanes-t.numClipIntersection)}var k0=/^[ \t]*#include +<([\w\d./]+)>/gm;function Bo(r){return r.replace(k0,G0)}var H0=new Map([["encodings_fragment","colorspace_fragment"],["encodings_pars_fragment","colorspace_pars_fragment"],["output_fragment","opaque_fragment"]]);function G0(r,t){let e=kt[t];if(e===void 0){let n=H0.get(t);if(n!==void 0)e=kt[n],console.warn('THREE.WebGLRenderer: Shader chunk "%s" has been deprecated. Use "%s" instead.',t,n);else throw new Error("Can not resolve #include <"+t+">")}return Bo(e)}var W0=/#pragma unroll_loop_start\s+for\s*\(\s*int\s+i\s*=\s*(\d+)\s*;\s*i\s*<\s*(\d+)\s*;\s*i\s*\+\+\s*\)\s*{([\s\S]+?)}\s+#pragma unroll_loop_end/g;function Wh(r){return r.replace(W0,X0)}function X0(r,t,e,n){let i="";for(let s=parseInt(t);s<parseInt(e);s++)i+=n.replace(/\[\s*i\s*\]/g,"[ "+s+" ]").replace(/UNROLLED_LOOP_INDEX/g,s);return i}function Xh(r){let t="precision "+r.precision+` float;
precision `+r.precision+" int;";return r.precision==="highp"?t+=`
#define HIGH_PRECISION`:r.precision==="mediump"?t+=`
#define MEDIUM_PRECISION`:r.precision==="lowp"&&(t+=`
#define LOW_PRECISION`),t}function q0(r){let t="SHADOWMAP_TYPE_BASIC";return r.shadowMapType===Rd?t="SHADOWMAP_TYPE_PCF":r.shadowMapType===hf?t="SHADOWMAP_TYPE_PCF_SOFT":r.shadowMapType===vn&&(t="SHADOWMAP_TYPE_VSM"),t}function Y0(r){let t="ENVMAP_TYPE_CUBE";if(r.envMap)switch(r.envMapMode){case Xn:case mi:t="ENVMAP_TYPE_CUBE";break;case Ys:t="ENVMAP_TYPE_CUBE_UV";break}return t}function Z0(r){let t="ENVMAP_MODE_REFLECTION";return r.envMap&&r.envMapMode===mi&&(t="ENVMAP_MODE_REFRACTION"),t}function J0(r){let t="ENVMAP_BLENDING_NONE";if(r.envMap)switch(r.combine){case Pa:t="ENVMAP_BLENDING_MULTIPLY";break;case Df:t="ENVMAP_BLENDING_MIX";break;case Nf:t="ENVMAP_BLENDING_ADD";break}return t}function $0(r){let t=r.envMapCubeUVHeight;if(t===null)return null;let e=Math.log2(t)-2,n=1/t;return{texelWidth:1/(3*Math.max(Math.pow(2,e),112)),texelHeight:n,maxMip:e}}function K0(r,t,e,n){let i=r.getContext(),s=e.defines,a=e.vertexShader,o=e.fragmentShader,c=q0(e),l=Y0(e),h=Z0(e),u=J0(e),d=$0(e),f=e.isWebGL2?"":F0(e),m=B0(e),_=z0(s),g=i.createProgram(),p,v,x=e.glslVersion?"#version "+e.glslVersion+`
`:"";e.isRawShaderMaterial?(p=["#define SHADER_TYPE "+e.shaderType,"#define SHADER_NAME "+e.shaderName,_].filter(Ji).join(`
`),p.length>0&&(p+=`
`),v=[f,"#define SHADER_TYPE "+e.shaderType,"#define SHADER_NAME "+e.shaderName,_].filter(Ji).join(`
`),v.length>0&&(v+=`
`)):(p=[Xh(e),"#define SHADER_TYPE "+e.shaderType,"#define SHADER_NAME "+e.shaderName,_,e.extensionClipCullDistance?"#define USE_CLIP_DISTANCE":"",e.batching?"#define USE_BATCHING":"",e.instancing?"#define USE_INSTANCING":"",e.instancingColor?"#define USE_INSTANCING_COLOR":"",e.useFog&&e.fog?"#define USE_FOG":"",e.useFog&&e.fogExp2?"#define FOG_EXP2":"",e.map?"#define USE_MAP":"",e.envMap?"#define USE_ENVMAP":"",e.envMap?"#define "+h:"",e.lightMap?"#define USE_LIGHTMAP":"",e.aoMap?"#define USE_AOMAP":"",e.bumpMap?"#define USE_BUMPMAP":"",e.normalMap?"#define USE_NORMALMAP":"",e.normalMapObjectSpace?"#define USE_NORMALMAP_OBJECTSPACE":"",e.normalMapTangentSpace?"#define USE_NORMALMAP_TANGENTSPACE":"",e.displacementMap?"#define USE_DISPLACEMENTMAP":"",e.emissiveMap?"#define USE_EMISSIVEMAP":"",e.anisotropy?"#define USE_ANISOTROPY":"",e.anisotropyMap?"#define USE_ANISOTROPYMAP":"",e.clearcoatMap?"#define USE_CLEARCOATMAP":"",e.clearcoatRoughnessMap?"#define USE_CLEARCOAT_ROUGHNESSMAP":"",e.clearcoatNormalMap?"#define USE_CLEARCOAT_NORMALMAP":"",e.iridescenceMap?"#define USE_IRIDESCENCEMAP":"",e.iridescenceThicknessMap?"#define USE_IRIDESCENCE_THICKNESSMAP":"",e.specularMap?"#define USE_SPECULARMAP":"",e.specularColorMap?"#define USE_SPECULAR_COLORMAP":"",e.specularIntensityMap?"#define USE_SPECULAR_INTENSITYMAP":"",e.roughnessMap?"#define USE_ROUGHNESSMAP":"",e.metalnessMap?"#define USE_METALNESSMAP":"",e.alphaMap?"#define USE_ALPHAMAP":"",e.alphaHash?"#define USE_ALPHAHASH":"",e.transmission?"#define USE_TRANSMISSION":"",e.transmissionMap?"#define USE_TRANSMISSIONMAP":"",e.thicknessMap?"#define USE_THICKNESSMAP":"",e.sheenColorMap?"#define USE_SHEEN_COLORMAP":"",e.sheenRoughnessMap?"#define USE_SHEEN_ROUGHNESSMAP":"",e.mapUv?"#define MAP_UV "+e.mapUv:"",e.alphaMapUv?"#define ALPHAMAP_UV "+e.alphaMapUv:"",e.lightMapUv?"#define LIGHTMAP_UV "+e.lightMapUv:"",e.aoMapUv?"#define AOMAP_UV "+e.aoMapUv:"",e.emissiveMapUv?"#define EMISSIVEMAP_UV "+e.emissiveMapUv:"",e.bumpMapUv?"#define BUMPMAP_UV "+e.bumpMapUv:"",e.normalMapUv?"#define NORMALMAP_UV "+e.normalMapUv:"",e.displacementMapUv?"#define DISPLACEMENTMAP_UV "+e.displacementMapUv:"",e.metalnessMapUv?"#define METALNESSMAP_UV "+e.metalnessMapUv:"",e.roughnessMapUv?"#define ROUGHNESSMAP_UV "+e.roughnessMapUv:"",e.anisotropyMapUv?"#define ANISOTROPYMAP_UV "+e.anisotropyMapUv:"",e.clearcoatMapUv?"#define CLEARCOATMAP_UV "+e.clearcoatMapUv:"",e.clearcoatNormalMapUv?"#define CLEARCOAT_NORMALMAP_UV "+e.clearcoatNormalMapUv:"",e.clearcoatRoughnessMapUv?"#define CLEARCOAT_ROUGHNESSMAP_UV "+e.clearcoatRoughnessMapUv:"",e.iridescenceMapUv?"#define IRIDESCENCEMAP_UV "+e.iridescenceMapUv:"",e.iridescenceThicknessMapUv?"#define IRIDESCENCE_THICKNESSMAP_UV "+e.iridescenceThicknessMapUv:"",e.sheenColorMapUv?"#define SHEEN_COLORMAP_UV "+e.sheenColorMapUv:"",e.sheenRoughnessMapUv?"#define SHEEN_ROUGHNESSMAP_UV "+e.sheenRoughnessMapUv:"",e.specularMapUv?"#define SPECULARMAP_UV "+e.specularMapUv:"",e.specularColorMapUv?"#define SPECULAR_COLORMAP_UV "+e.specularColorMapUv:"",e.specularIntensityMapUv?"#define SPECULAR_INTENSITYMAP_UV "+e.specularIntensityMapUv:"",e.transmissionMapUv?"#define TRANSMISSIONMAP_UV "+e.transmissionMapUv:"",e.thicknessMapUv?"#define THICKNESSMAP_UV "+e.thicknessMapUv:"",e.vertexTangents&&e.flatShading===!1?"#define USE_TANGENT":"",e.vertexColors?"#define USE_COLOR":"",e.vertexAlphas?"#define USE_COLOR_ALPHA":"",e.vertexUv1s?"#define USE_UV1":"",e.vertexUv2s?"#define USE_UV2":"",e.vertexUv3s?"#define USE_UV3":"",e.pointsUvs?"#define USE_POINTS_UV":"",e.flatShading?"#define FLAT_SHADED":"",e.skinning?"#define USE_SKINNING":"",e.morphTargets?"#define USE_MORPHTARGETS":"",e.morphNormals&&e.flatShading===!1?"#define USE_MORPHNORMALS":"",e.morphColors&&e.isWebGL2?"#define USE_MORPHCOLORS":"",e.morphTargetsCount>0&&e.isWebGL2?"#define MORPHTARGETS_TEXTURE":"",e.morphTargetsCount>0&&e.isWebGL2?"#define MORPHTARGETS_TEXTURE_STRIDE "+e.morphTextureStride:"",e.morphTargetsCount>0&&e.isWebGL2?"#define MORPHTARGETS_COUNT "+e.morphTargetsCount:"",e.doubleSided?"#define DOUBLE_SIDED":"",e.flipSided?"#define FLIP_SIDED":"",e.shadowMapEnabled?"#define USE_SHADOWMAP":"",e.shadowMapEnabled?"#define "+c:"",e.sizeAttenuation?"#define USE_SIZEATTENUATION":"",e.numLightProbes>0?"#define USE_LIGHT_PROBES":"",e.useLegacyLights?"#define LEGACY_LIGHTS":"",e.logarithmicDepthBuffer?"#define USE_LOGDEPTHBUF":"",e.logarithmicDepthBuffer&&e.rendererExtensionFragDepth?"#define USE_LOGDEPTHBUF_EXT":"","uniform mat4 modelMatrix;","uniform mat4 modelViewMatrix;","uniform mat4 projectionMatrix;","uniform mat4 viewMatrix;","uniform mat3 normalMatrix;","uniform vec3 cameraPosition;","uniform bool isOrthographic;","#ifdef USE_INSTANCING","	attribute mat4 instanceMatrix;","#endif","#ifdef USE_INSTANCING_COLOR","	attribute vec3 instanceColor;","#endif","attribute vec3 position;","attribute vec3 normal;","attribute vec2 uv;","#ifdef USE_UV1","	attribute vec2 uv1;","#endif","#ifdef USE_UV2","	attribute vec2 uv2;","#endif","#ifdef USE_UV3","	attribute vec2 uv3;","#endif","#ifdef USE_TANGENT","	attribute vec4 tangent;","#endif","#if defined( USE_COLOR_ALPHA )","	attribute vec4 color;","#elif defined( USE_COLOR )","	attribute vec3 color;","#endif","#if ( defined( USE_MORPHTARGETS ) && ! defined( MORPHTARGETS_TEXTURE ) )","	attribute vec3 morphTarget0;","	attribute vec3 morphTarget1;","	attribute vec3 morphTarget2;","	attribute vec3 morphTarget3;","	#ifdef USE_MORPHNORMALS","		attribute vec3 morphNormal0;","		attribute vec3 morphNormal1;","		attribute vec3 morphNormal2;","		attribute vec3 morphNormal3;","	#else","		attribute vec3 morphTarget4;","		attribute vec3 morphTarget5;","		attribute vec3 morphTarget6;","		attribute vec3 morphTarget7;","	#endif","#endif","#ifdef USE_SKINNING","	attribute vec4 skinIndex;","	attribute vec4 skinWeight;","#endif",`
`].filter(Ji).join(`
`),v=[f,Xh(e),"#define SHADER_TYPE "+e.shaderType,"#define SHADER_NAME "+e.shaderName,_,e.useFog&&e.fog?"#define USE_FOG":"",e.useFog&&e.fogExp2?"#define FOG_EXP2":"",e.map?"#define USE_MAP":"",e.matcap?"#define USE_MATCAP":"",e.envMap?"#define USE_ENVMAP":"",e.envMap?"#define "+l:"",e.envMap?"#define "+h:"",e.envMap?"#define "+u:"",d?"#define CUBEUV_TEXEL_WIDTH "+d.texelWidth:"",d?"#define CUBEUV_TEXEL_HEIGHT "+d.texelHeight:"",d?"#define CUBEUV_MAX_MIP "+d.maxMip+".0":"",e.lightMap?"#define USE_LIGHTMAP":"",e.aoMap?"#define USE_AOMAP":"",e.bumpMap?"#define USE_BUMPMAP":"",e.normalMap?"#define USE_NORMALMAP":"",e.normalMapObjectSpace?"#define USE_NORMALMAP_OBJECTSPACE":"",e.normalMapTangentSpace?"#define USE_NORMALMAP_TANGENTSPACE":"",e.emissiveMap?"#define USE_EMISSIVEMAP":"",e.anisotropy?"#define USE_ANISOTROPY":"",e.anisotropyMap?"#define USE_ANISOTROPYMAP":"",e.clearcoat?"#define USE_CLEARCOAT":"",e.clearcoatMap?"#define USE_CLEARCOATMAP":"",e.clearcoatRoughnessMap?"#define USE_CLEARCOAT_ROUGHNESSMAP":"",e.clearcoatNormalMap?"#define USE_CLEARCOAT_NORMALMAP":"",e.iridescence?"#define USE_IRIDESCENCE":"",e.iridescenceMap?"#define USE_IRIDESCENCEMAP":"",e.iridescenceThicknessMap?"#define USE_IRIDESCENCE_THICKNESSMAP":"",e.specularMap?"#define USE_SPECULARMAP":"",e.specularColorMap?"#define USE_SPECULAR_COLORMAP":"",e.specularIntensityMap?"#define USE_SPECULAR_INTENSITYMAP":"",e.roughnessMap?"#define USE_ROUGHNESSMAP":"",e.metalnessMap?"#define USE_METALNESSMAP":"",e.alphaMap?"#define USE_ALPHAMAP":"",e.alphaTest?"#define USE_ALPHATEST":"",e.alphaHash?"#define USE_ALPHAHASH":"",e.sheen?"#define USE_SHEEN":"",e.sheenColorMap?"#define USE_SHEEN_COLORMAP":"",e.sheenRoughnessMap?"#define USE_SHEEN_ROUGHNESSMAP":"",e.transmission?"#define USE_TRANSMISSION":"",e.transmissionMap?"#define USE_TRANSMISSIONMAP":"",e.thicknessMap?"#define USE_THICKNESSMAP":"",e.vertexTangents&&e.flatShading===!1?"#define USE_TANGENT":"",e.vertexColors||e.instancingColor?"#define USE_COLOR":"",e.vertexAlphas?"#define USE_COLOR_ALPHA":"",e.vertexUv1s?"#define USE_UV1":"",e.vertexUv2s?"#define USE_UV2":"",e.vertexUv3s?"#define USE_UV3":"",e.pointsUvs?"#define USE_POINTS_UV":"",e.gradientMap?"#define USE_GRADIENTMAP":"",e.flatShading?"#define FLAT_SHADED":"",e.doubleSided?"#define DOUBLE_SIDED":"",e.flipSided?"#define FLIP_SIDED":"",e.shadowMapEnabled?"#define USE_SHADOWMAP":"",e.shadowMapEnabled?"#define "+c:"",e.premultipliedAlpha?"#define PREMULTIPLIED_ALPHA":"",e.numLightProbes>0?"#define USE_LIGHT_PROBES":"",e.useLegacyLights?"#define LEGACY_LIGHTS":"",e.decodeVideoTexture?"#define DECODE_VIDEO_TEXTURE":"",e.logarithmicDepthBuffer?"#define USE_LOGDEPTHBUF":"",e.logarithmicDepthBuffer&&e.rendererExtensionFragDepth?"#define USE_LOGDEPTHBUF_EXT":"","uniform mat4 viewMatrix;","uniform vec3 cameraPosition;","uniform bool isOrthographic;",e.toneMapping!==Vn?"#define TONE_MAPPING":"",e.toneMapping!==Vn?kt.tonemapping_pars_fragment:"",e.toneMapping!==Vn?O0("toneMapping",e.toneMapping):"",e.dithering?"#define DITHERING":"",e.opaque?"#define OPAQUE":"",kt.colorspace_pars_fragment,N0("linearToOutputTexel",e.outputColorSpace),e.useDepthPacking?"#define DEPTH_PACKING "+e.depthPacking:"",`
`].filter(Ji).join(`
`)),a=Bo(a),a=Hh(a,e),a=Gh(a,e),o=Bo(o),o=Hh(o,e),o=Gh(o,e),a=Wh(a),o=Wh(o),e.isWebGL2&&e.isRawShaderMaterial!==!0&&(x=`#version 300 es
`,p=[m,"precision mediump sampler2DArray;","#define attribute in","#define varying out","#define texture2D texture"].join(`
`)+`
`+p,v=["precision mediump sampler2DArray;","#define varying in",e.glslVersion===th?"":"layout(location = 0) out highp vec4 pc_fragColor;",e.glslVersion===th?"":"#define gl_FragColor pc_fragColor","#define gl_FragDepthEXT gl_FragDepth","#define texture2D texture","#define textureCube texture","#define texture2DProj textureProj","#define texture2DLodEXT textureLod","#define texture2DProjLodEXT textureProjLod","#define textureCubeLodEXT textureLod","#define texture2DGradEXT textureGrad","#define texture2DProjGradEXT textureProjGrad","#define textureCubeGradEXT textureGrad"].join(`
`)+`
`+v);let y=x+p+a,C=x+v+o,T=Vh(i,i.VERTEX_SHADER,y),R=Vh(i,i.FRAGMENT_SHADER,C);i.attachShader(g,T),i.attachShader(g,R),e.index0AttributeName!==void 0?i.bindAttribLocation(g,0,e.index0AttributeName):e.morphTargets===!0&&i.bindAttribLocation(g,0,"position"),i.linkProgram(g);function U(G){if(r.debug.checkShaderErrors){let it=i.getProgramInfoLog(g).trim(),I=i.getShaderInfoLog(T).trim(),F=i.getShaderInfoLog(R).trim(),k=!0,J=!0;if(i.getProgramParameter(g,i.LINK_STATUS)===!1)if(k=!1,typeof r.debug.onShaderError=="function")r.debug.onShaderError(i,g,T,R);else{let Y=kh(i,T,"vertex"),W=kh(i,R,"fragment");console.error("THREE.WebGLProgram: Shader Error "+i.getError()+" - VALIDATE_STATUS "+i.getProgramParameter(g,i.VALIDATE_STATUS)+`

Program Info Log: `+it+`
`+Y+`
`+W)}else it!==""?console.warn("THREE.WebGLProgram: Program Info Log:",it):(I===""||F==="")&&(J=!1);J&&(G.diagnostics={runnable:k,programLog:it,vertexShader:{log:I,prefix:p},fragmentShader:{log:F,prefix:v}})}i.deleteShader(T),i.deleteShader(R),S=new ji(i,g),E=V0(i,g)}let S;this.getUniforms=function(){return S===void 0&&U(this),S};let E;this.getAttributes=function(){return E===void 0&&U(this),E};let N=e.rendererExtensionParallelShaderCompile===!1;return this.isReady=function(){return N===!1&&(N=i.getProgramParameter(g,L0)),N},this.destroy=function(){n.releaseStatesOfProgram(this),i.deleteProgram(g),this.program=void 0},this.type=e.shaderType,this.name=e.shaderName,this.id=I0++,this.cacheKey=t,this.usedTimes=1,this.program=g,this.vertexShader=T,this.fragmentShader=R,this}var Q0=0,zo=class{constructor(){this.shaderCache=new Map,this.materialCache=new Map}update(t){let e=t.vertexShader,n=t.fragmentShader,i=this._getShaderStage(e),s=this._getShaderStage(n),a=this._getShaderCacheForMaterial(t);return a.has(i)===!1&&(a.add(i),i.usedTimes++),a.has(s)===!1&&(a.add(s),s.usedTimes++),this}remove(t){let e=this.materialCache.get(t);for(let n of e)n.usedTimes--,n.usedTimes===0&&this.shaderCache.delete(n.code);return this.materialCache.delete(t),this}getVertexShaderID(t){return this._getShaderStage(t.vertexShader).id}getFragmentShaderID(t){return this._getShaderStage(t.fragmentShader).id}dispose(){this.shaderCache.clear(),this.materialCache.clear()}_getShaderCacheForMaterial(t){let e=this.materialCache,n=e.get(t);return n===void 0&&(n=new Set,e.set(t,n)),n}_getShaderStage(t){let e=this.shaderCache,n=e.get(t);return n===void 0&&(n=new Vo(t),e.set(t,n)),n}},Vo=class{constructor(t){this.id=Q0++,this.code=t,this.usedTimes=0}};function j0(r,t,e,n,i,s,a){let o=new Os,c=new zo,l=[],h=i.isWebGL2,u=i.logarithmicDepthBuffer,d=i.vertexTextures,f=i.precision,m={MeshDepthMaterial:"depth",MeshDistanceMaterial:"distanceRGBA",MeshNormalMaterial:"normal",MeshBasicMaterial:"basic",MeshLambertMaterial:"lambert",MeshPhongMaterial:"phong",MeshToonMaterial:"toon",MeshStandardMaterial:"physical",MeshPhysicalMaterial:"physical",MeshMatcapMaterial:"matcap",LineBasicMaterial:"basic",LineDashedMaterial:"dashed",PointsMaterial:"points",ShadowMaterial:"shadow",SpriteMaterial:"sprite"};function _(S){return S===0?"uv":`uv${S}`}function g(S,E,N,G,it){let I=G.fog,F=it.geometry,k=S.isMeshStandardMaterial?G.environment:null,J=(S.isMeshStandardMaterial?e:t).get(S.envMap||k),Y=J&&J.mapping===Ys?J.image.height:null,W=m[S.type];S.precision!==null&&(f=i.getMaxPrecision(S.precision),f!==S.precision&&console.warn("THREE.WebGLProgram.getParameters:",S.precision,"not supported, using",f,"instead."));let tt=F.morphAttributes.position||F.morphAttributes.normal||F.morphAttributes.color,et=tt!==void 0?tt.length:0,ut=0;F.morphAttributes.position!==void 0&&(ut=1),F.morphAttributes.normal!==void 0&&(ut=2),F.morphAttributes.color!==void 0&&(ut=3);let H,K,dt,Mt;if(W){let Ue=on[W];H=Ue.vertexShader,K=Ue.fragmentShader}else H=S.vertexShader,K=S.fragmentShader,c.update(S),dt=c.getVertexShaderID(S),Mt=c.getFragmentShaderID(S);let gt=r.getRenderTarget(),Ct=it.isInstancedMesh===!0,Nt=it.isBatchedMesh===!0,St=!!S.map,Ut=!!S.matcap,P=!!J,rt=!!S.aoMap,q=!!S.lightMap,st=!!S.bumpMap,X=!!S.normalMap,Et=!!S.displacementMap,ft=!!S.emissiveMap,b=!!S.metalnessMap,M=!!S.roughnessMap,O=S.anisotropy>0,nt=S.clearcoat>0,Q=S.iridescence>0,$=S.sheen>0,yt=S.transmission>0,ct=O&&!!S.anisotropyMap,_t=nt&&!!S.clearcoatMap,Tt=nt&&!!S.clearcoatNormalMap,Ft=nt&&!!S.clearcoatRoughnessMap,j=Q&&!!S.iridescenceMap,Zt=Q&&!!S.iridescenceThicknessMap,Yt=$&&!!S.sheenColorMap,Dt=$&&!!S.sheenRoughnessMap,At=!!S.specularMap,vt=!!S.specularColorMap,Vt=!!S.specularIntensityMap,$t=yt&&!!S.transmissionMap,oe=yt&&!!S.thicknessMap,Xt=!!S.gradientMap,at=!!S.alphaMap,L=S.alphaTest>0,lt=!!S.alphaHash,ht=!!S.extensions,Pt=!!F.attributes.uv1,wt=!!F.attributes.uv2,ee=!!F.attributes.uv3,ne=Vn;return S.toneMapped&&(gt===null||gt.isXRRenderTarget===!0)&&(ne=r.toneMapping),{isWebGL2:h,shaderID:W,shaderType:S.type,shaderName:S.name,vertexShader:H,fragmentShader:K,defines:S.defines,customVertexShaderID:dt,customFragmentShaderID:Mt,isRawShaderMaterial:S.isRawShaderMaterial===!0,glslVersion:S.glslVersion,precision:f,batching:Nt,instancing:Ct,instancingColor:Ct&&it.instanceColor!==null,supportsVertexTextures:d,outputColorSpace:gt===null?r.outputColorSpace:gt.isXRRenderTarget===!0?gt.texture.colorSpace:En,map:St,matcap:Ut,envMap:P,envMapMode:P&&J.mapping,envMapCubeUVHeight:Y,aoMap:rt,lightMap:q,bumpMap:st,normalMap:X,displacementMap:d&&Et,emissiveMap:ft,normalMapObjectSpace:X&&S.normalMapType===np,normalMapTangentSpace:X&&S.normalMapType===Si,metalnessMap:b,roughnessMap:M,anisotropy:O,anisotropyMap:ct,clearcoat:nt,clearcoatMap:_t,clearcoatNormalMap:Tt,clearcoatRoughnessMap:Ft,iridescence:Q,iridescenceMap:j,iridescenceThicknessMap:Zt,sheen:$,sheenColorMap:Yt,sheenRoughnessMap:Dt,specularMap:At,specularColorMap:vt,specularIntensityMap:Vt,transmission:yt,transmissionMap:$t,thicknessMap:oe,gradientMap:Xt,opaque:S.transparent===!1&&S.blending===Ki,alphaMap:at,alphaTest:L,alphaHash:lt,combine:S.combine,mapUv:St&&_(S.map.channel),aoMapUv:rt&&_(S.aoMap.channel),lightMapUv:q&&_(S.lightMap.channel),bumpMapUv:st&&_(S.bumpMap.channel),normalMapUv:X&&_(S.normalMap.channel),displacementMapUv:Et&&_(S.displacementMap.channel),emissiveMapUv:ft&&_(S.emissiveMap.channel),metalnessMapUv:b&&_(S.metalnessMap.channel),roughnessMapUv:M&&_(S.roughnessMap.channel),anisotropyMapUv:ct&&_(S.anisotropyMap.channel),clearcoatMapUv:_t&&_(S.clearcoatMap.channel),clearcoatNormalMapUv:Tt&&_(S.clearcoatNormalMap.channel),clearcoatRoughnessMapUv:Ft&&_(S.clearcoatRoughnessMap.channel),iridescenceMapUv:j&&_(S.iridescenceMap.channel),iridescenceThicknessMapUv:Zt&&_(S.iridescenceThicknessMap.channel),sheenColorMapUv:Yt&&_(S.sheenColorMap.channel),sheenRoughnessMapUv:Dt&&_(S.sheenRoughnessMap.channel),specularMapUv:At&&_(S.specularMap.channel),specularColorMapUv:vt&&_(S.specularColorMap.channel),specularIntensityMapUv:Vt&&_(S.specularIntensityMap.channel),transmissionMapUv:$t&&_(S.transmissionMap.channel),thicknessMapUv:oe&&_(S.thicknessMap.channel),alphaMapUv:at&&_(S.alphaMap.channel),vertexTangents:!!F.attributes.tangent&&(X||O),vertexColors:S.vertexColors,vertexAlphas:S.vertexColors===!0&&!!F.attributes.color&&F.attributes.color.itemSize===4,vertexUv1s:Pt,vertexUv2s:wt,vertexUv3s:ee,pointsUvs:it.isPoints===!0&&!!F.attributes.uv&&(St||at),fog:!!I,useFog:S.fog===!0,fogExp2:I&&I.isFogExp2,flatShading:S.flatShading===!0,sizeAttenuation:S.sizeAttenuation===!0,logarithmicDepthBuffer:u,skinning:it.isSkinnedMesh===!0,morphTargets:F.morphAttributes.position!==void 0,morphNormals:F.morphAttributes.normal!==void 0,morphColors:F.morphAttributes.color!==void 0,morphTargetsCount:et,morphTextureStride:ut,numDirLights:E.directional.length,numPointLights:E.point.length,numSpotLights:E.spot.length,numSpotLightMaps:E.spotLightMap.length,numRectAreaLights:E.rectArea.length,numHemiLights:E.hemi.length,numDirLightShadows:E.directionalShadowMap.length,numPointLightShadows:E.pointShadowMap.length,numSpotLightShadows:E.spotShadowMap.length,numSpotLightShadowsWithMaps:E.numSpotLightShadowsWithMaps,numLightProbes:E.numLightProbes,numClippingPlanes:a.numPlanes,numClipIntersection:a.numIntersection,dithering:S.dithering,shadowMapEnabled:r.shadowMap.enabled&&N.length>0,shadowMapType:r.shadowMap.type,toneMapping:ne,useLegacyLights:r._useLegacyLights,decodeVideoTexture:St&&S.map.isVideoTexture===!0&&jt.getTransfer(S.map.colorSpace)===se,premultipliedAlpha:S.premultipliedAlpha,doubleSided:S.side===Mn,flipSided:S.side===He,useDepthPacking:S.depthPacking>=0,depthPacking:S.depthPacking||0,index0AttributeName:S.index0AttributeName,extensionDerivatives:ht&&S.extensions.derivatives===!0,extensionFragDepth:ht&&S.extensions.fragDepth===!0,extensionDrawBuffers:ht&&S.extensions.drawBuffers===!0,extensionShaderTextureLOD:ht&&S.extensions.shaderTextureLOD===!0,extensionClipCullDistance:ht&&S.extensions.clipCullDistance&&n.has("WEBGL_clip_cull_distance"),rendererExtensionFragDepth:h||n.has("EXT_frag_depth"),rendererExtensionDrawBuffers:h||n.has("WEBGL_draw_buffers"),rendererExtensionShaderTextureLod:h||n.has("EXT_shader_texture_lod"),rendererExtensionParallelShaderCompile:n.has("KHR_parallel_shader_compile"),customProgramCacheKey:S.customProgramCacheKey()}}function p(S){let E=[];if(S.shaderID?E.push(S.shaderID):(E.push(S.customVertexShaderID),E.push(S.customFragmentShaderID)),S.defines!==void 0)for(let N in S.defines)E.push(N),E.push(S.defines[N]);return S.isRawShaderMaterial===!1&&(v(E,S),x(E,S),E.push(r.outputColorSpace)),E.push(S.customProgramCacheKey),E.join()}function v(S,E){S.push(E.precision),S.push(E.outputColorSpace),S.push(E.envMapMode),S.push(E.envMapCubeUVHeight),S.push(E.mapUv),S.push(E.alphaMapUv),S.push(E.lightMapUv),S.push(E.aoMapUv),S.push(E.bumpMapUv),S.push(E.normalMapUv),S.push(E.displacementMapUv),S.push(E.emissiveMapUv),S.push(E.metalnessMapUv),S.push(E.roughnessMapUv),S.push(E.anisotropyMapUv),S.push(E.clearcoatMapUv),S.push(E.clearcoatNormalMapUv),S.push(E.clearcoatRoughnessMapUv),S.push(E.iridescenceMapUv),S.push(E.iridescenceThicknessMapUv),S.push(E.sheenColorMapUv),S.push(E.sheenRoughnessMapUv),S.push(E.specularMapUv),S.push(E.specularColorMapUv),S.push(E.specularIntensityMapUv),S.push(E.transmissionMapUv),S.push(E.thicknessMapUv),S.push(E.combine),S.push(E.fogExp2),S.push(E.sizeAttenuation),S.push(E.morphTargetsCount),S.push(E.morphAttributeCount),S.push(E.numDirLights),S.push(E.numPointLights),S.push(E.numSpotLights),S.push(E.numSpotLightMaps),S.push(E.numHemiLights),S.push(E.numRectAreaLights),S.push(E.numDirLightShadows),S.push(E.numPointLightShadows),S.push(E.numSpotLightShadows),S.push(E.numSpotLightShadowsWithMaps),S.push(E.numLightProbes),S.push(E.shadowMapType),S.push(E.toneMapping),S.push(E.numClippingPlanes),S.push(E.numClipIntersection),S.push(E.depthPacking)}function x(S,E){o.disableAll(),E.isWebGL2&&o.enable(0),E.supportsVertexTextures&&o.enable(1),E.instancing&&o.enable(2),E.instancingColor&&o.enable(3),E.matcap&&o.enable(4),E.envMap&&o.enable(5),E.normalMapObjectSpace&&o.enable(6),E.normalMapTangentSpace&&o.enable(7),E.clearcoat&&o.enable(8),E.iridescence&&o.enable(9),E.alphaTest&&o.enable(10),E.vertexColors&&o.enable(11),E.vertexAlphas&&o.enable(12),E.vertexUv1s&&o.enable(13),E.vertexUv2s&&o.enable(14),E.vertexUv3s&&o.enable(15),E.vertexTangents&&o.enable(16),E.anisotropy&&o.enable(17),E.alphaHash&&o.enable(18),E.batching&&o.enable(19),S.push(o.mask),o.disableAll(),E.fog&&o.enable(0),E.useFog&&o.enable(1),E.flatShading&&o.enable(2),E.logarithmicDepthBuffer&&o.enable(3),E.skinning&&o.enable(4),E.morphTargets&&o.enable(5),E.morphNormals&&o.enable(6),E.morphColors&&o.enable(7),E.premultipliedAlpha&&o.enable(8),E.shadowMapEnabled&&o.enable(9),E.useLegacyLights&&o.enable(10),E.doubleSided&&o.enable(11),E.flipSided&&o.enable(12),E.useDepthPacking&&o.enable(13),E.dithering&&o.enable(14),E.transmission&&o.enable(15),E.sheen&&o.enable(16),E.opaque&&o.enable(17),E.pointsUvs&&o.enable(18),E.decodeVideoTexture&&o.enable(19),S.push(o.mask)}function y(S){let E=m[S.type],N;if(E){let G=on[E];N=Hp.clone(G.uniforms)}else N=S.uniforms;return N}function C(S,E){let N;for(let G=0,it=l.length;G<it;G++){let I=l[G];if(I.cacheKey===E){N=I,++N.usedTimes;break}}return N===void 0&&(N=new K0(r,E,S,s),l.push(N)),N}function T(S){if(--S.usedTimes===0){let E=l.indexOf(S);l[E]=l[l.length-1],l.pop(),S.destroy()}}function R(S){c.remove(S)}function U(){c.dispose()}return{getParameters:g,getProgramCacheKey:p,getUniforms:y,acquireProgram:C,releaseProgram:T,releaseShaderCache:R,programs:l,dispose:U}}function tx(){let r=new WeakMap;function t(s){let a=r.get(s);return a===void 0&&(a={},r.set(s,a)),a}function e(s){r.delete(s)}function n(s,a,o){r.get(s)[a]=o}function i(){r=new WeakMap}return{get:t,remove:e,update:n,dispose:i}}function ex(r,t){return r.groupOrder!==t.groupOrder?r.groupOrder-t.groupOrder:r.renderOrder!==t.renderOrder?r.renderOrder-t.renderOrder:r.material.id!==t.material.id?r.material.id-t.material.id:r.z!==t.z?r.z-t.z:r.id-t.id}function qh(r,t){return r.groupOrder!==t.groupOrder?r.groupOrder-t.groupOrder:r.renderOrder!==t.renderOrder?r.renderOrder-t.renderOrder:r.z!==t.z?t.z-r.z:r.id-t.id}function Yh(){let r=[],t=0,e=[],n=[],i=[];function s(){t=0,e.length=0,n.length=0,i.length=0}function a(u,d,f,m,_,g){let p=r[t];return p===void 0?(p={id:u.id,object:u,geometry:d,material:f,groupOrder:m,renderOrder:u.renderOrder,z:_,group:g},r[t]=p):(p.id=u.id,p.object=u,p.geometry=d,p.material=f,p.groupOrder=m,p.renderOrder=u.renderOrder,p.z=_,p.group=g),t++,p}function o(u,d,f,m,_,g){let p=a(u,d,f,m,_,g);f.transmission>0?n.push(p):f.transparent===!0?i.push(p):e.push(p)}function c(u,d,f,m,_,g){let p=a(u,d,f,m,_,g);f.transmission>0?n.unshift(p):f.transparent===!0?i.unshift(p):e.unshift(p)}function l(u,d){e.length>1&&e.sort(u||ex),n.length>1&&n.sort(d||qh),i.length>1&&i.sort(d||qh)}function h(){for(let u=t,d=r.length;u<d;u++){let f=r[u];if(f.id===null)break;f.id=null,f.object=null,f.geometry=null,f.material=null,f.group=null}}return{opaque:e,transmissive:n,transparent:i,init:s,push:o,unshift:c,finish:h,sort:l}}function nx(){let r=new WeakMap;function t(n,i){let s=r.get(n),a;return s===void 0?(a=new Yh,r.set(n,[a])):i>=s.length?(a=new Yh,s.push(a)):a=s[i],a}function e(){r=new WeakMap}return{get:t,dispose:e}}function ix(){let r={};return{get:function(t){if(r[t.id]!==void 0)return r[t.id];let e;switch(t.type){case"DirectionalLight":e={direction:new w,color:new pt};break;case"SpotLight":e={position:new w,direction:new w,color:new pt,distance:0,coneCos:0,penumbraCos:0,decay:0};break;case"PointLight":e={position:new w,color:new pt,distance:0,decay:0};break;case"HemisphereLight":e={direction:new w,skyColor:new pt,groundColor:new pt};break;case"RectAreaLight":e={color:new pt,position:new w,halfWidth:new w,halfHeight:new w};break}return r[t.id]=e,e}}}function sx(){let r={};return{get:function(t){if(r[t.id]!==void 0)return r[t.id];let e;switch(t.type){case"DirectionalLight":e={shadowBias:0,shadowNormalBias:0,shadowRadius:1,shadowMapSize:new Z};break;case"SpotLight":e={shadowBias:0,shadowNormalBias:0,shadowRadius:1,shadowMapSize:new Z};break;case"PointLight":e={shadowBias:0,shadowNormalBias:0,shadowRadius:1,shadowMapSize:new Z,shadowCameraNear:1,shadowCameraFar:1e3};break}return r[t.id]=e,e}}}var rx=0;function ax(r,t){return(t.castShadow?2:0)-(r.castShadow?2:0)+(t.map?1:0)-(r.map?1:0)}function ox(r,t){let e=new ix,n=sx(),i={version:0,hash:{directionalLength:-1,pointLength:-1,spotLength:-1,rectAreaLength:-1,hemiLength:-1,numDirectionalShadows:-1,numPointShadows:-1,numSpotShadows:-1,numSpotMaps:-1,numLightProbes:-1},ambient:[0,0,0],probe:[],directional:[],directionalShadow:[],directionalShadowMap:[],directionalShadowMatrix:[],spot:[],spotLightMap:[],spotShadow:[],spotShadowMap:[],spotLightMatrix:[],rectArea:[],rectAreaLTC1:null,rectAreaLTC2:null,point:[],pointShadow:[],pointShadowMap:[],pointShadowMatrix:[],hemi:[],numSpotLightShadowsWithMaps:0,numLightProbes:0};for(let h=0;h<9;h++)i.probe.push(new w);let s=new w,a=new It,o=new It;function c(h,u){let d=0,f=0,m=0;for(let G=0;G<9;G++)i.probe[G].set(0,0,0);let _=0,g=0,p=0,v=0,x=0,y=0,C=0,T=0,R=0,U=0,S=0;h.sort(ax);let E=u===!0?Math.PI:1;for(let G=0,it=h.length;G<it;G++){let I=h[G],F=I.color,k=I.intensity,J=I.distance,Y=I.shadow&&I.shadow.map?I.shadow.map.texture:null;if(I.isAmbientLight)d+=F.r*k*E,f+=F.g*k*E,m+=F.b*k*E;else if(I.isLightProbe){for(let W=0;W<9;W++)i.probe[W].addScaledVector(I.sh.coefficients[W],k);S++}else if(I.isDirectionalLight){let W=e.get(I);if(W.color.copy(I.color).multiplyScalar(I.intensity*E),I.castShadow){let tt=I.shadow,et=n.get(I);et.shadowBias=tt.bias,et.shadowNormalBias=tt.normalBias,et.shadowRadius=tt.radius,et.shadowMapSize=tt.mapSize,i.directionalShadow[_]=et,i.directionalShadowMap[_]=Y,i.directionalShadowMatrix[_]=I.shadow.matrix,y++}i.directional[_]=W,_++}else if(I.isSpotLight){let W=e.get(I);W.position.setFromMatrixPosition(I.matrixWorld),W.color.copy(F).multiplyScalar(k*E),W.distance=J,W.coneCos=Math.cos(I.angle),W.penumbraCos=Math.cos(I.angle*(1-I.penumbra)),W.decay=I.decay,i.spot[p]=W;let tt=I.shadow;if(I.map&&(i.spotLightMap[R]=I.map,R++,tt.updateMatrices(I),I.castShadow&&U++),i.spotLightMatrix[p]=tt.matrix,I.castShadow){let et=n.get(I);et.shadowBias=tt.bias,et.shadowNormalBias=tt.normalBias,et.shadowRadius=tt.radius,et.shadowMapSize=tt.mapSize,i.spotShadow[p]=et,i.spotShadowMap[p]=Y,T++}p++}else if(I.isRectAreaLight){let W=e.get(I);W.color.copy(F).multiplyScalar(k),W.halfWidth.set(I.width*.5,0,0),W.halfHeight.set(0,I.height*.5,0),i.rectArea[v]=W,v++}else if(I.isPointLight){let W=e.get(I);if(W.color.copy(I.color).multiplyScalar(I.intensity*E),W.distance=I.distance,W.decay=I.decay,I.castShadow){let tt=I.shadow,et=n.get(I);et.shadowBias=tt.bias,et.shadowNormalBias=tt.normalBias,et.shadowRadius=tt.radius,et.shadowMapSize=tt.mapSize,et.shadowCameraNear=tt.camera.near,et.shadowCameraFar=tt.camera.far,i.pointShadow[g]=et,i.pointShadowMap[g]=Y,i.pointShadowMatrix[g]=I.shadow.matrix,C++}i.point[g]=W,g++}else if(I.isHemisphereLight){let W=e.get(I);W.skyColor.copy(I.color).multiplyScalar(k*E),W.groundColor.copy(I.groundColor).multiplyScalar(k*E),i.hemi[x]=W,x++}}v>0&&(t.isWebGL2?r.has("OES_texture_float_linear")===!0?(i.rectAreaLTC1=ot.LTC_FLOAT_1,i.rectAreaLTC2=ot.LTC_FLOAT_2):(i.rectAreaLTC1=ot.LTC_HALF_1,i.rectAreaLTC2=ot.LTC_HALF_2):r.has("OES_texture_float_linear")===!0?(i.rectAreaLTC1=ot.LTC_FLOAT_1,i.rectAreaLTC2=ot.LTC_FLOAT_2):r.has("OES_texture_half_float_linear")===!0?(i.rectAreaLTC1=ot.LTC_HALF_1,i.rectAreaLTC2=ot.LTC_HALF_2):console.error("THREE.WebGLRenderer: Unable to use RectAreaLight. Missing WebGL extensions.")),i.ambient[0]=d,i.ambient[1]=f,i.ambient[2]=m;let N=i.hash;(N.directionalLength!==_||N.pointLength!==g||N.spotLength!==p||N.rectAreaLength!==v||N.hemiLength!==x||N.numDirectionalShadows!==y||N.numPointShadows!==C||N.numSpotShadows!==T||N.numSpotMaps!==R||N.numLightProbes!==S)&&(i.directional.length=_,i.spot.length=p,i.rectArea.length=v,i.point.length=g,i.hemi.length=x,i.directionalShadow.length=y,i.directionalShadowMap.length=y,i.pointShadow.length=C,i.pointShadowMap.length=C,i.spotShadow.length=T,i.spotShadowMap.length=T,i.directionalShadowMatrix.length=y,i.pointShadowMatrix.length=C,i.spotLightMatrix.length=T+R-U,i.spotLightMap.length=R,i.numSpotLightShadowsWithMaps=U,i.numLightProbes=S,N.directionalLength=_,N.pointLength=g,N.spotLength=p,N.rectAreaLength=v,N.hemiLength=x,N.numDirectionalShadows=y,N.numPointShadows=C,N.numSpotShadows=T,N.numSpotMaps=R,N.numLightProbes=S,i.version=rx++)}function l(h,u){let d=0,f=0,m=0,_=0,g=0,p=u.matrixWorldInverse;for(let v=0,x=h.length;v<x;v++){let y=h[v];if(y.isDirectionalLight){let C=i.directional[d];C.direction.setFromMatrixPosition(y.matrixWorld),s.setFromMatrixPosition(y.target.matrixWorld),C.direction.sub(s),C.direction.transformDirection(p),d++}else if(y.isSpotLight){let C=i.spot[m];C.position.setFromMatrixPosition(y.matrixWorld),C.position.applyMatrix4(p),C.direction.setFromMatrixPosition(y.matrixWorld),s.setFromMatrixPosition(y.target.matrixWorld),C.direction.sub(s),C.direction.transformDirection(p),m++}else if(y.isRectAreaLight){let C=i.rectArea[_];C.position.setFromMatrixPosition(y.matrixWorld),C.position.applyMatrix4(p),o.identity(),a.copy(y.matrixWorld),a.premultiply(p),o.extractRotation(a),C.halfWidth.set(y.width*.5,0,0),C.halfHeight.set(0,y.height*.5,0),C.halfWidth.applyMatrix4(o),C.halfHeight.applyMatrix4(o),_++}else if(y.isPointLight){let C=i.point[f];C.position.setFromMatrixPosition(y.matrixWorld),C.position.applyMatrix4(p),f++}else if(y.isHemisphereLight){let C=i.hemi[g];C.direction.setFromMatrixPosition(y.matrixWorld),C.direction.transformDirection(p),g++}}}return{setup:c,setupView:l,state:i}}function Zh(r,t){let e=new ox(r,t),n=[],i=[];function s(){n.length=0,i.length=0}function a(u){n.push(u)}function o(u){i.push(u)}function c(u){e.setup(n,u)}function l(u){e.setupView(n,u)}return{init:s,state:{lightsArray:n,shadowsArray:i,lights:e},setupLights:c,setupLightsView:l,pushLight:a,pushShadow:o}}function cx(r,t){let e=new WeakMap;function n(s,a=0){let o=e.get(s),c;return o===void 0?(c=new Zh(r,t),e.set(s,[c])):a>=o.length?(c=new Zh(r,t),o.push(c)):c=o[a],c}function i(){e=new WeakMap}return{get:n,dispose:i}}var ha=class extends Te{constructor(t){super(),this.isMeshDepthMaterial=!0,this.type="MeshDepthMaterial",this.depthPacking=tp,this.map=null,this.alphaMap=null,this.displacementMap=null,this.displacementScale=1,this.displacementBias=0,this.wireframe=!1,this.wireframeLinewidth=1,this.setValues(t)}copy(t){return super.copy(t),this.depthPacking=t.depthPacking,this.map=t.map,this.alphaMap=t.alphaMap,this.displacementMap=t.displacementMap,this.displacementScale=t.displacementScale,this.displacementBias=t.displacementBias,this.wireframe=t.wireframe,this.wireframeLinewidth=t.wireframeLinewidth,this}},ua=class extends Te{constructor(t){super(),this.isMeshDistanceMaterial=!0,this.type="MeshDistanceMaterial",this.map=null,this.alphaMap=null,this.displacementMap=null,this.displacementScale=1,this.displacementBias=0,this.setValues(t)}copy(t){return super.copy(t),this.map=t.map,this.alphaMap=t.alphaMap,this.displacementMap=t.displacementMap,this.displacementScale=t.displacementScale,this.displacementBias=t.displacementBias,this}},lx=`void main() {
	gl_Position = vec4( position, 1.0 );
}`,hx=`uniform sampler2D shadow_pass;
uniform vec2 resolution;
uniform float radius;
#include <packing>
void main() {
	const float samples = float( VSM_SAMPLES );
	float mean = 0.0;
	float squared_mean = 0.0;
	float uvStride = samples <= 1.0 ? 0.0 : 2.0 / ( samples - 1.0 );
	float uvStart = samples <= 1.0 ? 0.0 : - 1.0;
	for ( float i = 0.0; i < samples; i ++ ) {
		float uvOffset = uvStart + i * uvStride;
		#ifdef HORIZONTAL_PASS
			vec2 distribution = unpackRGBATo2Half( texture2D( shadow_pass, ( gl_FragCoord.xy + vec2( uvOffset, 0.0 ) * radius ) / resolution ) );
			mean += distribution.x;
			squared_mean += distribution.y * distribution.y + distribution.x * distribution.x;
		#else
			float depth = unpackRGBAToDepth( texture2D( shadow_pass, ( gl_FragCoord.xy + vec2( 0.0, uvOffset ) * radius ) / resolution ) );
			mean += depth;
			squared_mean += depth * depth;
		#endif
	}
	mean = mean / samples;
	squared_mean = squared_mean / samples;
	float std_dev = sqrt( squared_mean - mean * mean );
	gl_FragColor = pack2HalfToRGBA( vec2( mean, std_dev ) );
}`;function ux(r,t,e){let n=new rs,i=new Z,s=new Z,a=new te,o=new ha({depthPacking:ep}),c=new ua,l={},h=e.maxTextureSize,u={[Wn]:He,[He]:Wn,[Mn]:Mn},d=new sn({defines:{VSM_SAMPLES:8},uniforms:{shadow_pass:{value:null},resolution:{value:new Z},radius:{value:4}},vertexShader:lx,fragmentShader:hx}),f=d.clone();f.defines.HORIZONTAL_PASS=1;let m=new Wt;m.setAttribute("position",new Jt(new Float32Array([-1,-1,.5,3,-1,.5,-1,3,.5]),3));let _=new ge(m,d),g=this;this.enabled=!1,this.autoUpdate=!0,this.needsUpdate=!1,this.type=Rd;let p=this.type;this.render=function(T,R,U){if(g.enabled===!1||g.autoUpdate===!1&&g.needsUpdate===!1||T.length===0)return;let S=r.getRenderTarget(),E=r.getActiveCubeFace(),N=r.getActiveMipmapLevel(),G=r.state;G.setBlending(zn),G.buffers.color.setClear(1,1,1,1),G.buffers.depth.setTest(!0),G.setScissorTest(!1);let it=p!==vn&&this.type===vn,I=p===vn&&this.type!==vn;for(let F=0,k=T.length;F<k;F++){let J=T[F],Y=J.shadow;if(Y===void 0){console.warn("THREE.WebGLShadowMap:",J,"has no shadow.");continue}if(Y.autoUpdate===!1&&Y.needsUpdate===!1)continue;i.copy(Y.mapSize);let W=Y.getFrameExtents();if(i.multiply(W),s.copy(Y.mapSize),(i.x>h||i.y>h)&&(i.x>h&&(s.x=Math.floor(h/W.x),i.x=s.x*W.x,Y.mapSize.x=s.x),i.y>h&&(s.y=Math.floor(h/W.y),i.y=s.y*W.y,Y.mapSize.y=s.y)),Y.map===null||it===!0||I===!0){let et=this.type!==vn?{minFilter:pe,magFilter:pe}:{};Y.map!==null&&Y.map.dispose(),Y.map=new Ke(i.x,i.y,et),Y.map.texture.name=J.name+".shadowMap",Y.camera.updateProjectionMatrix()}r.setRenderTarget(Y.map),r.clear();let tt=Y.getViewportCount();for(let et=0;et<tt;et++){let ut=Y.getViewport(et);a.set(s.x*ut.x,s.y*ut.y,s.x*ut.z,s.y*ut.w),G.viewport(a),Y.updateMatrices(J,et),n=Y.getFrustum(),y(R,U,Y.camera,J,this.type)}Y.isPointLightShadow!==!0&&this.type===vn&&v(Y,U),Y.needsUpdate=!1}p=this.type,g.needsUpdate=!1,r.setRenderTarget(S,E,N)};function v(T,R){let U=t.update(_);d.defines.VSM_SAMPLES!==T.blurSamples&&(d.defines.VSM_SAMPLES=T.blurSamples,f.defines.VSM_SAMPLES=T.blurSamples,d.needsUpdate=!0,f.needsUpdate=!0),T.mapPass===null&&(T.mapPass=new Ke(i.x,i.y)),d.uniforms.shadow_pass.value=T.map.texture,d.uniforms.resolution.value=T.mapSize,d.uniforms.radius.value=T.radius,r.setRenderTarget(T.mapPass),r.clear(),r.renderBufferDirect(R,null,U,d,_,null),f.uniforms.shadow_pass.value=T.mapPass.texture,f.uniforms.resolution.value=T.mapSize,f.uniforms.radius.value=T.radius,r.setRenderTarget(T.map),r.clear(),r.renderBufferDirect(R,null,U,f,_,null)}function x(T,R,U,S){let E=null,N=U.isPointLight===!0?T.customDistanceMaterial:T.customDepthMaterial;if(N!==void 0)E=N;else if(E=U.isPointLight===!0?c:o,r.localClippingEnabled&&R.clipShadows===!0&&Array.isArray(R.clippingPlanes)&&R.clippingPlanes.length!==0||R.displacementMap&&R.displacementScale!==0||R.alphaMap&&R.alphaTest>0||R.map&&R.alphaTest>0){let G=E.uuid,it=R.uuid,I=l[G];I===void 0&&(I={},l[G]=I);let F=I[it];F===void 0&&(F=E.clone(),I[it]=F,R.addEventListener("dispose",C)),E=F}if(E.visible=R.visible,E.wireframe=R.wireframe,S===vn?E.side=R.shadowSide!==null?R.shadowSide:R.side:E.side=R.shadowSide!==null?R.shadowSide:u[R.side],E.alphaMap=R.alphaMap,E.alphaTest=R.alphaTest,E.map=R.map,E.clipShadows=R.clipShadows,E.clippingPlanes=R.clippingPlanes,E.clipIntersection=R.clipIntersection,E.displacementMap=R.displacementMap,E.displacementScale=R.displacementScale,E.displacementBias=R.displacementBias,E.wireframeLinewidth=R.wireframeLinewidth,E.linewidth=R.linewidth,U.isPointLight===!0&&E.isMeshDistanceMaterial===!0){let G=r.properties.get(E);G.light=U}return E}function y(T,R,U,S,E){if(T.visible===!1)return;if(T.layers.test(R.layers)&&(T.isMesh||T.isLine||T.isPoints)&&(T.castShadow||T.receiveShadow&&E===vn)&&(!T.frustumCulled||n.intersectsObject(T))){T.modelViewMatrix.multiplyMatrices(U.matrixWorldInverse,T.matrixWorld);let it=t.update(T),I=T.material;if(Array.isArray(I)){let F=it.groups;for(let k=0,J=F.length;k<J;k++){let Y=F[k],W=I[Y.materialIndex];if(W&&W.visible){let tt=x(T,W,S,E);T.onBeforeShadow(r,T,R,U,it,tt,Y),r.renderBufferDirect(U,null,it,tt,T,Y),T.onAfterShadow(r,T,R,U,it,tt,Y)}}}else if(I.visible){let F=x(T,I,S,E);T.onBeforeShadow(r,T,R,U,it,F,null),r.renderBufferDirect(U,null,it,F,T,null),T.onAfterShadow(r,T,R,U,it,F,null)}}let G=T.children;for(let it=0,I=G.length;it<I;it++)y(G[it],R,U,S,E)}function C(T){T.target.removeEventListener("dispose",C);for(let U in l){let S=l[U],E=T.target.uuid;E in S&&(S[E].dispose(),delete S[E])}}}function dx(r,t,e){let n=e.isWebGL2;function i(){let L=!1,lt=new te,ht=null,Pt=new te(0,0,0,0);return{setMask:function(wt){ht!==wt&&!L&&(r.colorMask(wt,wt,wt,wt),ht=wt)},setLocked:function(wt){L=wt},setClear:function(wt,ee,ne,ve,Ue){Ue===!0&&(wt*=ve,ee*=ve,ne*=ve),lt.set(wt,ee,ne,ve),Pt.equals(lt)===!1&&(r.clearColor(wt,ee,ne,ve),Pt.copy(lt))},reset:function(){L=!1,ht=null,Pt.set(-1,0,0,0)}}}function s(){let L=!1,lt=null,ht=null,Pt=null;return{setTest:function(wt){wt?Nt(r.DEPTH_TEST):St(r.DEPTH_TEST)},setMask:function(wt){lt!==wt&&!L&&(r.depthMask(wt),lt=wt)},setFunc:function(wt){if(ht!==wt){switch(wt){case wf:r.depthFunc(r.NEVER);break;case Rf:r.depthFunc(r.ALWAYS);break;case Cf:r.depthFunc(r.LESS);break;case Gr:r.depthFunc(r.LEQUAL);break;case Pf:r.depthFunc(r.EQUAL);break;case Lf:r.depthFunc(r.GEQUAL);break;case If:r.depthFunc(r.GREATER);break;case Uf:r.depthFunc(r.NOTEQUAL);break;default:r.depthFunc(r.LEQUAL)}ht=wt}},setLocked:function(wt){L=wt},setClear:function(wt){Pt!==wt&&(r.clearDepth(wt),Pt=wt)},reset:function(){L=!1,lt=null,ht=null,Pt=null}}}function a(){let L=!1,lt=null,ht=null,Pt=null,wt=null,ee=null,ne=null,ve=null,Ue=null;return{setTest:function(ie){L||(ie?Nt(r.STENCIL_TEST):St(r.STENCIL_TEST))},setMask:function(ie){lt!==ie&&!L&&(r.stencilMask(ie),lt=ie)},setFunc:function(ie,De,an){(ht!==ie||Pt!==De||wt!==an)&&(r.stencilFunc(ie,De,an),ht=ie,Pt=De,wt=an)},setOp:function(ie,De,an){(ee!==ie||ne!==De||ve!==an)&&(r.stencilOp(ie,De,an),ee=ie,ne=De,ve=an)},setLocked:function(ie){L=ie},setClear:function(ie){Ue!==ie&&(r.clearStencil(ie),Ue=ie)},reset:function(){L=!1,lt=null,ht=null,Pt=null,wt=null,ee=null,ne=null,ve=null,Ue=null}}}let o=new i,c=new s,l=new a,h=new WeakMap,u=new WeakMap,d={},f={},m=new WeakMap,_=[],g=null,p=!1,v=null,x=null,y=null,C=null,T=null,R=null,U=null,S=new pt(0,0,0),E=0,N=!1,G=null,it=null,I=null,F=null,k=null,J=r.getParameter(r.MAX_COMBINED_TEXTURE_IMAGE_UNITS),Y=!1,W=0,tt=r.getParameter(r.VERSION);tt.indexOf("WebGL")!==-1?(W=parseFloat(/^WebGL (\d)/.exec(tt)[1]),Y=W>=1):tt.indexOf("OpenGL ES")!==-1&&(W=parseFloat(/^OpenGL ES (\d)/.exec(tt)[1]),Y=W>=2);let et=null,ut={},H=r.getParameter(r.SCISSOR_BOX),K=r.getParameter(r.VIEWPORT),dt=new te().fromArray(H),Mt=new te().fromArray(K);function gt(L,lt,ht,Pt){let wt=new Uint8Array(4),ee=r.createTexture();r.bindTexture(L,ee),r.texParameteri(L,r.TEXTURE_MIN_FILTER,r.NEAREST),r.texParameteri(L,r.TEXTURE_MAG_FILTER,r.NEAREST);for(let ne=0;ne<ht;ne++)n&&(L===r.TEXTURE_3D||L===r.TEXTURE_2D_ARRAY)?r.texImage3D(lt,0,r.RGBA,1,1,Pt,0,r.RGBA,r.UNSIGNED_BYTE,wt):r.texImage2D(lt+ne,0,r.RGBA,1,1,0,r.RGBA,r.UNSIGNED_BYTE,wt);return ee}let Ct={};Ct[r.TEXTURE_2D]=gt(r.TEXTURE_2D,r.TEXTURE_2D,1),Ct[r.TEXTURE_CUBE_MAP]=gt(r.TEXTURE_CUBE_MAP,r.TEXTURE_CUBE_MAP_POSITIVE_X,6),n&&(Ct[r.TEXTURE_2D_ARRAY]=gt(r.TEXTURE_2D_ARRAY,r.TEXTURE_2D_ARRAY,1,1),Ct[r.TEXTURE_3D]=gt(r.TEXTURE_3D,r.TEXTURE_3D,1,1)),o.setClear(0,0,0,1),c.setClear(1),l.setClear(0),Nt(r.DEPTH_TEST),c.setFunc(Gr),ft(!1),b(Ml),Nt(r.CULL_FACE),X(zn);function Nt(L){d[L]!==!0&&(r.enable(L),d[L]=!0)}function St(L){d[L]!==!1&&(r.disable(L),d[L]=!1)}function Ut(L,lt){return f[L]!==lt?(r.bindFramebuffer(L,lt),f[L]=lt,n&&(L===r.DRAW_FRAMEBUFFER&&(f[r.FRAMEBUFFER]=lt),L===r.FRAMEBUFFER&&(f[r.DRAW_FRAMEBUFFER]=lt)),!0):!1}function P(L,lt){let ht=_,Pt=!1;if(L)if(ht=m.get(lt),ht===void 0&&(ht=[],m.set(lt,ht)),L.isWebGLMultipleRenderTargets){let wt=L.texture;if(ht.length!==wt.length||ht[0]!==r.COLOR_ATTACHMENT0){for(let ee=0,ne=wt.length;ee<ne;ee++)ht[ee]=r.COLOR_ATTACHMENT0+ee;ht.length=wt.length,Pt=!0}}else ht[0]!==r.COLOR_ATTACHMENT0&&(ht[0]=r.COLOR_ATTACHMENT0,Pt=!0);else ht[0]!==r.BACK&&(ht[0]=r.BACK,Pt=!0);Pt&&(e.isWebGL2?r.drawBuffers(ht):t.get("WEBGL_draw_buffers").drawBuffersWEBGL(ht))}function rt(L){return g!==L?(r.useProgram(L),g=L,!0):!1}let q={[oi]:r.FUNC_ADD,[df]:r.FUNC_SUBTRACT,[ff]:r.FUNC_REVERSE_SUBTRACT};if(n)q[Al]=r.MIN,q[Tl]=r.MAX;else{let L=t.get("EXT_blend_minmax");L!==null&&(q[Al]=L.MIN_EXT,q[Tl]=L.MAX_EXT)}let st={[pf]:r.ZERO,[mf]:r.ONE,[gf]:r.SRC_COLOR,[wo]:r.SRC_ALPHA,[Sf]:r.SRC_ALPHA_SATURATE,[yf]:r.DST_COLOR,[xf]:r.DST_ALPHA,[_f]:r.ONE_MINUS_SRC_COLOR,[Ro]:r.ONE_MINUS_SRC_ALPHA,[Mf]:r.ONE_MINUS_DST_COLOR,[vf]:r.ONE_MINUS_DST_ALPHA,[bf]:r.CONSTANT_COLOR,[Ef]:r.ONE_MINUS_CONSTANT_COLOR,[Af]:r.CONSTANT_ALPHA,[Tf]:r.ONE_MINUS_CONSTANT_ALPHA};function X(L,lt,ht,Pt,wt,ee,ne,ve,Ue,ie){if(L===zn){p===!0&&(St(r.BLEND),p=!1);return}if(p===!1&&(Nt(r.BLEND),p=!0),L!==uf){if(L!==v||ie!==N){if((x!==oi||T!==oi)&&(r.blendEquation(r.FUNC_ADD),x=oi,T=oi),ie)switch(L){case Ki:r.blendFuncSeparate(r.ONE,r.ONE_MINUS_SRC_ALPHA,r.ONE,r.ONE_MINUS_SRC_ALPHA);break;case Sl:r.blendFunc(r.ONE,r.ONE);break;case bl:r.blendFuncSeparate(r.ZERO,r.ONE_MINUS_SRC_COLOR,r.ZERO,r.ONE);break;case El:r.blendFuncSeparate(r.ZERO,r.SRC_COLOR,r.ZERO,r.SRC_ALPHA);break;default:console.error("THREE.WebGLState: Invalid blending: ",L);break}else switch(L){case Ki:r.blendFuncSeparate(r.SRC_ALPHA,r.ONE_MINUS_SRC_ALPHA,r.ONE,r.ONE_MINUS_SRC_ALPHA);break;case Sl:r.blendFunc(r.SRC_ALPHA,r.ONE);break;case bl:r.blendFuncSeparate(r.ZERO,r.ONE_MINUS_SRC_COLOR,r.ZERO,r.ONE);break;case El:r.blendFunc(r.ZERO,r.SRC_COLOR);break;default:console.error("THREE.WebGLState: Invalid blending: ",L);break}y=null,C=null,R=null,U=null,S.set(0,0,0),E=0,v=L,N=ie}return}wt=wt||lt,ee=ee||ht,ne=ne||Pt,(lt!==x||wt!==T)&&(r.blendEquationSeparate(q[lt],q[wt]),x=lt,T=wt),(ht!==y||Pt!==C||ee!==R||ne!==U)&&(r.blendFuncSeparate(st[ht],st[Pt],st[ee],st[ne]),y=ht,C=Pt,R=ee,U=ne),(ve.equals(S)===!1||Ue!==E)&&(r.blendColor(ve.r,ve.g,ve.b,Ue),S.copy(ve),E=Ue),v=L,N=!1}function Et(L,lt){L.side===Mn?St(r.CULL_FACE):Nt(r.CULL_FACE);let ht=L.side===He;lt&&(ht=!ht),ft(ht),L.blending===Ki&&L.transparent===!1?X(zn):X(L.blending,L.blendEquation,L.blendSrc,L.blendDst,L.blendEquationAlpha,L.blendSrcAlpha,L.blendDstAlpha,L.blendColor,L.blendAlpha,L.premultipliedAlpha),c.setFunc(L.depthFunc),c.setTest(L.depthTest),c.setMask(L.depthWrite),o.setMask(L.colorWrite);let Pt=L.stencilWrite;l.setTest(Pt),Pt&&(l.setMask(L.stencilWriteMask),l.setFunc(L.stencilFunc,L.stencilRef,L.stencilFuncMask),l.setOp(L.stencilFail,L.stencilZFail,L.stencilZPass)),O(L.polygonOffset,L.polygonOffsetFactor,L.polygonOffsetUnits),L.alphaToCoverage===!0?Nt(r.SAMPLE_ALPHA_TO_COVERAGE):St(r.SAMPLE_ALPHA_TO_COVERAGE)}function ft(L){G!==L&&(L?r.frontFace(r.CW):r.frontFace(r.CCW),G=L)}function b(L){L!==cf?(Nt(r.CULL_FACE),L!==it&&(L===Ml?r.cullFace(r.BACK):L===lf?r.cullFace(r.FRONT):r.cullFace(r.FRONT_AND_BACK))):St(r.CULL_FACE),it=L}function M(L){L!==I&&(Y&&r.lineWidth(L),I=L)}function O(L,lt,ht){L?(Nt(r.POLYGON_OFFSET_FILL),(F!==lt||k!==ht)&&(r.polygonOffset(lt,ht),F=lt,k=ht)):St(r.POLYGON_OFFSET_FILL)}function nt(L){L?Nt(r.SCISSOR_TEST):St(r.SCISSOR_TEST)}function Q(L){L===void 0&&(L=r.TEXTURE0+J-1),et!==L&&(r.activeTexture(L),et=L)}function $(L,lt,ht){ht===void 0&&(et===null?ht=r.TEXTURE0+J-1:ht=et);let Pt=ut[ht];Pt===void 0&&(Pt={type:void 0,texture:void 0},ut[ht]=Pt),(Pt.type!==L||Pt.texture!==lt)&&(et!==ht&&(r.activeTexture(ht),et=ht),r.bindTexture(L,lt||Ct[L]),Pt.type=L,Pt.texture=lt)}function yt(){let L=ut[et];L!==void 0&&L.type!==void 0&&(r.bindTexture(L.type,null),L.type=void 0,L.texture=void 0)}function ct(){try{r.compressedTexImage2D.apply(r,arguments)}catch(L){console.error("THREE.WebGLState:",L)}}function _t(){try{r.compressedTexImage3D.apply(r,arguments)}catch(L){console.error("THREE.WebGLState:",L)}}function Tt(){try{r.texSubImage2D.apply(r,arguments)}catch(L){console.error("THREE.WebGLState:",L)}}function Ft(){try{r.texSubImage3D.apply(r,arguments)}catch(L){console.error("THREE.WebGLState:",L)}}function j(){try{r.compressedTexSubImage2D.apply(r,arguments)}catch(L){console.error("THREE.WebGLState:",L)}}function Zt(){try{r.compressedTexSubImage3D.apply(r,arguments)}catch(L){console.error("THREE.WebGLState:",L)}}function Yt(){try{r.texStorage2D.apply(r,arguments)}catch(L){console.error("THREE.WebGLState:",L)}}function Dt(){try{r.texStorage3D.apply(r,arguments)}catch(L){console.error("THREE.WebGLState:",L)}}function At(){try{r.texImage2D.apply(r,arguments)}catch(L){console.error("THREE.WebGLState:",L)}}function vt(){try{r.texImage3D.apply(r,arguments)}catch(L){console.error("THREE.WebGLState:",L)}}function Vt(L){dt.equals(L)===!1&&(r.scissor(L.x,L.y,L.z,L.w),dt.copy(L))}function $t(L){Mt.equals(L)===!1&&(r.viewport(L.x,L.y,L.z,L.w),Mt.copy(L))}function oe(L,lt){let ht=u.get(lt);ht===void 0&&(ht=new WeakMap,u.set(lt,ht));let Pt=ht.get(L);Pt===void 0&&(Pt=r.getUniformBlockIndex(lt,L.name),ht.set(L,Pt))}function Xt(L,lt){let Pt=u.get(lt).get(L);h.get(lt)!==Pt&&(r.uniformBlockBinding(lt,Pt,L.__bindingPointIndex),h.set(lt,Pt))}function at(){r.disable(r.BLEND),r.disable(r.CULL_FACE),r.disable(r.DEPTH_TEST),r.disable(r.POLYGON_OFFSET_FILL),r.disable(r.SCISSOR_TEST),r.disable(r.STENCIL_TEST),r.disable(r.SAMPLE_ALPHA_TO_COVERAGE),r.blendEquation(r.FUNC_ADD),r.blendFunc(r.ONE,r.ZERO),r.blendFuncSeparate(r.ONE,r.ZERO,r.ONE,r.ZERO),r.blendColor(0,0,0,0),r.colorMask(!0,!0,!0,!0),r.clearColor(0,0,0,0),r.depthMask(!0),r.depthFunc(r.LESS),r.clearDepth(1),r.stencilMask(4294967295),r.stencilFunc(r.ALWAYS,0,4294967295),r.stencilOp(r.KEEP,r.KEEP,r.KEEP),r.clearStencil(0),r.cullFace(r.BACK),r.frontFace(r.CCW),r.polygonOffset(0,0),r.activeTexture(r.TEXTURE0),r.bindFramebuffer(r.FRAMEBUFFER,null),n===!0&&(r.bindFramebuffer(r.DRAW_FRAMEBUFFER,null),r.bindFramebuffer(r.READ_FRAMEBUFFER,null)),r.useProgram(null),r.lineWidth(1),r.scissor(0,0,r.canvas.width,r.canvas.height),r.viewport(0,0,r.canvas.width,r.canvas.height),d={},et=null,ut={},f={},m=new WeakMap,_=[],g=null,p=!1,v=null,x=null,y=null,C=null,T=null,R=null,U=null,S=new pt(0,0,0),E=0,N=!1,G=null,it=null,I=null,F=null,k=null,dt.set(0,0,r.canvas.width,r.canvas.height),Mt.set(0,0,r.canvas.width,r.canvas.height),o.reset(),c.reset(),l.reset()}return{buffers:{color:o,depth:c,stencil:l},enable:Nt,disable:St,bindFramebuffer:Ut,drawBuffers:P,useProgram:rt,setBlending:X,setMaterial:Et,setFlipSided:ft,setCullFace:b,setLineWidth:M,setPolygonOffset:O,setScissorTest:nt,activeTexture:Q,bindTexture:$,unbindTexture:yt,compressedTexImage2D:ct,compressedTexImage3D:_t,texImage2D:At,texImage3D:vt,updateUBOMapping:oe,uniformBlockBinding:Xt,texStorage2D:Yt,texStorage3D:Dt,texSubImage2D:Tt,texSubImage3D:Ft,compressedTexSubImage2D:j,compressedTexSubImage3D:Zt,scissor:Vt,viewport:$t,reset:at}}function fx(r,t,e,n,i,s,a){let o=i.isWebGL2,c=t.has("WEBGL_multisampled_render_to_texture")?t.get("WEBGL_multisampled_render_to_texture"):null,l=typeof navigator>"u"?!1:/OculusBrowser/g.test(navigator.userAgent),h=new WeakMap,u,d=new WeakMap,f=!1;try{f=typeof OffscreenCanvas<"u"&&new OffscreenCanvas(1,1).getContext("2d")!==null}catch{}function m(b,M){return f?new OffscreenCanvas(b,M):Ds("canvas")}function _(b,M,O,nt){let Q=1;if((b.width>nt||b.height>nt)&&(Q=nt/Math.max(b.width,b.height)),Q<1||M===!0)if(typeof HTMLImageElement<"u"&&b instanceof HTMLImageElement||typeof HTMLCanvasElement<"u"&&b instanceof HTMLCanvasElement||typeof ImageBitmap<"u"&&b instanceof ImageBitmap){let $=M?ea:Math.floor,yt=$(Q*b.width),ct=$(Q*b.height);u===void 0&&(u=m(yt,ct));let _t=O?m(yt,ct):u;return _t.width=yt,_t.height=ct,_t.getContext("2d").drawImage(b,0,0,yt,ct),console.warn("THREE.WebGLRenderer: Texture has been resized from ("+b.width+"x"+b.height+") to ("+yt+"x"+ct+")."),_t}else return"data"in b&&console.warn("THREE.WebGLRenderer: Image in DataTexture is too big ("+b.width+"x"+b.height+")."),b;return b}function g(b){return Lo(b.width)&&Lo(b.height)}function p(b){return o?!1:b.wrapS!==Fe||b.wrapT!==Fe||b.minFilter!==pe&&b.minFilter!==me}function v(b,M){return b.generateMipmaps&&M&&b.minFilter!==pe&&b.minFilter!==me}function x(b){r.generateMipmap(b)}function y(b,M,O,nt,Q=!1){if(o===!1)return M;if(b!==null){if(r[b]!==void 0)return r[b];console.warn("THREE.WebGLRenderer: Attempt to use non-existing WebGL internal format '"+b+"'")}let $=M;if(M===r.RED&&(O===r.FLOAT&&($=r.R32F),O===r.HALF_FLOAT&&($=r.R16F),O===r.UNSIGNED_BYTE&&($=r.R8)),M===r.RED_INTEGER&&(O===r.UNSIGNED_BYTE&&($=r.R8UI),O===r.UNSIGNED_SHORT&&($=r.R16UI),O===r.UNSIGNED_INT&&($=r.R32UI),O===r.BYTE&&($=r.R8I),O===r.SHORT&&($=r.R16I),O===r.INT&&($=r.R32I)),M===r.RG&&(O===r.FLOAT&&($=r.RG32F),O===r.HALF_FLOAT&&($=r.RG16F),O===r.UNSIGNED_BYTE&&($=r.RG8)),M===r.RGBA){let yt=Q?Kr:jt.getTransfer(nt);O===r.FLOAT&&($=r.RGBA32F),O===r.HALF_FLOAT&&($=r.RGBA16F),O===r.UNSIGNED_BYTE&&($=yt===se?r.SRGB8_ALPHA8:r.RGBA8),O===r.UNSIGNED_SHORT_4_4_4_4&&($=r.RGBA4),O===r.UNSIGNED_SHORT_5_5_5_1&&($=r.RGB5_A1)}return($===r.R16F||$===r.R32F||$===r.RG16F||$===r.RG32F||$===r.RGBA16F||$===r.RGBA32F)&&t.get("EXT_color_buffer_float"),$}function C(b,M,O){return v(b,O)===!0||b.isFramebufferTexture&&b.minFilter!==pe&&b.minFilter!==me?Math.log2(Math.max(M.width,M.height))+1:b.mipmaps!==void 0&&b.mipmaps.length>0?b.mipmaps.length:b.isCompressedTexture&&Array.isArray(b.image)?M.mipmaps.length:1}function T(b){return b===pe||b===Co||b===Hr?r.NEAREST:r.LINEAR}function R(b){let M=b.target;M.removeEventListener("dispose",R),S(M),M.isVideoTexture&&h.delete(M)}function U(b){let M=b.target;M.removeEventListener("dispose",U),N(M)}function S(b){let M=n.get(b);if(M.__webglInit===void 0)return;let O=b.source,nt=d.get(O);if(nt){let Q=nt[M.__cacheKey];Q.usedTimes--,Q.usedTimes===0&&E(b),Object.keys(nt).length===0&&d.delete(O)}n.remove(b)}function E(b){let M=n.get(b);r.deleteTexture(M.__webglTexture);let O=b.source,nt=d.get(O);delete nt[M.__cacheKey],a.memory.textures--}function N(b){let M=b.texture,O=n.get(b),nt=n.get(M);if(nt.__webglTexture!==void 0&&(r.deleteTexture(nt.__webglTexture),a.memory.textures--),b.depthTexture&&b.depthTexture.dispose(),b.isWebGLCubeRenderTarget)for(let Q=0;Q<6;Q++){if(Array.isArray(O.__webglFramebuffer[Q]))for(let $=0;$<O.__webglFramebuffer[Q].length;$++)r.deleteFramebuffer(O.__webglFramebuffer[Q][$]);else r.deleteFramebuffer(O.__webglFramebuffer[Q]);O.__webglDepthbuffer&&r.deleteRenderbuffer(O.__webglDepthbuffer[Q])}else{if(Array.isArray(O.__webglFramebuffer))for(let Q=0;Q<O.__webglFramebuffer.length;Q++)r.deleteFramebuffer(O.__webglFramebuffer[Q]);else r.deleteFramebuffer(O.__webglFramebuffer);if(O.__webglDepthbuffer&&r.deleteRenderbuffer(O.__webglDepthbuffer),O.__webglMultisampledFramebuffer&&r.deleteFramebuffer(O.__webglMultisampledFramebuffer),O.__webglColorRenderbuffer)for(let Q=0;Q<O.__webglColorRenderbuffer.length;Q++)O.__webglColorRenderbuffer[Q]&&r.deleteRenderbuffer(O.__webglColorRenderbuffer[Q]);O.__webglDepthRenderbuffer&&r.deleteRenderbuffer(O.__webglDepthRenderbuffer)}if(b.isWebGLMultipleRenderTargets)for(let Q=0,$=M.length;Q<$;Q++){let yt=n.get(M[Q]);yt.__webglTexture&&(r.deleteTexture(yt.__webglTexture),a.memory.textures--),n.remove(M[Q])}n.remove(M),n.remove(b)}let G=0;function it(){G=0}function I(){let b=G;return b>=i.maxTextures&&console.warn("THREE.WebGLTextures: Trying to use "+b+" texture units while this GPU supports only "+i.maxTextures),G+=1,b}function F(b){let M=[];return M.push(b.wrapS),M.push(b.wrapT),M.push(b.wrapR||0),M.push(b.magFilter),M.push(b.minFilter),M.push(b.anisotropy),M.push(b.internalFormat),M.push(b.format),M.push(b.type),M.push(b.generateMipmaps),M.push(b.premultiplyAlpha),M.push(b.flipY),M.push(b.unpackAlignment),M.push(b.colorSpace),M.join()}function k(b,M){let O=n.get(b);if(b.isVideoTexture&&Et(b),b.isRenderTargetTexture===!1&&b.version>0&&O.__version!==b.version){let nt=b.image;if(nt===null)console.warn("THREE.WebGLRenderer: Texture marked for update but no image data found.");else if(nt.complete===!1)console.warn("THREE.WebGLRenderer: Texture marked for update but image is incomplete");else{dt(O,b,M);return}}e.bindTexture(r.TEXTURE_2D,O.__webglTexture,r.TEXTURE0+M)}function J(b,M){let O=n.get(b);if(b.version>0&&O.__version!==b.version){dt(O,b,M);return}e.bindTexture(r.TEXTURE_2D_ARRAY,O.__webglTexture,r.TEXTURE0+M)}function Y(b,M){let O=n.get(b);if(b.version>0&&O.__version!==b.version){dt(O,b,M);return}e.bindTexture(r.TEXTURE_3D,O.__webglTexture,r.TEXTURE0+M)}function W(b,M){let O=n.get(b);if(b.version>0&&O.__version!==b.version){Mt(O,b,M);return}e.bindTexture(r.TEXTURE_CUBE_MAP,O.__webglTexture,r.TEXTURE0+M)}let tt={[qr]:r.REPEAT,[Fe]:r.CLAMP_TO_EDGE,[Yr]:r.MIRRORED_REPEAT},et={[pe]:r.NEAREST,[Co]:r.NEAREST_MIPMAP_NEAREST,[Hr]:r.NEAREST_MIPMAP_LINEAR,[me]:r.LINEAR,[Cd]:r.LINEAR_MIPMAP_NEAREST,[gi]:r.LINEAR_MIPMAP_LINEAR},ut={[ip]:r.NEVER,[lp]:r.ALWAYS,[sp]:r.LESS,[zd]:r.LEQUAL,[rp]:r.EQUAL,[cp]:r.GEQUAL,[ap]:r.GREATER,[op]:r.NOTEQUAL};function H(b,M,O){if(O?(r.texParameteri(b,r.TEXTURE_WRAP_S,tt[M.wrapS]),r.texParameteri(b,r.TEXTURE_WRAP_T,tt[M.wrapT]),(b===r.TEXTURE_3D||b===r.TEXTURE_2D_ARRAY)&&r.texParameteri(b,r.TEXTURE_WRAP_R,tt[M.wrapR]),r.texParameteri(b,r.TEXTURE_MAG_FILTER,et[M.magFilter]),r.texParameteri(b,r.TEXTURE_MIN_FILTER,et[M.minFilter])):(r.texParameteri(b,r.TEXTURE_WRAP_S,r.CLAMP_TO_EDGE),r.texParameteri(b,r.TEXTURE_WRAP_T,r.CLAMP_TO_EDGE),(b===r.TEXTURE_3D||b===r.TEXTURE_2D_ARRAY)&&r.texParameteri(b,r.TEXTURE_WRAP_R,r.CLAMP_TO_EDGE),(M.wrapS!==Fe||M.wrapT!==Fe)&&console.warn("THREE.WebGLRenderer: Texture is not power of two. Texture.wrapS and Texture.wrapT should be set to THREE.ClampToEdgeWrapping."),r.texParameteri(b,r.TEXTURE_MAG_FILTER,T(M.magFilter)),r.texParameteri(b,r.TEXTURE_MIN_FILTER,T(M.minFilter)),M.minFilter!==pe&&M.minFilter!==me&&console.warn("THREE.WebGLRenderer: Texture is not power of two. Texture.minFilter should be set to THREE.NearestFilter or THREE.LinearFilter.")),M.compareFunction&&(r.texParameteri(b,r.TEXTURE_COMPARE_MODE,r.COMPARE_REF_TO_TEXTURE),r.texParameteri(b,r.TEXTURE_COMPARE_FUNC,ut[M.compareFunction])),t.has("EXT_texture_filter_anisotropic")===!0){let nt=t.get("EXT_texture_filter_anisotropic");if(M.magFilter===pe||M.minFilter!==Hr&&M.minFilter!==gi||M.type===cn&&t.has("OES_texture_float_linear")===!1||o===!1&&M.type===Is&&t.has("OES_texture_half_float_linear")===!1)return;(M.anisotropy>1||n.get(M).__currentAnisotropy)&&(r.texParameterf(b,nt.TEXTURE_MAX_ANISOTROPY_EXT,Math.min(M.anisotropy,i.getMaxAnisotropy())),n.get(M).__currentAnisotropy=M.anisotropy)}}function K(b,M){let O=!1;b.__webglInit===void 0&&(b.__webglInit=!0,M.addEventListener("dispose",R));let nt=M.source,Q=d.get(nt);Q===void 0&&(Q={},d.set(nt,Q));let $=F(M);if($!==b.__cacheKey){Q[$]===void 0&&(Q[$]={texture:r.createTexture(),usedTimes:0},a.memory.textures++,O=!0),Q[$].usedTimes++;let yt=Q[b.__cacheKey];yt!==void 0&&(Q[b.__cacheKey].usedTimes--,yt.usedTimes===0&&E(M)),b.__cacheKey=$,b.__webglTexture=Q[$].texture}return O}function dt(b,M,O){let nt=r.TEXTURE_2D;(M.isDataArrayTexture||M.isCompressedArrayTexture)&&(nt=r.TEXTURE_2D_ARRAY),M.isData3DTexture&&(nt=r.TEXTURE_3D);let Q=K(b,M),$=M.source;e.bindTexture(nt,b.__webglTexture,r.TEXTURE0+O);let yt=n.get($);if($.version!==yt.__version||Q===!0){e.activeTexture(r.TEXTURE0+O);let ct=jt.getPrimaries(jt.workingColorSpace),_t=M.colorSpace===$e?null:jt.getPrimaries(M.colorSpace),Tt=M.colorSpace===$e||ct===_t?r.NONE:r.BROWSER_DEFAULT_WEBGL;r.pixelStorei(r.UNPACK_FLIP_Y_WEBGL,M.flipY),r.pixelStorei(r.UNPACK_PREMULTIPLY_ALPHA_WEBGL,M.premultiplyAlpha),r.pixelStorei(r.UNPACK_ALIGNMENT,M.unpackAlignment),r.pixelStorei(r.UNPACK_COLORSPACE_CONVERSION_WEBGL,Tt);let Ft=p(M)&&g(M.image)===!1,j=_(M.image,Ft,!1,i.maxTextureSize);j=ft(M,j);let Zt=g(j)||o,Yt=s.convert(M.format,M.colorSpace),Dt=s.convert(M.type),At=y(M.internalFormat,Yt,Dt,M.colorSpace,M.isVideoTexture);H(nt,M,Zt);let vt,Vt=M.mipmaps,$t=o&&M.isVideoTexture!==!0&&At!==Od,oe=yt.__version===void 0||Q===!0,Xt=C(M,j,Zt);if(M.isDepthTexture)At=r.DEPTH_COMPONENT,o?M.type===cn?At=r.DEPTH_COMPONENT32F:M.type===Nn?At=r.DEPTH_COMPONENT24:M.type===ui?At=r.DEPTH24_STENCIL8:At=r.DEPTH_COMPONENT16:M.type===cn&&console.error("WebGLRenderer: Floating point depth texture requires WebGL2."),M.format===di&&At===r.DEPTH_COMPONENT&&M.type!==al&&M.type!==Nn&&(console.warn("THREE.WebGLRenderer: Use UnsignedShortType or UnsignedIntType for DepthFormat DepthTexture."),M.type=Nn,Dt=s.convert(M.type)),M.format===ts&&At===r.DEPTH_COMPONENT&&(At=r.DEPTH_STENCIL,M.type!==ui&&(console.warn("THREE.WebGLRenderer: Use UnsignedInt248Type for DepthStencilFormat DepthTexture."),M.type=ui,Dt=s.convert(M.type))),oe&&($t?e.texStorage2D(r.TEXTURE_2D,1,At,j.width,j.height):e.texImage2D(r.TEXTURE_2D,0,At,j.width,j.height,0,Yt,Dt,null));else if(M.isDataTexture)if(Vt.length>0&&Zt){$t&&oe&&e.texStorage2D(r.TEXTURE_2D,Xt,At,Vt[0].width,Vt[0].height);for(let at=0,L=Vt.length;at<L;at++)vt=Vt[at],$t?e.texSubImage2D(r.TEXTURE_2D,at,0,0,vt.width,vt.height,Yt,Dt,vt.data):e.texImage2D(r.TEXTURE_2D,at,At,vt.width,vt.height,0,Yt,Dt,vt.data);M.generateMipmaps=!1}else $t?(oe&&e.texStorage2D(r.TEXTURE_2D,Xt,At,j.width,j.height),e.texSubImage2D(r.TEXTURE_2D,0,0,0,j.width,j.height,Yt,Dt,j.data)):e.texImage2D(r.TEXTURE_2D,0,At,j.width,j.height,0,Yt,Dt,j.data);else if(M.isCompressedTexture)if(M.isCompressedArrayTexture){$t&&oe&&e.texStorage3D(r.TEXTURE_2D_ARRAY,Xt,At,Vt[0].width,Vt[0].height,j.depth);for(let at=0,L=Vt.length;at<L;at++)vt=Vt[at],M.format!==qe?Yt!==null?$t?e.compressedTexSubImage3D(r.TEXTURE_2D_ARRAY,at,0,0,0,vt.width,vt.height,j.depth,Yt,vt.data,0,0):e.compressedTexImage3D(r.TEXTURE_2D_ARRAY,at,At,vt.width,vt.height,j.depth,0,vt.data,0,0):console.warn("THREE.WebGLRenderer: Attempt to load unsupported compressed texture format in .uploadTexture()"):$t?e.texSubImage3D(r.TEXTURE_2D_ARRAY,at,0,0,0,vt.width,vt.height,j.depth,Yt,Dt,vt.data):e.texImage3D(r.TEXTURE_2D_ARRAY,at,At,vt.width,vt.height,j.depth,0,Yt,Dt,vt.data)}else{$t&&oe&&e.texStorage2D(r.TEXTURE_2D,Xt,At,Vt[0].width,Vt[0].height);for(let at=0,L=Vt.length;at<L;at++)vt=Vt[at],M.format!==qe?Yt!==null?$t?e.compressedTexSubImage2D(r.TEXTURE_2D,at,0,0,vt.width,vt.height,Yt,vt.data):e.compressedTexImage2D(r.TEXTURE_2D,at,At,vt.width,vt.height,0,vt.data):console.warn("THREE.WebGLRenderer: Attempt to load unsupported compressed texture format in .uploadTexture()"):$t?e.texSubImage2D(r.TEXTURE_2D,at,0,0,vt.width,vt.height,Yt,Dt,vt.data):e.texImage2D(r.TEXTURE_2D,at,At,vt.width,vt.height,0,Yt,Dt,vt.data)}else if(M.isDataArrayTexture)$t?(oe&&e.texStorage3D(r.TEXTURE_2D_ARRAY,Xt,At,j.width,j.height,j.depth),e.texSubImage3D(r.TEXTURE_2D_ARRAY,0,0,0,0,j.width,j.height,j.depth,Yt,Dt,j.data)):e.texImage3D(r.TEXTURE_2D_ARRAY,0,At,j.width,j.height,j.depth,0,Yt,Dt,j.data);else if(M.isData3DTexture)$t?(oe&&e.texStorage3D(r.TEXTURE_3D,Xt,At,j.width,j.height,j.depth),e.texSubImage3D(r.TEXTURE_3D,0,0,0,0,j.width,j.height,j.depth,Yt,Dt,j.data)):e.texImage3D(r.TEXTURE_3D,0,At,j.width,j.height,j.depth,0,Yt,Dt,j.data);else if(M.isFramebufferTexture){if(oe)if($t)e.texStorage2D(r.TEXTURE_2D,Xt,At,j.width,j.height);else{let at=j.width,L=j.height;for(let lt=0;lt<Xt;lt++)e.texImage2D(r.TEXTURE_2D,lt,At,at,L,0,Yt,Dt,null),at>>=1,L>>=1}}else if(Vt.length>0&&Zt){$t&&oe&&e.texStorage2D(r.TEXTURE_2D,Xt,At,Vt[0].width,Vt[0].height);for(let at=0,L=Vt.length;at<L;at++)vt=Vt[at],$t?e.texSubImage2D(r.TEXTURE_2D,at,0,0,Yt,Dt,vt):e.texImage2D(r.TEXTURE_2D,at,At,Yt,Dt,vt);M.generateMipmaps=!1}else $t?(oe&&e.texStorage2D(r.TEXTURE_2D,Xt,At,j.width,j.height),e.texSubImage2D(r.TEXTURE_2D,0,0,0,Yt,Dt,j)):e.texImage2D(r.TEXTURE_2D,0,At,Yt,Dt,j);v(M,Zt)&&x(nt),yt.__version=$.version,M.onUpdate&&M.onUpdate(M)}b.__version=M.version}function Mt(b,M,O){if(M.image.length!==6)return;let nt=K(b,M),Q=M.source;e.bindTexture(r.TEXTURE_CUBE_MAP,b.__webglTexture,r.TEXTURE0+O);let $=n.get(Q);if(Q.version!==$.__version||nt===!0){e.activeTexture(r.TEXTURE0+O);let yt=jt.getPrimaries(jt.workingColorSpace),ct=M.colorSpace===$e?null:jt.getPrimaries(M.colorSpace),_t=M.colorSpace===$e||yt===ct?r.NONE:r.BROWSER_DEFAULT_WEBGL;r.pixelStorei(r.UNPACK_FLIP_Y_WEBGL,M.flipY),r.pixelStorei(r.UNPACK_PREMULTIPLY_ALPHA_WEBGL,M.premultiplyAlpha),r.pixelStorei(r.UNPACK_ALIGNMENT,M.unpackAlignment),r.pixelStorei(r.UNPACK_COLORSPACE_CONVERSION_WEBGL,_t);let Tt=M.isCompressedTexture||M.image[0].isCompressedTexture,Ft=M.image[0]&&M.image[0].isDataTexture,j=[];for(let at=0;at<6;at++)!Tt&&!Ft?j[at]=_(M.image[at],!1,!0,i.maxCubemapSize):j[at]=Ft?M.image[at].image:M.image[at],j[at]=ft(M,j[at]);let Zt=j[0],Yt=g(Zt)||o,Dt=s.convert(M.format,M.colorSpace),At=s.convert(M.type),vt=y(M.internalFormat,Dt,At,M.colorSpace),Vt=o&&M.isVideoTexture!==!0,$t=$.__version===void 0||nt===!0,oe=C(M,Zt,Yt);H(r.TEXTURE_CUBE_MAP,M,Yt);let Xt;if(Tt){Vt&&$t&&e.texStorage2D(r.TEXTURE_CUBE_MAP,oe,vt,Zt.width,Zt.height);for(let at=0;at<6;at++){Xt=j[at].mipmaps;for(let L=0;L<Xt.length;L++){let lt=Xt[L];M.format!==qe?Dt!==null?Vt?e.compressedTexSubImage2D(r.TEXTURE_CUBE_MAP_POSITIVE_X+at,L,0,0,lt.width,lt.height,Dt,lt.data):e.compressedTexImage2D(r.TEXTURE_CUBE_MAP_POSITIVE_X+at,L,vt,lt.width,lt.height,0,lt.data):console.warn("THREE.WebGLRenderer: Attempt to load unsupported compressed texture format in .setTextureCube()"):Vt?e.texSubImage2D(r.TEXTURE_CUBE_MAP_POSITIVE_X+at,L,0,0,lt.width,lt.height,Dt,At,lt.data):e.texImage2D(r.TEXTURE_CUBE_MAP_POSITIVE_X+at,L,vt,lt.width,lt.height,0,Dt,At,lt.data)}}}else{Xt=M.mipmaps,Vt&&$t&&(Xt.length>0&&oe++,e.texStorage2D(r.TEXTURE_CUBE_MAP,oe,vt,j[0].width,j[0].height));for(let at=0;at<6;at++)if(Ft){Vt?e.texSubImage2D(r.TEXTURE_CUBE_MAP_POSITIVE_X+at,0,0,0,j[at].width,j[at].height,Dt,At,j[at].data):e.texImage2D(r.TEXTURE_CUBE_MAP_POSITIVE_X+at,0,vt,j[at].width,j[at].height,0,Dt,At,j[at].data);for(let L=0;L<Xt.length;L++){let ht=Xt[L].image[at].image;Vt?e.texSubImage2D(r.TEXTURE_CUBE_MAP_POSITIVE_X+at,L+1,0,0,ht.width,ht.height,Dt,At,ht.data):e.texImage2D(r.TEXTURE_CUBE_MAP_POSITIVE_X+at,L+1,vt,ht.width,ht.height,0,Dt,At,ht.data)}}else{Vt?e.texSubImage2D(r.TEXTURE_CUBE_MAP_POSITIVE_X+at,0,0,0,Dt,At,j[at]):e.texImage2D(r.TEXTURE_CUBE_MAP_POSITIVE_X+at,0,vt,Dt,At,j[at]);for(let L=0;L<Xt.length;L++){let lt=Xt[L];Vt?e.texSubImage2D(r.TEXTURE_CUBE_MAP_POSITIVE_X+at,L+1,0,0,Dt,At,lt.image[at]):e.texImage2D(r.TEXTURE_CUBE_MAP_POSITIVE_X+at,L+1,vt,Dt,At,lt.image[at])}}}v(M,Yt)&&x(r.TEXTURE_CUBE_MAP),$.__version=Q.version,M.onUpdate&&M.onUpdate(M)}b.__version=M.version}function gt(b,M,O,nt,Q,$){let yt=s.convert(O.format,O.colorSpace),ct=s.convert(O.type),_t=y(O.internalFormat,yt,ct,O.colorSpace);if(!n.get(M).__hasExternalTextures){let Ft=Math.max(1,M.width>>$),j=Math.max(1,M.height>>$);Q===r.TEXTURE_3D||Q===r.TEXTURE_2D_ARRAY?e.texImage3D(Q,$,_t,Ft,j,M.depth,0,yt,ct,null):e.texImage2D(Q,$,_t,Ft,j,0,yt,ct,null)}e.bindFramebuffer(r.FRAMEBUFFER,b),X(M)?c.framebufferTexture2DMultisampleEXT(r.FRAMEBUFFER,nt,Q,n.get(O).__webglTexture,0,st(M)):(Q===r.TEXTURE_2D||Q>=r.TEXTURE_CUBE_MAP_POSITIVE_X&&Q<=r.TEXTURE_CUBE_MAP_NEGATIVE_Z)&&r.framebufferTexture2D(r.FRAMEBUFFER,nt,Q,n.get(O).__webglTexture,$),e.bindFramebuffer(r.FRAMEBUFFER,null)}function Ct(b,M,O){if(r.bindRenderbuffer(r.RENDERBUFFER,b),M.depthBuffer&&!M.stencilBuffer){let nt=o===!0?r.DEPTH_COMPONENT24:r.DEPTH_COMPONENT16;if(O||X(M)){let Q=M.depthTexture;Q&&Q.isDepthTexture&&(Q.type===cn?nt=r.DEPTH_COMPONENT32F:Q.type===Nn&&(nt=r.DEPTH_COMPONENT24));let $=st(M);X(M)?c.renderbufferStorageMultisampleEXT(r.RENDERBUFFER,$,nt,M.width,M.height):r.renderbufferStorageMultisample(r.RENDERBUFFER,$,nt,M.width,M.height)}else r.renderbufferStorage(r.RENDERBUFFER,nt,M.width,M.height);r.framebufferRenderbuffer(r.FRAMEBUFFER,r.DEPTH_ATTACHMENT,r.RENDERBUFFER,b)}else if(M.depthBuffer&&M.stencilBuffer){let nt=st(M);O&&X(M)===!1?r.renderbufferStorageMultisample(r.RENDERBUFFER,nt,r.DEPTH24_STENCIL8,M.width,M.height):X(M)?c.renderbufferStorageMultisampleEXT(r.RENDERBUFFER,nt,r.DEPTH24_STENCIL8,M.width,M.height):r.renderbufferStorage(r.RENDERBUFFER,r.DEPTH_STENCIL,M.width,M.height),r.framebufferRenderbuffer(r.FRAMEBUFFER,r.DEPTH_STENCIL_ATTACHMENT,r.RENDERBUFFER,b)}else{let nt=M.isWebGLMultipleRenderTargets===!0?M.texture:[M.texture];for(let Q=0;Q<nt.length;Q++){let $=nt[Q],yt=s.convert($.format,$.colorSpace),ct=s.convert($.type),_t=y($.internalFormat,yt,ct,$.colorSpace),Tt=st(M);O&&X(M)===!1?r.renderbufferStorageMultisample(r.RENDERBUFFER,Tt,_t,M.width,M.height):X(M)?c.renderbufferStorageMultisampleEXT(r.RENDERBUFFER,Tt,_t,M.width,M.height):r.renderbufferStorage(r.RENDERBUFFER,_t,M.width,M.height)}}r.bindRenderbuffer(r.RENDERBUFFER,null)}function Nt(b,M){if(M&&M.isWebGLCubeRenderTarget)throw new Error("Depth Texture with cube render targets is not supported");if(e.bindFramebuffer(r.FRAMEBUFFER,b),!(M.depthTexture&&M.depthTexture.isDepthTexture))throw new Error("renderTarget.depthTexture must be an instance of THREE.DepthTexture");(!n.get(M.depthTexture).__webglTexture||M.depthTexture.image.width!==M.width||M.depthTexture.image.height!==M.height)&&(M.depthTexture.image.width=M.width,M.depthTexture.image.height=M.height,M.depthTexture.needsUpdate=!0),k(M.depthTexture,0);let nt=n.get(M.depthTexture).__webglTexture,Q=st(M);if(M.depthTexture.format===di)X(M)?c.framebufferTexture2DMultisampleEXT(r.FRAMEBUFFER,r.DEPTH_ATTACHMENT,r.TEXTURE_2D,nt,0,Q):r.framebufferTexture2D(r.FRAMEBUFFER,r.DEPTH_ATTACHMENT,r.TEXTURE_2D,nt,0);else if(M.depthTexture.format===ts)X(M)?c.framebufferTexture2DMultisampleEXT(r.FRAMEBUFFER,r.DEPTH_STENCIL_ATTACHMENT,r.TEXTURE_2D,nt,0,Q):r.framebufferTexture2D(r.FRAMEBUFFER,r.DEPTH_STENCIL_ATTACHMENT,r.TEXTURE_2D,nt,0);else throw new Error("Unknown depthTexture format")}function St(b){let M=n.get(b),O=b.isWebGLCubeRenderTarget===!0;if(b.depthTexture&&!M.__autoAllocateDepthBuffer){if(O)throw new Error("target.depthTexture not supported in Cube render targets");Nt(M.__webglFramebuffer,b)}else if(O){M.__webglDepthbuffer=[];for(let nt=0;nt<6;nt++)e.bindFramebuffer(r.FRAMEBUFFER,M.__webglFramebuffer[nt]),M.__webglDepthbuffer[nt]=r.createRenderbuffer(),Ct(M.__webglDepthbuffer[nt],b,!1)}else e.bindFramebuffer(r.FRAMEBUFFER,M.__webglFramebuffer),M.__webglDepthbuffer=r.createRenderbuffer(),Ct(M.__webglDepthbuffer,b,!1);e.bindFramebuffer(r.FRAMEBUFFER,null)}function Ut(b,M,O){let nt=n.get(b);M!==void 0&&gt(nt.__webglFramebuffer,b,b.texture,r.COLOR_ATTACHMENT0,r.TEXTURE_2D,0),O!==void 0&&St(b)}function P(b){let M=b.texture,O=n.get(b),nt=n.get(M);b.addEventListener("dispose",U),b.isWebGLMultipleRenderTargets!==!0&&(nt.__webglTexture===void 0&&(nt.__webglTexture=r.createTexture()),nt.__version=M.version,a.memory.textures++);let Q=b.isWebGLCubeRenderTarget===!0,$=b.isWebGLMultipleRenderTargets===!0,yt=g(b)||o;if(Q){O.__webglFramebuffer=[];for(let ct=0;ct<6;ct++)if(o&&M.mipmaps&&M.mipmaps.length>0){O.__webglFramebuffer[ct]=[];for(let _t=0;_t<M.mipmaps.length;_t++)O.__webglFramebuffer[ct][_t]=r.createFramebuffer()}else O.__webglFramebuffer[ct]=r.createFramebuffer()}else{if(o&&M.mipmaps&&M.mipmaps.length>0){O.__webglFramebuffer=[];for(let ct=0;ct<M.mipmaps.length;ct++)O.__webglFramebuffer[ct]=r.createFramebuffer()}else O.__webglFramebuffer=r.createFramebuffer();if($)if(i.drawBuffers){let ct=b.texture;for(let _t=0,Tt=ct.length;_t<Tt;_t++){let Ft=n.get(ct[_t]);Ft.__webglTexture===void 0&&(Ft.__webglTexture=r.createTexture(),a.memory.textures++)}}else console.warn("THREE.WebGLRenderer: WebGLMultipleRenderTargets can only be used with WebGL2 or WEBGL_draw_buffers extension.");if(o&&b.samples>0&&X(b)===!1){let ct=$?M:[M];O.__webglMultisampledFramebuffer=r.createFramebuffer(),O.__webglColorRenderbuffer=[],e.bindFramebuffer(r.FRAMEBUFFER,O.__webglMultisampledFramebuffer);for(let _t=0;_t<ct.length;_t++){let Tt=ct[_t];O.__webglColorRenderbuffer[_t]=r.createRenderbuffer(),r.bindRenderbuffer(r.RENDERBUFFER,O.__webglColorRenderbuffer[_t]);let Ft=s.convert(Tt.format,Tt.colorSpace),j=s.convert(Tt.type),Zt=y(Tt.internalFormat,Ft,j,Tt.colorSpace,b.isXRRenderTarget===!0),Yt=st(b);r.renderbufferStorageMultisample(r.RENDERBUFFER,Yt,Zt,b.width,b.height),r.framebufferRenderbuffer(r.FRAMEBUFFER,r.COLOR_ATTACHMENT0+_t,r.RENDERBUFFER,O.__webglColorRenderbuffer[_t])}r.bindRenderbuffer(r.RENDERBUFFER,null),b.depthBuffer&&(O.__webglDepthRenderbuffer=r.createRenderbuffer(),Ct(O.__webglDepthRenderbuffer,b,!0)),e.bindFramebuffer(r.FRAMEBUFFER,null)}}if(Q){e.bindTexture(r.TEXTURE_CUBE_MAP,nt.__webglTexture),H(r.TEXTURE_CUBE_MAP,M,yt);for(let ct=0;ct<6;ct++)if(o&&M.mipmaps&&M.mipmaps.length>0)for(let _t=0;_t<M.mipmaps.length;_t++)gt(O.__webglFramebuffer[ct][_t],b,M,r.COLOR_ATTACHMENT0,r.TEXTURE_CUBE_MAP_POSITIVE_X+ct,_t);else gt(O.__webglFramebuffer[ct],b,M,r.COLOR_ATTACHMENT0,r.TEXTURE_CUBE_MAP_POSITIVE_X+ct,0);v(M,yt)&&x(r.TEXTURE_CUBE_MAP),e.unbindTexture()}else if($){let ct=b.texture;for(let _t=0,Tt=ct.length;_t<Tt;_t++){let Ft=ct[_t],j=n.get(Ft);e.bindTexture(r.TEXTURE_2D,j.__webglTexture),H(r.TEXTURE_2D,Ft,yt),gt(O.__webglFramebuffer,b,Ft,r.COLOR_ATTACHMENT0+_t,r.TEXTURE_2D,0),v(Ft,yt)&&x(r.TEXTURE_2D)}e.unbindTexture()}else{let ct=r.TEXTURE_2D;if((b.isWebGL3DRenderTarget||b.isWebGLArrayRenderTarget)&&(o?ct=b.isWebGL3DRenderTarget?r.TEXTURE_3D:r.TEXTURE_2D_ARRAY:console.error("THREE.WebGLTextures: THREE.Data3DTexture and THREE.DataArrayTexture only supported with WebGL2.")),e.bindTexture(ct,nt.__webglTexture),H(ct,M,yt),o&&M.mipmaps&&M.mipmaps.length>0)for(let _t=0;_t<M.mipmaps.length;_t++)gt(O.__webglFramebuffer[_t],b,M,r.COLOR_ATTACHMENT0,ct,_t);else gt(O.__webglFramebuffer,b,M,r.COLOR_ATTACHMENT0,ct,0);v(M,yt)&&x(ct),e.unbindTexture()}b.depthBuffer&&St(b)}function rt(b){let M=g(b)||o,O=b.isWebGLMultipleRenderTargets===!0?b.texture:[b.texture];for(let nt=0,Q=O.length;nt<Q;nt++){let $=O[nt];if(v($,M)){let yt=b.isWebGLCubeRenderTarget?r.TEXTURE_CUBE_MAP:r.TEXTURE_2D,ct=n.get($).__webglTexture;e.bindTexture(yt,ct),x(yt),e.unbindTexture()}}}function q(b){if(o&&b.samples>0&&X(b)===!1){let M=b.isWebGLMultipleRenderTargets?b.texture:[b.texture],O=b.width,nt=b.height,Q=r.COLOR_BUFFER_BIT,$=[],yt=b.stencilBuffer?r.DEPTH_STENCIL_ATTACHMENT:r.DEPTH_ATTACHMENT,ct=n.get(b),_t=b.isWebGLMultipleRenderTargets===!0;if(_t)for(let Tt=0;Tt<M.length;Tt++)e.bindFramebuffer(r.FRAMEBUFFER,ct.__webglMultisampledFramebuffer),r.framebufferRenderbuffer(r.FRAMEBUFFER,r.COLOR_ATTACHMENT0+Tt,r.RENDERBUFFER,null),e.bindFramebuffer(r.FRAMEBUFFER,ct.__webglFramebuffer),r.framebufferTexture2D(r.DRAW_FRAMEBUFFER,r.COLOR_ATTACHMENT0+Tt,r.TEXTURE_2D,null,0);e.bindFramebuffer(r.READ_FRAMEBUFFER,ct.__webglMultisampledFramebuffer),e.bindFramebuffer(r.DRAW_FRAMEBUFFER,ct.__webglFramebuffer);for(let Tt=0;Tt<M.length;Tt++){$.push(r.COLOR_ATTACHMENT0+Tt),b.depthBuffer&&$.push(yt);let Ft=ct.__ignoreDepthValues!==void 0?ct.__ignoreDepthValues:!1;if(Ft===!1&&(b.depthBuffer&&(Q|=r.DEPTH_BUFFER_BIT),b.stencilBuffer&&(Q|=r.STENCIL_BUFFER_BIT)),_t&&r.framebufferRenderbuffer(r.READ_FRAMEBUFFER,r.COLOR_ATTACHMENT0,r.RENDERBUFFER,ct.__webglColorRenderbuffer[Tt]),Ft===!0&&(r.invalidateFramebuffer(r.READ_FRAMEBUFFER,[yt]),r.invalidateFramebuffer(r.DRAW_FRAMEBUFFER,[yt])),_t){let j=n.get(M[Tt]).__webglTexture;r.framebufferTexture2D(r.DRAW_FRAMEBUFFER,r.COLOR_ATTACHMENT0,r.TEXTURE_2D,j,0)}r.blitFramebuffer(0,0,O,nt,0,0,O,nt,Q,r.NEAREST),l&&r.invalidateFramebuffer(r.READ_FRAMEBUFFER,$)}if(e.bindFramebuffer(r.READ_FRAMEBUFFER,null),e.bindFramebuffer(r.DRAW_FRAMEBUFFER,null),_t)for(let Tt=0;Tt<M.length;Tt++){e.bindFramebuffer(r.FRAMEBUFFER,ct.__webglMultisampledFramebuffer),r.framebufferRenderbuffer(r.FRAMEBUFFER,r.COLOR_ATTACHMENT0+Tt,r.RENDERBUFFER,ct.__webglColorRenderbuffer[Tt]);let Ft=n.get(M[Tt]).__webglTexture;e.bindFramebuffer(r.FRAMEBUFFER,ct.__webglFramebuffer),r.framebufferTexture2D(r.DRAW_FRAMEBUFFER,r.COLOR_ATTACHMENT0+Tt,r.TEXTURE_2D,Ft,0)}e.bindFramebuffer(r.DRAW_FRAMEBUFFER,ct.__webglMultisampledFramebuffer)}}function st(b){return Math.min(i.maxSamples,b.samples)}function X(b){let M=n.get(b);return o&&b.samples>0&&t.has("WEBGL_multisampled_render_to_texture")===!0&&M.__useRenderToTexture!==!1}function Et(b){let M=a.render.frame;h.get(b)!==M&&(h.set(b,M),b.update())}function ft(b,M){let O=b.colorSpace,nt=b.format,Q=b.type;return b.isCompressedTexture===!0||b.isVideoTexture===!0||b.format===Po||O!==En&&O!==$e&&(jt.getTransfer(O)===se?o===!1?t.has("EXT_sRGB")===!0&&nt===qe?(b.format=Po,b.minFilter=me,b.generateMipmaps=!1):M=na.sRGBToLinear(M):(nt!==qe||Q!==kn)&&console.warn("THREE.WebGLTextures: sRGB encoded textures have to use RGBAFormat and UnsignedByteType."):console.error("THREE.WebGLTextures: Unsupported texture color space:",O)),M}this.allocateTextureUnit=I,this.resetTextureUnits=it,this.setTexture2D=k,this.setTexture2DArray=J,this.setTexture3D=Y,this.setTextureCube=W,this.rebindTextures=Ut,this.setupRenderTarget=P,this.updateRenderTargetMipmap=rt,this.updateMultisampleRenderTarget=q,this.setupDepthRenderbuffer=St,this.setupFrameBufferTexture=gt,this.useMultisampledRTT=X}function px(r,t,e){let n=e.isWebGL2;function i(s,a=$e){let o,c=jt.getTransfer(a);if(s===kn)return r.UNSIGNED_BYTE;if(s===Ld)return r.UNSIGNED_SHORT_4_4_4_4;if(s===Id)return r.UNSIGNED_SHORT_5_5_5_1;if(s===Gf)return r.BYTE;if(s===Wf)return r.SHORT;if(s===al)return r.UNSIGNED_SHORT;if(s===Pd)return r.INT;if(s===Nn)return r.UNSIGNED_INT;if(s===cn)return r.FLOAT;if(s===Is)return n?r.HALF_FLOAT:(o=t.get("OES_texture_half_float"),o!==null?o.HALF_FLOAT_OES:null);if(s===Xf)return r.ALPHA;if(s===qe)return r.RGBA;if(s===qf)return r.LUMINANCE;if(s===Yf)return r.LUMINANCE_ALPHA;if(s===di)return r.DEPTH_COMPONENT;if(s===ts)return r.DEPTH_STENCIL;if(s===Po)return o=t.get("EXT_sRGB"),o!==null?o.SRGB_ALPHA_EXT:null;if(s===Zf)return r.RED;if(s===Ud)return r.RED_INTEGER;if(s===Jf)return r.RG;if(s===Dd)return r.RG_INTEGER;if(s===Nd)return r.RGBA_INTEGER;if(s===Ba||s===za||s===Va||s===ka)if(c===se)if(o=t.get("WEBGL_compressed_texture_s3tc_srgb"),o!==null){if(s===Ba)return o.COMPRESSED_SRGB_S3TC_DXT1_EXT;if(s===za)return o.COMPRESSED_SRGB_ALPHA_S3TC_DXT1_EXT;if(s===Va)return o.COMPRESSED_SRGB_ALPHA_S3TC_DXT3_EXT;if(s===ka)return o.COMPRESSED_SRGB_ALPHA_S3TC_DXT5_EXT}else return null;else if(o=t.get("WEBGL_compressed_texture_s3tc"),o!==null){if(s===Ba)return o.COMPRESSED_RGB_S3TC_DXT1_EXT;if(s===za)return o.COMPRESSED_RGBA_S3TC_DXT1_EXT;if(s===Va)return o.COMPRESSED_RGBA_S3TC_DXT3_EXT;if(s===ka)return o.COMPRESSED_RGBA_S3TC_DXT5_EXT}else return null;if(s===Rl||s===Cl||s===Pl||s===Ll)if(o=t.get("WEBGL_compressed_texture_pvrtc"),o!==null){if(s===Rl)return o.COMPRESSED_RGB_PVRTC_4BPPV1_IMG;if(s===Cl)return o.COMPRESSED_RGB_PVRTC_2BPPV1_IMG;if(s===Pl)return o.COMPRESSED_RGBA_PVRTC_4BPPV1_IMG;if(s===Ll)return o.COMPRESSED_RGBA_PVRTC_2BPPV1_IMG}else return null;if(s===Od)return o=t.get("WEBGL_compressed_texture_etc1"),o!==null?o.COMPRESSED_RGB_ETC1_WEBGL:null;if(s===Il||s===Ul)if(o=t.get("WEBGL_compressed_texture_etc"),o!==null){if(s===Il)return c===se?o.COMPRESSED_SRGB8_ETC2:o.COMPRESSED_RGB8_ETC2;if(s===Ul)return c===se?o.COMPRESSED_SRGB8_ALPHA8_ETC2_EAC:o.COMPRESSED_RGBA8_ETC2_EAC}else return null;if(s===Dl||s===Nl||s===Ol||s===Fl||s===Bl||s===zl||s===Vl||s===kl||s===Hl||s===Gl||s===Wl||s===Xl||s===ql||s===Yl)if(o=t.get("WEBGL_compressed_texture_astc"),o!==null){if(s===Dl)return c===se?o.COMPRESSED_SRGB8_ALPHA8_ASTC_4x4_KHR:o.COMPRESSED_RGBA_ASTC_4x4_KHR;if(s===Nl)return c===se?o.COMPRESSED_SRGB8_ALPHA8_ASTC_5x4_KHR:o.COMPRESSED_RGBA_ASTC_5x4_KHR;if(s===Ol)return c===se?o.COMPRESSED_SRGB8_ALPHA8_ASTC_5x5_KHR:o.COMPRESSED_RGBA_ASTC_5x5_KHR;if(s===Fl)return c===se?o.COMPRESSED_SRGB8_ALPHA8_ASTC_6x5_KHR:o.COMPRESSED_RGBA_ASTC_6x5_KHR;if(s===Bl)return c===se?o.COMPRESSED_SRGB8_ALPHA8_ASTC_6x6_KHR:o.COMPRESSED_RGBA_ASTC_6x6_KHR;if(s===zl)return c===se?o.COMPRESSED_SRGB8_ALPHA8_ASTC_8x5_KHR:o.COMPRESSED_RGBA_ASTC_8x5_KHR;if(s===Vl)return c===se?o.COMPRESSED_SRGB8_ALPHA8_ASTC_8x6_KHR:o.COMPRESSED_RGBA_ASTC_8x6_KHR;if(s===kl)return c===se?o.COMPRESSED_SRGB8_ALPHA8_ASTC_8x8_KHR:o.COMPRESSED_RGBA_ASTC_8x8_KHR;if(s===Hl)return c===se?o.COMPRESSED_SRGB8_ALPHA8_ASTC_10x5_KHR:o.COMPRESSED_RGBA_ASTC_10x5_KHR;if(s===Gl)return c===se?o.COMPRESSED_SRGB8_ALPHA8_ASTC_10x6_KHR:o.COMPRESSED_RGBA_ASTC_10x6_KHR;if(s===Wl)return c===se?o.COMPRESSED_SRGB8_ALPHA8_ASTC_10x8_KHR:o.COMPRESSED_RGBA_ASTC_10x8_KHR;if(s===Xl)return c===se?o.COMPRESSED_SRGB8_ALPHA8_ASTC_10x10_KHR:o.COMPRESSED_RGBA_ASTC_10x10_KHR;if(s===ql)return c===se?o.COMPRESSED_SRGB8_ALPHA8_ASTC_12x10_KHR:o.COMPRESSED_RGBA_ASTC_12x10_KHR;if(s===Yl)return c===se?o.COMPRESSED_SRGB8_ALPHA8_ASTC_12x12_KHR:o.COMPRESSED_RGBA_ASTC_12x12_KHR}else return null;if(s===Ha||s===Zl||s===Jl)if(o=t.get("EXT_texture_compression_bptc"),o!==null){if(s===Ha)return c===se?o.COMPRESSED_SRGB_ALPHA_BPTC_UNORM_EXT:o.COMPRESSED_RGBA_BPTC_UNORM_EXT;if(s===Zl)return o.COMPRESSED_RGB_BPTC_SIGNED_FLOAT_EXT;if(s===Jl)return o.COMPRESSED_RGB_BPTC_UNSIGNED_FLOAT_EXT}else return null;if(s===$f||s===$l||s===Kl||s===Ql)if(o=t.get("EXT_texture_compression_rgtc"),o!==null){if(s===Ha)return o.COMPRESSED_RED_RGTC1_EXT;if(s===$l)return o.COMPRESSED_SIGNED_RED_RGTC1_EXT;if(s===Kl)return o.COMPRESSED_RED_GREEN_RGTC2_EXT;if(s===Ql)return o.COMPRESSED_SIGNED_RED_GREEN_RGTC2_EXT}else return null;return s===ui?n?r.UNSIGNED_INT_24_8:(o=t.get("WEBGL_depth_texture"),o!==null?o.UNSIGNED_INT_24_8_WEBGL:null):r[s]!==void 0?r[s]:null}return{convert:i}}var ko=class extends be{constructor(t=[]){super(),this.isArrayCamera=!0,this.cameras=t}},li=class extends Kt{constructor(){super(),this.isGroup=!0,this.type="Group"}},mx={type:"move"},Cs=class{constructor(){this._targetRay=null,this._grip=null,this._hand=null}getHandSpace(){return this._hand===null&&(this._hand=new li,this._hand.matrixAutoUpdate=!1,this._hand.visible=!1,this._hand.joints={},this._hand.inputState={pinching:!1}),this._hand}getTargetRaySpace(){return this._targetRay===null&&(this._targetRay=new li,this._targetRay.matrixAutoUpdate=!1,this._targetRay.visible=!1,this._targetRay.hasLinearVelocity=!1,this._targetRay.linearVelocity=new w,this._targetRay.hasAngularVelocity=!1,this._targetRay.angularVelocity=new w),this._targetRay}getGripSpace(){return this._grip===null&&(this._grip=new li,this._grip.matrixAutoUpdate=!1,this._grip.visible=!1,this._grip.hasLinearVelocity=!1,this._grip.linearVelocity=new w,this._grip.hasAngularVelocity=!1,this._grip.angularVelocity=new w),this._grip}dispatchEvent(t){return this._targetRay!==null&&this._targetRay.dispatchEvent(t),this._grip!==null&&this._grip.dispatchEvent(t),this._hand!==null&&this._hand.dispatchEvent(t),this}connect(t){if(t&&t.hand){let e=this._hand;if(e)for(let n of t.hand.values())this._getHandJoint(e,n)}return this.dispatchEvent({type:"connected",data:t}),this}disconnect(t){return this.dispatchEvent({type:"disconnected",data:t}),this._targetRay!==null&&(this._targetRay.visible=!1),this._grip!==null&&(this._grip.visible=!1),this._hand!==null&&(this._hand.visible=!1),this}update(t,e,n){let i=null,s=null,a=null,o=this._targetRay,c=this._grip,l=this._hand;if(t&&e.session.visibilityState!=="visible-blurred"){if(l&&t.hand){a=!0;for(let _ of t.hand.values()){let g=e.getJointPose(_,n),p=this._getHandJoint(l,_);g!==null&&(p.matrix.fromArray(g.transform.matrix),p.matrix.decompose(p.position,p.rotation,p.scale),p.matrixWorldNeedsUpdate=!0,p.jointRadius=g.radius),p.visible=g!==null}let h=l.joints["index-finger-tip"],u=l.joints["thumb-tip"],d=h.position.distanceTo(u.position),f=.02,m=.005;l.inputState.pinching&&d>f+m?(l.inputState.pinching=!1,this.dispatchEvent({type:"pinchend",handedness:t.handedness,target:this})):!l.inputState.pinching&&d<=f-m&&(l.inputState.pinching=!0,this.dispatchEvent({type:"pinchstart",handedness:t.handedness,target:this}))}else c!==null&&t.gripSpace&&(s=e.getPose(t.gripSpace,n),s!==null&&(c.matrix.fromArray(s.transform.matrix),c.matrix.decompose(c.position,c.rotation,c.scale),c.matrixWorldNeedsUpdate=!0,s.linearVelocity?(c.hasLinearVelocity=!0,c.linearVelocity.copy(s.linearVelocity)):c.hasLinearVelocity=!1,s.angularVelocity?(c.hasAngularVelocity=!0,c.angularVelocity.copy(s.angularVelocity)):c.hasAngularVelocity=!1));o!==null&&(i=e.getPose(t.targetRaySpace,n),i===null&&s!==null&&(i=s),i!==null&&(o.matrix.fromArray(i.transform.matrix),o.matrix.decompose(o.position,o.rotation,o.scale),o.matrixWorldNeedsUpdate=!0,i.linearVelocity?(o.hasLinearVelocity=!0,o.linearVelocity.copy(i.linearVelocity)):o.hasLinearVelocity=!1,i.angularVelocity?(o.hasAngularVelocity=!0,o.angularVelocity.copy(i.angularVelocity)):o.hasAngularVelocity=!1,this.dispatchEvent(mx)))}return o!==null&&(o.visible=i!==null),c!==null&&(c.visible=s!==null),l!==null&&(l.visible=a!==null),this}_getHandJoint(t,e){if(t.joints[e.jointName]===void 0){let n=new li;n.matrixAutoUpdate=!1,n.visible=!1,t.joints[e.jointName]=n,t.add(n)}return t.joints[e.jointName]}},Ho=class extends hn{constructor(t,e){super();let n=this,i=null,s=1,a=null,o="local-floor",c=1,l=null,h=null,u=null,d=null,f=null,m=null,_=e.getContextAttributes(),g=null,p=null,v=[],x=[],y=new Z,C=null,T=new be;T.layers.enable(1),T.viewport=new te;let R=new be;R.layers.enable(2),R.viewport=new te;let U=[T,R],S=new ko;S.layers.enable(1),S.layers.enable(2);let E=null,N=null;this.cameraAutoUpdate=!0,this.enabled=!1,this.isPresenting=!1,this.getController=function(H){let K=v[H];return K===void 0&&(K=new Cs,v[H]=K),K.getTargetRaySpace()},this.getControllerGrip=function(H){let K=v[H];return K===void 0&&(K=new Cs,v[H]=K),K.getGripSpace()},this.getHand=function(H){let K=v[H];return K===void 0&&(K=new Cs,v[H]=K),K.getHandSpace()};function G(H){let K=x.indexOf(H.inputSource);if(K===-1)return;let dt=v[K];dt!==void 0&&(dt.update(H.inputSource,H.frame,l||a),dt.dispatchEvent({type:H.type,data:H.inputSource}))}function it(){i.removeEventListener("select",G),i.removeEventListener("selectstart",G),i.removeEventListener("selectend",G),i.removeEventListener("squeeze",G),i.removeEventListener("squeezestart",G),i.removeEventListener("squeezeend",G),i.removeEventListener("end",it),i.removeEventListener("inputsourceschange",I);for(let H=0;H<v.length;H++){let K=x[H];K!==null&&(x[H]=null,v[H].disconnect(K))}E=null,N=null,t.setRenderTarget(g),f=null,d=null,u=null,i=null,p=null,ut.stop(),n.isPresenting=!1,t.setPixelRatio(C),t.setSize(y.width,y.height,!1),n.dispatchEvent({type:"sessionend"})}this.setFramebufferScaleFactor=function(H){s=H,n.isPresenting===!0&&console.warn("THREE.WebXRManager: Cannot change framebuffer scale while presenting.")},this.setReferenceSpaceType=function(H){o=H,n.isPresenting===!0&&console.warn("THREE.WebXRManager: Cannot change reference space type while presenting.")},this.getReferenceSpace=function(){return l||a},this.setReferenceSpace=function(H){l=H},this.getBaseLayer=function(){return d!==null?d:f},this.getBinding=function(){return u},this.getFrame=function(){return m},this.getSession=function(){return i},this.setSession=async function(H){if(i=H,i!==null){if(g=t.getRenderTarget(),i.addEventListener("select",G),i.addEventListener("selectstart",G),i.addEventListener("selectend",G),i.addEventListener("squeeze",G),i.addEventListener("squeezestart",G),i.addEventListener("squeezeend",G),i.addEventListener("end",it),i.addEventListener("inputsourceschange",I),_.xrCompatible!==!0&&await e.makeXRCompatible(),C=t.getPixelRatio(),t.getSize(y),i.renderState.layers===void 0||t.capabilities.isWebGL2===!1){let K={antialias:i.renderState.layers===void 0?_.antialias:!0,alpha:!0,depth:_.depth,stencil:_.stencil,framebufferScaleFactor:s};f=new XRWebGLLayer(i,e,K),i.updateRenderState({baseLayer:f}),t.setPixelRatio(1),t.setSize(f.framebufferWidth,f.framebufferHeight,!1),p=new Ke(f.framebufferWidth,f.framebufferHeight,{format:qe,type:kn,colorSpace:t.outputColorSpace,stencilBuffer:_.stencil})}else{let K=null,dt=null,Mt=null;_.depth&&(Mt=_.stencil?e.DEPTH24_STENCIL8:e.DEPTH_COMPONENT24,K=_.stencil?ts:di,dt=_.stencil?ui:Nn);let gt={colorFormat:e.RGBA8,depthFormat:Mt,scaleFactor:s};u=new XRWebGLBinding(i,e),d=u.createProjectionLayer(gt),i.updateRenderState({layers:[d]}),t.setPixelRatio(1),t.setSize(d.textureWidth,d.textureHeight,!1),p=new Ke(d.textureWidth,d.textureHeight,{format:qe,type:kn,depthTexture:new la(d.textureWidth,d.textureHeight,dt,void 0,void 0,void 0,void 0,void 0,void 0,K),stencilBuffer:_.stencil,colorSpace:t.outputColorSpace,samples:_.antialias?4:0});let Ct=t.properties.get(p);Ct.__ignoreDepthValues=d.ignoreDepthValues}p.isXRRenderTarget=!0,this.setFoveation(c),l=null,a=await i.requestReferenceSpace(o),ut.setContext(i),ut.start(),n.isPresenting=!0,n.dispatchEvent({type:"sessionstart"})}},this.getEnvironmentBlendMode=function(){if(i!==null)return i.environmentBlendMode};function I(H){for(let K=0;K<H.removed.length;K++){let dt=H.removed[K],Mt=x.indexOf(dt);Mt>=0&&(x[Mt]=null,v[Mt].disconnect(dt))}for(let K=0;K<H.added.length;K++){let dt=H.added[K],Mt=x.indexOf(dt);if(Mt===-1){for(let Ct=0;Ct<v.length;Ct++)if(Ct>=x.length){x.push(dt),Mt=Ct;break}else if(x[Ct]===null){x[Ct]=dt,Mt=Ct;break}if(Mt===-1)break}let gt=v[Mt];gt&&gt.connect(dt)}}let F=new w,k=new w;function J(H,K,dt){F.setFromMatrixPosition(K.matrixWorld),k.setFromMatrixPosition(dt.matrixWorld);let Mt=F.distanceTo(k),gt=K.projectionMatrix.elements,Ct=dt.projectionMatrix.elements,Nt=gt[14]/(gt[10]-1),St=gt[14]/(gt[10]+1),Ut=(gt[9]+1)/gt[5],P=(gt[9]-1)/gt[5],rt=(gt[8]-1)/gt[0],q=(Ct[8]+1)/Ct[0],st=Nt*rt,X=Nt*q,Et=Mt/(-rt+q),ft=Et*-rt;K.matrixWorld.decompose(H.position,H.quaternion,H.scale),H.translateX(ft),H.translateZ(Et),H.matrixWorld.compose(H.position,H.quaternion,H.scale),H.matrixWorldInverse.copy(H.matrixWorld).invert();let b=Nt+Et,M=St+Et,O=st-ft,nt=X+(Mt-ft),Q=Ut*St/M*b,$=P*St/M*b;H.projectionMatrix.makePerspective(O,nt,Q,$,b,M),H.projectionMatrixInverse.copy(H.projectionMatrix).invert()}function Y(H,K){K===null?H.matrixWorld.copy(H.matrix):H.matrixWorld.multiplyMatrices(K.matrixWorld,H.matrix),H.matrixWorldInverse.copy(H.matrixWorld).invert()}this.updateCamera=function(H){if(i===null)return;S.near=R.near=T.near=H.near,S.far=R.far=T.far=H.far,(E!==S.near||N!==S.far)&&(i.updateRenderState({depthNear:S.near,depthFar:S.far}),E=S.near,N=S.far);let K=H.parent,dt=S.cameras;Y(S,K);for(let Mt=0;Mt<dt.length;Mt++)Y(dt[Mt],K);dt.length===2?J(S,T,R):S.projectionMatrix.copy(T.projectionMatrix),W(H,S,K)};function W(H,K,dt){dt===null?H.matrix.copy(K.matrixWorld):(H.matrix.copy(dt.matrixWorld),H.matrix.invert(),H.matrix.multiply(K.matrixWorld)),H.matrix.decompose(H.position,H.quaternion,H.scale),H.updateMatrixWorld(!0),H.projectionMatrix.copy(K.projectionMatrix),H.projectionMatrixInverse.copy(K.projectionMatrixInverse),H.isPerspectiveCamera&&(H.fov=es*2*Math.atan(1/H.projectionMatrix.elements[5]),H.zoom=1)}this.getCamera=function(){return S},this.getFoveation=function(){if(!(d===null&&f===null))return c},this.setFoveation=function(H){c=H,d!==null&&(d.fixedFoveation=H),f!==null&&f.fixedFoveation!==void 0&&(f.fixedFoveation=H)};let tt=null;function et(H,K){if(h=K.getViewerPose(l||a),m=K,h!==null){let dt=h.views;f!==null&&(t.setRenderTargetFramebuffer(p,f.framebuffer),t.setRenderTarget(p));let Mt=!1;dt.length!==S.cameras.length&&(S.cameras.length=0,Mt=!0);for(let gt=0;gt<dt.length;gt++){let Ct=dt[gt],Nt=null;if(f!==null)Nt=f.getViewport(Ct);else{let Ut=u.getViewSubImage(d,Ct);Nt=Ut.viewport,gt===0&&(t.setRenderTargetTextures(p,Ut.colorTexture,d.ignoreDepthValues?void 0:Ut.depthStencilTexture),t.setRenderTarget(p))}let St=U[gt];St===void 0&&(St=new be,St.layers.enable(gt),St.viewport=new te,U[gt]=St),St.matrix.fromArray(Ct.transform.matrix),St.matrix.decompose(St.position,St.quaternion,St.scale),St.projectionMatrix.fromArray(Ct.projectionMatrix),St.projectionMatrixInverse.copy(St.projectionMatrix).invert(),St.viewport.set(Nt.x,Nt.y,Nt.width,Nt.height),gt===0&&(S.matrix.copy(St.matrix),S.matrix.decompose(S.position,S.quaternion,S.scale)),Mt===!0&&S.cameras.push(St)}}for(let dt=0;dt<v.length;dt++){let Mt=x[dt],gt=v[dt];Mt!==null&&gt!==void 0&&gt.update(Mt,K,l||a)}tt&&tt(H,K),K.detectedPlanes&&n.dispatchEvent({type:"planesdetected",data:K}),m=null}let ut=new Gd;ut.setAnimationLoop(et),this.setAnimationLoop=function(H){tt=H},this.dispose=function(){}}};function gx(r,t){function e(g,p){g.matrixAutoUpdate===!0&&g.updateMatrix(),p.value.copy(g.matrix)}function n(g,p){p.color.getRGB(g.fogColor.value,Hd(r)),p.isFog?(g.fogNear.value=p.near,g.fogFar.value=p.far):p.isFogExp2&&(g.fogDensity.value=p.density)}function i(g,p,v,x,y){p.isMeshBasicMaterial||p.isMeshLambertMaterial?s(g,p):p.isMeshToonMaterial?(s(g,p),u(g,p)):p.isMeshPhongMaterial?(s(g,p),h(g,p)):p.isMeshStandardMaterial?(s(g,p),d(g,p),p.isMeshPhysicalMaterial&&f(g,p,y)):p.isMeshMatcapMaterial?(s(g,p),m(g,p)):p.isMeshDepthMaterial?s(g,p):p.isMeshDistanceMaterial?(s(g,p),_(g,p)):p.isMeshNormalMaterial?s(g,p):p.isLineBasicMaterial?(a(g,p),p.isLineDashedMaterial&&o(g,p)):p.isPointsMaterial?c(g,p,v,x):p.isSpriteMaterial?l(g,p):p.isShadowMaterial?(g.color.value.copy(p.color),g.opacity.value=p.opacity):p.isShaderMaterial&&(p.uniformsNeedUpdate=!1)}function s(g,p){g.opacity.value=p.opacity,p.color&&g.diffuse.value.copy(p.color),p.emissive&&g.emissive.value.copy(p.emissive).multiplyScalar(p.emissiveIntensity),p.map&&(g.map.value=p.map,e(p.map,g.mapTransform)),p.alphaMap&&(g.alphaMap.value=p.alphaMap,e(p.alphaMap,g.alphaMapTransform)),p.bumpMap&&(g.bumpMap.value=p.bumpMap,e(p.bumpMap,g.bumpMapTransform),g.bumpScale.value=p.bumpScale,p.side===He&&(g.bumpScale.value*=-1)),p.normalMap&&(g.normalMap.value=p.normalMap,e(p.normalMap,g.normalMapTransform),g.normalScale.value.copy(p.normalScale),p.side===He&&g.normalScale.value.negate()),p.displacementMap&&(g.displacementMap.value=p.displacementMap,e(p.displacementMap,g.displacementMapTransform),g.displacementScale.value=p.displacementScale,g.displacementBias.value=p.displacementBias),p.emissiveMap&&(g.emissiveMap.value=p.emissiveMap,e(p.emissiveMap,g.emissiveMapTransform)),p.specularMap&&(g.specularMap.value=p.specularMap,e(p.specularMap,g.specularMapTransform)),p.alphaTest>0&&(g.alphaTest.value=p.alphaTest);let v=t.get(p).envMap;if(v&&(g.envMap.value=v,g.flipEnvMap.value=v.isCubeTexture&&v.isRenderTargetTexture===!1?-1:1,g.reflectivity.value=p.reflectivity,g.ior.value=p.ior,g.refractionRatio.value=p.refractionRatio),p.lightMap){g.lightMap.value=p.lightMap;let x=r._useLegacyLights===!0?Math.PI:1;g.lightMapIntensity.value=p.lightMapIntensity*x,e(p.lightMap,g.lightMapTransform)}p.aoMap&&(g.aoMap.value=p.aoMap,g.aoMapIntensity.value=p.aoMapIntensity,e(p.aoMap,g.aoMapTransform))}function a(g,p){g.diffuse.value.copy(p.color),g.opacity.value=p.opacity,p.map&&(g.map.value=p.map,e(p.map,g.mapTransform))}function o(g,p){g.dashSize.value=p.dashSize,g.totalSize.value=p.dashSize+p.gapSize,g.scale.value=p.scale}function c(g,p,v,x){g.diffuse.value.copy(p.color),g.opacity.value=p.opacity,g.size.value=p.size*v,g.scale.value=x*.5,p.map&&(g.map.value=p.map,e(p.map,g.uvTransform)),p.alphaMap&&(g.alphaMap.value=p.alphaMap,e(p.alphaMap,g.alphaMapTransform)),p.alphaTest>0&&(g.alphaTest.value=p.alphaTest)}function l(g,p){g.diffuse.value.copy(p.color),g.opacity.value=p.opacity,g.rotation.value=p.rotation,p.map&&(g.map.value=p.map,e(p.map,g.mapTransform)),p.alphaMap&&(g.alphaMap.value=p.alphaMap,e(p.alphaMap,g.alphaMapTransform)),p.alphaTest>0&&(g.alphaTest.value=p.alphaTest)}function h(g,p){g.specular.value.copy(p.specular),g.shininess.value=Math.max(p.shininess,1e-4)}function u(g,p){p.gradientMap&&(g.gradientMap.value=p.gradientMap)}function d(g,p){g.metalness.value=p.metalness,p.metalnessMap&&(g.metalnessMap.value=p.metalnessMap,e(p.metalnessMap,g.metalnessMapTransform)),g.roughness.value=p.roughness,p.roughnessMap&&(g.roughnessMap.value=p.roughnessMap,e(p.roughnessMap,g.roughnessMapTransform)),t.get(p).envMap&&(g.envMapIntensity.value=p.envMapIntensity)}function f(g,p,v){g.ior.value=p.ior,p.sheen>0&&(g.sheenColor.value.copy(p.sheenColor).multiplyScalar(p.sheen),g.sheenRoughness.value=p.sheenRoughness,p.sheenColorMap&&(g.sheenColorMap.value=p.sheenColorMap,e(p.sheenColorMap,g.sheenColorMapTransform)),p.sheenRoughnessMap&&(g.sheenRoughnessMap.value=p.sheenRoughnessMap,e(p.sheenRoughnessMap,g.sheenRoughnessMapTransform))),p.clearcoat>0&&(g.clearcoat.value=p.clearcoat,g.clearcoatRoughness.value=p.clearcoatRoughness,p.clearcoatMap&&(g.clearcoatMap.value=p.clearcoatMap,e(p.clearcoatMap,g.clearcoatMapTransform)),p.clearcoatRoughnessMap&&(g.clearcoatRoughnessMap.value=p.clearcoatRoughnessMap,e(p.clearcoatRoughnessMap,g.clearcoatRoughnessMapTransform)),p.clearcoatNormalMap&&(g.clearcoatNormalMap.value=p.clearcoatNormalMap,e(p.clearcoatNormalMap,g.clearcoatNormalMapTransform),g.clearcoatNormalScale.value.copy(p.clearcoatNormalScale),p.side===He&&g.clearcoatNormalScale.value.negate())),p.iridescence>0&&(g.iridescence.value=p.iridescence,g.iridescenceIOR.value=p.iridescenceIOR,g.iridescenceThicknessMinimum.value=p.iridescenceThicknessRange[0],g.iridescenceThicknessMaximum.value=p.iridescenceThicknessRange[1],p.iridescenceMap&&(g.iridescenceMap.value=p.iridescenceMap,e(p.iridescenceMap,g.iridescenceMapTransform)),p.iridescenceThicknessMap&&(g.iridescenceThicknessMap.value=p.iridescenceThicknessMap,e(p.iridescenceThicknessMap,g.iridescenceThicknessMapTransform))),p.transmission>0&&(g.transmission.value=p.transmission,g.transmissionSamplerMap.value=v.texture,g.transmissionSamplerSize.value.set(v.width,v.height),p.transmissionMap&&(g.transmissionMap.value=p.transmissionMap,e(p.transmissionMap,g.transmissionMapTransform)),g.thickness.value=p.thickness,p.thicknessMap&&(g.thicknessMap.value=p.thicknessMap,e(p.thicknessMap,g.thicknessMapTransform)),g.attenuationDistance.value=p.attenuationDistance,g.attenuationColor.value.copy(p.attenuationColor)),p.anisotropy>0&&(g.anisotropyVector.value.set(p.anisotropy*Math.cos(p.anisotropyRotation),p.anisotropy*Math.sin(p.anisotropyRotation)),p.anisotropyMap&&(g.anisotropyMap.value=p.anisotropyMap,e(p.anisotropyMap,g.anisotropyMapTransform))),g.specularIntensity.value=p.specularIntensity,g.specularColor.value.copy(p.specularColor),p.specularColorMap&&(g.specularColorMap.value=p.specularColorMap,e(p.specularColorMap,g.specularColorMapTransform)),p.specularIntensityMap&&(g.specularIntensityMap.value=p.specularIntensityMap,e(p.specularIntensityMap,g.specularIntensityMapTransform))}function m(g,p){p.matcap&&(g.matcap.value=p.matcap)}function _(g,p){let v=t.get(p).light;g.referencePosition.value.setFromMatrixPosition(v.matrixWorld),g.nearDistance.value=v.shadow.camera.near,g.farDistance.value=v.shadow.camera.far}return{refreshFogUniforms:n,refreshMaterialUniforms:i}}function _x(r,t,e,n){let i={},s={},a=[],o=e.isWebGL2?r.getParameter(r.MAX_UNIFORM_BUFFER_BINDINGS):0;function c(v,x){let y=x.program;n.uniformBlockBinding(v,y)}function l(v,x){let y=i[v.id];y===void 0&&(m(v),y=h(v),i[v.id]=y,v.addEventListener("dispose",g));let C=x.program;n.updateUBOMapping(v,C);let T=t.render.frame;s[v.id]!==T&&(d(v),s[v.id]=T)}function h(v){let x=u();v.__bindingPointIndex=x;let y=r.createBuffer(),C=v.__size,T=v.usage;return r.bindBuffer(r.UNIFORM_BUFFER,y),r.bufferData(r.UNIFORM_BUFFER,C,T),r.bindBuffer(r.UNIFORM_BUFFER,null),r.bindBufferBase(r.UNIFORM_BUFFER,x,y),y}function u(){for(let v=0;v<o;v++)if(a.indexOf(v)===-1)return a.push(v),v;return console.error("THREE.WebGLRenderer: Maximum number of simultaneously usable uniforms groups reached."),0}function d(v){let x=i[v.id],y=v.uniforms,C=v.__cache;r.bindBuffer(r.UNIFORM_BUFFER,x);for(let T=0,R=y.length;T<R;T++){let U=Array.isArray(y[T])?y[T]:[y[T]];for(let S=0,E=U.length;S<E;S++){let N=U[S];if(f(N,T,S,C)===!0){let G=N.__offset,it=Array.isArray(N.value)?N.value:[N.value],I=0;for(let F=0;F<it.length;F++){let k=it[F],J=_(k);typeof k=="number"||typeof k=="boolean"?(N.__data[0]=k,r.bufferSubData(r.UNIFORM_BUFFER,G+I,N.__data)):k.isMatrix3?(N.__data[0]=k.elements[0],N.__data[1]=k.elements[1],N.__data[2]=k.elements[2],N.__data[3]=0,N.__data[4]=k.elements[3],N.__data[5]=k.elements[4],N.__data[6]=k.elements[5],N.__data[7]=0,N.__data[8]=k.elements[6],N.__data[9]=k.elements[7],N.__data[10]=k.elements[8],N.__data[11]=0):(k.toArray(N.__data,I),I+=J.storage/Float32Array.BYTES_PER_ELEMENT)}r.bufferSubData(r.UNIFORM_BUFFER,G,N.__data)}}}r.bindBuffer(r.UNIFORM_BUFFER,null)}function f(v,x,y,C){let T=v.value,R=x+"_"+y;if(C[R]===void 0)return typeof T=="number"||typeof T=="boolean"?C[R]=T:C[R]=T.clone(),!0;{let U=C[R];if(typeof T=="number"||typeof T=="boolean"){if(U!==T)return C[R]=T,!0}else if(U.equals(T)===!1)return U.copy(T),!0}return!1}function m(v){let x=v.uniforms,y=0,C=16;for(let R=0,U=x.length;R<U;R++){let S=Array.isArray(x[R])?x[R]:[x[R]];for(let E=0,N=S.length;E<N;E++){let G=S[E],it=Array.isArray(G.value)?G.value:[G.value];for(let I=0,F=it.length;I<F;I++){let k=it[I],J=_(k),Y=y%C;Y!==0&&C-Y<J.boundary&&(y+=C-Y),G.__data=new Float32Array(J.storage/Float32Array.BYTES_PER_ELEMENT),G.__offset=y,y+=J.storage}}}let T=y%C;return T>0&&(y+=C-T),v.__size=y,v.__cache={},this}function _(v){let x={boundary:0,storage:0};return typeof v=="number"||typeof v=="boolean"?(x.boundary=4,x.storage=4):v.isVector2?(x.boundary=8,x.storage=8):v.isVector3||v.isColor?(x.boundary=16,x.storage=12):v.isVector4?(x.boundary=16,x.storage=16):v.isMatrix3?(x.boundary=48,x.storage=48):v.isMatrix4?(x.boundary=64,x.storage=64):v.isTexture?console.warn("THREE.WebGLRenderer: Texture samplers can not be part of an uniforms group."):console.warn("THREE.WebGLRenderer: Unsupported uniform value type.",v),x}function g(v){let x=v.target;x.removeEventListener("dispose",g);let y=a.indexOf(x.__bindingPointIndex);a.splice(y,1),r.deleteBuffer(i[x.id]),delete i[x.id],delete s[x.id]}function p(){for(let v in i)r.deleteBuffer(i[v]);a=[],i={},s={}}return{bind:c,update:l,dispose:p}}var Go=class{constructor(t={}){let{canvas:e=Ap(),context:n=null,depth:i=!0,stencil:s=!0,alpha:a=!1,antialias:o=!1,premultipliedAlpha:c=!0,preserveDrawingBuffer:l=!1,powerPreference:h="default",failIfMajorPerformanceCaveat:u=!1}=t;this.isWebGLRenderer=!0;let d;n!==null?d=n.getContextAttributes().alpha:d=a;let f=new Uint32Array(4),m=new Int32Array(4),_=null,g=null,p=[],v=[];this.domElement=e,this.debug={checkShaderErrors:!0,onShaderError:null},this.autoClear=!0,this.autoClearColor=!0,this.autoClearDepth=!0,this.autoClearStencil=!0,this.sortObjects=!0,this.clippingPlanes=[],this.localClippingEnabled=!1,this._outputColorSpace=Se,this._useLegacyLights=!1,this.toneMapping=Vn,this.toneMappingExposure=1;let x=this,y=!1,C=0,T=0,R=null,U=-1,S=null,E=new te,N=new te,G=null,it=new pt(0),I=0,F=e.width,k=e.height,J=1,Y=null,W=null,tt=new te(0,0,F,k),et=new te(0,0,F,k),ut=!1,H=new rs,K=!1,dt=!1,Mt=null,gt=new It,Ct=new Z,Nt=new w,St={background:null,fog:null,environment:null,overrideMaterial:null,isScene:!0};function Ut(){return R===null?J:1}let P=n;function rt(A,D){for(let z=0;z<A.length;z++){let V=A[z],B=e.getContext(V,D);if(B!==null)return B}return null}try{let A={alpha:!0,depth:i,stencil:s,antialias:o,premultipliedAlpha:c,preserveDrawingBuffer:l,powerPreference:h,failIfMajorPerformanceCaveat:u};if("setAttribute"in e&&e.setAttribute("data-engine","three.js r160"),e.addEventListener("webglcontextlost",at,!1),e.addEventListener("webglcontextrestored",L,!1),e.addEventListener("webglcontextcreationerror",lt,!1),P===null){let D=["webgl2","webgl","experimental-webgl"];if(x.isWebGL1Renderer===!0&&D.shift(),P=rt(D,A),P===null)throw rt(D)?new Error("Error creating WebGL context with your selected attributes."):new Error("Error creating WebGL context.")}typeof WebGLRenderingContext<"u"&&P instanceof WebGLRenderingContext&&console.warn("THREE.WebGLRenderer: WebGL 1 support was deprecated in r153 and will be removed in r163."),P.getShaderPrecisionFormat===void 0&&(P.getShaderPrecisionFormat=function(){return{rangeMin:1,rangeMax:1,precision:1}})}catch(A){throw console.error("THREE.WebGLRenderer: "+A.message),A}let q,st,X,Et,ft,b,M,O,nt,Q,$,yt,ct,_t,Tt,Ft,j,Zt,Yt,Dt,At,vt,Vt,$t;function oe(){q=new O_(P),st=new P_(P,q,t),q.init(st),vt=new px(P,q,st),X=new dx(P,q,st),Et=new z_(P),ft=new tx,b=new fx(P,q,X,ft,st,vt,Et),M=new I_(x),O=new N_(x),nt=new Yp(P,st),Vt=new R_(P,q,nt,st),Q=new F_(P,nt,Et,Vt),$=new G_(P,Q,nt,Et),Yt=new H_(P,st,b),Ft=new L_(ft),yt=new j0(x,M,O,q,st,Vt,Ft),ct=new gx(x,ft),_t=new nx,Tt=new cx(q,st),Zt=new w_(x,M,O,X,$,d,c),j=new ux(x,$,st),$t=new _x(P,Et,st,X),Dt=new C_(P,q,Et,st),At=new B_(P,q,Et,st),Et.programs=yt.programs,x.capabilities=st,x.extensions=q,x.properties=ft,x.renderLists=_t,x.shadowMap=j,x.state=X,x.info=Et}oe();let Xt=new Ho(x,P);this.xr=Xt,this.getContext=function(){return P},this.getContextAttributes=function(){return P.getContextAttributes()},this.forceContextLoss=function(){let A=q.get("WEBGL_lose_context");A&&A.loseContext()},this.forceContextRestore=function(){let A=q.get("WEBGL_lose_context");A&&A.restoreContext()},this.getPixelRatio=function(){return J},this.setPixelRatio=function(A){A!==void 0&&(J=A,this.setSize(F,k,!1))},this.getSize=function(A){return A.set(F,k)},this.setSize=function(A,D,z=!0){if(Xt.isPresenting){console.warn("THREE.WebGLRenderer: Can't change size while VR device is presenting.");return}F=A,k=D,e.width=Math.floor(A*J),e.height=Math.floor(D*J),z===!0&&(e.style.width=A+"px",e.style.height=D+"px"),this.setViewport(0,0,A,D)},this.getDrawingBufferSize=function(A){return A.set(F*J,k*J).floor()},this.setDrawingBufferSize=function(A,D,z){F=A,k=D,J=z,e.width=Math.floor(A*z),e.height=Math.floor(D*z),this.setViewport(0,0,A,D)},this.getCurrentViewport=function(A){return A.copy(E)},this.getViewport=function(A){return A.copy(tt)},this.setViewport=function(A,D,z,V){A.isVector4?tt.set(A.x,A.y,A.z,A.w):tt.set(A,D,z,V),X.viewport(E.copy(tt).multiplyScalar(J).floor())},this.getScissor=function(A){return A.copy(et)},this.setScissor=function(A,D,z,V){A.isVector4?et.set(A.x,A.y,A.z,A.w):et.set(A,D,z,V),X.scissor(N.copy(et).multiplyScalar(J).floor())},this.getScissorTest=function(){return ut},this.setScissorTest=function(A){X.setScissorTest(ut=A)},this.setOpaqueSort=function(A){Y=A},this.setTransparentSort=function(A){W=A},this.getClearColor=function(A){return A.copy(Zt.getClearColor())},this.setClearColor=function(){Zt.setClearColor.apply(Zt,arguments)},this.getClearAlpha=function(){return Zt.getClearAlpha()},this.setClearAlpha=function(){Zt.setClearAlpha.apply(Zt,arguments)},this.clear=function(A=!0,D=!0,z=!0){let V=0;if(A){let B=!1;if(R!==null){let mt=R.texture.format;B=mt===Nd||mt===Dd||mt===Ud}if(B){let mt=R.texture.type,bt=mt===kn||mt===Nn||mt===al||mt===ui||mt===Ld||mt===Id,Rt=Zt.getClearColor(),Lt=Zt.getClearAlpha(),Ht=Rt.r,Ot=Rt.g,Bt=Rt.b;bt?(f[0]=Ht,f[1]=Ot,f[2]=Bt,f[3]=Lt,P.clearBufferuiv(P.COLOR,0,f)):(m[0]=Ht,m[1]=Ot,m[2]=Bt,m[3]=Lt,P.clearBufferiv(P.COLOR,0,m))}else V|=P.COLOR_BUFFER_BIT}D&&(V|=P.DEPTH_BUFFER_BIT),z&&(V|=P.STENCIL_BUFFER_BIT,this.state.buffers.stencil.setMask(4294967295)),P.clear(V)},this.clearColor=function(){this.clear(!0,!1,!1)},this.clearDepth=function(){this.clear(!1,!0,!1)},this.clearStencil=function(){this.clear(!1,!1,!0)},this.dispose=function(){e.removeEventListener("webglcontextlost",at,!1),e.removeEventListener("webglcontextrestored",L,!1),e.removeEventListener("webglcontextcreationerror",lt,!1),_t.dispose(),Tt.dispose(),ft.dispose(),M.dispose(),O.dispose(),$.dispose(),Vt.dispose(),$t.dispose(),yt.dispose(),Xt.dispose(),Xt.removeEventListener("sessionstart",Ue),Xt.removeEventListener("sessionend",ie),Mt&&(Mt.dispose(),Mt=null),De.stop()};function at(A){A.preventDefault(),console.log("THREE.WebGLRenderer: Context Lost."),y=!0}function L(){console.log("THREE.WebGLRenderer: Context Restored."),y=!1;let A=Et.autoReset,D=j.enabled,z=j.autoUpdate,V=j.needsUpdate,B=j.type;oe(),Et.autoReset=A,j.enabled=D,j.autoUpdate=z,j.needsUpdate=V,j.type=B}function lt(A){console.error("THREE.WebGLRenderer: A WebGL context could not be created. Reason: ",A.statusMessage)}function ht(A){let D=A.target;D.removeEventListener("dispose",ht),Pt(D)}function Pt(A){wt(A),ft.remove(A)}function wt(A){let D=ft.get(A).programs;D!==void 0&&(D.forEach(function(z){yt.releaseProgram(z)}),A.isShaderMaterial&&yt.releaseShaderCache(A))}this.renderBufferDirect=function(A,D,z,V,B,mt){D===null&&(D=St);let bt=B.isMesh&&B.matrixWorld.determinant()<0,Rt=sf(A,D,z,V,B);X.setMaterial(V,bt);let Lt=z.index,Ht=1;if(V.wireframe===!0){if(Lt=Q.getWireframeAttribute(z),Lt===void 0)return;Ht=2}let Ot=z.drawRange,Bt=z.attributes.position,ue=Ot.start*Ht,Ge=(Ot.start+Ot.count)*Ht;mt!==null&&(ue=Math.max(ue,mt.start*Ht),Ge=Math.min(Ge,(mt.start+mt.count)*Ht)),Lt!==null?(ue=Math.max(ue,0),Ge=Math.min(Ge,Lt.count)):Bt!=null&&(ue=Math.max(ue,0),Ge=Math.min(Ge,Bt.count));let ye=Ge-ue;if(ye<0||ye===1/0)return;Vt.setup(B,V,Rt,z,Lt);let dn,re=Dt;if(Lt!==null&&(dn=nt.get(Lt),re=At,re.setIndex(dn)),B.isMesh)V.wireframe===!0?(X.setLineWidth(V.wireframeLinewidth*Ut()),re.setMode(P.LINES)):re.setMode(P.TRIANGLES);else if(B.isLine){let qt=V.linewidth;qt===void 0&&(qt=1),X.setLineWidth(qt*Ut()),B.isLineSegments?re.setMode(P.LINES):B.isLineLoop?re.setMode(P.LINE_LOOP):re.setMode(P.LINE_STRIP)}else B.isPoints?re.setMode(P.POINTS):B.isSprite&&re.setMode(P.TRIANGLES);if(B.isBatchedMesh)re.renderMultiDraw(B._multiDrawStarts,B._multiDrawCounts,B._multiDrawCount);else if(B.isInstancedMesh)re.renderInstances(ue,ye,B.count);else if(z.isInstancedBufferGeometry){let qt=z._maxInstanceCount!==void 0?z._maxInstanceCount:1/0,Da=Math.min(z.instanceCount,qt);re.renderInstances(ue,ye,Da)}else re.render(ue,ye)};function ee(A,D,z){A.transparent===!0&&A.side===Mn&&A.forceSinglePass===!1?(A.side=He,A.needsUpdate=!0,Js(A,D,z),A.side=Wn,A.needsUpdate=!0,Js(A,D,z),A.side=Mn):Js(A,D,z)}this.compile=function(A,D,z=null){z===null&&(z=A),g=Tt.get(z),g.init(),v.push(g),z.traverseVisible(function(B){B.isLight&&B.layers.test(D.layers)&&(g.pushLight(B),B.castShadow&&g.pushShadow(B))}),A!==z&&A.traverseVisible(function(B){B.isLight&&B.layers.test(D.layers)&&(g.pushLight(B),B.castShadow&&g.pushShadow(B))}),g.setupLights(x._useLegacyLights);let V=new Set;return A.traverse(function(B){let mt=B.material;if(mt)if(Array.isArray(mt))for(let bt=0;bt<mt.length;bt++){let Rt=mt[bt];ee(Rt,z,B),V.add(Rt)}else ee(mt,z,B),V.add(mt)}),v.pop(),g=null,V},this.compileAsync=function(A,D,z=null){let V=this.compile(A,D,z);return new Promise(B=>{function mt(){if(V.forEach(function(bt){ft.get(bt).currentProgram.isReady()&&V.delete(bt)}),V.size===0){B(A);return}setTimeout(mt,10)}q.get("KHR_parallel_shader_compile")!==null?mt():setTimeout(mt,10)})};let ne=null;function ve(A){ne&&ne(A)}function Ue(){De.stop()}function ie(){De.start()}let De=new Gd;De.setAnimationLoop(ve),typeof self<"u"&&De.setContext(self),this.setAnimationLoop=function(A){ne=A,Xt.setAnimationLoop(A),A===null?De.stop():De.start()},Xt.addEventListener("sessionstart",Ue),Xt.addEventListener("sessionend",ie),this.render=function(A,D){if(D!==void 0&&D.isCamera!==!0){console.error("THREE.WebGLRenderer.render: camera is not an instance of THREE.Camera.");return}if(y===!0)return;A.matrixWorldAutoUpdate===!0&&A.updateMatrixWorld(),D.parent===null&&D.matrixWorldAutoUpdate===!0&&D.updateMatrixWorld(),Xt.enabled===!0&&Xt.isPresenting===!0&&(Xt.cameraAutoUpdate===!0&&Xt.updateCamera(D),D=Xt.getCamera()),A.isScene===!0&&A.onBeforeRender(x,A,D,R),g=Tt.get(A,v.length),g.init(),v.push(g),gt.multiplyMatrices(D.projectionMatrix,D.matrixWorldInverse),H.setFromProjectionMatrix(gt),dt=this.localClippingEnabled,K=Ft.init(this.clippingPlanes,dt),_=_t.get(A,p.length),_.init(),p.push(_),an(A,D,0,x.sortObjects),_.finish(),x.sortObjects===!0&&_.sort(Y,W),this.info.render.frame++,K===!0&&Ft.beginShadows();let z=g.state.shadowsArray;if(j.render(z,A,D),K===!0&&Ft.endShadows(),this.info.autoReset===!0&&this.info.reset(),Zt.render(_,A),g.setupLights(x._useLegacyLights),D.isArrayCamera){let V=D.cameras;for(let B=0,mt=V.length;B<mt;B++){let bt=V[B];ml(_,A,bt,bt.viewport)}}else ml(_,A,D);R!==null&&(b.updateMultisampleRenderTarget(R),b.updateRenderTargetMipmap(R)),A.isScene===!0&&A.onAfterRender(x,A,D),Vt.resetDefaultState(),U=-1,S=null,v.pop(),v.length>0?g=v[v.length-1]:g=null,p.pop(),p.length>0?_=p[p.length-1]:_=null};function an(A,D,z,V){if(A.visible===!1)return;if(A.layers.test(D.layers)){if(A.isGroup)z=A.renderOrder;else if(A.isLOD)A.autoUpdate===!0&&A.update(D);else if(A.isLight)g.pushLight(A),A.castShadow&&g.pushShadow(A);else if(A.isSprite){if(!A.frustumCulled||H.intersectsSprite(A)){V&&Nt.setFromMatrixPosition(A.matrixWorld).applyMatrix4(gt);let bt=$.update(A),Rt=A.material;Rt.visible&&_.push(A,bt,Rt,z,Nt.z,null)}}else if((A.isMesh||A.isLine||A.isPoints)&&(!A.frustumCulled||H.intersectsObject(A))){let bt=$.update(A),Rt=A.material;if(V&&(A.boundingSphere!==void 0?(A.boundingSphere===null&&A.computeBoundingSphere(),Nt.copy(A.boundingSphere.center)):(bt.boundingSphere===null&&bt.computeBoundingSphere(),Nt.copy(bt.boundingSphere.center)),Nt.applyMatrix4(A.matrixWorld).applyMatrix4(gt)),Array.isArray(Rt)){let Lt=bt.groups;for(let Ht=0,Ot=Lt.length;Ht<Ot;Ht++){let Bt=Lt[Ht],ue=Rt[Bt.materialIndex];ue&&ue.visible&&_.push(A,bt,ue,z,Nt.z,Bt)}}else Rt.visible&&_.push(A,bt,Rt,z,Nt.z,null)}}let mt=A.children;for(let bt=0,Rt=mt.length;bt<Rt;bt++)an(mt[bt],D,z,V)}function ml(A,D,z,V){let B=A.opaque,mt=A.transmissive,bt=A.transparent;g.setupLightsView(z),K===!0&&Ft.setGlobalState(x.clippingPlanes,z),mt.length>0&&nf(B,mt,D,z),V&&X.viewport(E.copy(V)),B.length>0&&Zs(B,D,z),mt.length>0&&Zs(mt,D,z),bt.length>0&&Zs(bt,D,z),X.buffers.depth.setTest(!0),X.buffers.depth.setMask(!0),X.buffers.color.setMask(!0),X.setPolygonOffset(!1)}function nf(A,D,z,V){if((z.isScene===!0?z.overrideMaterial:null)!==null)return;let mt=st.isWebGL2;Mt===null&&(Mt=new Ke(1,1,{generateMipmaps:!0,type:q.has("EXT_color_buffer_half_float")?Is:kn,minFilter:gi,samples:mt?4:0})),x.getDrawingBufferSize(Ct),mt?Mt.setSize(Ct.x,Ct.y):Mt.setSize(ea(Ct.x),ea(Ct.y));let bt=x.getRenderTarget();x.setRenderTarget(Mt),x.getClearColor(it),I=x.getClearAlpha(),I<1&&x.setClearColor(16777215,.5),x.clear();let Rt=x.toneMapping;x.toneMapping=Vn,Zs(A,z,V),b.updateMultisampleRenderTarget(Mt),b.updateRenderTargetMipmap(Mt);let Lt=!1;for(let Ht=0,Ot=D.length;Ht<Ot;Ht++){let Bt=D[Ht],ue=Bt.object,Ge=Bt.geometry,ye=Bt.material,dn=Bt.group;if(ye.side===Mn&&ue.layers.test(V.layers)){let re=ye.side;ye.side=He,ye.needsUpdate=!0,gl(ue,z,V,Ge,ye,dn),ye.side=re,ye.needsUpdate=!0,Lt=!0}}Lt===!0&&(b.updateMultisampleRenderTarget(Mt),b.updateRenderTargetMipmap(Mt)),x.setRenderTarget(bt),x.setClearColor(it,I),x.toneMapping=Rt}function Zs(A,D,z){let V=D.isScene===!0?D.overrideMaterial:null;for(let B=0,mt=A.length;B<mt;B++){let bt=A[B],Rt=bt.object,Lt=bt.geometry,Ht=V===null?bt.material:V,Ot=bt.group;Rt.layers.test(z.layers)&&gl(Rt,D,z,Lt,Ht,Ot)}}function gl(A,D,z,V,B,mt){A.onBeforeRender(x,D,z,V,B,mt),A.modelViewMatrix.multiplyMatrices(z.matrixWorldInverse,A.matrixWorld),A.normalMatrix.getNormalMatrix(A.modelViewMatrix),B.onBeforeRender(x,D,z,V,A,mt),B.transparent===!0&&B.side===Mn&&B.forceSinglePass===!1?(B.side=He,B.needsUpdate=!0,x.renderBufferDirect(z,D,V,B,A,mt),B.side=Wn,B.needsUpdate=!0,x.renderBufferDirect(z,D,V,B,A,mt),B.side=Mn):x.renderBufferDirect(z,D,V,B,A,mt),A.onAfterRender(x,D,z,V,B,mt)}function Js(A,D,z){D.isScene!==!0&&(D=St);let V=ft.get(A),B=g.state.lights,mt=g.state.shadowsArray,bt=B.state.version,Rt=yt.getParameters(A,B.state,mt,D,z),Lt=yt.getProgramCacheKey(Rt),Ht=V.programs;V.environment=A.isMeshStandardMaterial?D.environment:null,V.fog=D.fog,V.envMap=(A.isMeshStandardMaterial?O:M).get(A.envMap||V.environment),Ht===void 0&&(A.addEventListener("dispose",ht),Ht=new Map,V.programs=Ht);let Ot=Ht.get(Lt);if(Ot!==void 0){if(V.currentProgram===Ot&&V.lightsStateVersion===bt)return xl(A,Rt),Ot}else Rt.uniforms=yt.getUniforms(A),A.onBuild(z,Rt,x),A.onBeforeCompile(Rt,x),Ot=yt.acquireProgram(Rt,Lt),Ht.set(Lt,Ot),V.uniforms=Rt.uniforms;let Bt=V.uniforms;return(!A.isShaderMaterial&&!A.isRawShaderMaterial||A.clipping===!0)&&(Bt.clippingPlanes=Ft.uniform),xl(A,Rt),V.needsLights=af(A),V.lightsStateVersion=bt,V.needsLights&&(Bt.ambientLightColor.value=B.state.ambient,Bt.lightProbe.value=B.state.probe,Bt.directionalLights.value=B.state.directional,Bt.directionalLightShadows.value=B.state.directionalShadow,Bt.spotLights.value=B.state.spot,Bt.spotLightShadows.value=B.state.spotShadow,Bt.rectAreaLights.value=B.state.rectArea,Bt.ltc_1.value=B.state.rectAreaLTC1,Bt.ltc_2.value=B.state.rectAreaLTC2,Bt.pointLights.value=B.state.point,Bt.pointLightShadows.value=B.state.pointShadow,Bt.hemisphereLights.value=B.state.hemi,Bt.directionalShadowMap.value=B.state.directionalShadowMap,Bt.directionalShadowMatrix.value=B.state.directionalShadowMatrix,Bt.spotShadowMap.value=B.state.spotShadowMap,Bt.spotLightMatrix.value=B.state.spotLightMatrix,Bt.spotLightMap.value=B.state.spotLightMap,Bt.pointShadowMap.value=B.state.pointShadowMap,Bt.pointShadowMatrix.value=B.state.pointShadowMatrix),V.currentProgram=Ot,V.uniformsList=null,Ot}function _l(A){if(A.uniformsList===null){let D=A.currentProgram.getUniforms();A.uniformsList=ji.seqWithValue(D.seq,A.uniforms)}return A.uniformsList}function xl(A,D){let z=ft.get(A);z.outputColorSpace=D.outputColorSpace,z.batching=D.batching,z.instancing=D.instancing,z.instancingColor=D.instancingColor,z.skinning=D.skinning,z.morphTargets=D.morphTargets,z.morphNormals=D.morphNormals,z.morphColors=D.morphColors,z.morphTargetsCount=D.morphTargetsCount,z.numClippingPlanes=D.numClippingPlanes,z.numIntersection=D.numClipIntersection,z.vertexAlphas=D.vertexAlphas,z.vertexTangents=D.vertexTangents,z.toneMapping=D.toneMapping}function sf(A,D,z,V,B){D.isScene!==!0&&(D=St),b.resetTextureUnits();let mt=D.fog,bt=V.isMeshStandardMaterial?D.environment:null,Rt=R===null?x.outputColorSpace:R.isXRRenderTarget===!0?R.texture.colorSpace:En,Lt=(V.isMeshStandardMaterial?O:M).get(V.envMap||bt),Ht=V.vertexColors===!0&&!!z.attributes.color&&z.attributes.color.itemSize===4,Ot=!!z.attributes.tangent&&(!!V.normalMap||V.anisotropy>0),Bt=!!z.morphAttributes.position,ue=!!z.morphAttributes.normal,Ge=!!z.morphAttributes.color,ye=Vn;V.toneMapped&&(R===null||R.isXRRenderTarget===!0)&&(ye=x.toneMapping);let dn=z.morphAttributes.position||z.morphAttributes.normal||z.morphAttributes.color,re=dn!==void 0?dn.length:0,qt=ft.get(V),Da=g.state.lights;if(K===!0&&(dt===!0||A!==S)){let Ze=A===S&&V.id===U;Ft.setState(V,A,Ze)}let ce=!1;V.version===qt.__version?(qt.needsLights&&qt.lightsStateVersion!==Da.state.version||qt.outputColorSpace!==Rt||B.isBatchedMesh&&qt.batching===!1||!B.isBatchedMesh&&qt.batching===!0||B.isInstancedMesh&&qt.instancing===!1||!B.isInstancedMesh&&qt.instancing===!0||B.isSkinnedMesh&&qt.skinning===!1||!B.isSkinnedMesh&&qt.skinning===!0||B.isInstancedMesh&&qt.instancingColor===!0&&B.instanceColor===null||B.isInstancedMesh&&qt.instancingColor===!1&&B.instanceColor!==null||qt.envMap!==Lt||V.fog===!0&&qt.fog!==mt||qt.numClippingPlanes!==void 0&&(qt.numClippingPlanes!==Ft.numPlanes||qt.numIntersection!==Ft.numIntersection)||qt.vertexAlphas!==Ht||qt.vertexTangents!==Ot||qt.morphTargets!==Bt||qt.morphNormals!==ue||qt.morphColors!==Ge||qt.toneMapping!==ye||st.isWebGL2===!0&&qt.morphTargetsCount!==re)&&(ce=!0):(ce=!0,qt.__version=V.version);let Zn=qt.currentProgram;ce===!0&&(Zn=Js(V,D,B));let vl=!1,ps=!1,Na=!1,we=Zn.getUniforms(),Jn=qt.uniforms;if(X.useProgram(Zn.program)&&(vl=!0,ps=!0,Na=!0),V.id!==U&&(U=V.id,ps=!0),vl||S!==A){we.setValue(P,"projectionMatrix",A.projectionMatrix),we.setValue(P,"viewMatrix",A.matrixWorldInverse);let Ze=we.map.cameraPosition;Ze!==void 0&&Ze.setValue(P,Nt.setFromMatrixPosition(A.matrixWorld)),st.logarithmicDepthBuffer&&we.setValue(P,"logDepthBufFC",2/(Math.log(A.far+1)/Math.LN2)),(V.isMeshPhongMaterial||V.isMeshToonMaterial||V.isMeshLambertMaterial||V.isMeshBasicMaterial||V.isMeshStandardMaterial||V.isShaderMaterial)&&we.setValue(P,"isOrthographic",A.isOrthographicCamera===!0),S!==A&&(S=A,ps=!0,Na=!0)}if(B.isSkinnedMesh){we.setOptional(P,B,"bindMatrix"),we.setOptional(P,B,"bindMatrixInverse");let Ze=B.skeleton;Ze&&(st.floatVertexTextures?(Ze.boneTexture===null&&Ze.computeBoneTexture(),we.setValue(P,"boneTexture",Ze.boneTexture,b)):console.warn("THREE.WebGLRenderer: SkinnedMesh can only be used with WebGL 2. With WebGL 1 OES_texture_float and vertex textures support is required."))}B.isBatchedMesh&&(we.setOptional(P,B,"batchingTexture"),we.setValue(P,"batchingTexture",B._matricesTexture,b));let Oa=z.morphAttributes;if((Oa.position!==void 0||Oa.normal!==void 0||Oa.color!==void 0&&st.isWebGL2===!0)&&Yt.update(B,z,Zn),(ps||qt.receiveShadow!==B.receiveShadow)&&(qt.receiveShadow=B.receiveShadow,we.setValue(P,"receiveShadow",B.receiveShadow)),V.isMeshGouraudMaterial&&V.envMap!==null&&(Jn.envMap.value=Lt,Jn.flipEnvMap.value=Lt.isCubeTexture&&Lt.isRenderTargetTexture===!1?-1:1),ps&&(we.setValue(P,"toneMappingExposure",x.toneMappingExposure),qt.needsLights&&rf(Jn,Na),mt&&V.fog===!0&&ct.refreshFogUniforms(Jn,mt),ct.refreshMaterialUniforms(Jn,V,J,k,Mt),ji.upload(P,_l(qt),Jn,b)),V.isShaderMaterial&&V.uniformsNeedUpdate===!0&&(ji.upload(P,_l(qt),Jn,b),V.uniformsNeedUpdate=!1),V.isSpriteMaterial&&we.setValue(P,"center",B.center),we.setValue(P,"modelViewMatrix",B.modelViewMatrix),we.setValue(P,"normalMatrix",B.normalMatrix),we.setValue(P,"modelMatrix",B.matrixWorld),V.isShaderMaterial||V.isRawShaderMaterial){let Ze=V.uniformsGroups;for(let Fa=0,of=Ze.length;Fa<of;Fa++)if(st.isWebGL2){let yl=Ze[Fa];$t.update(yl,Zn),$t.bind(yl,Zn)}else console.warn("THREE.WebGLRenderer: Uniform Buffer Objects can only be used with WebGL 2.")}return Zn}function rf(A,D){A.ambientLightColor.needsUpdate=D,A.lightProbe.needsUpdate=D,A.directionalLights.needsUpdate=D,A.directionalLightShadows.needsUpdate=D,A.pointLights.needsUpdate=D,A.pointLightShadows.needsUpdate=D,A.spotLights.needsUpdate=D,A.spotLightShadows.needsUpdate=D,A.rectAreaLights.needsUpdate=D,A.hemisphereLights.needsUpdate=D}function af(A){return A.isMeshLambertMaterial||A.isMeshToonMaterial||A.isMeshPhongMaterial||A.isMeshStandardMaterial||A.isShadowMaterial||A.isShaderMaterial&&A.lights===!0}this.getActiveCubeFace=function(){return C},this.getActiveMipmapLevel=function(){return T},this.getRenderTarget=function(){return R},this.setRenderTargetTextures=function(A,D,z){ft.get(A.texture).__webglTexture=D,ft.get(A.depthTexture).__webglTexture=z;let V=ft.get(A);V.__hasExternalTextures=!0,V.__hasExternalTextures&&(V.__autoAllocateDepthBuffer=z===void 0,V.__autoAllocateDepthBuffer||q.has("WEBGL_multisampled_render_to_texture")===!0&&(console.warn("THREE.WebGLRenderer: Render-to-texture extension was disabled because an external texture was provided"),V.__useRenderToTexture=!1))},this.setRenderTargetFramebuffer=function(A,D){let z=ft.get(A);z.__webglFramebuffer=D,z.__useDefaultFramebuffer=D===void 0},this.setRenderTarget=function(A,D=0,z=0){R=A,C=D,T=z;let V=!0,B=null,mt=!1,bt=!1;if(A){let Lt=ft.get(A);Lt.__useDefaultFramebuffer!==void 0?(X.bindFramebuffer(P.FRAMEBUFFER,null),V=!1):Lt.__webglFramebuffer===void 0?b.setupRenderTarget(A):Lt.__hasExternalTextures&&b.rebindTextures(A,ft.get(A.texture).__webglTexture,ft.get(A.depthTexture).__webglTexture);let Ht=A.texture;(Ht.isData3DTexture||Ht.isDataArrayTexture||Ht.isCompressedArrayTexture)&&(bt=!0);let Ot=ft.get(A).__webglFramebuffer;A.isWebGLCubeRenderTarget?(Array.isArray(Ot[D])?B=Ot[D][z]:B=Ot[D],mt=!0):st.isWebGL2&&A.samples>0&&b.useMultisampledRTT(A)===!1?B=ft.get(A).__webglMultisampledFramebuffer:Array.isArray(Ot)?B=Ot[z]:B=Ot,E.copy(A.viewport),N.copy(A.scissor),G=A.scissorTest}else E.copy(tt).multiplyScalar(J).floor(),N.copy(et).multiplyScalar(J).floor(),G=ut;if(X.bindFramebuffer(P.FRAMEBUFFER,B)&&st.drawBuffers&&V&&X.drawBuffers(A,B),X.viewport(E),X.scissor(N),X.setScissorTest(G),mt){let Lt=ft.get(A.texture);P.framebufferTexture2D(P.FRAMEBUFFER,P.COLOR_ATTACHMENT0,P.TEXTURE_CUBE_MAP_POSITIVE_X+D,Lt.__webglTexture,z)}else if(bt){let Lt=ft.get(A.texture),Ht=D||0;P.framebufferTextureLayer(P.FRAMEBUFFER,P.COLOR_ATTACHMENT0,Lt.__webglTexture,z||0,Ht)}U=-1},this.readRenderTargetPixels=function(A,D,z,V,B,mt,bt){if(!(A&&A.isWebGLRenderTarget)){console.error("THREE.WebGLRenderer.readRenderTargetPixels: renderTarget is not THREE.WebGLRenderTarget.");return}let Rt=ft.get(A).__webglFramebuffer;if(A.isWebGLCubeRenderTarget&&bt!==void 0&&(Rt=Rt[bt]),Rt){X.bindFramebuffer(P.FRAMEBUFFER,Rt);try{let Lt=A.texture,Ht=Lt.format,Ot=Lt.type;if(Ht!==qe&&vt.convert(Ht)!==P.getParameter(P.IMPLEMENTATION_COLOR_READ_FORMAT)){console.error("THREE.WebGLRenderer.readRenderTargetPixels: renderTarget is not in RGBA or implementation defined format.");return}let Bt=Ot===Is&&(q.has("EXT_color_buffer_half_float")||st.isWebGL2&&q.has("EXT_color_buffer_float"));if(Ot!==kn&&vt.convert(Ot)!==P.getParameter(P.IMPLEMENTATION_COLOR_READ_TYPE)&&!(Ot===cn&&(st.isWebGL2||q.has("OES_texture_float")||q.has("WEBGL_color_buffer_float")))&&!Bt){console.error("THREE.WebGLRenderer.readRenderTargetPixels: renderTarget is not in UnsignedByteType or implementation defined type.");return}D>=0&&D<=A.width-V&&z>=0&&z<=A.height-B&&P.readPixels(D,z,V,B,vt.convert(Ht),vt.convert(Ot),mt)}finally{let Lt=R!==null?ft.get(R).__webglFramebuffer:null;X.bindFramebuffer(P.FRAMEBUFFER,Lt)}}},this.copyFramebufferToTexture=function(A,D,z=0){let V=Math.pow(2,-z),B=Math.floor(D.image.width*V),mt=Math.floor(D.image.height*V);b.setTexture2D(D,0),P.copyTexSubImage2D(P.TEXTURE_2D,z,0,0,A.x,A.y,B,mt),X.unbindTexture()},this.copyTextureToTexture=function(A,D,z,V=0){let B=D.image.width,mt=D.image.height,bt=vt.convert(z.format),Rt=vt.convert(z.type);b.setTexture2D(z,0),P.pixelStorei(P.UNPACK_FLIP_Y_WEBGL,z.flipY),P.pixelStorei(P.UNPACK_PREMULTIPLY_ALPHA_WEBGL,z.premultiplyAlpha),P.pixelStorei(P.UNPACK_ALIGNMENT,z.unpackAlignment),D.isDataTexture?P.texSubImage2D(P.TEXTURE_2D,V,A.x,A.y,B,mt,bt,Rt,D.image.data):D.isCompressedTexture?P.compressedTexSubImage2D(P.TEXTURE_2D,V,A.x,A.y,D.mipmaps[0].width,D.mipmaps[0].height,bt,D.mipmaps[0].data):P.texSubImage2D(P.TEXTURE_2D,V,A.x,A.y,bt,Rt,D.image),V===0&&z.generateMipmaps&&P.generateMipmap(P.TEXTURE_2D),X.unbindTexture()},this.copyTextureToTexture3D=function(A,D,z,V,B=0){if(x.isWebGL1Renderer){console.warn("THREE.WebGLRenderer.copyTextureToTexture3D: can only be used with WebGL2.");return}let mt=A.max.x-A.min.x+1,bt=A.max.y-A.min.y+1,Rt=A.max.z-A.min.z+1,Lt=vt.convert(V.format),Ht=vt.convert(V.type),Ot;if(V.isData3DTexture)b.setTexture3D(V,0),Ot=P.TEXTURE_3D;else if(V.isDataArrayTexture||V.isCompressedArrayTexture)b.setTexture2DArray(V,0),Ot=P.TEXTURE_2D_ARRAY;else{console.warn("THREE.WebGLRenderer.copyTextureToTexture3D: only supports THREE.DataTexture3D and THREE.DataTexture2DArray.");return}P.pixelStorei(P.UNPACK_FLIP_Y_WEBGL,V.flipY),P.pixelStorei(P.UNPACK_PREMULTIPLY_ALPHA_WEBGL,V.premultiplyAlpha),P.pixelStorei(P.UNPACK_ALIGNMENT,V.unpackAlignment);let Bt=P.getParameter(P.UNPACK_ROW_LENGTH),ue=P.getParameter(P.UNPACK_IMAGE_HEIGHT),Ge=P.getParameter(P.UNPACK_SKIP_PIXELS),ye=P.getParameter(P.UNPACK_SKIP_ROWS),dn=P.getParameter(P.UNPACK_SKIP_IMAGES),re=z.isCompressedTexture?z.mipmaps[B]:z.image;P.pixelStorei(P.UNPACK_ROW_LENGTH,re.width),P.pixelStorei(P.UNPACK_IMAGE_HEIGHT,re.height),P.pixelStorei(P.UNPACK_SKIP_PIXELS,A.min.x),P.pixelStorei(P.UNPACK_SKIP_ROWS,A.min.y),P.pixelStorei(P.UNPACK_SKIP_IMAGES,A.min.z),z.isDataTexture||z.isData3DTexture?P.texSubImage3D(Ot,B,D.x,D.y,D.z,mt,bt,Rt,Lt,Ht,re.data):z.isCompressedArrayTexture?(console.warn("THREE.WebGLRenderer.copyTextureToTexture3D: untested support for compressed srcTexture."),P.compressedTexSubImage3D(Ot,B,D.x,D.y,D.z,mt,bt,Rt,Lt,re.data)):P.texSubImage3D(Ot,B,D.x,D.y,D.z,mt,bt,Rt,Lt,Ht,re),P.pixelStorei(P.UNPACK_ROW_LENGTH,Bt),P.pixelStorei(P.UNPACK_IMAGE_HEIGHT,ue),P.pixelStorei(P.UNPACK_SKIP_PIXELS,Ge),P.pixelStorei(P.UNPACK_SKIP_ROWS,ye),P.pixelStorei(P.UNPACK_SKIP_IMAGES,dn),B===0&&V.generateMipmaps&&P.generateMipmap(Ot),X.unbindTexture()},this.initTexture=function(A){A.isCubeTexture?b.setTextureCube(A,0):A.isData3DTexture?b.setTexture3D(A,0):A.isDataArrayTexture||A.isCompressedArrayTexture?b.setTexture2DArray(A,0):b.setTexture2D(A,0),X.unbindTexture()},this.resetState=function(){C=0,T=0,R=null,X.reset(),Vt.reset()},typeof __THREE_DEVTOOLS__<"u"&&__THREE_DEVTOOLS__.dispatchEvent(new CustomEvent("observe",{detail:this}))}get coordinateSystem(){return ln}get outputColorSpace(){return this._outputColorSpace}set outputColorSpace(t){this._outputColorSpace=t;let e=this.getContext();e.drawingBufferColorSpace=t===cl?"display-p3":"srgb",e.unpackColorSpace=jt.workingColorSpace===La?"display-p3":"srgb"}get outputEncoding(){return console.warn("THREE.WebGLRenderer: Property .outputEncoding has been removed. Use .outputColorSpace instead."),this.outputColorSpace===Se?fi:Bd}set outputEncoding(t){console.warn("THREE.WebGLRenderer: Property .outputEncoding has been removed. Use .outputColorSpace instead."),this.outputColorSpace=t===fi?Se:En}get useLegacyLights(){return console.warn("THREE.WebGLRenderer: The property .useLegacyLights has been deprecated. Migrate your lighting according to the following guide: https://discourse.threejs.org/t/updates-to-lighting-in-three-js-r155/53733."),this._useLegacyLights}set useLegacyLights(t){console.warn("THREE.WebGLRenderer: The property .useLegacyLights has been deprecated. Migrate your lighting according to the following guide: https://discourse.threejs.org/t/updates-to-lighting-in-three-js-r155/53733."),this._useLegacyLights=t}},Wo=class extends Go{};Wo.prototype.isWebGL1Renderer=!0;var Xo=class r{constructor(t,e=25e-5){this.isFogExp2=!0,this.name="",this.color=new pt(t),this.density=e}clone(){return new r(this.color,this.density)}toJSON(){return{type:"FogExp2",name:this.name,color:this.color.getHex(),density:this.density}}},qo=class r{constructor(t,e=1,n=1e3){this.isFog=!0,this.name="",this.color=new pt(t),this.near=e,this.far=n}clone(){return new r(this.color,this.near,this.far)}toJSON(){return{type:"Fog",name:this.name,color:this.color.getHex(),near:this.near,far:this.far}}},Yo=class extends Kt{constructor(){super(),this.isScene=!0,this.type="Scene",this.background=null,this.environment=null,this.fog=null,this.backgroundBlurriness=0,this.backgroundIntensity=1,this.overrideMaterial=null,typeof __THREE_DEVTOOLS__<"u"&&__THREE_DEVTOOLS__.dispatchEvent(new CustomEvent("observe",{detail:this}))}copy(t,e){return super.copy(t,e),t.background!==null&&(this.background=t.background.clone()),t.environment!==null&&(this.environment=t.environment.clone()),t.fog!==null&&(this.fog=t.fog.clone()),this.backgroundBlurriness=t.backgroundBlurriness,this.backgroundIntensity=t.backgroundIntensity,t.overrideMaterial!==null&&(this.overrideMaterial=t.overrideMaterial.clone()),this.matrixAutoUpdate=t.matrixAutoUpdate,this}toJSON(t){let e=super.toJSON(t);return this.fog!==null&&(e.object.fog=this.fog.toJSON()),this.backgroundBlurriness>0&&(e.object.backgroundBlurriness=this.backgroundBlurriness),this.backgroundIntensity!==1&&(e.object.backgroundIntensity=this.backgroundIntensity),e}},zs=class{constructor(t,e){this.isInterleavedBuffer=!0,this.array=t,this.stride=e,this.count=t!==void 0?t.length/e:0,this.usage=ta,this._updateRange={offset:0,count:-1},this.updateRanges=[],this.version=0,this.uuid=Ye()}onUploadCallback(){}set needsUpdate(t){t===!0&&this.version++}get updateRange(){return console.warn("THREE.InterleavedBuffer: updateRange() is deprecated and will be removed in r169. Use addUpdateRange() instead."),this._updateRange}setUsage(t){return this.usage=t,this}addUpdateRange(t,e){this.updateRanges.push({start:t,count:e})}clearUpdateRanges(){this.updateRanges.length=0}copy(t){return this.array=new t.array.constructor(t.array),this.count=t.count,this.stride=t.stride,this.usage=t.usage,this}copyAt(t,e,n){t*=this.stride,n*=e.stride;for(let i=0,s=this.stride;i<s;i++)this.array[t+i]=e.array[n+i];return this}set(t,e=0){return this.array.set(t,e),this}clone(t){t.arrayBuffers===void 0&&(t.arrayBuffers={}),this.array.buffer._uuid===void 0&&(this.array.buffer._uuid=Ye()),t.arrayBuffers[this.array.buffer._uuid]===void 0&&(t.arrayBuffers[this.array.buffer._uuid]=this.array.slice(0).buffer);let e=new this.array.constructor(t.arrayBuffers[this.array.buffer._uuid]),n=new this.constructor(e,this.stride);return n.setUsage(this.usage),n}onUpload(t){return this.onUploadCallback=t,this}toJSON(t){return t.arrayBuffers===void 0&&(t.arrayBuffers={}),this.array.buffer._uuid===void 0&&(this.array.buffer._uuid=Ye()),t.arrayBuffers[this.array.buffer._uuid]===void 0&&(t.arrayBuffers[this.array.buffer._uuid]=Array.from(new Uint32Array(this.array.buffer))),{uuid:this.uuid,buffer:this.array.buffer._uuid,type:this.array.constructor.name,stride:this.stride}}},Ne=new w,as=class r{constructor(t,e,n,i=!1){this.isInterleavedBufferAttribute=!0,this.name="",this.data=t,this.itemSize=e,this.offset=n,this.normalized=i}get count(){return this.data.count}get array(){return this.data.array}set needsUpdate(t){this.data.needsUpdate=t}applyMatrix4(t){for(let e=0,n=this.data.count;e<n;e++)Ne.fromBufferAttribute(this,e),Ne.applyMatrix4(t),this.setXYZ(e,Ne.x,Ne.y,Ne.z);return this}applyNormalMatrix(t){for(let e=0,n=this.count;e<n;e++)Ne.fromBufferAttribute(this,e),Ne.applyNormalMatrix(t),this.setXYZ(e,Ne.x,Ne.y,Ne.z);return this}transformDirection(t){for(let e=0,n=this.count;e<n;e++)Ne.fromBufferAttribute(this,e),Ne.transformDirection(t),this.setXYZ(e,Ne.x,Ne.y,Ne.z);return this}setX(t,e){return this.normalized&&(e=zt(e,this.array)),this.data.array[t*this.data.stride+this.offset]=e,this}setY(t,e){return this.normalized&&(e=zt(e,this.array)),this.data.array[t*this.data.stride+this.offset+1]=e,this}setZ(t,e){return this.normalized&&(e=zt(e,this.array)),this.data.array[t*this.data.stride+this.offset+2]=e,this}setW(t,e){return this.normalized&&(e=zt(e,this.array)),this.data.array[t*this.data.stride+this.offset+3]=e,this}getX(t){let e=this.data.array[t*this.data.stride+this.offset];return this.normalized&&(e=ke(e,this.array)),e}getY(t){let e=this.data.array[t*this.data.stride+this.offset+1];return this.normalized&&(e=ke(e,this.array)),e}getZ(t){let e=this.data.array[t*this.data.stride+this.offset+2];return this.normalized&&(e=ke(e,this.array)),e}getW(t){let e=this.data.array[t*this.data.stride+this.offset+3];return this.normalized&&(e=ke(e,this.array)),e}setXY(t,e,n){return t=t*this.data.stride+this.offset,this.normalized&&(e=zt(e,this.array),n=zt(n,this.array)),this.data.array[t+0]=e,this.data.array[t+1]=n,this}setXYZ(t,e,n,i){return t=t*this.data.stride+this.offset,this.normalized&&(e=zt(e,this.array),n=zt(n,this.array),i=zt(i,this.array)),this.data.array[t+0]=e,this.data.array[t+1]=n,this.data.array[t+2]=i,this}setXYZW(t,e,n,i,s){return t=t*this.data.stride+this.offset,this.normalized&&(e=zt(e,this.array),n=zt(n,this.array),i=zt(i,this.array),s=zt(s,this.array)),this.data.array[t+0]=e,this.data.array[t+1]=n,this.data.array[t+2]=i,this.data.array[t+3]=s,this}clone(t){if(t===void 0){console.log("THREE.InterleavedBufferAttribute.clone(): Cloning an interleaved buffer attribute will de-interleave buffer data.");let e=[];for(let n=0;n<this.count;n++){let i=n*this.data.stride+this.offset;for(let s=0;s<this.itemSize;s++)e.push(this.data.array[i+s])}return new Jt(new this.array.constructor(e),this.itemSize,this.normalized)}else return t.interleavedBuffers===void 0&&(t.interleavedBuffers={}),t.interleavedBuffers[this.data.uuid]===void 0&&(t.interleavedBuffers[this.data.uuid]=this.data.clone(t)),new r(t.interleavedBuffers[this.data.uuid],this.itemSize,this.offset,this.normalized)}toJSON(t){if(t===void 0){console.log("THREE.InterleavedBufferAttribute.toJSON(): Serializing an interleaved buffer attribute will de-interleave buffer data.");let e=[];for(let n=0;n<this.count;n++){let i=n*this.data.stride+this.offset;for(let s=0;s<this.itemSize;s++)e.push(this.data.array[i+s])}return{itemSize:this.itemSize,type:this.array.constructor.name,array:e,normalized:this.normalized}}else return t.interleavedBuffers===void 0&&(t.interleavedBuffers={}),t.interleavedBuffers[this.data.uuid]===void 0&&(t.interleavedBuffers[this.data.uuid]=this.data.toJSON(t)),{isInterleavedBufferAttribute:!0,itemSize:this.itemSize,data:this.data.uuid,offset:this.offset,normalized:this.normalized}}},da=class extends Te{constructor(t){super(),this.isSpriteMaterial=!0,this.type="SpriteMaterial",this.color=new pt(16777215),this.map=null,this.alphaMap=null,this.rotation=0,this.sizeAttenuation=!0,this.transparent=!0,this.fog=!0,this.setValues(t)}copy(t){return super.copy(t),this.color.copy(t.color),this.map=t.map,this.alphaMap=t.alphaMap,this.rotation=t.rotation,this.sizeAttenuation=t.sizeAttenuation,this.fog=t.fog,this}},zi,vs=new w,Vi=new w,ki=new w,Hi=new Z,ys=new Z,Jd=new It,xr=new w,Ms=new w,vr=new w,Jh=new Z,fo=new Z,$h=new Z,Zo=class extends Kt{constructor(t=new da){if(super(),this.isSprite=!0,this.type="Sprite",zi===void 0){zi=new Wt;let e=new Float32Array([-.5,-.5,0,0,0,.5,-.5,0,1,0,.5,.5,0,1,1,-.5,.5,0,0,1]),n=new zs(e,5);zi.setIndex([0,1,2,0,2,3]),zi.setAttribute("position",new as(n,3,0,!1)),zi.setAttribute("uv",new as(n,2,3,!1))}this.geometry=zi,this.material=t,this.center=new Z(.5,.5)}raycast(t,e){t.camera===null&&console.error('THREE.Sprite: "Raycaster.camera" needs to be set in order to raycast against sprites.'),Vi.setFromMatrixScale(this.matrixWorld),Jd.copy(t.camera.matrixWorld),this.modelViewMatrix.multiplyMatrices(t.camera.matrixWorldInverse,this.matrixWorld),ki.setFromMatrixPosition(this.modelViewMatrix),t.camera.isPerspectiveCamera&&this.material.sizeAttenuation===!1&&Vi.multiplyScalar(-ki.z);let n=this.material.rotation,i,s;n!==0&&(s=Math.cos(n),i=Math.sin(n));let a=this.center;yr(xr.set(-.5,-.5,0),ki,a,Vi,i,s),yr(Ms.set(.5,-.5,0),ki,a,Vi,i,s),yr(vr.set(.5,.5,0),ki,a,Vi,i,s),Jh.set(0,0),fo.set(1,0),$h.set(1,1);let o=t.ray.intersectTriangle(xr,Ms,vr,!1,vs);if(o===null&&(yr(Ms.set(-.5,.5,0),ki,a,Vi,i,s),fo.set(0,1),o=t.ray.intersectTriangle(xr,vr,Ms,!1,vs),o===null))return;let c=t.ray.origin.distanceTo(vs);c<t.near||c>t.far||e.push({distance:c,point:vs.clone(),uv:Fn.getInterpolation(vs,xr,Ms,vr,Jh,fo,$h,new Z),face:null,object:this})}copy(t,e){return super.copy(t,e),t.center!==void 0&&this.center.copy(t.center),this.material=t.material,this}};function yr(r,t,e,n,i,s){Hi.subVectors(r,e).addScalar(.5).multiply(n),i!==void 0?(ys.x=s*Hi.x-i*Hi.y,ys.y=i*Hi.x+s*Hi.y):ys.copy(Hi),r.copy(t),r.x+=ys.x,r.y+=ys.y,r.applyMatrix4(Jd)}var Mr=new w,Kh=new w,Jo=class extends Kt{constructor(){super(),this._currentLevel=0,this.type="LOD",Object.defineProperties(this,{levels:{enumerable:!0,value:[]},isLOD:{value:!0}}),this.autoUpdate=!0}copy(t){super.copy(t,!1);let e=t.levels;for(let n=0,i=e.length;n<i;n++){let s=e[n];this.addLevel(s.object.clone(),s.distance,s.hysteresis)}return this.autoUpdate=t.autoUpdate,this}addLevel(t,e=0,n=0){e=Math.abs(e);let i=this.levels,s;for(s=0;s<i.length&&!(e<i[s].distance);s++);return i.splice(s,0,{distance:e,hysteresis:n,object:t}),this.add(t),this}getCurrentLevel(){return this._currentLevel}getObjectForDistance(t){let e=this.levels;if(e.length>0){let n,i;for(n=1,i=e.length;n<i;n++){let s=e[n].distance;if(e[n].object.visible&&(s-=s*e[n].hysteresis),t<s)break}return e[n-1].object}return null}raycast(t,e){if(this.levels.length>0){Mr.setFromMatrixPosition(this.matrixWorld);let i=t.ray.origin.distanceTo(Mr);this.getObjectForDistance(i).raycast(t,e)}}update(t){let e=this.levels;if(e.length>1){Mr.setFromMatrixPosition(t.matrixWorld),Kh.setFromMatrixPosition(this.matrixWorld);let n=Mr.distanceTo(Kh)/t.zoom;e[0].object.visible=!0;let i,s;for(i=1,s=e.length;i<s;i++){let a=e[i].distance;if(e[i].object.visible&&(a-=a*e[i].hysteresis),n>=a)e[i-1].object.visible=!1,e[i].object.visible=!0;else break}for(this._currentLevel=i-1;i<s;i++)e[i].object.visible=!1}}toJSON(t){let e=super.toJSON(t);this.autoUpdate===!1&&(e.object.autoUpdate=!1),e.object.levels=[];let n=this.levels;for(let i=0,s=n.length;i<s;i++){let a=n[i];e.object.levels.push({object:a.object.uuid,distance:a.distance,hysteresis:a.hysteresis})}return e}},Qh=new w,jh=new te,tu=new te,xx=new w,eu=new It,Sr=new w,po=new Ae,nu=new It,mo=new _i,$o=class extends ge{constructor(t,e){super(t,e),this.isSkinnedMesh=!0,this.type="SkinnedMesh",this.bindMode=wl,this.bindMatrix=new It,this.bindMatrixInverse=new It,this.boundingBox=null,this.boundingSphere=null}computeBoundingBox(){let t=this.geometry;this.boundingBox===null&&(this.boundingBox=new Le),this.boundingBox.makeEmpty();let e=t.getAttribute("position");for(let n=0;n<e.count;n++)this.getVertexPosition(n,Sr),this.boundingBox.expandByPoint(Sr)}computeBoundingSphere(){let t=this.geometry;this.boundingSphere===null&&(this.boundingSphere=new Ae),this.boundingSphere.makeEmpty();let e=t.getAttribute("position");for(let n=0;n<e.count;n++)this.getVertexPosition(n,Sr),this.boundingSphere.expandByPoint(Sr)}copy(t,e){return super.copy(t,e),this.bindMode=t.bindMode,this.bindMatrix.copy(t.bindMatrix),this.bindMatrixInverse.copy(t.bindMatrixInverse),this.skeleton=t.skeleton,t.boundingBox!==null&&(this.boundingBox=t.boundingBox.clone()),t.boundingSphere!==null&&(this.boundingSphere=t.boundingSphere.clone()),this}raycast(t,e){let n=this.material,i=this.matrixWorld;n!==void 0&&(this.boundingSphere===null&&this.computeBoundingSphere(),po.copy(this.boundingSphere),po.applyMatrix4(i),t.ray.intersectsSphere(po)!==!1&&(nu.copy(i).invert(),mo.copy(t.ray).applyMatrix4(nu),!(this.boundingBox!==null&&mo.intersectsBox(this.boundingBox)===!1)&&this._computeIntersections(t,e,mo)))}getVertexPosition(t,e){return super.getVertexPosition(t,e),this.applyBoneTransform(t,e),e}bind(t,e){this.skeleton=t,e===void 0&&(this.updateMatrixWorld(!0),this.skeleton.calculateInverses(),e=this.matrixWorld),this.bindMatrix.copy(e),this.bindMatrixInverse.copy(e).invert()}pose(){this.skeleton.pose()}normalizeSkinWeights(){let t=new te,e=this.geometry.attributes.skinWeight;for(let n=0,i=e.count;n<i;n++){t.fromBufferAttribute(e,n);let s=1/t.manhattanLength();s!==1/0?t.multiplyScalar(s):t.set(1,0,0,0),e.setXYZW(n,t.x,t.y,t.z,t.w)}}updateMatrixWorld(t){super.updateMatrixWorld(t),this.bindMode===wl?this.bindMatrixInverse.copy(this.matrixWorld).invert():this.bindMode===Hf?this.bindMatrixInverse.copy(this.bindMatrix).invert():console.warn("THREE.SkinnedMesh: Unrecognized bindMode: "+this.bindMode)}applyBoneTransform(t,e){let n=this.skeleton,i=this.geometry;jh.fromBufferAttribute(i.attributes.skinIndex,t),tu.fromBufferAttribute(i.attributes.skinWeight,t),Qh.copy(e).applyMatrix4(this.bindMatrix),e.set(0,0,0);for(let s=0;s<4;s++){let a=tu.getComponent(s);if(a!==0){let o=jh.getComponent(s);eu.multiplyMatrices(n.bones[o].matrixWorld,n.boneInverses[o]),e.addScaledVector(xx.copy(Qh).applyMatrix4(eu),a)}}return e.applyMatrix4(this.bindMatrixInverse)}boneTransform(t,e){return console.warn("THREE.SkinnedMesh: .boneTransform() was renamed to .applyBoneTransform() in r151."),this.applyBoneTransform(t,e)}},fa=class extends Kt{constructor(){super(),this.isBone=!0,this.type="Bone"}},Hn=class extends Ee{constructor(t=null,e=1,n=1,i,s,a,o,c,l=pe,h=pe,u,d){super(null,a,o,c,l,h,i,s,u,d),this.isDataTexture=!0,this.image={data:t,width:e,height:n},this.generateMipmaps=!1,this.flipY=!1,this.unpackAlignment=1}},iu=new It,vx=new It,Ko=class r{constructor(t=[],e=[]){this.uuid=Ye(),this.bones=t.slice(0),this.boneInverses=e,this.boneMatrices=null,this.boneTexture=null,this.init()}init(){let t=this.bones,e=this.boneInverses;if(this.boneMatrices=new Float32Array(t.length*16),e.length===0)this.calculateInverses();else if(t.length!==e.length){console.warn("THREE.Skeleton: Number of inverse bone matrices does not match amount of bones."),this.boneInverses=[];for(let n=0,i=this.bones.length;n<i;n++)this.boneInverses.push(new It)}}calculateInverses(){this.boneInverses.length=0;for(let t=0,e=this.bones.length;t<e;t++){let n=new It;this.bones[t]&&n.copy(this.bones[t].matrixWorld).invert(),this.boneInverses.push(n)}}pose(){for(let t=0,e=this.bones.length;t<e;t++){let n=this.bones[t];n&&n.matrixWorld.copy(this.boneInverses[t]).invert()}for(let t=0,e=this.bones.length;t<e;t++){let n=this.bones[t];n&&(n.parent&&n.parent.isBone?(n.matrix.copy(n.parent.matrixWorld).invert(),n.matrix.multiply(n.matrixWorld)):n.matrix.copy(n.matrixWorld),n.matrix.decompose(n.position,n.quaternion,n.scale))}}update(){let t=this.bones,e=this.boneInverses,n=this.boneMatrices,i=this.boneTexture;for(let s=0,a=t.length;s<a;s++){let o=t[s]?t[s].matrixWorld:vx;iu.multiplyMatrices(o,e[s]),iu.toArray(n,s*16)}i!==null&&(i.needsUpdate=!0)}clone(){return new r(this.bones,this.boneInverses)}computeBoneTexture(){let t=Math.sqrt(this.bones.length*4);t=Math.ceil(t/4)*4,t=Math.max(t,4);let e=new Float32Array(t*t*4);e.set(this.boneMatrices);let n=new Hn(e,t,t,qe,cn);return n.needsUpdate=!0,this.boneMatrices=e,this.boneTexture=n,this}getBoneByName(t){for(let e=0,n=this.bones.length;e<n;e++){let i=this.bones[e];if(i.name===t)return i}}dispose(){this.boneTexture!==null&&(this.boneTexture.dispose(),this.boneTexture=null)}fromJSON(t,e){this.uuid=t.uuid;for(let n=0,i=t.bones.length;n<i;n++){let s=t.bones[n],a=e[s];a===void 0&&(console.warn("THREE.Skeleton: No bone found with UUID:",s),a=new fa),this.bones.push(a),this.boneInverses.push(new It().fromArray(t.boneInverses[n]))}return this.init(),this}toJSON(){let t={metadata:{version:4.6,type:"Skeleton",generator:"Skeleton.toJSON"},bones:[],boneInverses:[]};t.uuid=this.uuid;let e=this.bones,n=this.boneInverses;for(let i=0,s=e.length;i<s;i++){let a=e[i];t.bones.push(a.uuid);let o=n[i];t.boneInverses.push(o.toArray())}return t}},xi=class extends Jt{constructor(t,e,n,i=1){super(t,e,n),this.isInstancedBufferAttribute=!0,this.meshPerAttribute=i}copy(t){return super.copy(t),this.meshPerAttribute=t.meshPerAttribute,this}toJSON(){let t=super.toJSON();return t.meshPerAttribute=this.meshPerAttribute,t.isInstancedBufferAttribute=!0,t}},Gi=new It,su=new It,br=[],ru=new Le,yx=new It,Ss=new ge,bs=new Ae,Qo=class extends ge{constructor(t,e,n){super(t,e),this.isInstancedMesh=!0,this.instanceMatrix=new xi(new Float32Array(n*16),16),this.instanceColor=null,this.count=n,this.boundingBox=null,this.boundingSphere=null;for(let i=0;i<n;i++)this.setMatrixAt(i,yx)}computeBoundingBox(){let t=this.geometry,e=this.count;this.boundingBox===null&&(this.boundingBox=new Le),t.boundingBox===null&&t.computeBoundingBox(),this.boundingBox.makeEmpty();for(let n=0;n<e;n++)this.getMatrixAt(n,Gi),ru.copy(t.boundingBox).applyMatrix4(Gi),this.boundingBox.union(ru)}computeBoundingSphere(){let t=this.geometry,e=this.count;this.boundingSphere===null&&(this.boundingSphere=new Ae),t.boundingSphere===null&&t.computeBoundingSphere(),this.boundingSphere.makeEmpty();for(let n=0;n<e;n++)this.getMatrixAt(n,Gi),bs.copy(t.boundingSphere).applyMatrix4(Gi),this.boundingSphere.union(bs)}copy(t,e){return super.copy(t,e),this.instanceMatrix.copy(t.instanceMatrix),t.instanceColor!==null&&(this.instanceColor=t.instanceColor.clone()),this.count=t.count,t.boundingBox!==null&&(this.boundingBox=t.boundingBox.clone()),t.boundingSphere!==null&&(this.boundingSphere=t.boundingSphere.clone()),this}getColorAt(t,e){e.fromArray(this.instanceColor.array,t*3)}getMatrixAt(t,e){e.fromArray(this.instanceMatrix.array,t*16)}raycast(t,e){let n=this.matrixWorld,i=this.count;if(Ss.geometry=this.geometry,Ss.material=this.material,Ss.material!==void 0&&(this.boundingSphere===null&&this.computeBoundingSphere(),bs.copy(this.boundingSphere),bs.applyMatrix4(n),t.ray.intersectsSphere(bs)!==!1))for(let s=0;s<i;s++){this.getMatrixAt(s,Gi),su.multiplyMatrices(n,Gi),Ss.matrixWorld=su,Ss.raycast(t,br);for(let a=0,o=br.length;a<o;a++){let c=br[a];c.instanceId=s,c.object=this,e.push(c)}br.length=0}}setColorAt(t,e){this.instanceColor===null&&(this.instanceColor=new xi(new Float32Array(this.instanceMatrix.count*3),3)),e.toArray(this.instanceColor.array,t*3)}setMatrixAt(t,e){e.toArray(this.instanceMatrix.array,t*16)}updateMorphTargets(){}dispose(){this.dispatchEvent({type:"dispose"})}};function Mx(r,t){return r.z-t.z}function Sx(r,t){return t.z-r.z}var jo=class{constructor(){this.index=0,this.pool=[],this.list=[]}push(t,e){let n=this.pool,i=this.list;this.index>=n.length&&n.push({start:-1,count:-1,z:-1});let s=n[this.index];i.push(s),this.index++,s.start=t.start,s.count=t.count,s.z=e}reset(){this.list.length=0,this.index=0}},Wi="batchId",Un=new It,au=new It,bx=new It,ou=new It,go=new rs,Er=new Le,ti=new Ae,Es=new w,_o=new jo,Pe=new ge,Ar=[];function Ex(r,t,e=0){let n=t.itemSize;if(r.isInterleavedBufferAttribute||r.array.constructor!==t.array.constructor){let i=r.count;for(let s=0;s<i;s++)for(let a=0;a<n;a++)t.setComponent(s+e,a,r.getComponent(s,a))}else t.array.set(r.array,e*n);t.needsUpdate=!0}var tc=class extends ge{get maxGeometryCount(){return this._maxGeometryCount}constructor(t,e,n=e*2,i){super(new Wt,i),this.isBatchedMesh=!0,this.perObjectFrustumCulled=!0,this.sortObjects=!0,this.boundingBox=null,this.boundingSphere=null,this.customSort=null,this._drawRanges=[],this._reservedRanges=[],this._visibility=[],this._active=[],this._bounds=[],this._maxGeometryCount=t,this._maxVertexCount=e,this._maxIndexCount=n,this._geometryInitialized=!1,this._geometryCount=0,this._multiDrawCounts=new Int32Array(t),this._multiDrawStarts=new Int32Array(t),this._multiDrawCount=0,this._visibilityChanged=!0,this._matricesTexture=null,this._initMatricesTexture()}_initMatricesTexture(){let t=Math.sqrt(this._maxGeometryCount*4);t=Math.ceil(t/4)*4,t=Math.max(t,4);let e=new Float32Array(t*t*4),n=new Hn(e,t,t,qe,cn);this._matricesTexture=n}_initializeGeometry(t){let e=this.geometry,n=this._maxVertexCount,i=this._maxGeometryCount,s=this._maxIndexCount;if(this._geometryInitialized===!1){for(let o in t.attributes){let c=t.getAttribute(o),{array:l,itemSize:h,normalized:u}=c,d=new l.constructor(n*h),f=new c.constructor(d,h,u);f.setUsage(c.usage),e.setAttribute(o,f)}if(t.getIndex()!==null){let o=n>65536?new Uint32Array(s):new Uint16Array(s);e.setIndex(new Jt(o,1))}let a=i>65536?new Uint32Array(n):new Uint16Array(n);e.setAttribute(Wi,new Jt(a,1)),this._geometryInitialized=!0}}_validateGeometry(t){if(t.getAttribute(Wi))throw new Error(`BatchedMesh: Geometry cannot use attribute "${Wi}"`);let e=this.geometry;if(!!t.getIndex()!=!!e.getIndex())throw new Error('BatchedMesh: All geometries must consistently have "index".');for(let n in e.attributes){if(n===Wi)continue;if(!t.hasAttribute(n))throw new Error(`BatchedMesh: Added geometry missing "${n}". All geometries must have consistent attributes.`);let i=t.getAttribute(n),s=e.getAttribute(n);if(i.itemSize!==s.itemSize||i.normalized!==s.normalized)throw new Error("BatchedMesh: All attributes must have a consistent itemSize and normalized value.")}}setCustomSort(t){return this.customSort=t,this}computeBoundingBox(){this.boundingBox===null&&(this.boundingBox=new Le);let t=this._geometryCount,e=this.boundingBox,n=this._active;e.makeEmpty();for(let i=0;i<t;i++)n[i]!==!1&&(this.getMatrixAt(i,Un),this.getBoundingBoxAt(i,Er).applyMatrix4(Un),e.union(Er))}computeBoundingSphere(){this.boundingSphere===null&&(this.boundingSphere=new Ae);let t=this._geometryCount,e=this.boundingSphere,n=this._active;e.makeEmpty();for(let i=0;i<t;i++)n[i]!==!1&&(this.getMatrixAt(i,Un),this.getBoundingSphereAt(i,ti).applyMatrix4(Un),e.union(ti))}addGeometry(t,e=-1,n=-1){if(this._initializeGeometry(t),this._validateGeometry(t),this._geometryCount>=this._maxGeometryCount)throw new Error("BatchedMesh: Maximum geometry count reached.");let i={vertexStart:-1,vertexCount:-1,indexStart:-1,indexCount:-1},s=null,a=this._reservedRanges,o=this._drawRanges,c=this._bounds;this._geometryCount!==0&&(s=a[a.length-1]),e===-1?i.vertexCount=t.getAttribute("position").count:i.vertexCount=e,s===null?i.vertexStart=0:i.vertexStart=s.vertexStart+s.vertexCount;let l=t.getIndex(),h=l!==null;if(h&&(n===-1?i.indexCount=l.count:i.indexCount=n,s===null?i.indexStart=0:i.indexStart=s.indexStart+s.indexCount),i.indexStart!==-1&&i.indexStart+i.indexCount>this._maxIndexCount||i.vertexStart+i.vertexCount>this._maxVertexCount)throw new Error("BatchedMesh: Reserved space request exceeds the maximum buffer size.");let u=this._visibility,d=this._active,f=this._matricesTexture,m=this._matricesTexture.image.data;u.push(!0),d.push(!0);let _=this._geometryCount;this._geometryCount++,bx.toArray(m,_*16),f.needsUpdate=!0,a.push(i),o.push({start:h?i.indexStart:i.vertexStart,count:-1}),c.push({boxInitialized:!1,box:new Le,sphereInitialized:!1,sphere:new Ae});let g=this.geometry.getAttribute(Wi);for(let p=0;p<i.vertexCount;p++)g.setX(i.vertexStart+p,_);return g.needsUpdate=!0,this.setGeometryAt(_,t),_}setGeometryAt(t,e){if(t>=this._geometryCount)throw new Error("BatchedMesh: Maximum geometry count reached.");this._validateGeometry(e);let n=this.geometry,i=n.getIndex()!==null,s=n.getIndex(),a=e.getIndex(),o=this._reservedRanges[t];if(i&&a.count>o.indexCount||e.attributes.position.count>o.vertexCount)throw new Error("BatchedMesh: Reserved space not large enough for provided geometry.");let c=o.vertexStart,l=o.vertexCount;for(let f in n.attributes){if(f===Wi)continue;let m=e.getAttribute(f),_=n.getAttribute(f);Ex(m,_,c);let g=m.itemSize;for(let p=m.count,v=l;p<v;p++){let x=c+p;for(let y=0;y<g;y++)_.setComponent(x,y,0)}_.needsUpdate=!0}if(i){let f=o.indexStart;for(let m=0;m<a.count;m++)s.setX(f+m,c+a.getX(m));for(let m=a.count,_=o.indexCount;m<_;m++)s.setX(f+m,c);s.needsUpdate=!0}let h=this._bounds[t];e.boundingBox!==null?(h.box.copy(e.boundingBox),h.boxInitialized=!0):h.boxInitialized=!1,e.boundingSphere!==null?(h.sphere.copy(e.boundingSphere),h.sphereInitialized=!0):h.sphereInitialized=!1;let u=this._drawRanges[t],d=e.getAttribute("position");return u.count=i?a.count:d.count,this._visibilityChanged=!0,t}deleteGeometry(t){let e=this._active;return t>=e.length||e[t]===!1?this:(e[t]=!1,this._visibilityChanged=!0,this)}getBoundingBoxAt(t,e){if(this._active[t]===!1)return this;let i=this._bounds[t],s=i.box,a=this.geometry;if(i.boxInitialized===!1){s.makeEmpty();let o=a.index,c=a.attributes.position,l=this._drawRanges[t];for(let h=l.start,u=l.start+l.count;h<u;h++){let d=h;o&&(d=o.getX(d)),s.expandByPoint(Es.fromBufferAttribute(c,d))}i.boxInitialized=!0}return e.copy(s),e}getBoundingSphereAt(t,e){if(this._active[t]===!1)return this;let i=this._bounds[t],s=i.sphere,a=this.geometry;if(i.sphereInitialized===!1){s.makeEmpty(),this.getBoundingBoxAt(t,Er),Er.getCenter(s.center);let o=a.index,c=a.attributes.position,l=this._drawRanges[t],h=0;for(let u=l.start,d=l.start+l.count;u<d;u++){let f=u;o&&(f=o.getX(f)),Es.fromBufferAttribute(c,f),h=Math.max(h,s.center.distanceToSquared(Es))}s.radius=Math.sqrt(h),i.sphereInitialized=!0}return e.copy(s),e}setMatrixAt(t,e){let n=this._active,i=this._matricesTexture,s=this._matricesTexture.image.data,a=this._geometryCount;return t>=a||n[t]===!1?this:(e.toArray(s,t*16),i.needsUpdate=!0,this)}getMatrixAt(t,e){let n=this._active,i=this._matricesTexture.image.data,s=this._geometryCount;return t>=s||n[t]===!1?null:e.fromArray(i,t*16)}setVisibleAt(t,e){let n=this._visibility,i=this._active,s=this._geometryCount;return t>=s||i[t]===!1||n[t]===e?this:(n[t]=e,this._visibilityChanged=!0,this)}getVisibleAt(t){let e=this._visibility,n=this._active,i=this._geometryCount;return t>=i||n[t]===!1?!1:e[t]}raycast(t,e){let n=this._visibility,i=this._active,s=this._drawRanges,a=this._geometryCount,o=this.matrixWorld,c=this.geometry;Pe.material=this.material,Pe.geometry.index=c.index,Pe.geometry.attributes=c.attributes,Pe.geometry.boundingBox===null&&(Pe.geometry.boundingBox=new Le),Pe.geometry.boundingSphere===null&&(Pe.geometry.boundingSphere=new Ae);for(let l=0;l<a;l++){if(!n[l]||!i[l])continue;let h=s[l];Pe.geometry.setDrawRange(h.start,h.count),this.getMatrixAt(l,Pe.matrixWorld).premultiply(o),this.getBoundingBoxAt(l,Pe.geometry.boundingBox),this.getBoundingSphereAt(l,Pe.geometry.boundingSphere),Pe.raycast(t,Ar);for(let u=0,d=Ar.length;u<d;u++){let f=Ar[u];f.object=this,f.batchId=l,e.push(f)}Ar.length=0}Pe.material=null,Pe.geometry.index=null,Pe.geometry.attributes={},Pe.geometry.setDrawRange(0,1/0)}copy(t){return super.copy(t),this.geometry=t.geometry.clone(),this.perObjectFrustumCulled=t.perObjectFrustumCulled,this.sortObjects=t.sortObjects,this.boundingBox=t.boundingBox!==null?t.boundingBox.clone():null,this.boundingSphere=t.boundingSphere!==null?t.boundingSphere.clone():null,this._drawRanges=t._drawRanges.map(e=>({...e})),this._reservedRanges=t._reservedRanges.map(e=>({...e})),this._visibility=t._visibility.slice(),this._active=t._active.slice(),this._bounds=t._bounds.map(e=>({boxInitialized:e.boxInitialized,box:e.box.clone(),sphereInitialized:e.sphereInitialized,sphere:e.sphere.clone()})),this._maxGeometryCount=t._maxGeometryCount,this._maxVertexCount=t._maxVertexCount,this._maxIndexCount=t._maxIndexCount,this._geometryInitialized=t._geometryInitialized,this._geometryCount=t._geometryCount,this._multiDrawCounts=t._multiDrawCounts.slice(),this._multiDrawStarts=t._multiDrawStarts.slice(),this._matricesTexture=t._matricesTexture.clone(),this._matricesTexture.image.data=this._matricesTexture.image.slice(),this}dispose(){return this.geometry.dispose(),this._matricesTexture.dispose(),this._matricesTexture=null,this}onBeforeRender(t,e,n,i,s){if(!this._visibilityChanged&&!this.perObjectFrustumCulled&&!this.sortObjects)return;let a=i.getIndex(),o=a===null?1:a.array.BYTES_PER_ELEMENT,c=this._visibility,l=this._multiDrawStarts,h=this._multiDrawCounts,u=this._drawRanges,d=this.perObjectFrustumCulled;d&&(ou.multiplyMatrices(n.projectionMatrix,n.matrixWorldInverse).multiply(this.matrixWorld),go.setFromProjectionMatrix(ou,t.isWebGPURenderer?Us:ln));let f=0;if(this.sortObjects){au.copy(this.matrixWorld).invert(),Es.setFromMatrixPosition(n.matrixWorld).applyMatrix4(au);for(let g=0,p=c.length;g<p;g++)if(c[g]){this.getMatrixAt(g,Un),this.getBoundingSphereAt(g,ti).applyMatrix4(Un);let v=!1;if(d&&(v=!go.intersectsSphere(ti)),!v){let x=Es.distanceTo(ti.center);_o.push(u[g],x)}}let m=_o.list,_=this.customSort;_===null?m.sort(s.transparent?Sx:Mx):_.call(this,m,n);for(let g=0,p=m.length;g<p;g++){let v=m[g];l[f]=v.start*o,h[f]=v.count,f++}_o.reset()}else for(let m=0,_=c.length;m<_;m++)if(c[m]){let g=!1;if(d&&(this.getMatrixAt(m,Un),this.getBoundingSphereAt(m,ti).applyMatrix4(Un),g=!go.intersectsSphere(ti)),!g){let p=u[m];l[f]=p.start*o,h[f]=p.count,f++}}this._multiDrawCount=f,this._visibilityChanged=!1}onBeforeShadow(t,e,n,i,s,a){this.onBeforeRender(t,null,i,s,a)}},Ie=class extends Te{constructor(t){super(),this.isLineBasicMaterial=!0,this.type="LineBasicMaterial",this.color=new pt(16777215),this.map=null,this.linewidth=1,this.linecap="round",this.linejoin="round",this.fog=!0,this.setValues(t)}copy(t){return super.copy(t),this.color.copy(t.color),this.map=t.map,this.linewidth=t.linewidth,this.linecap=t.linecap,this.linejoin=t.linejoin,this.fog=t.fog,this}},cu=new w,lu=new w,hu=new It,xo=new _i,Tr=new Ae,Tn=class extends Kt{constructor(t=new Wt,e=new Ie){super(),this.isLine=!0,this.type="Line",this.geometry=t,this.material=e,this.updateMorphTargets()}copy(t,e){return super.copy(t,e),this.material=Array.isArray(t.material)?t.material.slice():t.material,this.geometry=t.geometry,this}computeLineDistances(){let t=this.geometry;if(t.index===null){let e=t.attributes.position,n=[0];for(let i=1,s=e.count;i<s;i++)cu.fromBufferAttribute(e,i-1),lu.fromBufferAttribute(e,i),n[i]=n[i-1],n[i]+=cu.distanceTo(lu);t.setAttribute("lineDistance",new xt(n,1))}else console.warn("THREE.Line.computeLineDistances(): Computation only possible with non-indexed BufferGeometry.");return this}raycast(t,e){let n=this.geometry,i=this.matrixWorld,s=t.params.Line.threshold,a=n.drawRange;if(n.boundingSphere===null&&n.computeBoundingSphere(),Tr.copy(n.boundingSphere),Tr.applyMatrix4(i),Tr.radius+=s,t.ray.intersectsSphere(Tr)===!1)return;hu.copy(i).invert(),xo.copy(t.ray).applyMatrix4(hu);let o=s/((this.scale.x+this.scale.y+this.scale.z)/3),c=o*o,l=new w,h=new w,u=new w,d=new w,f=this.isLineSegments?2:1,m=n.index,g=n.attributes.position;if(m!==null){let p=Math.max(0,a.start),v=Math.min(m.count,a.start+a.count);for(let x=p,y=v-1;x<y;x+=f){let C=m.getX(x),T=m.getX(x+1);if(l.fromBufferAttribute(g,C),h.fromBufferAttribute(g,T),xo.distanceSqToSegment(l,h,d,u)>c)continue;d.applyMatrix4(this.matrixWorld);let U=t.ray.origin.distanceTo(d);U<t.near||U>t.far||e.push({distance:U,point:u.clone().applyMatrix4(this.matrixWorld),index:x,face:null,faceIndex:null,object:this})}}else{let p=Math.max(0,a.start),v=Math.min(g.count,a.start+a.count);for(let x=p,y=v-1;x<y;x+=f){if(l.fromBufferAttribute(g,x),h.fromBufferAttribute(g,x+1),xo.distanceSqToSegment(l,h,d,u)>c)continue;d.applyMatrix4(this.matrixWorld);let T=t.ray.origin.distanceTo(d);T<t.near||T>t.far||e.push({distance:T,point:u.clone().applyMatrix4(this.matrixWorld),index:x,face:null,faceIndex:null,object:this})}}}updateMorphTargets(){let e=this.geometry.morphAttributes,n=Object.keys(e);if(n.length>0){let i=e[n[0]];if(i!==void 0){this.morphTargetInfluences=[],this.morphTargetDictionary={};for(let s=0,a=i.length;s<a;s++){let o=i[s].name||String(s);this.morphTargetInfluences.push(0),this.morphTargetDictionary[o]=s}}}}},uu=new w,du=new w,rn=class extends Tn{constructor(t,e){super(t,e),this.isLineSegments=!0,this.type="LineSegments"}computeLineDistances(){let t=this.geometry;if(t.index===null){let e=t.attributes.position,n=[];for(let i=0,s=e.count;i<s;i+=2)uu.fromBufferAttribute(e,i),du.fromBufferAttribute(e,i+1),n[i]=i===0?0:n[i-1],n[i+1]=n[i]+uu.distanceTo(du);t.setAttribute("lineDistance",new xt(n,1))}else console.warn("THREE.LineSegments.computeLineDistances(): Computation only possible with non-indexed BufferGeometry.");return this}},ec=class extends Tn{constructor(t,e){super(t,e),this.isLineLoop=!0,this.type="LineLoop"}},pa=class extends Te{constructor(t){super(),this.isPointsMaterial=!0,this.type="PointsMaterial",this.color=new pt(16777215),this.map=null,this.alphaMap=null,this.size=1,this.sizeAttenuation=!0,this.fog=!0,this.setValues(t)}copy(t){return super.copy(t),this.color.copy(t.color),this.map=t.map,this.alphaMap=t.alphaMap,this.size=t.size,this.sizeAttenuation=t.sizeAttenuation,this.fog=t.fog,this}},fu=new It,nc=new _i,wr=new Ae,Rr=new w,ic=class extends Kt{constructor(t=new Wt,e=new pa){super(),this.isPoints=!0,this.type="Points",this.geometry=t,this.material=e,this.updateMorphTargets()}copy(t,e){return super.copy(t,e),this.material=Array.isArray(t.material)?t.material.slice():t.material,this.geometry=t.geometry,this}raycast(t,e){let n=this.geometry,i=this.matrixWorld,s=t.params.Points.threshold,a=n.drawRange;if(n.boundingSphere===null&&n.computeBoundingSphere(),wr.copy(n.boundingSphere),wr.applyMatrix4(i),wr.radius+=s,t.ray.intersectsSphere(wr)===!1)return;fu.copy(i).invert(),nc.copy(t.ray).applyMatrix4(fu);let o=s/((this.scale.x+this.scale.y+this.scale.z)/3),c=o*o,l=n.index,u=n.attributes.position;if(l!==null){let d=Math.max(0,a.start),f=Math.min(l.count,a.start+a.count);for(let m=d,_=f;m<_;m++){let g=l.getX(m);Rr.fromBufferAttribute(u,g),pu(Rr,g,c,i,t,e,this)}}else{let d=Math.max(0,a.start),f=Math.min(u.count,a.start+a.count);for(let m=d,_=f;m<_;m++)Rr.fromBufferAttribute(u,m),pu(Rr,m,c,i,t,e,this)}}updateMorphTargets(){let e=this.geometry.morphAttributes,n=Object.keys(e);if(n.length>0){let i=e[n[0]];if(i!==void 0){this.morphTargetInfluences=[],this.morphTargetDictionary={};for(let s=0,a=i.length;s<a;s++){let o=i[s].name||String(s);this.morphTargetInfluences.push(0),this.morphTargetDictionary[o]=s}}}}};function pu(r,t,e,n,i,s,a){let o=nc.distanceSqToPoint(r);if(o<e){let c=new w;nc.closestPointToPoint(r,c),c.applyMatrix4(n);let l=i.ray.origin.distanceTo(c);if(l<i.near||l>i.far)return;s.push({distance:l,distanceToRay:Math.sqrt(o),point:c,index:t,face:null,object:a})}}var mu=class extends Ee{constructor(t,e,n,i,s,a,o,c,l){super(t,e,n,i,s,a,o,c,l),this.isVideoTexture=!0,this.minFilter=a!==void 0?a:me,this.magFilter=s!==void 0?s:me,this.generateMipmaps=!1;let h=this;function u(){h.needsUpdate=!0,t.requestVideoFrameCallback(u)}"requestVideoFrameCallback"in t&&t.requestVideoFrameCallback(u)}clone(){return new this.constructor(this.image).copy(this)}update(){let t=this.image;"requestVideoFrameCallback"in t===!1&&t.readyState>=t.HAVE_CURRENT_DATA&&(this.needsUpdate=!0)}},gu=class extends Ee{constructor(t,e){super({width:t,height:e}),this.isFramebufferTexture=!0,this.magFilter=pe,this.minFilter=pe,this.generateMipmaps=!1,this.needsUpdate=!0}},Vs=class extends Ee{constructor(t,e,n,i,s,a,o,c,l,h,u,d){super(null,a,o,c,l,h,i,s,u,d),this.isCompressedTexture=!0,this.image={width:e,height:n},this.mipmaps=t,this.flipY=!1,this.generateMipmaps=!1}},_u=class extends Vs{constructor(t,e,n,i,s,a){super(t,e,n,s,a),this.isCompressedArrayTexture=!0,this.image.depth=i,this.wrapR=Fe}},xu=class extends Vs{constructor(t,e,n){super(void 0,t[0].width,t[0].height,e,n,Xn),this.isCompressedCubeTexture=!0,this.isCubeTexture=!0,this.image=t}},vu=class extends Ee{constructor(t,e,n,i,s,a,o,c,l){super(t,e,n,i,s,a,o,c,l),this.isCanvasTexture=!0,this.needsUpdate=!0}},Qe=class{constructor(){this.type="Curve",this.arcLengthDivisions=200}getPoint(){return console.warn("THREE.Curve: .getPoint() not implemented."),null}getPointAt(t,e){let n=this.getUtoTmapping(t);return this.getPoint(n,e)}getPoints(t=5){let e=[];for(let n=0;n<=t;n++)e.push(this.getPoint(n/t));return e}getSpacedPoints(t=5){let e=[];for(let n=0;n<=t;n++)e.push(this.getPointAt(n/t));return e}getLength(){let t=this.getLengths();return t[t.length-1]}getLengths(t=this.arcLengthDivisions){if(this.cacheArcLengths&&this.cacheArcLengths.length===t+1&&!this.needsUpdate)return this.cacheArcLengths;this.needsUpdate=!1;let e=[],n,i=this.getPoint(0),s=0;e.push(0);for(let a=1;a<=t;a++)n=this.getPoint(a/t),s+=n.distanceTo(i),e.push(s),i=n;return this.cacheArcLengths=e,e}updateArcLengths(){this.needsUpdate=!0,this.getLengths()}getUtoTmapping(t,e){let n=this.getLengths(),i=0,s=n.length,a;e?a=e:a=t*n[s-1];let o=0,c=s-1,l;for(;o<=c;)if(i=Math.floor(o+(c-o)/2),l=n[i]-a,l<0)o=i+1;else if(l>0)c=i-1;else{c=i;break}if(i=c,n[i]===a)return i/(s-1);let h=n[i],d=n[i+1]-h,f=(a-h)/d;return(i+f)/(s-1)}getTangent(t,e){let i=t-1e-4,s=t+1e-4;i<0&&(i=0),s>1&&(s=1);let a=this.getPoint(i),o=this.getPoint(s),c=e||(a.isVector2?new Z:new w);return c.copy(o).sub(a).normalize(),c}getTangentAt(t,e){let n=this.getUtoTmapping(t);return this.getTangent(n,e)}computeFrenetFrames(t,e){let n=new w,i=[],s=[],a=[],o=new w,c=new It;for(let f=0;f<=t;f++){let m=f/t;i[f]=this.getTangentAt(m,new w)}s[0]=new w,a[0]=new w;let l=Number.MAX_VALUE,h=Math.abs(i[0].x),u=Math.abs(i[0].y),d=Math.abs(i[0].z);h<=l&&(l=h,n.set(1,0,0)),u<=l&&(l=u,n.set(0,1,0)),d<=l&&n.set(0,0,1),o.crossVectors(i[0],n).normalize(),s[0].crossVectors(i[0],o),a[0].crossVectors(i[0],s[0]);for(let f=1;f<=t;f++){if(s[f]=s[f-1].clone(),a[f]=a[f-1].clone(),o.crossVectors(i[f-1],i[f]),o.length()>Number.EPSILON){o.normalize();let m=Math.acos(he(i[f-1].dot(i[f]),-1,1));s[f].applyMatrix4(c.makeRotationAxis(o,m))}a[f].crossVectors(i[f],s[f])}if(e===!0){let f=Math.acos(he(s[0].dot(s[t]),-1,1));f/=t,i[0].dot(o.crossVectors(s[0],s[t]))>0&&(f=-f);for(let m=1;m<=t;m++)s[m].applyMatrix4(c.makeRotationAxis(i[m],f*m)),a[m].crossVectors(i[m],s[m])}return{tangents:i,normals:s,binormals:a}}clone(){return new this.constructor().copy(this)}copy(t){return this.arcLengthDivisions=t.arcLengthDivisions,this}toJSON(){let t={metadata:{version:4.6,type:"Curve",generator:"Curve.toJSON"}};return t.arcLengthDivisions=this.arcLengthDivisions,t.type=this.type,t}fromJSON(t){return this.arcLengthDivisions=t.arcLengthDivisions,this}},ks=class extends Qe{constructor(t=0,e=0,n=1,i=1,s=0,a=Math.PI*2,o=!1,c=0){super(),this.isEllipseCurve=!0,this.type="EllipseCurve",this.aX=t,this.aY=e,this.xRadius=n,this.yRadius=i,this.aStartAngle=s,this.aEndAngle=a,this.aClockwise=o,this.aRotation=c}getPoint(t,e){let n=e||new Z,i=Math.PI*2,s=this.aEndAngle-this.aStartAngle,a=Math.abs(s)<Number.EPSILON;for(;s<0;)s+=i;for(;s>i;)s-=i;s<Number.EPSILON&&(a?s=0:s=i),this.aClockwise===!0&&!a&&(s===i?s=-i:s=s-i);let o=this.aStartAngle+t*s,c=this.aX+this.xRadius*Math.cos(o),l=this.aY+this.yRadius*Math.sin(o);if(this.aRotation!==0){let h=Math.cos(this.aRotation),u=Math.sin(this.aRotation),d=c-this.aX,f=l-this.aY;c=d*h-f*u+this.aX,l=d*u+f*h+this.aY}return n.set(c,l)}copy(t){return super.copy(t),this.aX=t.aX,this.aY=t.aY,this.xRadius=t.xRadius,this.yRadius=t.yRadius,this.aStartAngle=t.aStartAngle,this.aEndAngle=t.aEndAngle,this.aClockwise=t.aClockwise,this.aRotation=t.aRotation,this}toJSON(){let t=super.toJSON();return t.aX=this.aX,t.aY=this.aY,t.xRadius=this.xRadius,t.yRadius=this.yRadius,t.aStartAngle=this.aStartAngle,t.aEndAngle=this.aEndAngle,t.aClockwise=this.aClockwise,t.aRotation=this.aRotation,t}fromJSON(t){return super.fromJSON(t),this.aX=t.aX,this.aY=t.aY,this.xRadius=t.xRadius,this.yRadius=t.yRadius,this.aStartAngle=t.aStartAngle,this.aEndAngle=t.aEndAngle,this.aClockwise=t.aClockwise,this.aRotation=t.aRotation,this}},sc=class extends ks{constructor(t,e,n,i,s,a){super(t,e,n,n,i,s,a),this.isArcCurve=!0,this.type="ArcCurve"}};function ul(){let r=0,t=0,e=0,n=0;function i(s,a,o,c){r=s,t=o,e=-3*s+3*a-2*o-c,n=2*s-2*a+o+c}return{initCatmullRom:function(s,a,o,c,l){i(a,o,l*(o-s),l*(c-a))},initNonuniformCatmullRom:function(s,a,o,c,l,h,u){let d=(a-s)/l-(o-s)/(l+h)+(o-a)/h,f=(o-a)/h-(c-a)/(h+u)+(c-o)/u;d*=h,f*=h,i(a,o,d,f)},calc:function(s){let a=s*s,o=a*s;return r+t*s+e*a+n*o}}}var Cr=new w,vo=new ul,yo=new ul,Mo=new ul,rc=class extends Qe{constructor(t=[],e=!1,n="centripetal",i=.5){super(),this.isCatmullRomCurve3=!0,this.type="CatmullRomCurve3",this.points=t,this.closed=e,this.curveType=n,this.tension=i}getPoint(t,e=new w){let n=e,i=this.points,s=i.length,a=(s-(this.closed?0:1))*t,o=Math.floor(a),c=a-o;this.closed?o+=o>0?0:(Math.floor(Math.abs(o)/s)+1)*s:c===0&&o===s-1&&(o=s-2,c=1);let l,h;this.closed||o>0?l=i[(o-1)%s]:(Cr.subVectors(i[0],i[1]).add(i[0]),l=Cr);let u=i[o%s],d=i[(o+1)%s];if(this.closed||o+2<s?h=i[(o+2)%s]:(Cr.subVectors(i[s-1],i[s-2]).add(i[s-1]),h=Cr),this.curveType==="centripetal"||this.curveType==="chordal"){let f=this.curveType==="chordal"?.5:.25,m=Math.pow(l.distanceToSquared(u),f),_=Math.pow(u.distanceToSquared(d),f),g=Math.pow(d.distanceToSquared(h),f);_<1e-4&&(_=1),m<1e-4&&(m=_),g<1e-4&&(g=_),vo.initNonuniformCatmullRom(l.x,u.x,d.x,h.x,m,_,g),yo.initNonuniformCatmullRom(l.y,u.y,d.y,h.y,m,_,g),Mo.initNonuniformCatmullRom(l.z,u.z,d.z,h.z,m,_,g)}else this.curveType==="catmullrom"&&(vo.initCatmullRom(l.x,u.x,d.x,h.x,this.tension),yo.initCatmullRom(l.y,u.y,d.y,h.y,this.tension),Mo.initCatmullRom(l.z,u.z,d.z,h.z,this.tension));return n.set(vo.calc(c),yo.calc(c),Mo.calc(c)),n}copy(t){super.copy(t),this.points=[];for(let e=0,n=t.points.length;e<n;e++){let i=t.points[e];this.points.push(i.clone())}return this.closed=t.closed,this.curveType=t.curveType,this.tension=t.tension,this}toJSON(){let t=super.toJSON();t.points=[];for(let e=0,n=this.points.length;e<n;e++){let i=this.points[e];t.points.push(i.toArray())}return t.closed=this.closed,t.curveType=this.curveType,t.tension=this.tension,t}fromJSON(t){super.fromJSON(t),this.points=[];for(let e=0,n=t.points.length;e<n;e++){let i=t.points[e];this.points.push(new w().fromArray(i))}return this.closed=t.closed,this.curveType=t.curveType,this.tension=t.tension,this}};function yu(r,t,e,n,i){let s=(n-t)*.5,a=(i-e)*.5,o=r*r,c=r*o;return(2*e-2*n+s+a)*c+(-3*e+3*n-2*s-a)*o+s*r+e}function Ax(r,t){let e=1-r;return e*e*t}function Tx(r,t){return 2*(1-r)*r*t}function wx(r,t){return r*r*t}function Ps(r,t,e,n){return Ax(r,t)+Tx(r,e)+wx(r,n)}function Rx(r,t){let e=1-r;return e*e*e*t}function Cx(r,t){let e=1-r;return 3*e*e*r*t}function Px(r,t){return 3*(1-r)*r*r*t}function Lx(r,t){return r*r*r*t}function Ls(r,t,e,n,i){return Rx(r,t)+Cx(r,e)+Px(r,n)+Lx(r,i)}var ma=class extends Qe{constructor(t=new Z,e=new Z,n=new Z,i=new Z){super(),this.isCubicBezierCurve=!0,this.type="CubicBezierCurve",this.v0=t,this.v1=e,this.v2=n,this.v3=i}getPoint(t,e=new Z){let n=e,i=this.v0,s=this.v1,a=this.v2,o=this.v3;return n.set(Ls(t,i.x,s.x,a.x,o.x),Ls(t,i.y,s.y,a.y,o.y)),n}copy(t){return super.copy(t),this.v0.copy(t.v0),this.v1.copy(t.v1),this.v2.copy(t.v2),this.v3.copy(t.v3),this}toJSON(){let t=super.toJSON();return t.v0=this.v0.toArray(),t.v1=this.v1.toArray(),t.v2=this.v2.toArray(),t.v3=this.v3.toArray(),t}fromJSON(t){return super.fromJSON(t),this.v0.fromArray(t.v0),this.v1.fromArray(t.v1),this.v2.fromArray(t.v2),this.v3.fromArray(t.v3),this}},ac=class extends Qe{constructor(t=new w,e=new w,n=new w,i=new w){super(),this.isCubicBezierCurve3=!0,this.type="CubicBezierCurve3",this.v0=t,this.v1=e,this.v2=n,this.v3=i}getPoint(t,e=new w){let n=e,i=this.v0,s=this.v1,a=this.v2,o=this.v3;return n.set(Ls(t,i.x,s.x,a.x,o.x),Ls(t,i.y,s.y,a.y,o.y),Ls(t,i.z,s.z,a.z,o.z)),n}copy(t){return super.copy(t),this.v0.copy(t.v0),this.v1.copy(t.v1),this.v2.copy(t.v2),this.v3.copy(t.v3),this}toJSON(){let t=super.toJSON();return t.v0=this.v0.toArray(),t.v1=this.v1.toArray(),t.v2=this.v2.toArray(),t.v3=this.v3.toArray(),t}fromJSON(t){return super.fromJSON(t),this.v0.fromArray(t.v0),this.v1.fromArray(t.v1),this.v2.fromArray(t.v2),this.v3.fromArray(t.v3),this}},ga=class extends Qe{constructor(t=new Z,e=new Z){super(),this.isLineCurve=!0,this.type="LineCurve",this.v1=t,this.v2=e}getPoint(t,e=new Z){let n=e;return t===1?n.copy(this.v2):(n.copy(this.v2).sub(this.v1),n.multiplyScalar(t).add(this.v1)),n}getPointAt(t,e){return this.getPoint(t,e)}getTangent(t,e=new Z){return e.subVectors(this.v2,this.v1).normalize()}getTangentAt(t,e){return this.getTangent(t,e)}copy(t){return super.copy(t),this.v1.copy(t.v1),this.v2.copy(t.v2),this}toJSON(){let t=super.toJSON();return t.v1=this.v1.toArray(),t.v2=this.v2.toArray(),t}fromJSON(t){return super.fromJSON(t),this.v1.fromArray(t.v1),this.v2.fromArray(t.v2),this}},oc=class extends Qe{constructor(t=new w,e=new w){super(),this.isLineCurve3=!0,this.type="LineCurve3",this.v1=t,this.v2=e}getPoint(t,e=new w){let n=e;return t===1?n.copy(this.v2):(n.copy(this.v2).sub(this.v1),n.multiplyScalar(t).add(this.v1)),n}getPointAt(t,e){return this.getPoint(t,e)}getTangent(t,e=new w){return e.subVectors(this.v2,this.v1).normalize()}getTangentAt(t,e){return this.getTangent(t,e)}copy(t){return super.copy(t),this.v1.copy(t.v1),this.v2.copy(t.v2),this}toJSON(){let t=super.toJSON();return t.v1=this.v1.toArray(),t.v2=this.v2.toArray(),t}fromJSON(t){return super.fromJSON(t),this.v1.fromArray(t.v1),this.v2.fromArray(t.v2),this}},_a=class extends Qe{constructor(t=new Z,e=new Z,n=new Z){super(),this.isQuadraticBezierCurve=!0,this.type="QuadraticBezierCurve",this.v0=t,this.v1=e,this.v2=n}getPoint(t,e=new Z){let n=e,i=this.v0,s=this.v1,a=this.v2;return n.set(Ps(t,i.x,s.x,a.x),Ps(t,i.y,s.y,a.y)),n}copy(t){return super.copy(t),this.v0.copy(t.v0),this.v1.copy(t.v1),this.v2.copy(t.v2),this}toJSON(){let t=super.toJSON();return t.v0=this.v0.toArray(),t.v1=this.v1.toArray(),t.v2=this.v2.toArray(),t}fromJSON(t){return super.fromJSON(t),this.v0.fromArray(t.v0),this.v1.fromArray(t.v1),this.v2.fromArray(t.v2),this}},xa=class extends Qe{constructor(t=new w,e=new w,n=new w){super(),this.isQuadraticBezierCurve3=!0,this.type="QuadraticBezierCurve3",this.v0=t,this.v1=e,this.v2=n}getPoint(t,e=new w){let n=e,i=this.v0,s=this.v1,a=this.v2;return n.set(Ps(t,i.x,s.x,a.x),Ps(t,i.y,s.y,a.y),Ps(t,i.z,s.z,a.z)),n}copy(t){return super.copy(t),this.v0.copy(t.v0),this.v1.copy(t.v1),this.v2.copy(t.v2),this}toJSON(){let t=super.toJSON();return t.v0=this.v0.toArray(),t.v1=this.v1.toArray(),t.v2=this.v2.toArray(),t}fromJSON(t){return super.fromJSON(t),this.v0.fromArray(t.v0),this.v1.fromArray(t.v1),this.v2.fromArray(t.v2),this}},va=class extends Qe{constructor(t=[]){super(),this.isSplineCurve=!0,this.type="SplineCurve",this.points=t}getPoint(t,e=new Z){let n=e,i=this.points,s=(i.length-1)*t,a=Math.floor(s),o=s-a,c=i[a===0?a:a-1],l=i[a],h=i[a>i.length-2?i.length-1:a+1],u=i[a>i.length-3?i.length-1:a+2];return n.set(yu(o,c.x,l.x,h.x,u.x),yu(o,c.y,l.y,h.y,u.y)),n}copy(t){super.copy(t),this.points=[];for(let e=0,n=t.points.length;e<n;e++){let i=t.points[e];this.points.push(i.clone())}return this}toJSON(){let t=super.toJSON();t.points=[];for(let e=0,n=this.points.length;e<n;e++){let i=this.points[e];t.points.push(i.toArray())}return t}fromJSON(t){super.fromJSON(t),this.points=[];for(let e=0,n=t.points.length;e<n;e++){let i=t.points[e];this.points.push(new Z().fromArray(i))}return this}},ya=Object.freeze({__proto__:null,ArcCurve:sc,CatmullRomCurve3:rc,CubicBezierCurve:ma,CubicBezierCurve3:ac,EllipseCurve:ks,LineCurve:ga,LineCurve3:oc,QuadraticBezierCurve:_a,QuadraticBezierCurve3:xa,SplineCurve:va}),cc=class extends Qe{constructor(){super(),this.type="CurvePath",this.curves=[],this.autoClose=!1}add(t){this.curves.push(t)}closePath(){let t=this.curves[0].getPoint(0),e=this.curves[this.curves.length-1].getPoint(1);if(!t.equals(e)){let n=t.isVector2===!0?"LineCurve":"LineCurve3";this.curves.push(new ya[n](e,t))}return this}getPoint(t,e){let n=t*this.getLength(),i=this.getCurveLengths(),s=0;for(;s<i.length;){if(i[s]>=n){let a=i[s]-n,o=this.curves[s],c=o.getLength(),l=c===0?0:1-a/c;return o.getPointAt(l,e)}s++}return null}getLength(){let t=this.getCurveLengths();return t[t.length-1]}updateArcLengths(){this.needsUpdate=!0,this.cacheLengths=null,this.getCurveLengths()}getCurveLengths(){if(this.cacheLengths&&this.cacheLengths.length===this.curves.length)return this.cacheLengths;let t=[],e=0;for(let n=0,i=this.curves.length;n<i;n++)e+=this.curves[n].getLength(),t.push(e);return this.cacheLengths=t,t}getSpacedPoints(t=40){let e=[];for(let n=0;n<=t;n++)e.push(this.getPoint(n/t));return this.autoClose&&e.push(e[0]),e}getPoints(t=12){let e=[],n;for(let i=0,s=this.curves;i<s.length;i++){let a=s[i],o=a.isEllipseCurve?t*2:a.isLineCurve||a.isLineCurve3?1:a.isSplineCurve?t*a.points.length:t,c=a.getPoints(o);for(let l=0;l<c.length;l++){let h=c[l];n&&n.equals(h)||(e.push(h),n=h)}}return this.autoClose&&e.length>1&&!e[e.length-1].equals(e[0])&&e.push(e[0]),e}copy(t){super.copy(t),this.curves=[];for(let e=0,n=t.curves.length;e<n;e++){let i=t.curves[e];this.curves.push(i.clone())}return this.autoClose=t.autoClose,this}toJSON(){let t=super.toJSON();t.autoClose=this.autoClose,t.curves=[];for(let e=0,n=this.curves.length;e<n;e++){let i=this.curves[e];t.curves.push(i.toJSON())}return t}fromJSON(t){super.fromJSON(t),this.autoClose=t.autoClose,this.curves=[];for(let e=0,n=t.curves.length;e<n;e++){let i=t.curves[e];this.curves.push(new ya[i.type]().fromJSON(i))}return this}},os=class extends cc{constructor(t){super(),this.type="Path",this.currentPoint=new Z,t&&this.setFromPoints(t)}setFromPoints(t){this.moveTo(t[0].x,t[0].y);for(let e=1,n=t.length;e<n;e++)this.lineTo(t[e].x,t[e].y);return this}moveTo(t,e){return this.currentPoint.set(t,e),this}lineTo(t,e){let n=new ga(this.currentPoint.clone(),new Z(t,e));return this.curves.push(n),this.currentPoint.set(t,e),this}quadraticCurveTo(t,e,n,i){let s=new _a(this.currentPoint.clone(),new Z(t,e),new Z(n,i));return this.curves.push(s),this.currentPoint.set(n,i),this}bezierCurveTo(t,e,n,i,s,a){let o=new ma(this.currentPoint.clone(),new Z(t,e),new Z(n,i),new Z(s,a));return this.curves.push(o),this.currentPoint.set(s,a),this}splineThru(t){let e=[this.currentPoint.clone()].concat(t),n=new va(e);return this.curves.push(n),this.currentPoint.copy(t[t.length-1]),this}arc(t,e,n,i,s,a){let o=this.currentPoint.x,c=this.currentPoint.y;return this.absarc(t+o,e+c,n,i,s,a),this}absarc(t,e,n,i,s,a){return this.absellipse(t,e,n,n,i,s,a),this}ellipse(t,e,n,i,s,a,o,c){let l=this.currentPoint.x,h=this.currentPoint.y;return this.absellipse(t+l,e+h,n,i,s,a,o,c),this}absellipse(t,e,n,i,s,a,o,c){let l=new ks(t,e,n,i,s,a,o,c);if(this.curves.length>0){let u=l.getPoint(0);u.equals(this.currentPoint)||this.lineTo(u.x,u.y)}this.curves.push(l);let h=l.getPoint(1);return this.currentPoint.copy(h),this}copy(t){return super.copy(t),this.currentPoint.copy(t.currentPoint),this}toJSON(){let t=super.toJSON();return t.currentPoint=this.currentPoint.toArray(),t}fromJSON(t){return super.fromJSON(t),this.currentPoint.fromArray(t.currentPoint),this}},Ma=class r extends Wt{constructor(t=[new Z(0,-.5),new Z(.5,0),new Z(0,.5)],e=12,n=0,i=Math.PI*2){super(),this.type="LatheGeometry",this.parameters={points:t,segments:e,phiStart:n,phiLength:i},e=Math.floor(e),i=he(i,0,Math.PI*2);let s=[],a=[],o=[],c=[],l=[],h=1/e,u=new w,d=new Z,f=new w,m=new w,_=new w,g=0,p=0;for(let v=0;v<=t.length-1;v++)switch(v){case 0:g=t[v+1].x-t[v].x,p=t[v+1].y-t[v].y,f.x=p*1,f.y=-g,f.z=p*0,_.copy(f),f.normalize(),c.push(f.x,f.y,f.z);break;case t.length-1:c.push(_.x,_.y,_.z);break;default:g=t[v+1].x-t[v].x,p=t[v+1].y-t[v].y,f.x=p*1,f.y=-g,f.z=p*0,m.copy(f),f.x+=_.x,f.y+=_.y,f.z+=_.z,f.normalize(),c.push(f.x,f.y,f.z),_.copy(m)}for(let v=0;v<=e;v++){let x=n+v*h*i,y=Math.sin(x),C=Math.cos(x);for(let T=0;T<=t.length-1;T++){u.x=t[T].x*y,u.y=t[T].y,u.z=t[T].x*C,a.push(u.x,u.y,u.z),d.x=v/e,d.y=T/(t.length-1),o.push(d.x,d.y);let R=c[3*T+0]*y,U=c[3*T+1],S=c[3*T+0]*C;l.push(R,U,S)}}for(let v=0;v<e;v++)for(let x=0;x<t.length-1;x++){let y=x+v*t.length,C=y,T=y+t.length,R=y+t.length+1,U=y+1;s.push(C,T,U),s.push(R,U,T)}this.setIndex(s),this.setAttribute("position",new xt(a,3)),this.setAttribute("uv",new xt(o,2)),this.setAttribute("normal",new xt(l,3))}copy(t){return super.copy(t),this.parameters=Object.assign({},t.parameters),this}static fromJSON(t){return new r(t.points,t.segments,t.phiStart,t.phiLength)}},lc=class r extends Ma{constructor(t=1,e=1,n=4,i=8){let s=new os;s.absarc(0,-e/2,t,Math.PI*1.5,0),s.absarc(0,e/2,t,0,Math.PI*.5),super(s.getPoints(n),i),this.type="CapsuleGeometry",this.parameters={radius:t,length:e,capSegments:n,radialSegments:i}}static fromJSON(t){return new r(t.radius,t.length,t.capSegments,t.radialSegments)}},hc=class r extends Wt{constructor(t=1,e=32,n=0,i=Math.PI*2){super(),this.type="CircleGeometry",this.parameters={radius:t,segments:e,thetaStart:n,thetaLength:i},e=Math.max(3,e);let s=[],a=[],o=[],c=[],l=new w,h=new Z;a.push(0,0,0),o.push(0,0,1),c.push(.5,.5);for(let u=0,d=3;u<=e;u++,d+=3){let f=n+u/e*i;l.x=t*Math.cos(f),l.y=t*Math.sin(f),a.push(l.x,l.y,l.z),o.push(0,0,1),h.x=(a[d]/t+1)/2,h.y=(a[d+1]/t+1)/2,c.push(h.x,h.y)}for(let u=1;u<=e;u++)s.push(u,u+1,0);this.setIndex(s),this.setAttribute("position",new xt(a,3)),this.setAttribute("normal",new xt(o,3)),this.setAttribute("uv",new xt(c,2))}copy(t){return super.copy(t),this.parameters=Object.assign({},t.parameters),this}static fromJSON(t){return new r(t.radius,t.segments,t.thetaStart,t.thetaLength)}},Hs=class r extends Wt{constructor(t=1,e=1,n=1,i=32,s=1,a=!1,o=0,c=Math.PI*2){super(),this.type="CylinderGeometry",this.parameters={radiusTop:t,radiusBottom:e,height:n,radialSegments:i,heightSegments:s,openEnded:a,thetaStart:o,thetaLength:c};let l=this;i=Math.floor(i),s=Math.floor(s);let h=[],u=[],d=[],f=[],m=0,_=[],g=n/2,p=0;v(),a===!1&&(t>0&&x(!0),e>0&&x(!1)),this.setIndex(h),this.setAttribute("position",new xt(u,3)),this.setAttribute("normal",new xt(d,3)),this.setAttribute("uv",new xt(f,2));function v(){let y=new w,C=new w,T=0,R=(e-t)/n;for(let U=0;U<=s;U++){let S=[],E=U/s,N=E*(e-t)+t;for(let G=0;G<=i;G++){let it=G/i,I=it*c+o,F=Math.sin(I),k=Math.cos(I);C.x=N*F,C.y=-E*n+g,C.z=N*k,u.push(C.x,C.y,C.z),y.set(F,R,k).normalize(),d.push(y.x,y.y,y.z),f.push(it,1-E),S.push(m++)}_.push(S)}for(let U=0;U<i;U++)for(let S=0;S<s;S++){let E=_[S][U],N=_[S+1][U],G=_[S+1][U+1],it=_[S][U+1];h.push(E,N,it),h.push(N,G,it),T+=6}l.addGroup(p,T,0),p+=T}function x(y){let C=m,T=new Z,R=new w,U=0,S=y===!0?t:e,E=y===!0?1:-1;for(let G=1;G<=i;G++)u.push(0,g*E,0),d.push(0,E,0),f.push(.5,.5),m++;let N=m;for(let G=0;G<=i;G++){let I=G/i*c+o,F=Math.cos(I),k=Math.sin(I);R.x=S*k,R.y=g*E,R.z=S*F,u.push(R.x,R.y,R.z),d.push(0,E,0),T.x=F*.5+.5,T.y=k*.5*E+.5,f.push(T.x,T.y),m++}for(let G=0;G<i;G++){let it=C+G,I=N+G;y===!0?h.push(I,I+1,it):h.push(I+1,I,it),U+=3}l.addGroup(p,U,y===!0?1:2),p+=U}}copy(t){return super.copy(t),this.parameters=Object.assign({},t.parameters),this}static fromJSON(t){return new r(t.radiusTop,t.radiusBottom,t.height,t.radialSegments,t.heightSegments,t.openEnded,t.thetaStart,t.thetaLength)}},uc=class r extends Hs{constructor(t=1,e=1,n=32,i=1,s=!1,a=0,o=Math.PI*2){super(0,t,e,n,i,s,a,o),this.type="ConeGeometry",this.parameters={radius:t,height:e,radialSegments:n,heightSegments:i,openEnded:s,thetaStart:a,thetaLength:o}}static fromJSON(t){return new r(t.radius,t.height,t.radialSegments,t.heightSegments,t.openEnded,t.thetaStart,t.thetaLength)}},vi=class r extends Wt{constructor(t=[],e=[],n=1,i=0){super(),this.type="PolyhedronGeometry",this.parameters={vertices:t,indices:e,radius:n,detail:i};let s=[],a=[];o(i),l(n),h(),this.setAttribute("position",new xt(s,3)),this.setAttribute("normal",new xt(s.slice(),3)),this.setAttribute("uv",new xt(a,2)),i===0?this.computeVertexNormals():this.normalizeNormals();function o(v){let x=new w,y=new w,C=new w;for(let T=0;T<e.length;T+=3)f(e[T+0],x),f(e[T+1],y),f(e[T+2],C),c(x,y,C,v)}function c(v,x,y,C){let T=C+1,R=[];for(let U=0;U<=T;U++){R[U]=[];let S=v.clone().lerp(y,U/T),E=x.clone().lerp(y,U/T),N=T-U;for(let G=0;G<=N;G++)G===0&&U===T?R[U][G]=S:R[U][G]=S.clone().lerp(E,G/N)}for(let U=0;U<T;U++)for(let S=0;S<2*(T-U)-1;S++){let E=Math.floor(S/2);S%2===0?(d(R[U][E+1]),d(R[U+1][E]),d(R[U][E])):(d(R[U][E+1]),d(R[U+1][E+1]),d(R[U+1][E]))}}function l(v){let x=new w;for(let y=0;y<s.length;y+=3)x.x=s[y+0],x.y=s[y+1],x.z=s[y+2],x.normalize().multiplyScalar(v),s[y+0]=x.x,s[y+1]=x.y,s[y+2]=x.z}function h(){let v=new w;for(let x=0;x<s.length;x+=3){v.x=s[x+0],v.y=s[x+1],v.z=s[x+2];let y=g(v)/2/Math.PI+.5,C=p(v)/Math.PI+.5;a.push(y,1-C)}m(),u()}function u(){for(let v=0;v<a.length;v+=6){let x=a[v+0],y=a[v+2],C=a[v+4],T=Math.max(x,y,C),R=Math.min(x,y,C);T>.9&&R<.1&&(x<.2&&(a[v+0]+=1),y<.2&&(a[v+2]+=1),C<.2&&(a[v+4]+=1))}}function d(v){s.push(v.x,v.y,v.z)}function f(v,x){let y=v*3;x.x=t[y+0],x.y=t[y+1],x.z=t[y+2]}function m(){let v=new w,x=new w,y=new w,C=new w,T=new Z,R=new Z,U=new Z;for(let S=0,E=0;S<s.length;S+=9,E+=6){v.set(s[S+0],s[S+1],s[S+2]),x.set(s[S+3],s[S+4],s[S+5]),y.set(s[S+6],s[S+7],s[S+8]),T.set(a[E+0],a[E+1]),R.set(a[E+2],a[E+3]),U.set(a[E+4],a[E+5]),C.copy(v).add(x).add(y).divideScalar(3);let N=g(C);_(T,E+0,v,N),_(R,E+2,x,N),_(U,E+4,y,N)}}function _(v,x,y,C){C<0&&v.x===1&&(a[x]=v.x-1),y.x===0&&y.z===0&&(a[x]=C/2/Math.PI+.5)}function g(v){return Math.atan2(v.z,-v.x)}function p(v){return Math.atan2(-v.y,Math.sqrt(v.x*v.x+v.z*v.z))}}copy(t){return super.copy(t),this.parameters=Object.assign({},t.parameters),this}static fromJSON(t){return new r(t.vertices,t.indices,t.radius,t.details)}},dc=class r extends vi{constructor(t=1,e=0){let n=(1+Math.sqrt(5))/2,i=1/n,s=[-1,-1,-1,-1,-1,1,-1,1,-1,-1,1,1,1,-1,-1,1,-1,1,1,1,-1,1,1,1,0,-i,-n,0,-i,n,0,i,-n,0,i,n,-i,-n,0,-i,n,0,i,-n,0,i,n,0,-n,0,-i,n,0,-i,-n,0,i,n,0,i],a=[3,11,7,3,7,15,3,15,13,7,19,17,7,17,6,7,6,15,17,4,8,17,8,10,17,10,6,8,0,16,8,16,2,8,2,10,0,12,1,0,1,18,0,18,16,6,10,2,6,2,13,6,13,15,2,16,18,2,18,3,2,3,13,18,1,9,18,9,11,18,11,3,4,14,12,4,12,0,4,0,8,11,9,5,11,5,19,11,19,7,19,5,14,19,14,4,19,4,17,1,12,14,1,14,5,1,5,9];super(s,a,t,e),this.type="DodecahedronGeometry",this.parameters={radius:t,detail:e}}static fromJSON(t){return new r(t.radius,t.detail)}},Pr=new w,Lr=new w,So=new w,Ir=new Fn,fc=class extends Wt{constructor(t=null,e=1){if(super(),this.type="EdgesGeometry",this.parameters={geometry:t,thresholdAngle:e},t!==null){let i=Math.pow(10,4),s=Math.cos(pi*e),a=t.getIndex(),o=t.getAttribute("position"),c=a?a.count:o.count,l=[0,0,0],h=["a","b","c"],u=new Array(3),d={},f=[];for(let m=0;m<c;m+=3){a?(l[0]=a.getX(m),l[1]=a.getX(m+1),l[2]=a.getX(m+2)):(l[0]=m,l[1]=m+1,l[2]=m+2);let{a:_,b:g,c:p}=Ir;if(_.fromBufferAttribute(o,l[0]),g.fromBufferAttribute(o,l[1]),p.fromBufferAttribute(o,l[2]),Ir.getNormal(So),u[0]=`${Math.round(_.x*i)},${Math.round(_.y*i)},${Math.round(_.z*i)}`,u[1]=`${Math.round(g.x*i)},${Math.round(g.y*i)},${Math.round(g.z*i)}`,u[2]=`${Math.round(p.x*i)},${Math.round(p.y*i)},${Math.round(p.z*i)}`,!(u[0]===u[1]||u[1]===u[2]||u[2]===u[0]))for(let v=0;v<3;v++){let x=(v+1)%3,y=u[v],C=u[x],T=Ir[h[v]],R=Ir[h[x]],U=`${y}_${C}`,S=`${C}_${y}`;S in d&&d[S]?(So.dot(d[S].normal)<=s&&(f.push(T.x,T.y,T.z),f.push(R.x,R.y,R.z)),d[S]=null):U in d||(d[U]={index0:l[v],index1:l[x],normal:So.clone()})}}for(let m in d)if(d[m]){let{index0:_,index1:g}=d[m];Pr.fromBufferAttribute(o,_),Lr.fromBufferAttribute(o,g),f.push(Pr.x,Pr.y,Pr.z),f.push(Lr.x,Lr.y,Lr.z)}this.setAttribute("position",new xt(f,3))}}copy(t){return super.copy(t),this.parameters=Object.assign({},t.parameters),this}},Gn=class extends os{constructor(t){super(t),this.uuid=Ye(),this.type="Shape",this.holes=[]}getPointsHoles(t){let e=[];for(let n=0,i=this.holes.length;n<i;n++)e[n]=this.holes[n].getPoints(t);return e}extractPoints(t){return{shape:this.getPoints(t),holes:this.getPointsHoles(t)}}copy(t){super.copy(t),this.holes=[];for(let e=0,n=t.holes.length;e<n;e++){let i=t.holes[e];this.holes.push(i.clone())}return this}toJSON(){let t=super.toJSON();t.uuid=this.uuid,t.holes=[];for(let e=0,n=this.holes.length;e<n;e++){let i=this.holes[e];t.holes.push(i.toJSON())}return t}fromJSON(t){super.fromJSON(t),this.uuid=t.uuid,this.holes=[];for(let e=0,n=t.holes.length;e<n;e++){let i=t.holes[e];this.holes.push(new os().fromJSON(i))}return this}},Ix={triangulate:function(r,t,e=2){let n=t&&t.length,i=n?t[0]*e:r.length,s=$d(r,0,i,e,!0),a=[];if(!s||s.next===s.prev)return a;let o,c,l,h,u,d,f;if(n&&(s=Fx(r,t,s,e)),r.length>80*e){o=l=r[0],c=h=r[1];for(let m=e;m<i;m+=e)u=r[m],d=r[m+1],u<o&&(o=u),d<c&&(c=d),u>l&&(l=u),d>h&&(h=d);f=Math.max(l-o,h-c),f=f!==0?32767/f:0}return Gs(s,a,e,o,c,f,0),a}};function $d(r,t,e,n,i){let s,a;if(i===Zx(r,t,e,n)>0)for(s=t;s<e;s+=n)a=Mu(s,r[s],r[s+1],a);else for(s=e-n;s>=t;s-=n)a=Mu(s,r[s],r[s+1],a);return a&&Ua(a,a.next)&&(Xs(a),a=a.next),a}function yi(r,t){if(!r)return r;t||(t=r);let e=r,n;do if(n=!1,!e.steiner&&(Ua(e,e.next)||ae(e.prev,e,e.next)===0)){if(Xs(e),e=t=e.prev,e===e.next)break;n=!0}else e=e.next;while(n||e!==t);return t}function Gs(r,t,e,n,i,s,a){if(!r)return;!a&&s&&Hx(r,n,i,s);let o=r,c,l;for(;r.prev!==r.next;){if(c=r.prev,l=r.next,s?Dx(r,n,i,s):Ux(r)){t.push(c.i/e|0),t.push(r.i/e|0),t.push(l.i/e|0),Xs(r),r=l.next,o=l.next;continue}if(r=l,r===o){a?a===1?(r=Nx(yi(r),t,e),Gs(r,t,e,n,i,s,2)):a===2&&Ox(r,t,e,n,i,s):Gs(yi(r),t,e,n,i,s,1);break}}}function Ux(r){let t=r.prev,e=r,n=r.next;if(ae(t,e,n)>=0)return!1;let i=t.x,s=e.x,a=n.x,o=t.y,c=e.y,l=n.y,h=i<s?i<a?i:a:s<a?s:a,u=o<c?o<l?o:l:c<l?c:l,d=i>s?i>a?i:a:s>a?s:a,f=o>c?o>l?o:l:c>l?c:l,m=n.next;for(;m!==t;){if(m.x>=h&&m.x<=d&&m.y>=u&&m.y<=f&&$i(i,o,s,c,a,l,m.x,m.y)&&ae(m.prev,m,m.next)>=0)return!1;m=m.next}return!0}function Dx(r,t,e,n){let i=r.prev,s=r,a=r.next;if(ae(i,s,a)>=0)return!1;let o=i.x,c=s.x,l=a.x,h=i.y,u=s.y,d=a.y,f=o<c?o<l?o:l:c<l?c:l,m=h<u?h<d?h:d:u<d?u:d,_=o>c?o>l?o:l:c>l?c:l,g=h>u?h>d?h:d:u>d?u:d,p=pc(f,m,t,e,n),v=pc(_,g,t,e,n),x=r.prevZ,y=r.nextZ;for(;x&&x.z>=p&&y&&y.z<=v;){if(x.x>=f&&x.x<=_&&x.y>=m&&x.y<=g&&x!==i&&x!==a&&$i(o,h,c,u,l,d,x.x,x.y)&&ae(x.prev,x,x.next)>=0||(x=x.prevZ,y.x>=f&&y.x<=_&&y.y>=m&&y.y<=g&&y!==i&&y!==a&&$i(o,h,c,u,l,d,y.x,y.y)&&ae(y.prev,y,y.next)>=0))return!1;y=y.nextZ}for(;x&&x.z>=p;){if(x.x>=f&&x.x<=_&&x.y>=m&&x.y<=g&&x!==i&&x!==a&&$i(o,h,c,u,l,d,x.x,x.y)&&ae(x.prev,x,x.next)>=0)return!1;x=x.prevZ}for(;y&&y.z<=v;){if(y.x>=f&&y.x<=_&&y.y>=m&&y.y<=g&&y!==i&&y!==a&&$i(o,h,c,u,l,d,y.x,y.y)&&ae(y.prev,y,y.next)>=0)return!1;y=y.nextZ}return!0}function Nx(r,t,e){let n=r;do{let i=n.prev,s=n.next.next;!Ua(i,s)&&Kd(i,n,n.next,s)&&Ws(i,s)&&Ws(s,i)&&(t.push(i.i/e|0),t.push(n.i/e|0),t.push(s.i/e|0),Xs(n),Xs(n.next),n=r=s),n=n.next}while(n!==r);return yi(n)}function Ox(r,t,e,n,i,s){let a=r;do{let o=a.next.next;for(;o!==a.prev;){if(a.i!==o.i&&Xx(a,o)){let c=Qd(a,o);a=yi(a,a.next),c=yi(c,c.next),Gs(a,t,e,n,i,s,0),Gs(c,t,e,n,i,s,0);return}o=o.next}a=a.next}while(a!==r)}function Fx(r,t,e,n){let i=[],s,a,o,c,l;for(s=0,a=t.length;s<a;s++)o=t[s]*n,c=s<a-1?t[s+1]*n:r.length,l=$d(r,o,c,n,!1),l===l.next&&(l.steiner=!0),i.push(Wx(l));for(i.sort(Bx),s=0;s<i.length;s++)e=zx(i[s],e);return e}function Bx(r,t){return r.x-t.x}function zx(r,t){let e=Vx(r,t);if(!e)return t;let n=Qd(e,r);return yi(n,n.next),yi(e,e.next)}function Vx(r,t){let e=t,n=-1/0,i,s=r.x,a=r.y;do{if(a<=e.y&&a>=e.next.y&&e.next.y!==e.y){let d=e.x+(a-e.y)*(e.next.x-e.x)/(e.next.y-e.y);if(d<=s&&d>n&&(n=d,i=e.x<e.next.x?e:e.next,d===s))return i}e=e.next}while(e!==t);if(!i)return null;let o=i,c=i.x,l=i.y,h=1/0,u;e=i;do s>=e.x&&e.x>=c&&s!==e.x&&$i(a<l?s:n,a,c,l,a<l?n:s,a,e.x,e.y)&&(u=Math.abs(a-e.y)/(s-e.x),Ws(e,r)&&(u<h||u===h&&(e.x>i.x||e.x===i.x&&kx(i,e)))&&(i=e,h=u)),e=e.next;while(e!==o);return i}function kx(r,t){return ae(r.prev,r,t.prev)<0&&ae(t.next,r,r.next)<0}function Hx(r,t,e,n){let i=r;do i.z===0&&(i.z=pc(i.x,i.y,t,e,n)),i.prevZ=i.prev,i.nextZ=i.next,i=i.next;while(i!==r);i.prevZ.nextZ=null,i.prevZ=null,Gx(i)}function Gx(r){let t,e,n,i,s,a,o,c,l=1;do{for(e=r,r=null,s=null,a=0;e;){for(a++,n=e,o=0,t=0;t<l&&(o++,n=n.nextZ,!!n);t++);for(c=l;o>0||c>0&&n;)o!==0&&(c===0||!n||e.z<=n.z)?(i=e,e=e.nextZ,o--):(i=n,n=n.nextZ,c--),s?s.nextZ=i:r=i,i.prevZ=s,s=i;e=n}s.nextZ=null,l*=2}while(a>1);return r}function pc(r,t,e,n,i){return r=(r-e)*i|0,t=(t-n)*i|0,r=(r|r<<8)&16711935,r=(r|r<<4)&252645135,r=(r|r<<2)&858993459,r=(r|r<<1)&1431655765,t=(t|t<<8)&16711935,t=(t|t<<4)&252645135,t=(t|t<<2)&858993459,t=(t|t<<1)&1431655765,r|t<<1}function Wx(r){let t=r,e=r;do(t.x<e.x||t.x===e.x&&t.y<e.y)&&(e=t),t=t.next;while(t!==r);return e}function $i(r,t,e,n,i,s,a,o){return(i-a)*(t-o)>=(r-a)*(s-o)&&(r-a)*(n-o)>=(e-a)*(t-o)&&(e-a)*(s-o)>=(i-a)*(n-o)}function Xx(r,t){return r.next.i!==t.i&&r.prev.i!==t.i&&!qx(r,t)&&(Ws(r,t)&&Ws(t,r)&&Yx(r,t)&&(ae(r.prev,r,t.prev)||ae(r,t.prev,t))||Ua(r,t)&&ae(r.prev,r,r.next)>0&&ae(t.prev,t,t.next)>0)}function ae(r,t,e){return(t.y-r.y)*(e.x-t.x)-(t.x-r.x)*(e.y-t.y)}function Ua(r,t){return r.x===t.x&&r.y===t.y}function Kd(r,t,e,n){let i=Dr(ae(r,t,e)),s=Dr(ae(r,t,n)),a=Dr(ae(e,n,r)),o=Dr(ae(e,n,t));return!!(i!==s&&a!==o||i===0&&Ur(r,e,t)||s===0&&Ur(r,n,t)||a===0&&Ur(e,r,n)||o===0&&Ur(e,t,n))}function Ur(r,t,e){return t.x<=Math.max(r.x,e.x)&&t.x>=Math.min(r.x,e.x)&&t.y<=Math.max(r.y,e.y)&&t.y>=Math.min(r.y,e.y)}function Dr(r){return r>0?1:r<0?-1:0}function qx(r,t){let e=r;do{if(e.i!==r.i&&e.next.i!==r.i&&e.i!==t.i&&e.next.i!==t.i&&Kd(e,e.next,r,t))return!0;e=e.next}while(e!==r);return!1}function Ws(r,t){return ae(r.prev,r,r.next)<0?ae(r,t,r.next)>=0&&ae(r,r.prev,t)>=0:ae(r,t,r.prev)<0||ae(r,r.next,t)<0}function Yx(r,t){let e=r,n=!1,i=(r.x+t.x)/2,s=(r.y+t.y)/2;do e.y>s!=e.next.y>s&&e.next.y!==e.y&&i<(e.next.x-e.x)*(s-e.y)/(e.next.y-e.y)+e.x&&(n=!n),e=e.next;while(e!==r);return n}function Qd(r,t){let e=new mc(r.i,r.x,r.y),n=new mc(t.i,t.x,t.y),i=r.next,s=t.prev;return r.next=t,t.prev=r,e.next=i,i.prev=e,n.next=e,e.prev=n,s.next=n,n.prev=s,n}function Mu(r,t,e,n){let i=new mc(r,t,e);return n?(i.next=n.next,i.prev=n,n.next.prev=i,n.next=i):(i.prev=i,i.next=i),i}function Xs(r){r.next.prev=r.prev,r.prev.next=r.next,r.prevZ&&(r.prevZ.nextZ=r.nextZ),r.nextZ&&(r.nextZ.prevZ=r.prevZ)}function mc(r,t,e){this.i=r,this.x=t,this.y=e,this.prev=null,this.next=null,this.z=0,this.prevZ=null,this.nextZ=null,this.steiner=!1}function Zx(r,t,e,n){let i=0;for(let s=t,a=e-n;s<e;s+=n)i+=(r[a]-r[s])*(r[s+1]+r[a+1]),a=s;return i}var bn=class r{static area(t){let e=t.length,n=0;for(let i=e-1,s=0;s<e;i=s++)n+=t[i].x*t[s].y-t[s].x*t[i].y;return n*.5}static isClockWise(t){return r.area(t)<0}static triangulateShape(t,e){let n=[],i=[],s=[];Su(t),bu(n,t);let a=t.length;e.forEach(Su);for(let c=0;c<e.length;c++)i.push(a),a+=e[c].length,bu(n,e[c]);let o=Ix.triangulate(n,i);for(let c=0;c<o.length;c+=3)s.push(o.slice(c,c+3));return s}};function Su(r){let t=r.length;t>2&&r[t-1].equals(r[0])&&r.pop()}function bu(r,t){for(let e=0;e<t.length;e++)r.push(t[e].x),r.push(t[e].y)}var gc=class r extends Wt{constructor(t=new Gn([new Z(.5,.5),new Z(-.5,.5),new Z(-.5,-.5),new Z(.5,-.5)]),e={}){super(),this.type="ExtrudeGeometry",this.parameters={shapes:t,options:e},t=Array.isArray(t)?t:[t];let n=this,i=[],s=[];for(let o=0,c=t.length;o<c;o++){let l=t[o];a(l)}this.setAttribute("position",new xt(i,3)),this.setAttribute("uv",new xt(s,2)),this.computeVertexNormals();function a(o){let c=[],l=e.curveSegments!==void 0?e.curveSegments:12,h=e.steps!==void 0?e.steps:1,u=e.depth!==void 0?e.depth:1,d=e.bevelEnabled!==void 0?e.bevelEnabled:!0,f=e.bevelThickness!==void 0?e.bevelThickness:.2,m=e.bevelSize!==void 0?e.bevelSize:f-.1,_=e.bevelOffset!==void 0?e.bevelOffset:0,g=e.bevelSegments!==void 0?e.bevelSegments:3,p=e.extrudePath,v=e.UVGenerator!==void 0?e.UVGenerator:Jx,x,y=!1,C,T,R,U;p&&(x=p.getSpacedPoints(h),y=!0,d=!1,C=p.computeFrenetFrames(h,!1),T=new w,R=new w,U=new w),d||(g=0,f=0,m=0,_=0);let S=o.extractPoints(l),E=S.shape,N=S.holes;if(!bn.isClockWise(E)){E=E.reverse();for(let P=0,rt=N.length;P<rt;P++){let q=N[P];bn.isClockWise(q)&&(N[P]=q.reverse())}}let it=bn.triangulateShape(E,N),I=E;for(let P=0,rt=N.length;P<rt;P++){let q=N[P];E=E.concat(q)}function F(P,rt,q){return rt||console.error("THREE.ExtrudeGeometry: vec does not exist"),P.clone().addScaledVector(rt,q)}let k=E.length,J=it.length;function Y(P,rt,q){let st,X,Et,ft=P.x-rt.x,b=P.y-rt.y,M=q.x-P.x,O=q.y-P.y,nt=ft*ft+b*b,Q=ft*O-b*M;if(Math.abs(Q)>Number.EPSILON){let $=Math.sqrt(nt),yt=Math.sqrt(M*M+O*O),ct=rt.x-b/$,_t=rt.y+ft/$,Tt=q.x-O/yt,Ft=q.y+M/yt,j=((Tt-ct)*O-(Ft-_t)*M)/(ft*O-b*M);st=ct+ft*j-P.x,X=_t+b*j-P.y;let Zt=st*st+X*X;if(Zt<=2)return new Z(st,X);Et=Math.sqrt(Zt/2)}else{let $=!1;ft>Number.EPSILON?M>Number.EPSILON&&($=!0):ft<-Number.EPSILON?M<-Number.EPSILON&&($=!0):Math.sign(b)===Math.sign(O)&&($=!0),$?(st=-b,X=ft,Et=Math.sqrt(nt)):(st=ft,X=b,Et=Math.sqrt(nt/2))}return new Z(st/Et,X/Et)}let W=[];for(let P=0,rt=I.length,q=rt-1,st=P+1;P<rt;P++,q++,st++)q===rt&&(q=0),st===rt&&(st=0),W[P]=Y(I[P],I[q],I[st]);let tt=[],et,ut=W.concat();for(let P=0,rt=N.length;P<rt;P++){let q=N[P];et=[];for(let st=0,X=q.length,Et=X-1,ft=st+1;st<X;st++,Et++,ft++)Et===X&&(Et=0),ft===X&&(ft=0),et[st]=Y(q[st],q[Et],q[ft]);tt.push(et),ut=ut.concat(et)}for(let P=0;P<g;P++){let rt=P/g,q=f*Math.cos(rt*Math.PI/2),st=m*Math.sin(rt*Math.PI/2)+_;for(let X=0,Et=I.length;X<Et;X++){let ft=F(I[X],W[X],st);gt(ft.x,ft.y,-q)}for(let X=0,Et=N.length;X<Et;X++){let ft=N[X];et=tt[X];for(let b=0,M=ft.length;b<M;b++){let O=F(ft[b],et[b],st);gt(O.x,O.y,-q)}}}let H=m+_;for(let P=0;P<k;P++){let rt=d?F(E[P],ut[P],H):E[P];y?(R.copy(C.normals[0]).multiplyScalar(rt.x),T.copy(C.binormals[0]).multiplyScalar(rt.y),U.copy(x[0]).add(R).add(T),gt(U.x,U.y,U.z)):gt(rt.x,rt.y,0)}for(let P=1;P<=h;P++)for(let rt=0;rt<k;rt++){let q=d?F(E[rt],ut[rt],H):E[rt];y?(R.copy(C.normals[P]).multiplyScalar(q.x),T.copy(C.binormals[P]).multiplyScalar(q.y),U.copy(x[P]).add(R).add(T),gt(U.x,U.y,U.z)):gt(q.x,q.y,u/h*P)}for(let P=g-1;P>=0;P--){let rt=P/g,q=f*Math.cos(rt*Math.PI/2),st=m*Math.sin(rt*Math.PI/2)+_;for(let X=0,Et=I.length;X<Et;X++){let ft=F(I[X],W[X],st);gt(ft.x,ft.y,u+q)}for(let X=0,Et=N.length;X<Et;X++){let ft=N[X];et=tt[X];for(let b=0,M=ft.length;b<M;b++){let O=F(ft[b],et[b],st);y?gt(O.x,O.y+x[h-1].y,x[h-1].x+q):gt(O.x,O.y,u+q)}}}K(),dt();function K(){let P=i.length/3;if(d){let rt=0,q=k*rt;for(let st=0;st<J;st++){let X=it[st];Ct(X[2]+q,X[1]+q,X[0]+q)}rt=h+g*2,q=k*rt;for(let st=0;st<J;st++){let X=it[st];Ct(X[0]+q,X[1]+q,X[2]+q)}}else{for(let rt=0;rt<J;rt++){let q=it[rt];Ct(q[2],q[1],q[0])}for(let rt=0;rt<J;rt++){let q=it[rt];Ct(q[0]+k*h,q[1]+k*h,q[2]+k*h)}}n.addGroup(P,i.length/3-P,0)}function dt(){let P=i.length/3,rt=0;Mt(I,rt),rt+=I.length;for(let q=0,st=N.length;q<st;q++){let X=N[q];Mt(X,rt),rt+=X.length}n.addGroup(P,i.length/3-P,1)}function Mt(P,rt){let q=P.length;for(;--q>=0;){let st=q,X=q-1;X<0&&(X=P.length-1);for(let Et=0,ft=h+g*2;Et<ft;Et++){let b=k*Et,M=k*(Et+1),O=rt+st+b,nt=rt+X+b,Q=rt+X+M,$=rt+st+M;Nt(O,nt,Q,$)}}}function gt(P,rt,q){c.push(P),c.push(rt),c.push(q)}function Ct(P,rt,q){St(P),St(rt),St(q);let st=i.length/3,X=v.generateTopUV(n,i,st-3,st-2,st-1);Ut(X[0]),Ut(X[1]),Ut(X[2])}function Nt(P,rt,q,st){St(P),St(rt),St(st),St(rt),St(q),St(st);let X=i.length/3,Et=v.generateSideWallUV(n,i,X-6,X-3,X-2,X-1);Ut(Et[0]),Ut(Et[1]),Ut(Et[3]),Ut(Et[1]),Ut(Et[2]),Ut(Et[3])}function St(P){i.push(c[P*3+0]),i.push(c[P*3+1]),i.push(c[P*3+2])}function Ut(P){s.push(P.x),s.push(P.y)}}}copy(t){return super.copy(t),this.parameters=Object.assign({},t.parameters),this}toJSON(){let t=super.toJSON(),e=this.parameters.shapes,n=this.parameters.options;return $x(e,n,t)}static fromJSON(t,e){let n=[];for(let s=0,a=t.shapes.length;s<a;s++){let o=e[t.shapes[s]];n.push(o)}let i=t.options.extrudePath;return i!==void 0&&(t.options.extrudePath=new ya[i.type]().fromJSON(i)),new r(n,t.options)}},Jx={generateTopUV:function(r,t,e,n,i){let s=t[e*3],a=t[e*3+1],o=t[n*3],c=t[n*3+1],l=t[i*3],h=t[i*3+1];return[new Z(s,a),new Z(o,c),new Z(l,h)]},generateSideWallUV:function(r,t,e,n,i,s){let a=t[e*3],o=t[e*3+1],c=t[e*3+2],l=t[n*3],h=t[n*3+1],u=t[n*3+2],d=t[i*3],f=t[i*3+1],m=t[i*3+2],_=t[s*3],g=t[s*3+1],p=t[s*3+2];return Math.abs(o-h)<Math.abs(a-l)?[new Z(a,1-c),new Z(l,1-u),new Z(d,1-m),new Z(_,1-p)]:[new Z(o,1-c),new Z(h,1-u),new Z(f,1-m),new Z(g,1-p)]}};function $x(r,t,e){if(e.shapes=[],Array.isArray(r))for(let n=0,i=r.length;n<i;n++){let s=r[n];e.shapes.push(s.uuid)}else e.shapes.push(r.uuid);return e.options=Object.assign({},t),t.extrudePath!==void 0&&(e.options.extrudePath=t.extrudePath.toJSON()),e}var _c=class r extends vi{constructor(t=1,e=0){let n=(1+Math.sqrt(5))/2,i=[-1,n,0,1,n,0,-1,-n,0,1,-n,0,0,-1,n,0,1,n,0,-1,-n,0,1,-n,n,0,-1,n,0,1,-n,0,-1,-n,0,1],s=[0,11,5,0,5,1,0,1,7,0,7,10,0,10,11,1,5,9,5,11,4,11,10,2,10,7,6,7,1,8,3,9,4,3,4,2,3,2,6,3,6,8,3,8,9,4,9,5,2,4,11,6,2,10,8,6,7,9,8,1];super(i,s,t,e),this.type="IcosahedronGeometry",this.parameters={radius:t,detail:e}}static fromJSON(t){return new r(t.radius,t.detail)}},Sa=class r extends vi{constructor(t=1,e=0){let n=[1,0,0,-1,0,0,0,1,0,0,-1,0,0,0,1,0,0,-1],i=[0,2,4,0,4,3,0,3,5,0,5,2,1,2,5,1,5,3,1,3,4,1,4,2];super(n,i,t,e),this.type="OctahedronGeometry",this.parameters={radius:t,detail:e}}static fromJSON(t){return new r(t.radius,t.detail)}},xc=class r extends Wt{constructor(t=.5,e=1,n=32,i=1,s=0,a=Math.PI*2){super(),this.type="RingGeometry",this.parameters={innerRadius:t,outerRadius:e,thetaSegments:n,phiSegments:i,thetaStart:s,thetaLength:a},n=Math.max(3,n),i=Math.max(1,i);let o=[],c=[],l=[],h=[],u=t,d=(e-t)/i,f=new w,m=new Z;for(let _=0;_<=i;_++){for(let g=0;g<=n;g++){let p=s+g/n*a;f.x=u*Math.cos(p),f.y=u*Math.sin(p),c.push(f.x,f.y,f.z),l.push(0,0,1),m.x=(f.x/e+1)/2,m.y=(f.y/e+1)/2,h.push(m.x,m.y)}u+=d}for(let _=0;_<i;_++){let g=_*(n+1);for(let p=0;p<n;p++){let v=p+g,x=v,y=v+n+1,C=v+n+2,T=v+1;o.push(x,y,T),o.push(y,C,T)}}this.setIndex(o),this.setAttribute("position",new xt(c,3)),this.setAttribute("normal",new xt(l,3)),this.setAttribute("uv",new xt(h,2))}copy(t){return super.copy(t),this.parameters=Object.assign({},t.parameters),this}static fromJSON(t){return new r(t.innerRadius,t.outerRadius,t.thetaSegments,t.phiSegments,t.thetaStart,t.thetaLength)}},vc=class r extends Wt{constructor(t=new Gn([new Z(0,.5),new Z(-.5,-.5),new Z(.5,-.5)]),e=12){super(),this.type="ShapeGeometry",this.parameters={shapes:t,curveSegments:e};let n=[],i=[],s=[],a=[],o=0,c=0;if(Array.isArray(t)===!1)l(t);else for(let h=0;h<t.length;h++)l(t[h]),this.addGroup(o,c,h),o+=c,c=0;this.setIndex(n),this.setAttribute("position",new xt(i,3)),this.setAttribute("normal",new xt(s,3)),this.setAttribute("uv",new xt(a,2));function l(h){let u=i.length/3,d=h.extractPoints(e),f=d.shape,m=d.holes;bn.isClockWise(f)===!1&&(f=f.reverse());for(let g=0,p=m.length;g<p;g++){let v=m[g];bn.isClockWise(v)===!0&&(m[g]=v.reverse())}let _=bn.triangulateShape(f,m);for(let g=0,p=m.length;g<p;g++){let v=m[g];f=f.concat(v)}for(let g=0,p=f.length;g<p;g++){let v=f[g];i.push(v.x,v.y,0),s.push(0,0,1),a.push(v.x,v.y)}for(let g=0,p=_.length;g<p;g++){let v=_[g],x=v[0]+u,y=v[1]+u,C=v[2]+u;n.push(x,y,C),c+=3}}}copy(t){return super.copy(t),this.parameters=Object.assign({},t.parameters),this}toJSON(){let t=super.toJSON(),e=this.parameters.shapes;return Kx(e,t)}static fromJSON(t,e){let n=[];for(let i=0,s=t.shapes.length;i<s;i++){let a=e[t.shapes[i]];n.push(a)}return new r(n,t.curveSegments)}};function Kx(r,t){if(t.shapes=[],Array.isArray(r))for(let e=0,n=r.length;e<n;e++){let i=r[e];t.shapes.push(i.uuid)}else t.shapes.push(r.uuid);return t}var ba=class r extends Wt{constructor(t=1,e=32,n=16,i=0,s=Math.PI*2,a=0,o=Math.PI){super(),this.type="SphereGeometry",this.parameters={radius:t,widthSegments:e,heightSegments:n,phiStart:i,phiLength:s,thetaStart:a,thetaLength:o},e=Math.max(3,Math.floor(e)),n=Math.max(2,Math.floor(n));let c=Math.min(a+o,Math.PI),l=0,h=[],u=new w,d=new w,f=[],m=[],_=[],g=[];for(let p=0;p<=n;p++){let v=[],x=p/n,y=0;p===0&&a===0?y=.5/e:p===n&&c===Math.PI&&(y=-.5/e);for(let C=0;C<=e;C++){let T=C/e;u.x=-t*Math.cos(i+T*s)*Math.sin(a+x*o),u.y=t*Math.cos(a+x*o),u.z=t*Math.sin(i+T*s)*Math.sin(a+x*o),m.push(u.x,u.y,u.z),d.copy(u).normalize(),_.push(d.x,d.y,d.z),g.push(T+y,1-x),v.push(l++)}h.push(v)}for(let p=0;p<n;p++)for(let v=0;v<e;v++){let x=h[p][v+1],y=h[p][v],C=h[p+1][v],T=h[p+1][v+1];(p!==0||a>0)&&f.push(x,y,T),(p!==n-1||c<Math.PI)&&f.push(y,C,T)}this.setIndex(f),this.setAttribute("position",new xt(m,3)),this.setAttribute("normal",new xt(_,3)),this.setAttribute("uv",new xt(g,2))}copy(t){return super.copy(t),this.parameters=Object.assign({},t.parameters),this}static fromJSON(t){return new r(t.radius,t.widthSegments,t.heightSegments,t.phiStart,t.phiLength,t.thetaStart,t.thetaLength)}},yc=class r extends vi{constructor(t=1,e=0){let n=[1,1,1,-1,-1,1,-1,1,-1,1,-1,-1],i=[2,1,0,0,3,2,1,3,0,2,3,1];super(n,i,t,e),this.type="TetrahedronGeometry",this.parameters={radius:t,detail:e}}static fromJSON(t){return new r(t.radius,t.detail)}},Mc=class r extends Wt{constructor(t=1,e=.4,n=12,i=48,s=Math.PI*2){super(),this.type="TorusGeometry",this.parameters={radius:t,tube:e,radialSegments:n,tubularSegments:i,arc:s},n=Math.floor(n),i=Math.floor(i);let a=[],o=[],c=[],l=[],h=new w,u=new w,d=new w;for(let f=0;f<=n;f++)for(let m=0;m<=i;m++){let _=m/i*s,g=f/n*Math.PI*2;u.x=(t+e*Math.cos(g))*Math.cos(_),u.y=(t+e*Math.cos(g))*Math.sin(_),u.z=e*Math.sin(g),o.push(u.x,u.y,u.z),h.x=t*Math.cos(_),h.y=t*Math.sin(_),d.subVectors(u,h).normalize(),c.push(d.x,d.y,d.z),l.push(m/i),l.push(f/n)}for(let f=1;f<=n;f++)for(let m=1;m<=i;m++){let _=(i+1)*f+m-1,g=(i+1)*(f-1)+m-1,p=(i+1)*(f-1)+m,v=(i+1)*f+m;a.push(_,g,v),a.push(g,p,v)}this.setIndex(a),this.setAttribute("position",new xt(o,3)),this.setAttribute("normal",new xt(c,3)),this.setAttribute("uv",new xt(l,2))}copy(t){return super.copy(t),this.parameters=Object.assign({},t.parameters),this}static fromJSON(t){return new r(t.radius,t.tube,t.radialSegments,t.tubularSegments,t.arc)}},Sc=class r extends Wt{constructor(t=1,e=.4,n=64,i=8,s=2,a=3){super(),this.type="TorusKnotGeometry",this.parameters={radius:t,tube:e,tubularSegments:n,radialSegments:i,p:s,q:a},n=Math.floor(n),i=Math.floor(i);let o=[],c=[],l=[],h=[],u=new w,d=new w,f=new w,m=new w,_=new w,g=new w,p=new w;for(let x=0;x<=n;++x){let y=x/n*s*Math.PI*2;v(y,s,a,t,f),v(y+.01,s,a,t,m),g.subVectors(m,f),p.addVectors(m,f),_.crossVectors(g,p),p.crossVectors(_,g),_.normalize(),p.normalize();for(let C=0;C<=i;++C){let T=C/i*Math.PI*2,R=-e*Math.cos(T),U=e*Math.sin(T);u.x=f.x+(R*p.x+U*_.x),u.y=f.y+(R*p.y+U*_.y),u.z=f.z+(R*p.z+U*_.z),c.push(u.x,u.y,u.z),d.subVectors(u,f).normalize(),l.push(d.x,d.y,d.z),h.push(x/n),h.push(C/i)}}for(let x=1;x<=n;x++)for(let y=1;y<=i;y++){let C=(i+1)*(x-1)+(y-1),T=(i+1)*x+(y-1),R=(i+1)*x+y,U=(i+1)*(x-1)+y;o.push(C,T,U),o.push(T,R,U)}this.setIndex(o),this.setAttribute("position",new xt(c,3)),this.setAttribute("normal",new xt(l,3)),this.setAttribute("uv",new xt(h,2));function v(x,y,C,T,R){let U=Math.cos(x),S=Math.sin(x),E=C/y*x,N=Math.cos(E);R.x=T*(2+N)*.5*U,R.y=T*(2+N)*S*.5,R.z=T*Math.sin(E)*.5}}copy(t){return super.copy(t),this.parameters=Object.assign({},t.parameters),this}static fromJSON(t){return new r(t.radius,t.tube,t.tubularSegments,t.radialSegments,t.p,t.q)}},bc=class r extends Wt{constructor(t=new xa(new w(-1,-1,0),new w(-1,1,0),new w(1,1,0)),e=64,n=1,i=8,s=!1){super(),this.type="TubeGeometry",this.parameters={path:t,tubularSegments:e,radius:n,radialSegments:i,closed:s};let a=t.computeFrenetFrames(e,s);this.tangents=a.tangents,this.normals=a.normals,this.binormals=a.binormals;let o=new w,c=new w,l=new Z,h=new w,u=[],d=[],f=[],m=[];_(),this.setIndex(m),this.setAttribute("position",new xt(u,3)),this.setAttribute("normal",new xt(d,3)),this.setAttribute("uv",new xt(f,2));function _(){for(let x=0;x<e;x++)g(x);g(s===!1?e:0),v(),p()}function g(x){h=t.getPointAt(x/e,h);let y=a.normals[x],C=a.binormals[x];for(let T=0;T<=i;T++){let R=T/i*Math.PI*2,U=Math.sin(R),S=-Math.cos(R);c.x=S*y.x+U*C.x,c.y=S*y.y+U*C.y,c.z=S*y.z+U*C.z,c.normalize(),d.push(c.x,c.y,c.z),o.x=h.x+n*c.x,o.y=h.y+n*c.y,o.z=h.z+n*c.z,u.push(o.x,o.y,o.z)}}function p(){for(let x=1;x<=e;x++)for(let y=1;y<=i;y++){let C=(i+1)*(x-1)+(y-1),T=(i+1)*x+(y-1),R=(i+1)*x+y,U=(i+1)*(x-1)+y;m.push(C,T,U),m.push(T,R,U)}}function v(){for(let x=0;x<=e;x++)for(let y=0;y<=i;y++)l.x=x/e,l.y=y/i,f.push(l.x,l.y)}}copy(t){return super.copy(t),this.parameters=Object.assign({},t.parameters),this}toJSON(){let t=super.toJSON();return t.path=this.parameters.path.toJSON(),t}static fromJSON(t){return new r(new ya[t.path.type]().fromJSON(t.path),t.tubularSegments,t.radius,t.radialSegments,t.closed)}},Ec=class extends Wt{constructor(t=null){if(super(),this.type="WireframeGeometry",this.parameters={geometry:t},t!==null){let e=[],n=new Set,i=new w,s=new w;if(t.index!==null){let a=t.attributes.position,o=t.index,c=t.groups;c.length===0&&(c=[{start:0,count:o.count,materialIndex:0}]);for(let l=0,h=c.length;l<h;++l){let u=c[l],d=u.start,f=u.count;for(let m=d,_=d+f;m<_;m+=3)for(let g=0;g<3;g++){let p=o.getX(m+g),v=o.getX(m+(g+1)%3);i.fromBufferAttribute(a,p),s.fromBufferAttribute(a,v),Eu(i,s,n)===!0&&(e.push(i.x,i.y,i.z),e.push(s.x,s.y,s.z))}}}else{let a=t.attributes.position;for(let o=0,c=a.count/3;o<c;o++)for(let l=0;l<3;l++){let h=3*o+l,u=3*o+(l+1)%3;i.fromBufferAttribute(a,h),s.fromBufferAttribute(a,u),Eu(i,s,n)===!0&&(e.push(i.x,i.y,i.z),e.push(s.x,s.y,s.z))}}this.setAttribute("position",new xt(e,3))}}copy(t){return super.copy(t),this.parameters=Object.assign({},t.parameters),this}};function Eu(r,t,e){let n=`${r.x},${r.y},${r.z}-${t.x},${t.y},${t.z}`,i=`${t.x},${t.y},${t.z}-${r.x},${r.y},${r.z}`;return e.has(n)===!0||e.has(i)===!0?!1:(e.add(n),e.add(i),!0)}var Au=Object.freeze({__proto__:null,BoxGeometry:ns,CapsuleGeometry:lc,CircleGeometry:hc,ConeGeometry:uc,CylinderGeometry:Hs,DodecahedronGeometry:dc,EdgesGeometry:fc,ExtrudeGeometry:gc,IcosahedronGeometry:_c,LatheGeometry:Ma,OctahedronGeometry:Sa,PlaneGeometry:oa,PolyhedronGeometry:vi,RingGeometry:xc,ShapeGeometry:vc,SphereGeometry:ba,TetrahedronGeometry:yc,TorusGeometry:Mc,TorusKnotGeometry:Sc,TubeGeometry:bc,WireframeGeometry:Ec}),Ac=class extends Te{constructor(t){super(),this.isShadowMaterial=!0,this.type="ShadowMaterial",this.color=new pt(0),this.transparent=!0,this.fog=!0,this.setValues(t)}copy(t){return super.copy(t),this.color.copy(t.color),this.fog=t.fog,this}},Tc=class extends sn{constructor(t){super(t),this.isRawShaderMaterial=!0,this.type="RawShaderMaterial"}},Ea=class extends Te{constructor(t){super(),this.isMeshStandardMaterial=!0,this.defines={STANDARD:""},this.type="MeshStandardMaterial",this.color=new pt(16777215),this.roughness=1,this.metalness=0,this.map=null,this.lightMap=null,this.lightMapIntensity=1,this.aoMap=null,this.aoMapIntensity=1,this.emissive=new pt(0),this.emissiveIntensity=1,this.emissiveMap=null,this.bumpMap=null,this.bumpScale=1,this.normalMap=null,this.normalMapType=Si,this.normalScale=new Z(1,1),this.displacementMap=null,this.displacementScale=1,this.displacementBias=0,this.roughnessMap=null,this.metalnessMap=null,this.alphaMap=null,this.envMap=null,this.envMapIntensity=1,this.wireframe=!1,this.wireframeLinewidth=1,this.wireframeLinecap="round",this.wireframeLinejoin="round",this.flatShading=!1,this.fog=!0,this.setValues(t)}copy(t){return super.copy(t),this.defines={STANDARD:""},this.color.copy(t.color),this.roughness=t.roughness,this.metalness=t.metalness,this.map=t.map,this.lightMap=t.lightMap,this.lightMapIntensity=t.lightMapIntensity,this.aoMap=t.aoMap,this.aoMapIntensity=t.aoMapIntensity,this.emissive.copy(t.emissive),this.emissiveMap=t.emissiveMap,this.emissiveIntensity=t.emissiveIntensity,this.bumpMap=t.bumpMap,this.bumpScale=t.bumpScale,this.normalMap=t.normalMap,this.normalMapType=t.normalMapType,this.normalScale.copy(t.normalScale),this.displacementMap=t.displacementMap,this.displacementScale=t.displacementScale,this.displacementBias=t.displacementBias,this.roughnessMap=t.roughnessMap,this.metalnessMap=t.metalnessMap,this.alphaMap=t.alphaMap,this.envMap=t.envMap,this.envMapIntensity=t.envMapIntensity,this.wireframe=t.wireframe,this.wireframeLinewidth=t.wireframeLinewidth,this.wireframeLinecap=t.wireframeLinecap,this.wireframeLinejoin=t.wireframeLinejoin,this.flatShading=t.flatShading,this.fog=t.fog,this}},wc=class extends Ea{constructor(t){super(),this.isMeshPhysicalMaterial=!0,this.defines={STANDARD:"",PHYSICAL:""},this.type="MeshPhysicalMaterial",this.anisotropyRotation=0,this.anisotropyMap=null,this.clearcoatMap=null,this.clearcoatRoughness=0,this.clearcoatRoughnessMap=null,this.clearcoatNormalScale=new Z(1,1),this.clearcoatNormalMap=null,this.ior=1.5,Object.defineProperty(this,"reflectivity",{get:function(){return he(2.5*(this.ior-1)/(this.ior+1),0,1)},set:function(e){this.ior=(1+.4*e)/(1-.4*e)}}),this.iridescenceMap=null,this.iridescenceIOR=1.3,this.iridescenceThicknessRange=[100,400],this.iridescenceThicknessMap=null,this.sheenColor=new pt(0),this.sheenColorMap=null,this.sheenRoughness=1,this.sheenRoughnessMap=null,this.transmissionMap=null,this.thickness=0,this.thicknessMap=null,this.attenuationDistance=1/0,this.attenuationColor=new pt(1,1,1),this.specularIntensity=1,this.specularIntensityMap=null,this.specularColor=new pt(1,1,1),this.specularColorMap=null,this._anisotropy=0,this._clearcoat=0,this._iridescence=0,this._sheen=0,this._transmission=0,this.setValues(t)}get anisotropy(){return this._anisotropy}set anisotropy(t){this._anisotropy>0!=t>0&&this.version++,this._anisotropy=t}get clearcoat(){return this._clearcoat}set clearcoat(t){this._clearcoat>0!=t>0&&this.version++,this._clearcoat=t}get iridescence(){return this._iridescence}set iridescence(t){this._iridescence>0!=t>0&&this.version++,this._iridescence=t}get sheen(){return this._sheen}set sheen(t){this._sheen>0!=t>0&&this.version++,this._sheen=t}get transmission(){return this._transmission}set transmission(t){this._transmission>0!=t>0&&this.version++,this._transmission=t}copy(t){return super.copy(t),this.defines={STANDARD:"",PHYSICAL:""},this.anisotropy=t.anisotropy,this.anisotropyRotation=t.anisotropyRotation,this.anisotropyMap=t.anisotropyMap,this.clearcoat=t.clearcoat,this.clearcoatMap=t.clearcoatMap,this.clearcoatRoughness=t.clearcoatRoughness,this.clearcoatRoughnessMap=t.clearcoatRoughnessMap,this.clearcoatNormalMap=t.clearcoatNormalMap,this.clearcoatNormalScale.copy(t.clearcoatNormalScale),this.ior=t.ior,this.iridescence=t.iridescence,this.iridescenceMap=t.iridescenceMap,this.iridescenceIOR=t.iridescenceIOR,this.iridescenceThicknessRange=[...t.iridescenceThicknessRange],this.iridescenceThicknessMap=t.iridescenceThicknessMap,this.sheen=t.sheen,this.sheenColor.copy(t.sheenColor),this.sheenColorMap=t.sheenColorMap,this.sheenRoughness=t.sheenRoughness,this.sheenRoughnessMap=t.sheenRoughnessMap,this.transmission=t.transmission,this.transmissionMap=t.transmissionMap,this.thickness=t.thickness,this.thicknessMap=t.thicknessMap,this.attenuationDistance=t.attenuationDistance,this.attenuationColor.copy(t.attenuationColor),this.specularIntensity=t.specularIntensity,this.specularIntensityMap=t.specularIntensityMap,this.specularColor.copy(t.specularColor),this.specularColorMap=t.specularColorMap,this}},Rc=class extends Te{constructor(t){super(),this.isMeshPhongMaterial=!0,this.type="MeshPhongMaterial",this.color=new pt(16777215),this.specular=new pt(1118481),this.shininess=30,this.map=null,this.lightMap=null,this.lightMapIntensity=1,this.aoMap=null,this.aoMapIntensity=1,this.emissive=new pt(0),this.emissiveIntensity=1,this.emissiveMap=null,this.bumpMap=null,this.bumpScale=1,this.normalMap=null,this.normalMapType=Si,this.normalScale=new Z(1,1),this.displacementMap=null,this.displacementScale=1,this.displacementBias=0,this.specularMap=null,this.alphaMap=null,this.envMap=null,this.combine=Pa,this.reflectivity=1,this.refractionRatio=.98,this.wireframe=!1,this.wireframeLinewidth=1,this.wireframeLinecap="round",this.wireframeLinejoin="round",this.flatShading=!1,this.fog=!0,this.setValues(t)}copy(t){return super.copy(t),this.color.copy(t.color),this.specular.copy(t.specular),this.shininess=t.shininess,this.map=t.map,this.lightMap=t.lightMap,this.lightMapIntensity=t.lightMapIntensity,this.aoMap=t.aoMap,this.aoMapIntensity=t.aoMapIntensity,this.emissive.copy(t.emissive),this.emissiveMap=t.emissiveMap,this.emissiveIntensity=t.emissiveIntensity,this.bumpMap=t.bumpMap,this.bumpScale=t.bumpScale,this.normalMap=t.normalMap,this.normalMapType=t.normalMapType,this.normalScale.copy(t.normalScale),this.displacementMap=t.displacementMap,this.displacementScale=t.displacementScale,this.displacementBias=t.displacementBias,this.specularMap=t.specularMap,this.alphaMap=t.alphaMap,this.envMap=t.envMap,this.combine=t.combine,this.reflectivity=t.reflectivity,this.refractionRatio=t.refractionRatio,this.wireframe=t.wireframe,this.wireframeLinewidth=t.wireframeLinewidth,this.wireframeLinecap=t.wireframeLinecap,this.wireframeLinejoin=t.wireframeLinejoin,this.flatShading=t.flatShading,this.fog=t.fog,this}},Cc=class extends Te{constructor(t){super(),this.isMeshToonMaterial=!0,this.defines={TOON:""},this.type="MeshToonMaterial",this.color=new pt(16777215),this.map=null,this.gradientMap=null,this.lightMap=null,this.lightMapIntensity=1,this.aoMap=null,this.aoMapIntensity=1,this.emissive=new pt(0),this.emissiveIntensity=1,this.emissiveMap=null,this.bumpMap=null,this.bumpScale=1,this.normalMap=null,this.normalMapType=Si,this.normalScale=new Z(1,1),this.displacementMap=null,this.displacementScale=1,this.displacementBias=0,this.alphaMap=null,this.wireframe=!1,this.wireframeLinewidth=1,this.wireframeLinecap="round",this.wireframeLinejoin="round",this.fog=!0,this.setValues(t)}copy(t){return super.copy(t),this.color.copy(t.color),this.map=t.map,this.gradientMap=t.gradientMap,this.lightMap=t.lightMap,this.lightMapIntensity=t.lightMapIntensity,this.aoMap=t.aoMap,this.aoMapIntensity=t.aoMapIntensity,this.emissive.copy(t.emissive),this.emissiveMap=t.emissiveMap,this.emissiveIntensity=t.emissiveIntensity,this.bumpMap=t.bumpMap,this.bumpScale=t.bumpScale,this.normalMap=t.normalMap,this.normalMapType=t.normalMapType,this.normalScale.copy(t.normalScale),this.displacementMap=t.displacementMap,this.displacementScale=t.displacementScale,this.displacementBias=t.displacementBias,this.alphaMap=t.alphaMap,this.wireframe=t.wireframe,this.wireframeLinewidth=t.wireframeLinewidth,this.wireframeLinecap=t.wireframeLinecap,this.wireframeLinejoin=t.wireframeLinejoin,this.fog=t.fog,this}},Pc=class extends Te{constructor(t){super(),this.isMeshNormalMaterial=!0,this.type="MeshNormalMaterial",this.bumpMap=null,this.bumpScale=1,this.normalMap=null,this.normalMapType=Si,this.normalScale=new Z(1,1),this.displacementMap=null,this.displacementScale=1,this.displacementBias=0,this.wireframe=!1,this.wireframeLinewidth=1,this.flatShading=!1,this.setValues(t)}copy(t){return super.copy(t),this.bumpMap=t.bumpMap,this.bumpScale=t.bumpScale,this.normalMap=t.normalMap,this.normalMapType=t.normalMapType,this.normalScale.copy(t.normalScale),this.displacementMap=t.displacementMap,this.displacementScale=t.displacementScale,this.displacementBias=t.displacementBias,this.wireframe=t.wireframe,this.wireframeLinewidth=t.wireframeLinewidth,this.flatShading=t.flatShading,this}},Lc=class extends Te{constructor(t){super(),this.isMeshLambertMaterial=!0,this.type="MeshLambertMaterial",this.color=new pt(16777215),this.map=null,this.lightMap=null,this.lightMapIntensity=1,this.aoMap=null,this.aoMapIntensity=1,this.emissive=new pt(0),this.emissiveIntensity=1,this.emissiveMap=null,this.bumpMap=null,this.bumpScale=1,this.normalMap=null,this.normalMapType=Si,this.normalScale=new Z(1,1),this.displacementMap=null,this.displacementScale=1,this.displacementBias=0,this.specularMap=null,this.alphaMap=null,this.envMap=null,this.combine=Pa,this.reflectivity=1,this.refractionRatio=.98,this.wireframe=!1,this.wireframeLinewidth=1,this.wireframeLinecap="round",this.wireframeLinejoin="round",this.flatShading=!1,this.fog=!0,this.setValues(t)}copy(t){return super.copy(t),this.color.copy(t.color),this.map=t.map,this.lightMap=t.lightMap,this.lightMapIntensity=t.lightMapIntensity,this.aoMap=t.aoMap,this.aoMapIntensity=t.aoMapIntensity,this.emissive.copy(t.emissive),this.emissiveMap=t.emissiveMap,this.emissiveIntensity=t.emissiveIntensity,this.bumpMap=t.bumpMap,this.bumpScale=t.bumpScale,this.normalMap=t.normalMap,this.normalMapType=t.normalMapType,this.normalScale.copy(t.normalScale),this.displacementMap=t.displacementMap,this.displacementScale=t.displacementScale,this.displacementBias=t.displacementBias,this.specularMap=t.specularMap,this.alphaMap=t.alphaMap,this.envMap=t.envMap,this.combine=t.combine,this.reflectivity=t.reflectivity,this.refractionRatio=t.refractionRatio,this.wireframe=t.wireframe,this.wireframeLinewidth=t.wireframeLinewidth,this.wireframeLinecap=t.wireframeLinecap,this.wireframeLinejoin=t.wireframeLinejoin,this.flatShading=t.flatShading,this.fog=t.fog,this}},Ic=class extends Te{constructor(t){super(),this.isMeshMatcapMaterial=!0,this.defines={MATCAP:""},this.type="MeshMatcapMaterial",this.color=new pt(16777215),this.matcap=null,this.map=null,this.bumpMap=null,this.bumpScale=1,this.normalMap=null,this.normalMapType=Si,this.normalScale=new Z(1,1),this.displacementMap=null,this.displacementScale=1,this.displacementBias=0,this.alphaMap=null,this.flatShading=!1,this.fog=!0,this.setValues(t)}copy(t){return super.copy(t),this.defines={MATCAP:""},this.color.copy(t.color),this.matcap=t.matcap,this.map=t.map,this.bumpMap=t.bumpMap,this.bumpScale=t.bumpScale,this.normalMap=t.normalMap,this.normalMapType=t.normalMapType,this.normalScale.copy(t.normalScale),this.displacementMap=t.displacementMap,this.displacementScale=t.displacementScale,this.displacementBias=t.displacementBias,this.alphaMap=t.alphaMap,this.flatShading=t.flatShading,this.fog=t.fog,this}},Uc=class extends Ie{constructor(t){super(),this.isLineDashedMaterial=!0,this.type="LineDashedMaterial",this.scale=1,this.dashSize=3,this.gapSize=1,this.setValues(t)}copy(t){return super.copy(t),this.scale=t.scale,this.dashSize=t.dashSize,this.gapSize=t.gapSize,this}};function hi(r,t,e){return!r||!e&&r.constructor===t?r:typeof t.BYTES_PER_ELEMENT=="number"?new t(r):Array.prototype.slice.call(r)}function jd(r){return ArrayBuffer.isView(r)&&!(r instanceof DataView)}function tf(r){function t(i,s){return r[i]-r[s]}let e=r.length,n=new Array(e);for(let i=0;i!==e;++i)n[i]=i;return n.sort(t),n}function Dc(r,t,e){let n=r.length,i=new r.constructor(n);for(let s=0,a=0;a!==n;++s){let o=e[s]*t;for(let c=0;c!==t;++c)i[a++]=r[o+c]}return i}function dl(r,t,e,n){let i=1,s=r[0];for(;s!==void 0&&s[n]===void 0;)s=r[i++];if(s===void 0)return;let a=s[n];if(a!==void 0)if(Array.isArray(a))do a=s[n],a!==void 0&&(t.push(s.time),e.push.apply(e,a)),s=r[i++];while(s!==void 0);else if(a.toArray!==void 0)do a=s[n],a!==void 0&&(t.push(s.time),a.toArray(e,e.length)),s=r[i++];while(s!==void 0);else do a=s[n],a!==void 0&&(t.push(s.time),e.push(a)),s=r[i++];while(s!==void 0)}function Qx(r,t,e,n,i=30){let s=r.clone();s.name=t;let a=[];for(let c=0;c<s.tracks.length;++c){let l=s.tracks[c],h=l.getValueSize(),u=[],d=[];for(let f=0;f<l.times.length;++f){let m=l.times[f]*i;if(!(m<e||m>=n)){u.push(l.times[f]);for(let _=0;_<h;++_)d.push(l.values[f*h+_])}}u.length!==0&&(l.times=hi(u,l.times.constructor),l.values=hi(d,l.values.constructor),a.push(l))}s.tracks=a;let o=1/0;for(let c=0;c<s.tracks.length;++c)o>s.tracks[c].times[0]&&(o=s.tracks[c].times[0]);for(let c=0;c<s.tracks.length;++c)s.tracks[c].shift(-1*o);return s.resetDuration(),s}function jx(r,t=0,e=r,n=30){n<=0&&(n=30);let i=e.tracks.length,s=t/n;for(let a=0;a<i;++a){let o=e.tracks[a],c=o.ValueTypeName;if(c==="bool"||c==="string")continue;let l=r.tracks.find(function(p){return p.name===o.name&&p.ValueTypeName===c});if(l===void 0)continue;let h=0,u=o.getValueSize();o.createInterpolant.isInterpolantFactoryMethodGLTFCubicSpline&&(h=u/3);let d=0,f=l.getValueSize();l.createInterpolant.isInterpolantFactoryMethodGLTFCubicSpline&&(d=f/3);let m=o.times.length-1,_;if(s<=o.times[0]){let p=h,v=u-h;_=o.values.slice(p,v)}else if(s>=o.times[m]){let p=m*u+h,v=p+u-h;_=o.values.slice(p,v)}else{let p=o.createInterpolant(),v=h,x=u-h;p.evaluate(s),_=p.resultBuffer.slice(v,x)}c==="quaternion"&&new Be().fromArray(_).normalize().conjugate().toArray(_);let g=l.times.length;for(let p=0;p<g;++p){let v=p*f+d;if(c==="quaternion")Be.multiplyQuaternionsFlat(l.values,v,_,0,l.values,v);else{let x=f-d*2;for(let y=0;y<x;++y)l.values[v+y]-=_[y]}}}return r.blendMode=Fd,r}var ey={convertArray:hi,isTypedArray:jd,getKeyframeOrder:tf,sortedArray:Dc,flattenJSON:dl,subclip:Qx,makeClipAdditive:jx},cs=class{constructor(t,e,n,i){this.parameterPositions=t,this._cachedIndex=0,this.resultBuffer=i!==void 0?i:new e.constructor(n),this.sampleValues=e,this.valueSize=n,this.settings=null,this.DefaultSettings_={}}evaluate(t){let e=this.parameterPositions,n=this._cachedIndex,i=e[n],s=e[n-1];t:{e:{let a;n:{i:if(!(t<i)){for(let o=n+2;;){if(i===void 0){if(t<s)break i;return n=e.length,this._cachedIndex=n,this.copySampleValue_(n-1)}if(n===o)break;if(s=i,i=e[++n],t<i)break e}a=e.length;break n}if(!(t>=s)){let o=e[1];t<o&&(n=2,s=o);for(let c=n-2;;){if(s===void 0)return this._cachedIndex=0,this.copySampleValue_(0);if(n===c)break;if(i=s,s=e[--n-1],t>=s)break e}a=n,n=0;break n}break t}for(;n<a;){let o=n+a>>>1;t<e[o]?a=o:n=o+1}if(i=e[n],s=e[n-1],s===void 0)return this._cachedIndex=0,this.copySampleValue_(0);if(i===void 0)return n=e.length,this._cachedIndex=n,this.copySampleValue_(n-1)}this._cachedIndex=n,this.intervalChanged_(n,s,i)}return this.interpolate_(n,s,t,i)}getSettings_(){return this.settings||this.DefaultSettings_}copySampleValue_(t){let e=this.resultBuffer,n=this.sampleValues,i=this.valueSize,s=t*i;for(let a=0;a!==i;++a)e[a]=n[s+a];return e}interpolate_(){throw new Error("call to abstract method")}intervalChanged_(){}},Nc=class extends cs{constructor(t,e,n,i){super(t,e,n,i),this._weightPrev=-0,this._offsetPrev=-0,this._weightNext=-0,this._offsetNext=-0,this.DefaultSettings_={endingStart:Xi,endingEnd:Xi}}intervalChanged_(t,e,n){let i=this.parameterPositions,s=t-2,a=t+1,o=i[s],c=i[a];if(o===void 0)switch(this.getSettings_().endingStart){case qi:s=t,o=2*e-n;break;case $r:s=i.length-2,o=e+i[s]-i[s+1];break;default:s=t,o=n}if(c===void 0)switch(this.getSettings_().endingEnd){case qi:a=t,c=2*n-e;break;case $r:a=1,c=n+i[1]-i[0];break;default:a=t-1,c=e}let l=(n-e)*.5,h=this.valueSize;this._weightPrev=l/(e-o),this._weightNext=l/(c-n),this._offsetPrev=s*h,this._offsetNext=a*h}interpolate_(t,e,n,i){let s=this.resultBuffer,a=this.sampleValues,o=this.valueSize,c=t*o,l=c-o,h=this._offsetPrev,u=this._offsetNext,d=this._weightPrev,f=this._weightNext,m=(n-e)/(i-e),_=m*m,g=_*m,p=-d*g+2*d*_-d*m,v=(1+d)*g+(-1.5-2*d)*_+(-.5+d)*m+1,x=(-1-f)*g+(1.5+f)*_+.5*m,y=f*g-f*_;for(let C=0;C!==o;++C)s[C]=p*a[h+C]+v*a[l+C]+x*a[c+C]+y*a[u+C];return s}},Aa=class extends cs{constructor(t,e,n,i){super(t,e,n,i)}interpolate_(t,e,n,i){let s=this.resultBuffer,a=this.sampleValues,o=this.valueSize,c=t*o,l=c-o,h=(n-e)/(i-e),u=1-h;for(let d=0;d!==o;++d)s[d]=a[l+d]*u+a[c+d]*h;return s}},Oc=class extends cs{constructor(t,e,n,i){super(t,e,n,i)}interpolate_(t){return this.copySampleValue_(t-1)}},je=class{constructor(t,e,n,i){if(t===void 0)throw new Error("THREE.KeyframeTrack: track name is undefined");if(e===void 0||e.length===0)throw new Error("THREE.KeyframeTrack: no keyframes in track named "+t);this.name=t,this.times=hi(e,this.TimeBufferType),this.values=hi(n,this.ValueBufferType),this.setInterpolation(i||this.DefaultInterpolation)}static toJSON(t){let e=t.constructor,n;if(e.toJSON!==this.toJSON)n=e.toJSON(t);else{n={name:t.name,times:hi(t.times,Array),values:hi(t.values,Array)};let i=t.getInterpolation();i!==t.DefaultInterpolation&&(n.interpolation=i)}return n.type=t.ValueTypeName,n}InterpolantFactoryMethodDiscrete(t){return new Oc(this.times,this.values,this.getValueSize(),t)}InterpolantFactoryMethodLinear(t){return new Aa(this.times,this.values,this.getValueSize(),t)}InterpolantFactoryMethodSmooth(t){return new Nc(this.times,this.values,this.getValueSize(),t)}setInterpolation(t){let e;switch(t){case Zr:e=this.InterpolantFactoryMethodDiscrete;break;case Jr:e=this.InterpolantFactoryMethodLinear;break;case Ga:e=this.InterpolantFactoryMethodSmooth;break}if(e===void 0){let n="unsupported interpolation for "+this.ValueTypeName+" keyframe track named "+this.name;if(this.createInterpolant===void 0)if(t!==this.DefaultInterpolation)this.setInterpolation(this.DefaultInterpolation);else throw new Error(n);return console.warn("THREE.KeyframeTrack:",n),this}return this.createInterpolant=e,this}getInterpolation(){switch(this.createInterpolant){case this.InterpolantFactoryMethodDiscrete:return Zr;case this.InterpolantFactoryMethodLinear:return Jr;case this.InterpolantFactoryMethodSmooth:return Ga}}getValueSize(){return this.values.length/this.times.length}shift(t){if(t!==0){let e=this.times;for(let n=0,i=e.length;n!==i;++n)e[n]+=t}return this}scale(t){if(t!==1){let e=this.times;for(let n=0,i=e.length;n!==i;++n)e[n]*=t}return this}trim(t,e){let n=this.times,i=n.length,s=0,a=i-1;for(;s!==i&&n[s]<t;)++s;for(;a!==-1&&n[a]>e;)--a;if(++a,s!==0||a!==i){s>=a&&(a=Math.max(a,1),s=a-1);let o=this.getValueSize();this.times=n.slice(s,a),this.values=this.values.slice(s*o,a*o)}return this}validate(){let t=!0,e=this.getValueSize();e-Math.floor(e)!==0&&(console.error("THREE.KeyframeTrack: Invalid value size in track.",this),t=!1);let n=this.times,i=this.values,s=n.length;s===0&&(console.error("THREE.KeyframeTrack: Track is empty.",this),t=!1);let a=null;for(let o=0;o!==s;o++){let c=n[o];if(typeof c=="number"&&isNaN(c)){console.error("THREE.KeyframeTrack: Time is not a valid number.",this,o,c),t=!1;break}if(a!==null&&a>c){console.error("THREE.KeyframeTrack: Out of order keys.",this,o,c,a),t=!1;break}a=c}if(i!==void 0&&jd(i))for(let o=0,c=i.length;o!==c;++o){let l=i[o];if(isNaN(l)){console.error("THREE.KeyframeTrack: Value is not a valid number.",this,o,l),t=!1;break}}return t}optimize(){let t=this.times.slice(),e=this.values.slice(),n=this.getValueSize(),i=this.getInterpolation()===Ga,s=t.length-1,a=1;for(let o=1;o<s;++o){let c=!1,l=t[o],h=t[o+1];if(l!==h&&(o!==1||l!==t[0]))if(i)c=!0;else{let u=o*n,d=u-n,f=u+n;for(let m=0;m!==n;++m){let _=e[u+m];if(_!==e[d+m]||_!==e[f+m]){c=!0;break}}}if(c){if(o!==a){t[a]=t[o];let u=o*n,d=a*n;for(let f=0;f!==n;++f)e[d+f]=e[u+f]}++a}}if(s>0){t[a]=t[s];for(let o=s*n,c=a*n,l=0;l!==n;++l)e[c+l]=e[o+l];++a}return a!==t.length?(this.times=t.slice(0,a),this.values=e.slice(0,a*n)):(this.times=t,this.values=e),this}clone(){let t=this.times.slice(),e=this.values.slice(),n=this.constructor,i=new n(this.name,t,e);return i.createInterpolant=this.createInterpolant,i}};je.prototype.TimeBufferType=Float32Array;je.prototype.ValueBufferType=Float32Array;je.prototype.DefaultInterpolation=Jr;var qn=class extends je{};qn.prototype.ValueTypeName="bool";qn.prototype.ValueBufferType=Array;qn.prototype.DefaultInterpolation=Zr;qn.prototype.InterpolantFactoryMethodLinear=void 0;qn.prototype.InterpolantFactoryMethodSmooth=void 0;var Ta=class extends je{};Ta.prototype.ValueTypeName="color";var ls=class extends je{};ls.prototype.ValueTypeName="number";var Fc=class extends cs{constructor(t,e,n,i){super(t,e,n,i)}interpolate_(t,e,n,i){let s=this.resultBuffer,a=this.sampleValues,o=this.valueSize,c=(n-e)/(i-e),l=t*o;for(let h=l+o;l!==h;l+=4)Be.slerpFlat(s,0,a,l-o,a,l,c);return s}},Mi=class extends je{InterpolantFactoryMethodLinear(t){return new Fc(this.times,this.values,this.getValueSize(),t)}};Mi.prototype.ValueTypeName="quaternion";Mi.prototype.DefaultInterpolation=Jr;Mi.prototype.InterpolantFactoryMethodSmooth=void 0;var Yn=class extends je{};Yn.prototype.ValueTypeName="string";Yn.prototype.ValueBufferType=Array;Yn.prototype.DefaultInterpolation=Zr;Yn.prototype.InterpolantFactoryMethodLinear=void 0;Yn.prototype.InterpolantFactoryMethodSmooth=void 0;var hs=class extends je{};hs.prototype.ValueTypeName="vector";var us=class{constructor(t,e=-1,n,i=ol){this.name=t,this.tracks=n,this.duration=e,this.blendMode=i,this.uuid=Ye(),this.duration<0&&this.resetDuration()}static parse(t){let e=[],n=t.tracks,i=1/(t.fps||1);for(let a=0,o=n.length;a!==o;++a)e.push(ev(n[a]).scale(i));let s=new this(t.name,t.duration,e,t.blendMode);return s.uuid=t.uuid,s}static toJSON(t){let e=[],n=t.tracks,i={name:t.name,duration:t.duration,tracks:e,uuid:t.uuid,blendMode:t.blendMode};for(let s=0,a=n.length;s!==a;++s)e.push(je.toJSON(n[s]));return i}static CreateFromMorphTargetSequence(t,e,n,i){let s=e.length,a=[];for(let o=0;o<s;o++){let c=[],l=[];c.push((o+s-1)%s,o,(o+1)%s),l.push(0,1,0);let h=tf(c);c=Dc(c,1,h),l=Dc(l,1,h),!i&&c[0]===0&&(c.push(s),l.push(l[0])),a.push(new ls(".morphTargetInfluences["+e[o].name+"]",c,l).scale(1/n))}return new this(t,-1,a)}static findByName(t,e){let n=t;if(!Array.isArray(t)){let i=t;n=i.geometry&&i.geometry.animations||i.animations}for(let i=0;i<n.length;i++)if(n[i].name===e)return n[i];return null}static CreateClipsFromMorphTargetSequences(t,e,n){let i={},s=/^([\w-]*?)([\d]+)$/;for(let o=0,c=t.length;o<c;o++){let l=t[o],h=l.name.match(s);if(h&&h.length>1){let u=h[1],d=i[u];d||(i[u]=d=[]),d.push(l)}}let a=[];for(let o in i)a.push(this.CreateFromMorphTargetSequence(o,i[o],e,n));return a}static parseAnimation(t,e){if(!t)return console.error("THREE.AnimationClip: No animation in JSONLoader data."),null;let n=function(u,d,f,m,_){if(f.length!==0){let g=[],p=[];dl(f,g,p,m),g.length!==0&&_.push(new u(d,g,p))}},i=[],s=t.name||"default",a=t.fps||30,o=t.blendMode,c=t.length||-1,l=t.hierarchy||[];for(let u=0;u<l.length;u++){let d=l[u].keys;if(!(!d||d.length===0))if(d[0].morphTargets){let f={},m;for(m=0;m<d.length;m++)if(d[m].morphTargets)for(let _=0;_<d[m].morphTargets.length;_++)f[d[m].morphTargets[_]]=-1;for(let _ in f){let g=[],p=[];for(let v=0;v!==d[m].morphTargets.length;++v){let x=d[m];g.push(x.time),p.push(x.morphTarget===_?1:0)}i.push(new ls(".morphTargetInfluence["+_+"]",g,p))}c=f.length*a}else{let f=".bones["+e[u].name+"]";n(hs,f+".position",d,"pos",i),n(Mi,f+".quaternion",d,"rot",i),n(hs,f+".scale",d,"scl",i)}}return i.length===0?null:new this(s,c,i,o)}resetDuration(){let t=this.tracks,e=0;for(let n=0,i=t.length;n!==i;++n){let s=this.tracks[n];e=Math.max(e,s.times[s.times.length-1])}return this.duration=e,this}trim(){for(let t=0;t<this.tracks.length;t++)this.tracks[t].trim(0,this.duration);return this}validate(){let t=!0;for(let e=0;e<this.tracks.length;e++)t=t&&this.tracks[e].validate();return t}optimize(){for(let t=0;t<this.tracks.length;t++)this.tracks[t].optimize();return this}clone(){let t=[];for(let e=0;e<this.tracks.length;e++)t.push(this.tracks[e].clone());return new this.constructor(this.name,this.duration,t,this.blendMode)}toJSON(){return this.constructor.toJSON(this)}};function tv(r){switch(r.toLowerCase()){case"scalar":case"double":case"float":case"number":case"integer":return ls;case"vector":case"vector2":case"vector3":case"vector4":return hs;case"color":return Ta;case"quaternion":return Mi;case"bool":case"boolean":return qn;case"string":return Yn}throw new Error("THREE.KeyframeTrack: Unsupported typeName: "+r)}function ev(r){if(r.type===void 0)throw new Error("THREE.KeyframeTrack: track type undefined, can not parse");let t=tv(r.type);if(r.times===void 0){let e=[],n=[];dl(r.keys,e,n,"value"),r.times=e,r.values=n}return t.parse!==void 0?t.parse(r):new t(r.name,r.times,r.values,r.interpolation)}var Bn={enabled:!1,files:{},add:function(r,t){this.enabled!==!1&&(this.files[r]=t)},get:function(r){if(this.enabled!==!1)return this.files[r]},remove:function(r){delete this.files[r]},clear:function(){this.files={}}},wa=class{constructor(t,e,n){let i=this,s=!1,a=0,o=0,c,l=[];this.onStart=void 0,this.onLoad=t,this.onProgress=e,this.onError=n,this.itemStart=function(h){o++,s===!1&&i.onStart!==void 0&&i.onStart(h,a,o),s=!0},this.itemEnd=function(h){a++,i.onProgress!==void 0&&i.onProgress(h,a,o),a===o&&(s=!1,i.onLoad!==void 0&&i.onLoad())},this.itemError=function(h){i.onError!==void 0&&i.onError(h)},this.resolveURL=function(h){return c?c(h):h},this.setURLModifier=function(h){return c=h,this},this.addHandler=function(h,u){return l.push(h,u),this},this.removeHandler=function(h){let u=l.indexOf(h);return u!==-1&&l.splice(u,2),this},this.getHandler=function(h){for(let u=0,d=l.length;u<d;u+=2){let f=l[u],m=l[u+1];if(f.global&&(f.lastIndex=0),f.test(h))return m}return null}}},nv=new wa,ze=class{constructor(t){this.manager=t!==void 0?t:nv,this.crossOrigin="anonymous",this.withCredentials=!1,this.path="",this.resourcePath="",this.requestHeader={}}load(){}loadAsync(t,e){let n=this;return new Promise(function(i,s){n.load(t,i,e,s)})}parse(){}setCrossOrigin(t){return this.crossOrigin=t,this}setWithCredentials(t){return this.withCredentials=t,this}setPath(t){return this.path=t,this}setResourcePath(t){return this.resourcePath=t,this}setRequestHeader(t){return this.requestHeader=t,this}};ze.DEFAULT_MATERIAL_NAME="__DEFAULT";var xn={},Bc=class extends Error{constructor(t,e){super(t),this.response=e}},un=class extends ze{constructor(t){super(t)}load(t,e,n,i){t===void 0&&(t=""),this.path!==void 0&&(t=this.path+t),t=this.manager.resolveURL(t);let s=Bn.get(t);if(s!==void 0)return this.manager.itemStart(t),setTimeout(()=>{e&&e(s),this.manager.itemEnd(t)},0),s;if(xn[t]!==void 0){xn[t].push({onLoad:e,onProgress:n,onError:i});return}xn[t]=[],xn[t].push({onLoad:e,onProgress:n,onError:i});let a=new Request(t,{headers:new Headers(this.requestHeader),credentials:this.withCredentials?"include":"same-origin"}),o=this.mimeType,c=this.responseType;fetch(a).then(l=>{if(l.status===200||l.status===0){if(l.status===0&&console.warn("THREE.FileLoader: HTTP Status 0 received."),typeof ReadableStream>"u"||l.body===void 0||l.body.getReader===void 0)return l;let h=xn[t],u=l.body.getReader(),d=l.headers.get("Content-Length")||l.headers.get("X-File-Size"),f=d?parseInt(d):0,m=f!==0,_=0,g=new ReadableStream({start(p){v();function v(){u.read().then(({done:x,value:y})=>{if(x)p.close();else{_+=y.byteLength;let C=new ProgressEvent("progress",{lengthComputable:m,loaded:_,total:f});for(let T=0,R=h.length;T<R;T++){let U=h[T];U.onProgress&&U.onProgress(C)}p.enqueue(y),v()}})}}});return new Response(g)}else throw new Bc(`fetch for "${l.url}" responded with ${l.status}: ${l.statusText}`,l)}).then(l=>{switch(c){case"arraybuffer":return l.arrayBuffer();case"blob":return l.blob();case"document":return l.text().then(h=>new DOMParser().parseFromString(h,o));case"json":return l.json();default:if(o===void 0)return l.text();{let u=/charset="?([^;"\s]*)"?/i.exec(o),d=u&&u[1]?u[1].toLowerCase():void 0,f=new TextDecoder(d);return l.arrayBuffer().then(m=>f.decode(m))}}}).then(l=>{Bn.add(t,l);let h=xn[t];delete xn[t];for(let u=0,d=h.length;u<d;u++){let f=h[u];f.onLoad&&f.onLoad(l)}}).catch(l=>{let h=xn[t];if(h===void 0)throw this.manager.itemError(t),l;delete xn[t];for(let u=0,d=h.length;u<d;u++){let f=h[u];f.onError&&f.onError(l)}this.manager.itemError(t)}).finally(()=>{this.manager.itemEnd(t)}),this.manager.itemStart(t)}setResponseType(t){return this.responseType=t,this}setMimeType(t){return this.mimeType=t,this}},Tu=class extends ze{constructor(t){super(t)}load(t,e,n,i){let s=this,a=new un(this.manager);a.setPath(this.path),a.setRequestHeader(this.requestHeader),a.setWithCredentials(this.withCredentials),a.load(t,function(o){try{e(s.parse(JSON.parse(o)))}catch(c){i?i(c):console.error(c),s.manager.itemError(t)}},n,i)}parse(t){let e=[];for(let n=0;n<t.length;n++){let i=us.parse(t[n]);e.push(i)}return e}},wu=class extends ze{constructor(t){super(t)}load(t,e,n,i){let s=this,a=[],o=new Vs,c=new un(this.manager);c.setPath(this.path),c.setResponseType("arraybuffer"),c.setRequestHeader(this.requestHeader),c.setWithCredentials(s.withCredentials);let l=0;function h(u){c.load(t[u],function(d){let f=s.parse(d,!0);a[u]={width:f.width,height:f.height,format:f.format,mipmaps:f.mipmaps},l+=1,l===6&&(f.mipmapCount===1&&(o.minFilter=me),o.image=a,o.format=f.format,o.needsUpdate=!0,e&&e(o))},n,i)}if(Array.isArray(t))for(let u=0,d=t.length;u<d;++u)h(u);else c.load(t,function(u){let d=s.parse(u,!0);if(d.isCubemap){let f=d.mipmaps.length/d.mipmapCount;for(let m=0;m<f;m++){a[m]={mipmaps:[]};for(let _=0;_<d.mipmapCount;_++)a[m].mipmaps.push(d.mipmaps[m*d.mipmapCount+_]),a[m].format=d.format,a[m].width=d.width,a[m].height=d.height}o.image=a}else o.image.width=d.width,o.image.height=d.height,o.mipmaps=d.mipmaps;d.mipmapCount===1&&(o.minFilter=me),o.format=d.format,o.needsUpdate=!0,e&&e(o)},n,i);return o}},ds=class extends ze{constructor(t){super(t)}load(t,e,n,i){this.path!==void 0&&(t=this.path+t),t=this.manager.resolveURL(t);let s=this,a=Bn.get(t);if(a!==void 0)return s.manager.itemStart(t),setTimeout(function(){e&&e(a),s.manager.itemEnd(t)},0),a;let o=Ds("img");function c(){h(),Bn.add(t,this),e&&e(this),s.manager.itemEnd(t)}function l(u){h(),i&&i(u),s.manager.itemError(t),s.manager.itemEnd(t)}function h(){o.removeEventListener("load",c,!1),o.removeEventListener("error",l,!1)}return o.addEventListener("load",c,!1),o.addEventListener("error",l,!1),t.slice(0,5)!=="data:"&&this.crossOrigin!==void 0&&(o.crossOrigin=this.crossOrigin),s.manager.itemStart(t),o.src=t,o}},Ru=class extends ze{constructor(t){super(t)}load(t,e,n,i){let s=new ss;s.colorSpace=Se;let a=new ds(this.manager);a.setCrossOrigin(this.crossOrigin),a.setPath(this.path);let o=0;function c(l){a.load(t[l],function(h){s.images[l]=h,o++,o===6&&(s.needsUpdate=!0,e&&e(s))},void 0,i)}for(let l=0;l<t.length;++l)c(l);return s}},Cu=class extends ze{constructor(t){super(t)}load(t,e,n,i){let s=this,a=new Hn,o=new un(this.manager);return o.setResponseType("arraybuffer"),o.setRequestHeader(this.requestHeader),o.setPath(this.path),o.setWithCredentials(s.withCredentials),o.load(t,function(c){let l;try{l=s.parse(c)}catch(h){if(i!==void 0)i(h);else{console.error(h);return}}l.image!==void 0?a.image=l.image:l.data!==void 0&&(a.image.width=l.width,a.image.height=l.height,a.image.data=l.data),a.wrapS=l.wrapS!==void 0?l.wrapS:Fe,a.wrapT=l.wrapT!==void 0?l.wrapT:Fe,a.magFilter=l.magFilter!==void 0?l.magFilter:me,a.minFilter=l.minFilter!==void 0?l.minFilter:me,a.anisotropy=l.anisotropy!==void 0?l.anisotropy:1,l.colorSpace!==void 0?a.colorSpace=l.colorSpace:l.encoding!==void 0&&(a.encoding=l.encoding),l.flipY!==void 0&&(a.flipY=l.flipY),l.format!==void 0&&(a.format=l.format),l.type!==void 0&&(a.type=l.type),l.mipmaps!==void 0&&(a.mipmaps=l.mipmaps,a.minFilter=gi),l.mipmapCount===1&&(a.minFilter=me),l.generateMipmaps!==void 0&&(a.generateMipmaps=l.generateMipmaps),a.needsUpdate=!0,e&&e(a,l)},n,i),a}},Pu=class extends ze{constructor(t){super(t)}load(t,e,n,i){let s=new Ee,a=new ds(this.manager);return a.setCrossOrigin(this.crossOrigin),a.setPath(this.path),a.load(t,function(o){s.image=o,s.needsUpdate=!0,e!==void 0&&e(s)},n,i),s}},wn=class extends Kt{constructor(t,e=1){super(),this.isLight=!0,this.type="Light",this.color=new pt(t),this.intensity=e}dispose(){}copy(t,e){return super.copy(t,e),this.color.copy(t.color),this.intensity=t.intensity,this}toJSON(t){let e=super.toJSON(t);return e.object.color=this.color.getHex(),e.object.intensity=this.intensity,this.groundColor!==void 0&&(e.object.groundColor=this.groundColor.getHex()),this.distance!==void 0&&(e.object.distance=this.distance),this.angle!==void 0&&(e.object.angle=this.angle),this.decay!==void 0&&(e.object.decay=this.decay),this.penumbra!==void 0&&(e.object.penumbra=this.penumbra),this.shadow!==void 0&&(e.object.shadow=this.shadow.toJSON()),e}},zc=class extends wn{constructor(t,e,n){super(t,n),this.isHemisphereLight=!0,this.type="HemisphereLight",this.position.copy(Kt.DEFAULT_UP),this.updateMatrix(),this.groundColor=new pt(e)}copy(t,e){return super.copy(t,e),this.groundColor.copy(t.groundColor),this}},bo=new It,Lu=new w,Iu=new w,qs=class{constructor(t){this.camera=t,this.bias=0,this.normalBias=0,this.radius=1,this.blurSamples=8,this.mapSize=new Z(512,512),this.map=null,this.mapPass=null,this.matrix=new It,this.autoUpdate=!0,this.needsUpdate=!1,this._frustum=new rs,this._frameExtents=new Z(1,1),this._viewportCount=1,this._viewports=[new te(0,0,1,1)]}getViewportCount(){return this._viewportCount}getFrustum(){return this._frustum}updateMatrices(t){let e=this.camera,n=this.matrix;Lu.setFromMatrixPosition(t.matrixWorld),e.position.copy(Lu),Iu.setFromMatrixPosition(t.target.matrixWorld),e.lookAt(Iu),e.updateMatrixWorld(),bo.multiplyMatrices(e.projectionMatrix,e.matrixWorldInverse),this._frustum.setFromProjectionMatrix(bo),n.set(.5,0,0,.5,0,.5,0,.5,0,0,.5,.5,0,0,0,1),n.multiply(bo)}getViewport(t){return this._viewports[t]}getFrameExtents(){return this._frameExtents}dispose(){this.map&&this.map.dispose(),this.mapPass&&this.mapPass.dispose()}copy(t){return this.camera=t.camera.clone(),this.bias=t.bias,this.radius=t.radius,this.mapSize.copy(t.mapSize),this}clone(){return new this.constructor().copy(this)}toJSON(){let t={};return this.bias!==0&&(t.bias=this.bias),this.normalBias!==0&&(t.normalBias=this.normalBias),this.radius!==1&&(t.radius=this.radius),(this.mapSize.x!==512||this.mapSize.y!==512)&&(t.mapSize=this.mapSize.toArray()),t.camera=this.camera.toJSON(!1).object,delete t.camera.matrix,t}},Vc=class extends qs{constructor(){super(new be(50,1,.5,500)),this.isSpotLightShadow=!0,this.focus=1}updateMatrices(t){let e=this.camera,n=es*2*t.angle*this.focus,i=this.mapSize.width/this.mapSize.height,s=t.distance||e.far;(n!==e.fov||i!==e.aspect||s!==e.far)&&(e.fov=n,e.aspect=i,e.far=s,e.updateProjectionMatrix()),super.updateMatrices(t)}copy(t){return super.copy(t),this.focus=t.focus,this}},kc=class extends wn{constructor(t,e,n=0,i=Math.PI/3,s=0,a=2){super(t,e),this.isSpotLight=!0,this.type="SpotLight",this.position.copy(Kt.DEFAULT_UP),this.updateMatrix(),this.target=new Kt,this.distance=n,this.angle=i,this.penumbra=s,this.decay=a,this.map=null,this.shadow=new Vc}get power(){return this.intensity*Math.PI}set power(t){this.intensity=t/Math.PI}dispose(){this.shadow.dispose()}copy(t,e){return super.copy(t,e),this.distance=t.distance,this.angle=t.angle,this.penumbra=t.penumbra,this.decay=t.decay,this.target=t.target.clone(),this.shadow=t.shadow.clone(),this}},Uu=new It,As=new w,Eo=new w,Hc=class extends qs{constructor(){super(new be(90,1,.5,500)),this.isPointLightShadow=!0,this._frameExtents=new Z(4,2),this._viewportCount=6,this._viewports=[new te(2,1,1,1),new te(0,1,1,1),new te(3,1,1,1),new te(1,1,1,1),new te(3,0,1,1),new te(1,0,1,1)],this._cubeDirections=[new w(1,0,0),new w(-1,0,0),new w(0,0,1),new w(0,0,-1),new w(0,1,0),new w(0,-1,0)],this._cubeUps=[new w(0,1,0),new w(0,1,0),new w(0,1,0),new w(0,1,0),new w(0,0,1),new w(0,0,-1)]}updateMatrices(t,e=0){let n=this.camera,i=this.matrix,s=t.distance||n.far;s!==n.far&&(n.far=s,n.updateProjectionMatrix()),As.setFromMatrixPosition(t.matrixWorld),n.position.copy(As),Eo.copy(n.position),Eo.add(this._cubeDirections[e]),n.up.copy(this._cubeUps[e]),n.lookAt(Eo),n.updateMatrixWorld(),i.makeTranslation(-As.x,-As.y,-As.z),Uu.multiplyMatrices(n.projectionMatrix,n.matrixWorldInverse),this._frustum.setFromProjectionMatrix(Uu)}},Gc=class extends wn{constructor(t,e,n=0,i=2){super(t,e),this.isPointLight=!0,this.type="PointLight",this.distance=n,this.decay=i,this.shadow=new Hc}get power(){return this.intensity*4*Math.PI}set power(t){this.intensity=t/(4*Math.PI)}dispose(){this.shadow.dispose()}copy(t,e){return super.copy(t,e),this.distance=t.distance,this.decay=t.decay,this.shadow=t.shadow.clone(),this}},Wc=class extends qs{constructor(){super(new Bs(-5,5,5,-5,.5,500)),this.isDirectionalLightShadow=!0}},Xc=class extends wn{constructor(t,e){super(t,e),this.isDirectionalLight=!0,this.type="DirectionalLight",this.position.copy(Kt.DEFAULT_UP),this.updateMatrix(),this.target=new Kt,this.shadow=new Wc}dispose(){this.shadow.dispose()}copy(t){return super.copy(t),this.target=t.target.clone(),this.shadow=t.shadow.clone(),this}},qc=class extends wn{constructor(t,e){super(t,e),this.isAmbientLight=!0,this.type="AmbientLight"}},Yc=class extends wn{constructor(t,e,n=10,i=10){super(t,e),this.isRectAreaLight=!0,this.type="RectAreaLight",this.width=n,this.height=i}get power(){return this.intensity*this.width*this.height*Math.PI}set power(t){this.intensity=t/(this.width*this.height*Math.PI)}copy(t){return super.copy(t),this.width=t.width,this.height=t.height,this}toJSON(t){let e=super.toJSON(t);return e.object.width=this.width,e.object.height=this.height,e}},Zc=class{constructor(){this.isSphericalHarmonics3=!0,this.coefficients=[];for(let t=0;t<9;t++)this.coefficients.push(new w)}set(t){for(let e=0;e<9;e++)this.coefficients[e].copy(t[e]);return this}zero(){for(let t=0;t<9;t++)this.coefficients[t].set(0,0,0);return this}getAt(t,e){let n=t.x,i=t.y,s=t.z,a=this.coefficients;return e.copy(a[0]).multiplyScalar(.282095),e.addScaledVector(a[1],.488603*i),e.addScaledVector(a[2],.488603*s),e.addScaledVector(a[3],.488603*n),e.addScaledVector(a[4],1.092548*(n*i)),e.addScaledVector(a[5],1.092548*(i*s)),e.addScaledVector(a[6],.315392*(3*s*s-1)),e.addScaledVector(a[7],1.092548*(n*s)),e.addScaledVector(a[8],.546274*(n*n-i*i)),e}getIrradianceAt(t,e){let n=t.x,i=t.y,s=t.z,a=this.coefficients;return e.copy(a[0]).multiplyScalar(.886227),e.addScaledVector(a[1],2*.511664*i),e.addScaledVector(a[2],2*.511664*s),e.addScaledVector(a[3],2*.511664*n),e.addScaledVector(a[4],2*.429043*n*i),e.addScaledVector(a[5],2*.429043*i*s),e.addScaledVector(a[6],.743125*s*s-.247708),e.addScaledVector(a[7],2*.429043*n*s),e.addScaledVector(a[8],.429043*(n*n-i*i)),e}add(t){for(let e=0;e<9;e++)this.coefficients[e].add(t.coefficients[e]);return this}addScaledSH(t,e){for(let n=0;n<9;n++)this.coefficients[n].addScaledVector(t.coefficients[n],e);return this}scale(t){for(let e=0;e<9;e++)this.coefficients[e].multiplyScalar(t);return this}lerp(t,e){for(let n=0;n<9;n++)this.coefficients[n].lerp(t.coefficients[n],e);return this}equals(t){for(let e=0;e<9;e++)if(!this.coefficients[e].equals(t.coefficients[e]))return!1;return!0}copy(t){return this.set(t.coefficients)}clone(){return new this.constructor().copy(this)}fromArray(t,e=0){let n=this.coefficients;for(let i=0;i<9;i++)n[i].fromArray(t,e+i*3);return this}toArray(t=[],e=0){let n=this.coefficients;for(let i=0;i<9;i++)n[i].toArray(t,e+i*3);return t}static getBasisAt(t,e){let n=t.x,i=t.y,s=t.z;e[0]=.282095,e[1]=.488603*i,e[2]=.488603*s,e[3]=.488603*n,e[4]=1.092548*n*i,e[5]=1.092548*i*s,e[6]=.315392*(3*s*s-1),e[7]=1.092548*n*s,e[8]=.546274*(n*n-i*i)}},Jc=class extends wn{constructor(t=new Zc,e=1){super(void 0,e),this.isLightProbe=!0,this.sh=t}copy(t){return super.copy(t),this.sh.copy(t.sh),this}fromJSON(t){return this.intensity=t.intensity,this.sh.fromArray(t.sh),this}toJSON(t){let e=super.toJSON(t);return e.object.sh=this.sh.toArray(),e}},$c=class r extends ze{constructor(t){super(t),this.textures={}}load(t,e,n,i){let s=this,a=new un(s.manager);a.setPath(s.path),a.setRequestHeader(s.requestHeader),a.setWithCredentials(s.withCredentials),a.load(t,function(o){try{e(s.parse(JSON.parse(o)))}catch(c){i?i(c):console.error(c),s.manager.itemError(t)}},n,i)}parse(t){let e=this.textures;function n(s){return e[s]===void 0&&console.warn("THREE.MaterialLoader: Undefined texture",s),e[s]}let i=r.createMaterialFromType(t.type);if(t.uuid!==void 0&&(i.uuid=t.uuid),t.name!==void 0&&(i.name=t.name),t.color!==void 0&&i.color!==void 0&&i.color.setHex(t.color),t.roughness!==void 0&&(i.roughness=t.roughness),t.metalness!==void 0&&(i.metalness=t.metalness),t.sheen!==void 0&&(i.sheen=t.sheen),t.sheenColor!==void 0&&(i.sheenColor=new pt().setHex(t.sheenColor)),t.sheenRoughness!==void 0&&(i.sheenRoughness=t.sheenRoughness),t.emissive!==void 0&&i.emissive!==void 0&&i.emissive.setHex(t.emissive),t.specular!==void 0&&i.specular!==void 0&&i.specular.setHex(t.specular),t.specularIntensity!==void 0&&(i.specularIntensity=t.specularIntensity),t.specularColor!==void 0&&i.specularColor!==void 0&&i.specularColor.setHex(t.specularColor),t.shininess!==void 0&&(i.shininess=t.shininess),t.clearcoat!==void 0&&(i.clearcoat=t.clearcoat),t.clearcoatRoughness!==void 0&&(i.clearcoatRoughness=t.clearcoatRoughness),t.iridescence!==void 0&&(i.iridescence=t.iridescence),t.iridescenceIOR!==void 0&&(i.iridescenceIOR=t.iridescenceIOR),t.iridescenceThicknessRange!==void 0&&(i.iridescenceThicknessRange=t.iridescenceThicknessRange),t.transmission!==void 0&&(i.transmission=t.transmission),t.thickness!==void 0&&(i.thickness=t.thickness),t.attenuationDistance!==void 0&&(i.attenuationDistance=t.attenuationDistance),t.attenuationColor!==void 0&&i.attenuationColor!==void 0&&i.attenuationColor.setHex(t.attenuationColor),t.anisotropy!==void 0&&(i.anisotropy=t.anisotropy),t.anisotropyRotation!==void 0&&(i.anisotropyRotation=t.anisotropyRotation),t.fog!==void 0&&(i.fog=t.fog),t.flatShading!==void 0&&(i.flatShading=t.flatShading),t.blending!==void 0&&(i.blending=t.blending),t.combine!==void 0&&(i.combine=t.combine),t.side!==void 0&&(i.side=t.side),t.shadowSide!==void 0&&(i.shadowSide=t.shadowSide),t.opacity!==void 0&&(i.opacity=t.opacity),t.transparent!==void 0&&(i.transparent=t.transparent),t.alphaTest!==void 0&&(i.alphaTest=t.alphaTest),t.alphaHash!==void 0&&(i.alphaHash=t.alphaHash),t.depthFunc!==void 0&&(i.depthFunc=t.depthFunc),t.depthTest!==void 0&&(i.depthTest=t.depthTest),t.depthWrite!==void 0&&(i.depthWrite=t.depthWrite),t.colorWrite!==void 0&&(i.colorWrite=t.colorWrite),t.blendSrc!==void 0&&(i.blendSrc=t.blendSrc),t.blendDst!==void 0&&(i.blendDst=t.blendDst),t.blendEquation!==void 0&&(i.blendEquation=t.blendEquation),t.blendSrcAlpha!==void 0&&(i.blendSrcAlpha=t.blendSrcAlpha),t.blendDstAlpha!==void 0&&(i.blendDstAlpha=t.blendDstAlpha),t.blendEquationAlpha!==void 0&&(i.blendEquationAlpha=t.blendEquationAlpha),t.blendColor!==void 0&&i.blendColor!==void 0&&i.blendColor.setHex(t.blendColor),t.blendAlpha!==void 0&&(i.blendAlpha=t.blendAlpha),t.stencilWriteMask!==void 0&&(i.stencilWriteMask=t.stencilWriteMask),t.stencilFunc!==void 0&&(i.stencilFunc=t.stencilFunc),t.stencilRef!==void 0&&(i.stencilRef=t.stencilRef),t.stencilFuncMask!==void 0&&(i.stencilFuncMask=t.stencilFuncMask),t.stencilFail!==void 0&&(i.stencilFail=t.stencilFail),t.stencilZFail!==void 0&&(i.stencilZFail=t.stencilZFail),t.stencilZPass!==void 0&&(i.stencilZPass=t.stencilZPass),t.stencilWrite!==void 0&&(i.stencilWrite=t.stencilWrite),t.wireframe!==void 0&&(i.wireframe=t.wireframe),t.wireframeLinewidth!==void 0&&(i.wireframeLinewidth=t.wireframeLinewidth),t.wireframeLinecap!==void 0&&(i.wireframeLinecap=t.wireframeLinecap),t.wireframeLinejoin!==void 0&&(i.wireframeLinejoin=t.wireframeLinejoin),t.rotation!==void 0&&(i.rotation=t.rotation),t.linewidth!==void 0&&(i.linewidth=t.linewidth),t.dashSize!==void 0&&(i.dashSize=t.dashSize),t.gapSize!==void 0&&(i.gapSize=t.gapSize),t.scale!==void 0&&(i.scale=t.scale),t.polygonOffset!==void 0&&(i.polygonOffset=t.polygonOffset),t.polygonOffsetFactor!==void 0&&(i.polygonOffsetFactor=t.polygonOffsetFactor),t.polygonOffsetUnits!==void 0&&(i.polygonOffsetUnits=t.polygonOffsetUnits),t.dithering!==void 0&&(i.dithering=t.dithering),t.alphaToCoverage!==void 0&&(i.alphaToCoverage=t.alphaToCoverage),t.premultipliedAlpha!==void 0&&(i.premultipliedAlpha=t.premultipliedAlpha),t.forceSinglePass!==void 0&&(i.forceSinglePass=t.forceSinglePass),t.visible!==void 0&&(i.visible=t.visible),t.toneMapped!==void 0&&(i.toneMapped=t.toneMapped),t.userData!==void 0&&(i.userData=t.userData),t.vertexColors!==void 0&&(typeof t.vertexColors=="number"?i.vertexColors=t.vertexColors>0:i.vertexColors=t.vertexColors),t.uniforms!==void 0)for(let s in t.uniforms){let a=t.uniforms[s];switch(i.uniforms[s]={},a.type){case"t":i.uniforms[s].value=n(a.value);break;case"c":i.uniforms[s].value=new pt().setHex(a.value);break;case"v2":i.uniforms[s].value=new Z().fromArray(a.value);break;case"v3":i.uniforms[s].value=new w().fromArray(a.value);break;case"v4":i.uniforms[s].value=new te().fromArray(a.value);break;case"m3":i.uniforms[s].value=new Gt().fromArray(a.value);break;case"m4":i.uniforms[s].value=new It().fromArray(a.value);break;default:i.uniforms[s].value=a.value}}if(t.defines!==void 0&&(i.defines=t.defines),t.vertexShader!==void 0&&(i.vertexShader=t.vertexShader),t.fragmentShader!==void 0&&(i.fragmentShader=t.fragmentShader),t.glslVersion!==void 0&&(i.glslVersion=t.glslVersion),t.extensions!==void 0)for(let s in t.extensions)i.extensions[s]=t.extensions[s];if(t.lights!==void 0&&(i.lights=t.lights),t.clipping!==void 0&&(i.clipping=t.clipping),t.size!==void 0&&(i.size=t.size),t.sizeAttenuation!==void 0&&(i.sizeAttenuation=t.sizeAttenuation),t.map!==void 0&&(i.map=n(t.map)),t.matcap!==void 0&&(i.matcap=n(t.matcap)),t.alphaMap!==void 0&&(i.alphaMap=n(t.alphaMap)),t.bumpMap!==void 0&&(i.bumpMap=n(t.bumpMap)),t.bumpScale!==void 0&&(i.bumpScale=t.bumpScale),t.normalMap!==void 0&&(i.normalMap=n(t.normalMap)),t.normalMapType!==void 0&&(i.normalMapType=t.normalMapType),t.normalScale!==void 0){let s=t.normalScale;Array.isArray(s)===!1&&(s=[s,s]),i.normalScale=new Z().fromArray(s)}return t.displacementMap!==void 0&&(i.displacementMap=n(t.displacementMap)),t.displacementScale!==void 0&&(i.displacementScale=t.displacementScale),t.displacementBias!==void 0&&(i.displacementBias=t.displacementBias),t.roughnessMap!==void 0&&(i.roughnessMap=n(t.roughnessMap)),t.metalnessMap!==void 0&&(i.metalnessMap=n(t.metalnessMap)),t.emissiveMap!==void 0&&(i.emissiveMap=n(t.emissiveMap)),t.emissiveIntensity!==void 0&&(i.emissiveIntensity=t.emissiveIntensity),t.specularMap!==void 0&&(i.specularMap=n(t.specularMap)),t.specularIntensityMap!==void 0&&(i.specularIntensityMap=n(t.specularIntensityMap)),t.specularColorMap!==void 0&&(i.specularColorMap=n(t.specularColorMap)),t.envMap!==void 0&&(i.envMap=n(t.envMap)),t.envMapIntensity!==void 0&&(i.envMapIntensity=t.envMapIntensity),t.reflectivity!==void 0&&(i.reflectivity=t.reflectivity),t.refractionRatio!==void 0&&(i.refractionRatio=t.refractionRatio),t.lightMap!==void 0&&(i.lightMap=n(t.lightMap)),t.lightMapIntensity!==void 0&&(i.lightMapIntensity=t.lightMapIntensity),t.aoMap!==void 0&&(i.aoMap=n(t.aoMap)),t.aoMapIntensity!==void 0&&(i.aoMapIntensity=t.aoMapIntensity),t.gradientMap!==void 0&&(i.gradientMap=n(t.gradientMap)),t.clearcoatMap!==void 0&&(i.clearcoatMap=n(t.clearcoatMap)),t.clearcoatRoughnessMap!==void 0&&(i.clearcoatRoughnessMap=n(t.clearcoatRoughnessMap)),t.clearcoatNormalMap!==void 0&&(i.clearcoatNormalMap=n(t.clearcoatNormalMap)),t.clearcoatNormalScale!==void 0&&(i.clearcoatNormalScale=new Z().fromArray(t.clearcoatNormalScale)),t.iridescenceMap!==void 0&&(i.iridescenceMap=n(t.iridescenceMap)),t.iridescenceThicknessMap!==void 0&&(i.iridescenceThicknessMap=n(t.iridescenceThicknessMap)),t.transmissionMap!==void 0&&(i.transmissionMap=n(t.transmissionMap)),t.thicknessMap!==void 0&&(i.thicknessMap=n(t.thicknessMap)),t.anisotropyMap!==void 0&&(i.anisotropyMap=n(t.anisotropyMap)),t.sheenColorMap!==void 0&&(i.sheenColorMap=n(t.sheenColorMap)),t.sheenRoughnessMap!==void 0&&(i.sheenRoughnessMap=n(t.sheenRoughnessMap)),i}setTextures(t){return this.textures=t,this}static createMaterialFromType(t){let e={ShadowMaterial:Ac,SpriteMaterial:da,RawShaderMaterial:Tc,ShaderMaterial:sn,PointsMaterial:pa,MeshPhysicalMaterial:wc,MeshStandardMaterial:Ea,MeshPhongMaterial:Rc,MeshToonMaterial:Cc,MeshNormalMaterial:Pc,MeshLambertMaterial:Lc,MeshDepthMaterial:ha,MeshDistanceMaterial:ua,MeshBasicMaterial:An,MeshMatcapMaterial:Ic,LineDashedMaterial:Uc,LineBasicMaterial:Ie,Material:Te};return new e[t]}},Ra=class{static decodeText(t){if(typeof TextDecoder<"u")return new TextDecoder().decode(t);let e="";for(let n=0,i=t.length;n<i;n++)e+=String.fromCharCode(t[n]);try{return decodeURIComponent(escape(e))}catch{return e}}static extractUrlBase(t){let e=t.lastIndexOf("/");return e===-1?"./":t.slice(0,e+1)}static resolveURL(t,e){return typeof t!="string"||t===""?"":(/^https?:\/\//i.test(e)&&/^\//.test(t)&&(e=e.replace(/(^https?:\/\/[^\/]+).*/i,"$1")),/^(https?:)?\/\//i.test(t)||/^data:.*,.*$/i.test(t)||/^blob:.*$/i.test(t)?t:e+t)}},Kc=class extends Wt{constructor(){super(),this.isInstancedBufferGeometry=!0,this.type="InstancedBufferGeometry",this.instanceCount=1/0}copy(t){return super.copy(t),this.instanceCount=t.instanceCount,this}toJSON(){let t=super.toJSON();return t.instanceCount=this.instanceCount,t.isInstancedBufferGeometry=!0,t}},Qc=class extends ze{constructor(t){super(t)}load(t,e,n,i){let s=this,a=new un(s.manager);a.setPath(s.path),a.setRequestHeader(s.requestHeader),a.setWithCredentials(s.withCredentials),a.load(t,function(o){try{e(s.parse(JSON.parse(o)))}catch(c){i?i(c):console.error(c),s.manager.itemError(t)}},n,i)}parse(t){let e={},n={};function i(f,m){if(e[m]!==void 0)return e[m];let g=f.interleavedBuffers[m],p=s(f,g.buffer),v=Yi(g.type,p),x=new zs(v,g.stride);return x.uuid=g.uuid,e[m]=x,x}function s(f,m){if(n[m]!==void 0)return n[m];let g=f.arrayBuffers[m],p=new Uint32Array(g).buffer;return n[m]=p,p}let a=t.isInstancedBufferGeometry?new Kc:new Wt,o=t.data.index;if(o!==void 0){let f=Yi(o.type,o.array);a.setIndex(new Jt(f,1))}let c=t.data.attributes;for(let f in c){let m=c[f],_;if(m.isInterleavedBufferAttribute){let g=i(t.data,m.data);_=new as(g,m.itemSize,m.offset,m.normalized)}else{let g=Yi(m.type,m.array),p=m.isInstancedBufferAttribute?xi:Jt;_=new p(g,m.itemSize,m.normalized)}m.name!==void 0&&(_.name=m.name),m.usage!==void 0&&_.setUsage(m.usage),a.setAttribute(f,_)}let l=t.data.morphAttributes;if(l)for(let f in l){let m=l[f],_=[];for(let g=0,p=m.length;g<p;g++){let v=m[g],x;if(v.isInterleavedBufferAttribute){let y=i(t.data,v.data);x=new as(y,v.itemSize,v.offset,v.normalized)}else{let y=Yi(v.type,v.array);x=new Jt(y,v.itemSize,v.normalized)}v.name!==void 0&&(x.name=v.name),_.push(x)}a.morphAttributes[f]=_}t.data.morphTargetsRelative&&(a.morphTargetsRelative=!0);let u=t.data.groups||t.data.drawcalls||t.data.offsets;if(u!==void 0)for(let f=0,m=u.length;f!==m;++f){let _=u[f];a.addGroup(_.start,_.count,_.materialIndex)}let d=t.data.boundingSphere;if(d!==void 0){let f=new w;d.center!==void 0&&f.fromArray(d.center),a.boundingSphere=new Ae(f,d.radius)}return t.name&&(a.name=t.name),t.userData&&(a.userData=t.userData),a}},Du=class extends ze{constructor(t){super(t)}load(t,e,n,i){let s=this,a=this.path===""?Ra.extractUrlBase(t):this.path;this.resourcePath=this.resourcePath||a;let o=new un(this.manager);o.setPath(this.path),o.setRequestHeader(this.requestHeader),o.setWithCredentials(this.withCredentials),o.load(t,function(c){let l=null;try{l=JSON.parse(c)}catch(u){i!==void 0&&i(u),console.error("THREE:ObjectLoader: Can't parse "+t+".",u.message);return}let h=l.metadata;if(h===void 0||h.type===void 0||h.type.toLowerCase()==="geometry"){i!==void 0&&i(new Error("THREE.ObjectLoader: Can't load "+t)),console.error("THREE.ObjectLoader: Can't load "+t);return}s.parse(l,e)},n,i)}async loadAsync(t,e){let n=this,i=this.path===""?Ra.extractUrlBase(t):this.path;this.resourcePath=this.resourcePath||i;let s=new un(this.manager);s.setPath(this.path),s.setRequestHeader(this.requestHeader),s.setWithCredentials(this.withCredentials);let a=await s.loadAsync(t,e),o=JSON.parse(a),c=o.metadata;if(c===void 0||c.type===void 0||c.type.toLowerCase()==="geometry")throw new Error("THREE.ObjectLoader: Can't load "+t);return await n.parseAsync(o)}parse(t,e){let n=this.parseAnimations(t.animations),i=this.parseShapes(t.shapes),s=this.parseGeometries(t.geometries,i),a=this.parseImages(t.images,function(){e!==void 0&&e(l)}),o=this.parseTextures(t.textures,a),c=this.parseMaterials(t.materials,o),l=this.parseObject(t.object,s,c,o,n),h=this.parseSkeletons(t.skeletons,l);if(this.bindSkeletons(l,h),e!==void 0){let u=!1;for(let d in a)if(a[d].data instanceof HTMLImageElement){u=!0;break}u===!1&&e(l)}return l}async parseAsync(t){let e=this.parseAnimations(t.animations),n=this.parseShapes(t.shapes),i=this.parseGeometries(t.geometries,n),s=await this.parseImagesAsync(t.images),a=this.parseTextures(t.textures,s),o=this.parseMaterials(t.materials,a),c=this.parseObject(t.object,i,o,a,e),l=this.parseSkeletons(t.skeletons,c);return this.bindSkeletons(c,l),c}parseShapes(t){let e={};if(t!==void 0)for(let n=0,i=t.length;n<i;n++){let s=new Gn().fromJSON(t[n]);e[s.uuid]=s}return e}parseSkeletons(t,e){let n={},i={};if(e.traverse(function(s){s.isBone&&(i[s.uuid]=s)}),t!==void 0)for(let s=0,a=t.length;s<a;s++){let o=new Ko().fromJSON(t[s],i);n[o.uuid]=o}return n}parseGeometries(t,e){let n={};if(t!==void 0){let i=new Qc;for(let s=0,a=t.length;s<a;s++){let o,c=t[s];switch(c.type){case"BufferGeometry":case"InstancedBufferGeometry":o=i.parse(c);break;default:c.type in Au?o=Au[c.type].fromJSON(c,e):console.warn(`THREE.ObjectLoader: Unsupported geometry type "${c.type}"`)}o.uuid=c.uuid,c.name!==void 0&&(o.name=c.name),c.userData!==void 0&&(o.userData=c.userData),n[c.uuid]=o}}return n}parseMaterials(t,e){let n={},i={};if(t!==void 0){let s=new $c;s.setTextures(e);for(let a=0,o=t.length;a<o;a++){let c=t[a];n[c.uuid]===void 0&&(n[c.uuid]=s.parse(c)),i[c.uuid]=n[c.uuid]}}return i}parseAnimations(t){let e={};if(t!==void 0)for(let n=0;n<t.length;n++){let i=t[n],s=us.parse(i);e[s.uuid]=s}return e}parseImages(t,e){let n=this,i={},s;function a(c){return n.manager.itemStart(c),s.load(c,function(){n.manager.itemEnd(c)},void 0,function(){n.manager.itemError(c),n.manager.itemEnd(c)})}function o(c){if(typeof c=="string"){let l=c,h=/^(\/\/)|([a-z]+:(\/\/)?)/i.test(l)?l:n.resourcePath+l;return a(h)}else return c.data?{data:Yi(c.type,c.data),width:c.width,height:c.height}:null}if(t!==void 0&&t.length>0){let c=new wa(e);s=new ds(c),s.setCrossOrigin(this.crossOrigin);for(let l=0,h=t.length;l<h;l++){let u=t[l],d=u.url;if(Array.isArray(d)){let f=[];for(let m=0,_=d.length;m<_;m++){let g=d[m],p=o(g);p!==null&&(p instanceof HTMLImageElement?f.push(p):f.push(new Hn(p.data,p.width,p.height)))}i[u.uuid]=new On(f)}else{let f=o(u.url);i[u.uuid]=new On(f)}}}return i}async parseImagesAsync(t){let e=this,n={},i;async function s(a){if(typeof a=="string"){let o=a,c=/^(\/\/)|([a-z]+:(\/\/)?)/i.test(o)?o:e.resourcePath+o;return await i.loadAsync(c)}else return a.data?{data:Yi(a.type,a.data),width:a.width,height:a.height}:null}if(t!==void 0&&t.length>0){i=new ds(this.manager),i.setCrossOrigin(this.crossOrigin);for(let a=0,o=t.length;a<o;a++){let c=t[a],l=c.url;if(Array.isArray(l)){let h=[];for(let u=0,d=l.length;u<d;u++){let f=l[u],m=await s(f);m!==null&&(m instanceof HTMLImageElement?h.push(m):h.push(new Hn(m.data,m.width,m.height)))}n[c.uuid]=new On(h)}else{let h=await s(c.url);n[c.uuid]=new On(h)}}}return n}parseTextures(t,e){function n(s,a){return typeof s=="number"?s:(console.warn("THREE.ObjectLoader.parseTexture: Constant should be in numeric form.",s),a[s])}let i={};if(t!==void 0)for(let s=0,a=t.length;s<a;s++){let o=t[s];o.image===void 0&&console.warn('THREE.ObjectLoader: No "image" specified for',o.uuid),e[o.image]===void 0&&console.warn("THREE.ObjectLoader: Undefined image",o.image);let c=e[o.image],l=c.data,h;Array.isArray(l)?(h=new ss,l.length===6&&(h.needsUpdate=!0)):(l&&l.data?h=new Hn:h=new Ee,l&&(h.needsUpdate=!0)),h.source=c,h.uuid=o.uuid,o.name!==void 0&&(h.name=o.name),o.mapping!==void 0&&(h.mapping=n(o.mapping,iv)),o.channel!==void 0&&(h.channel=o.channel),o.offset!==void 0&&h.offset.fromArray(o.offset),o.repeat!==void 0&&h.repeat.fromArray(o.repeat),o.center!==void 0&&h.center.fromArray(o.center),o.rotation!==void 0&&(h.rotation=o.rotation),o.wrap!==void 0&&(h.wrapS=n(o.wrap[0],Nu),h.wrapT=n(o.wrap[1],Nu)),o.format!==void 0&&(h.format=o.format),o.internalFormat!==void 0&&(h.internalFormat=o.internalFormat),o.type!==void 0&&(h.type=o.type),o.colorSpace!==void 0&&(h.colorSpace=o.colorSpace),o.encoding!==void 0&&(h.encoding=o.encoding),o.minFilter!==void 0&&(h.minFilter=n(o.minFilter,Ou)),o.magFilter!==void 0&&(h.magFilter=n(o.magFilter,Ou)),o.anisotropy!==void 0&&(h.anisotropy=o.anisotropy),o.flipY!==void 0&&(h.flipY=o.flipY),o.generateMipmaps!==void 0&&(h.generateMipmaps=o.generateMipmaps),o.premultiplyAlpha!==void 0&&(h.premultiplyAlpha=o.premultiplyAlpha),o.unpackAlignment!==void 0&&(h.unpackAlignment=o.unpackAlignment),o.compareFunction!==void 0&&(h.compareFunction=o.compareFunction),o.userData!==void 0&&(h.userData=o.userData),i[o.uuid]=h}return i}parseObject(t,e,n,i,s){let a;function o(d){return e[d]===void 0&&console.warn("THREE.ObjectLoader: Undefined geometry",d),e[d]}function c(d){if(d!==void 0){if(Array.isArray(d)){let f=[];for(let m=0,_=d.length;m<_;m++){let g=d[m];n[g]===void 0&&console.warn("THREE.ObjectLoader: Undefined material",g),f.push(n[g])}return f}return n[d]===void 0&&console.warn("THREE.ObjectLoader: Undefined material",d),n[d]}}function l(d){return i[d]===void 0&&console.warn("THREE.ObjectLoader: Undefined texture",d),i[d]}let h,u;switch(t.type){case"Scene":a=new Yo,t.background!==void 0&&(Number.isInteger(t.background)?a.background=new pt(t.background):a.background=l(t.background)),t.environment!==void 0&&(a.environment=l(t.environment)),t.fog!==void 0&&(t.fog.type==="Fog"?a.fog=new qo(t.fog.color,t.fog.near,t.fog.far):t.fog.type==="FogExp2"&&(a.fog=new Xo(t.fog.color,t.fog.density)),t.fog.name!==""&&(a.fog.name=t.fog.name)),t.backgroundBlurriness!==void 0&&(a.backgroundBlurriness=t.backgroundBlurriness),t.backgroundIntensity!==void 0&&(a.backgroundIntensity=t.backgroundIntensity);break;case"PerspectiveCamera":a=new be(t.fov,t.aspect,t.near,t.far),t.focus!==void 0&&(a.focus=t.focus),t.zoom!==void 0&&(a.zoom=t.zoom),t.filmGauge!==void 0&&(a.filmGauge=t.filmGauge),t.filmOffset!==void 0&&(a.filmOffset=t.filmOffset),t.view!==void 0&&(a.view=Object.assign({},t.view));break;case"OrthographicCamera":a=new Bs(t.left,t.right,t.top,t.bottom,t.near,t.far),t.zoom!==void 0&&(a.zoom=t.zoom),t.view!==void 0&&(a.view=Object.assign({},t.view));break;case"AmbientLight":a=new qc(t.color,t.intensity);break;case"DirectionalLight":a=new Xc(t.color,t.intensity);break;case"PointLight":a=new Gc(t.color,t.intensity,t.distance,t.decay);break;case"RectAreaLight":a=new Yc(t.color,t.intensity,t.width,t.height);break;case"SpotLight":a=new kc(t.color,t.intensity,t.distance,t.angle,t.penumbra,t.decay);break;case"HemisphereLight":a=new zc(t.color,t.groundColor,t.intensity);break;case"LightProbe":a=new Jc().fromJSON(t);break;case"SkinnedMesh":h=o(t.geometry),u=c(t.material),a=new $o(h,u),t.bindMode!==void 0&&(a.bindMode=t.bindMode),t.bindMatrix!==void 0&&a.bindMatrix.fromArray(t.bindMatrix),t.skeleton!==void 0&&(a.skeleton=t.skeleton);break;case"Mesh":h=o(t.geometry),u=c(t.material),a=new ge(h,u);break;case"InstancedMesh":h=o(t.geometry),u=c(t.material);let d=t.count,f=t.instanceMatrix,m=t.instanceColor;a=new Qo(h,u,d),a.instanceMatrix=new xi(new Float32Array(f.array),16),m!==void 0&&(a.instanceColor=new xi(new Float32Array(m.array),m.itemSize));break;case"BatchedMesh":h=o(t.geometry),u=c(t.material),a=new tc(t.maxGeometryCount,t.maxVertexCount,t.maxIndexCount,u),a.geometry=h,a.perObjectFrustumCulled=t.perObjectFrustumCulled,a.sortObjects=t.sortObjects,a._drawRanges=t.drawRanges,a._reservedRanges=t.reservedRanges,a._visibility=t.visibility,a._active=t.active,a._bounds=t.bounds.map(_=>{let g=new Le;g.min.fromArray(_.boxMin),g.max.fromArray(_.boxMax);let p=new Ae;return p.radius=_.sphereRadius,p.center.fromArray(_.sphereCenter),{boxInitialized:_.boxInitialized,box:g,sphereInitialized:_.sphereInitialized,sphere:p}}),a._maxGeometryCount=t.maxGeometryCount,a._maxVertexCount=t.maxVertexCount,a._maxIndexCount=t.maxIndexCount,a._geometryInitialized=t.geometryInitialized,a._geometryCount=t.geometryCount,a._matricesTexture=l(t.matricesTexture.uuid);break;case"LOD":a=new Jo;break;case"Line":a=new Tn(o(t.geometry),c(t.material));break;case"LineLoop":a=new ec(o(t.geometry),c(t.material));break;case"LineSegments":a=new rn(o(t.geometry),c(t.material));break;case"PointCloud":case"Points":a=new ic(o(t.geometry),c(t.material));break;case"Sprite":a=new Zo(c(t.material));break;case"Group":a=new li;break;case"Bone":a=new fa;break;default:a=new Kt}if(a.uuid=t.uuid,t.name!==void 0&&(a.name=t.name),t.matrix!==void 0?(a.matrix.fromArray(t.matrix),t.matrixAutoUpdate!==void 0&&(a.matrixAutoUpdate=t.matrixAutoUpdate),a.matrixAutoUpdate&&a.matrix.decompose(a.position,a.quaternion,a.scale)):(t.position!==void 0&&a.position.fromArray(t.position),t.rotation!==void 0&&a.rotation.fromArray(t.rotation),t.quaternion!==void 0&&a.quaternion.fromArray(t.quaternion),t.scale!==void 0&&a.scale.fromArray(t.scale)),t.up!==void 0&&a.up.fromArray(t.up),t.castShadow!==void 0&&(a.castShadow=t.castShadow),t.receiveShadow!==void 0&&(a.receiveShadow=t.receiveShadow),t.shadow&&(t.shadow.bias!==void 0&&(a.shadow.bias=t.shadow.bias),t.shadow.normalBias!==void 0&&(a.shadow.normalBias=t.shadow.normalBias),t.shadow.radius!==void 0&&(a.shadow.radius=t.shadow.radius),t.shadow.mapSize!==void 0&&a.shadow.mapSize.fromArray(t.shadow.mapSize),t.shadow.camera!==void 0&&(a.shadow.camera=this.parseObject(t.shadow.camera))),t.visible!==void 0&&(a.visible=t.visible),t.frustumCulled!==void 0&&(a.frustumCulled=t.frustumCulled),t.renderOrder!==void 0&&(a.renderOrder=t.renderOrder),t.userData!==void 0&&(a.userData=t.userData),t.layers!==void 0&&(a.layers.mask=t.layers),t.children!==void 0){let d=t.children;for(let f=0;f<d.length;f++)a.add(this.parseObject(d[f],e,n,i,s))}if(t.animations!==void 0){let d=t.animations;for(let f=0;f<d.length;f++){let m=d[f];a.animations.push(s[m])}}if(t.type==="LOD"){t.autoUpdate!==void 0&&(a.autoUpdate=t.autoUpdate);let d=t.levels;for(let f=0;f<d.length;f++){let m=d[f],_=a.getObjectByProperty("uuid",m.object);_!==void 0&&a.addLevel(_,m.distance,m.hysteresis)}}return a}bindSkeletons(t,e){Object.keys(e).length!==0&&t.traverse(function(n){if(n.isSkinnedMesh===!0&&n.skeleton!==void 0){let i=e[n.skeleton];i===void 0?console.warn("THREE.ObjectLoader: No skeleton found with UUID:",n.skeleton):n.bind(i,n.bindMatrix)}})}},iv={UVMapping:rl,CubeReflectionMapping:Xn,CubeRefractionMapping:mi,EquirectangularReflectionMapping:Wr,EquirectangularRefractionMapping:Xr,CubeUVReflectionMapping:Ys},Nu={RepeatWrapping:qr,ClampToEdgeWrapping:Fe,MirroredRepeatWrapping:Yr},Ou={NearestFilter:pe,NearestMipmapNearestFilter:Co,NearestMipmapLinearFilter:Hr,LinearFilter:me,LinearMipmapNearestFilter:Cd,LinearMipmapLinearFilter:gi},Fu=class extends ze{constructor(t){super(t),this.isImageBitmapLoader=!0,typeof createImageBitmap>"u"&&console.warn("THREE.ImageBitmapLoader: createImageBitmap() not supported."),typeof fetch>"u"&&console.warn("THREE.ImageBitmapLoader: fetch() not supported."),this.options={premultiplyAlpha:"none"}}setOptions(t){return this.options=t,this}load(t,e,n,i){t===void 0&&(t=""),this.path!==void 0&&(t=this.path+t),t=this.manager.resolveURL(t);let s=this,a=Bn.get(t);if(a!==void 0){if(s.manager.itemStart(t),a.then){a.then(l=>{e&&e(l),s.manager.itemEnd(t)}).catch(l=>{i&&i(l)});return}return setTimeout(function(){e&&e(a),s.manager.itemEnd(t)},0),a}let o={};o.credentials=this.crossOrigin==="anonymous"?"same-origin":"include",o.headers=this.requestHeader;let c=fetch(t,o).then(function(l){return l.blob()}).then(function(l){return createImageBitmap(l,Object.assign(s.options,{colorSpaceConversion:"none"}))}).then(function(l){return Bn.add(t,l),e&&e(l),s.manager.itemEnd(t),l}).catch(function(l){i&&i(l),Bn.remove(t),s.manager.itemError(t),s.manager.itemEnd(t)});Bn.add(t,c),s.manager.itemStart(t)}},Nr,Ca=class{static getContext(){return Nr===void 0&&(Nr=new(window.AudioContext||window.webkitAudioContext)),Nr}static setContext(t){Nr=t}},Bu=class extends ze{constructor(t){super(t)}load(t,e,n,i){let s=this,a=new un(this.manager);a.setResponseType("arraybuffer"),a.setPath(this.path),a.setRequestHeader(this.requestHeader),a.setWithCredentials(this.withCredentials),a.load(t,function(c){try{let l=c.slice(0);Ca.getContext().decodeAudioData(l,function(u){e(u)}).catch(o)}catch(l){o(l)}},n,i);function o(c){i?i(c):console.error(c),s.manager.itemError(t)}}},zu=new It,Vu=new It,ei=new It,ku=class{constructor(){this.type="StereoCamera",this.aspect=1,this.eyeSep=.064,this.cameraL=new be,this.cameraL.layers.enable(1),this.cameraL.matrixAutoUpdate=!1,this.cameraR=new be,this.cameraR.layers.enable(2),this.cameraR.matrixAutoUpdate=!1,this._cache={focus:null,fov:null,aspect:null,near:null,far:null,zoom:null,eyeSep:null}}update(t){let e=this._cache;if(e.focus!==t.focus||e.fov!==t.fov||e.aspect!==t.aspect*this.aspect||e.near!==t.near||e.far!==t.far||e.zoom!==t.zoom||e.eyeSep!==this.eyeSep){e.focus=t.focus,e.fov=t.fov,e.aspect=t.aspect*this.aspect,e.near=t.near,e.far=t.far,e.zoom=t.zoom,e.eyeSep=this.eyeSep,ei.copy(t.projectionMatrix);let i=e.eyeSep/2,s=i*e.near/e.focus,a=e.near*Math.tan(pi*e.fov*.5)/e.zoom,o,c;Vu.elements[12]=-i,zu.elements[12]=i,o=-a*e.aspect+s,c=a*e.aspect+s,ei.elements[0]=2*e.near/(c-o),ei.elements[8]=(c+o)/(c-o),this.cameraL.projectionMatrix.copy(ei),o=-a*e.aspect-s,c=a*e.aspect-s,ei.elements[0]=2*e.near/(c-o),ei.elements[8]=(c+o)/(c-o),this.cameraR.projectionMatrix.copy(ei)}this.cameraL.matrixWorld.copy(t.matrixWorld).multiply(Vu),this.cameraR.matrixWorld.copy(t.matrixWorld).multiply(zu)}},jc=class{constructor(t=!0){this.autoStart=t,this.startTime=0,this.oldTime=0,this.elapsedTime=0,this.running=!1}start(){this.startTime=Hu(),this.oldTime=this.startTime,this.elapsedTime=0,this.running=!0}stop(){this.getElapsedTime(),this.running=!1,this.autoStart=!1}getElapsedTime(){return this.getDelta(),this.elapsedTime}getDelta(){let t=0;if(this.autoStart&&!this.running)return this.start(),0;if(this.running){let e=Hu();t=(e-this.oldTime)/1e3,this.oldTime=e,this.elapsedTime+=t}return t}};function Hu(){return(typeof performance>"u"?Date:performance).now()}var ni=new w,Gu=new Be,sv=new w,ii=new w,Wu=class extends Kt{constructor(){super(),this.type="AudioListener",this.context=Ca.getContext(),this.gain=this.context.createGain(),this.gain.connect(this.context.destination),this.filter=null,this.timeDelta=0,this._clock=new jc}getInput(){return this.gain}removeFilter(){return this.filter!==null&&(this.gain.disconnect(this.filter),this.filter.disconnect(this.context.destination),this.gain.connect(this.context.destination),this.filter=null),this}getFilter(){return this.filter}setFilter(t){return this.filter!==null?(this.gain.disconnect(this.filter),this.filter.disconnect(this.context.destination)):this.gain.disconnect(this.context.destination),this.filter=t,this.gain.connect(this.filter),this.filter.connect(this.context.destination),this}getMasterVolume(){return this.gain.gain.value}setMasterVolume(t){return this.gain.gain.setTargetAtTime(t,this.context.currentTime,.01),this}updateMatrixWorld(t){super.updateMatrixWorld(t);let e=this.context.listener,n=this.up;if(this.timeDelta=this._clock.getDelta(),this.matrixWorld.decompose(ni,Gu,sv),ii.set(0,0,-1).applyQuaternion(Gu),e.positionX){let i=this.context.currentTime+this.timeDelta;e.positionX.linearRampToValueAtTime(ni.x,i),e.positionY.linearRampToValueAtTime(ni.y,i),e.positionZ.linearRampToValueAtTime(ni.z,i),e.forwardX.linearRampToValueAtTime(ii.x,i),e.forwardY.linearRampToValueAtTime(ii.y,i),e.forwardZ.linearRampToValueAtTime(ii.z,i),e.upX.linearRampToValueAtTime(n.x,i),e.upY.linearRampToValueAtTime(n.y,i),e.upZ.linearRampToValueAtTime(n.z,i)}else e.setPosition(ni.x,ni.y,ni.z),e.setOrientation(ii.x,ii.y,ii.z,n.x,n.y,n.z)}},tl=class extends Kt{constructor(t){super(),this.type="Audio",this.listener=t,this.context=t.context,this.gain=this.context.createGain(),this.gain.connect(t.getInput()),this.autoplay=!1,this.buffer=null,this.detune=0,this.loop=!1,this.loopStart=0,this.loopEnd=0,this.offset=0,this.duration=void 0,this.playbackRate=1,this.isPlaying=!1,this.hasPlaybackControl=!0,this.source=null,this.sourceType="empty",this._startedAt=0,this._progress=0,this._connected=!1,this.filters=[]}getOutput(){return this.gain}setNodeSource(t){return this.hasPlaybackControl=!1,this.sourceType="audioNode",this.source=t,this.connect(),this}setMediaElementSource(t){return this.hasPlaybackControl=!1,this.sourceType="mediaNode",this.source=this.context.createMediaElementSource(t),this.connect(),this}setMediaStreamSource(t){return this.hasPlaybackControl=!1,this.sourceType="mediaStreamNode",this.source=this.context.createMediaStreamSource(t),this.connect(),this}setBuffer(t){return this.buffer=t,this.sourceType="buffer",this.autoplay&&this.play(),this}play(t=0){if(this.isPlaying===!0){console.warn("THREE.Audio: Audio is already playing.");return}if(this.hasPlaybackControl===!1){console.warn("THREE.Audio: this Audio has no playback control.");return}this._startedAt=this.context.currentTime+t;let e=this.context.createBufferSource();return e.buffer=this.buffer,e.loop=this.loop,e.loopStart=this.loopStart,e.loopEnd=this.loopEnd,e.onended=this.onEnded.bind(this),e.start(this._startedAt,this._progress+this.offset,this.duration),this.isPlaying=!0,this.source=e,this.setDetune(this.detune),this.setPlaybackRate(this.playbackRate),this.connect()}pause(){if(this.hasPlaybackControl===!1){console.warn("THREE.Audio: this Audio has no playback control.");return}return this.isPlaying===!0&&(this._progress+=Math.max(this.context.currentTime-this._startedAt,0)*this.playbackRate,this.loop===!0&&(this._progress=this._progress%(this.duration||this.buffer.duration)),this.source.stop(),this.source.onended=null,this.isPlaying=!1),this}stop(){if(this.hasPlaybackControl===!1){console.warn("THREE.Audio: this Audio has no playback control.");return}return this._progress=0,this.source!==null&&(this.source.stop(),this.source.onended=null),this.isPlaying=!1,this}connect(){if(this.filters.length>0){this.source.connect(this.filters[0]);for(let t=1,e=this.filters.length;t<e;t++)this.filters[t-1].connect(this.filters[t]);this.filters[this.filters.length-1].connect(this.getOutput())}else this.source.connect(this.getOutput());return this._connected=!0,this}disconnect(){if(this._connected!==!1){if(this.filters.length>0){this.source.disconnect(this.filters[0]);for(let t=1,e=this.filters.length;t<e;t++)this.filters[t-1].disconnect(this.filters[t]);this.filters[this.filters.length-1].disconnect(this.getOutput())}else this.source.disconnect(this.getOutput());return this._connected=!1,this}}getFilters(){return this.filters}setFilters(t){return t||(t=[]),this._connected===!0?(this.disconnect(),this.filters=t.slice(),this.connect()):this.filters=t.slice(),this}setDetune(t){if(this.detune=t,this.source.detune!==void 0)return this.isPlaying===!0&&this.source.detune.setTargetAtTime(this.detune,this.context.currentTime,.01),this}getDetune(){return this.detune}getFilter(){return this.getFilters()[0]}setFilter(t){return this.setFilters(t?[t]:[])}setPlaybackRate(t){if(this.hasPlaybackControl===!1){console.warn("THREE.Audio: this Audio has no playback control.");return}return this.playbackRate=t,this.isPlaying===!0&&this.source.playbackRate.setTargetAtTime(this.playbackRate,this.context.currentTime,.01),this}getPlaybackRate(){return this.playbackRate}onEnded(){this.isPlaying=!1}getLoop(){return this.hasPlaybackControl===!1?(console.warn("THREE.Audio: this Audio has no playback control."),!1):this.loop}setLoop(t){if(this.hasPlaybackControl===!1){console.warn("THREE.Audio: this Audio has no playback control.");return}return this.loop=t,this.isPlaying===!0&&(this.source.loop=this.loop),this}setLoopStart(t){return this.loopStart=t,this}setLoopEnd(t){return this.loopEnd=t,this}getVolume(){return this.gain.gain.value}setVolume(t){return this.gain.gain.setTargetAtTime(t,this.context.currentTime,.01),this}},si=new w,Xu=new Be,rv=new w,ri=new w,qu=class extends tl{constructor(t){super(t),this.panner=this.context.createPanner(),this.panner.panningModel="HRTF",this.panner.connect(this.gain)}connect(){super.connect(),this.panner.connect(this.gain)}disconnect(){super.disconnect(),this.panner.disconnect(this.gain)}getOutput(){return this.panner}getRefDistance(){return this.panner.refDistance}setRefDistance(t){return this.panner.refDistance=t,this}getRolloffFactor(){return this.panner.rolloffFactor}setRolloffFactor(t){return this.panner.rolloffFactor=t,this}getDistanceModel(){return this.panner.distanceModel}setDistanceModel(t){return this.panner.distanceModel=t,this}getMaxDistance(){return this.panner.maxDistance}setMaxDistance(t){return this.panner.maxDistance=t,this}setDirectionalCone(t,e,n){return this.panner.coneInnerAngle=t,this.panner.coneOuterAngle=e,this.panner.coneOuterGain=n,this}updateMatrixWorld(t){if(super.updateMatrixWorld(t),this.hasPlaybackControl===!0&&this.isPlaying===!1)return;this.matrixWorld.decompose(si,Xu,rv),ri.set(0,0,1).applyQuaternion(Xu);let e=this.panner;if(e.positionX){let n=this.context.currentTime+this.listener.timeDelta;e.positionX.linearRampToValueAtTime(si.x,n),e.positionY.linearRampToValueAtTime(si.y,n),e.positionZ.linearRampToValueAtTime(si.z,n),e.orientationX.linearRampToValueAtTime(ri.x,n),e.orientationY.linearRampToValueAtTime(ri.y,n),e.orientationZ.linearRampToValueAtTime(ri.z,n)}else e.setPosition(si.x,si.y,si.z),e.setOrientation(ri.x,ri.y,ri.z)}},Yu=class{constructor(t,e=2048){this.analyser=t.context.createAnalyser(),this.analyser.fftSize=e,this.data=new Uint8Array(this.analyser.frequencyBinCount),t.getOutput().connect(this.analyser)}getFrequencyData(){return this.analyser.getByteFrequencyData(this.data),this.data}getAverageFrequency(){let t=0,e=this.getFrequencyData();for(let n=0;n<e.length;n++)t+=e[n];return t/e.length}},el=class{constructor(t,e,n){this.binding=t,this.valueSize=n;let i,s,a;switch(e){case"quaternion":i=this._slerp,s=this._slerpAdditive,a=this._setAdditiveIdentityQuaternion,this.buffer=new Float64Array(n*6),this._workIndex=5;break;case"string":case"bool":i=this._select,s=this._select,a=this._setAdditiveIdentityOther,this.buffer=new Array(n*5);break;default:i=this._lerp,s=this._lerpAdditive,a=this._setAdditiveIdentityNumeric,this.buffer=new Float64Array(n*5)}this._mixBufferRegion=i,this._mixBufferRegionAdditive=s,this._setIdentity=a,this._origIndex=3,this._addIndex=4,this.cumulativeWeight=0,this.cumulativeWeightAdditive=0,this.useCount=0,this.referenceCount=0}accumulate(t,e){let n=this.buffer,i=this.valueSize,s=t*i+i,a=this.cumulativeWeight;if(a===0){for(let o=0;o!==i;++o)n[s+o]=n[o];a=e}else{a+=e;let o=e/a;this._mixBufferRegion(n,s,0,o,i)}this.cumulativeWeight=a}accumulateAdditive(t){let e=this.buffer,n=this.valueSize,i=n*this._addIndex;this.cumulativeWeightAdditive===0&&this._setIdentity(),this._mixBufferRegionAdditive(e,i,0,t,n),this.cumulativeWeightAdditive+=t}apply(t){let e=this.valueSize,n=this.buffer,i=t*e+e,s=this.cumulativeWeight,a=this.cumulativeWeightAdditive,o=this.binding;if(this.cumulativeWeight=0,this.cumulativeWeightAdditive=0,s<1){let c=e*this._origIndex;this._mixBufferRegion(n,i,c,1-s,e)}a>0&&this._mixBufferRegionAdditive(n,i,this._addIndex*e,1,e);for(let c=e,l=e+e;c!==l;++c)if(n[c]!==n[c+e]){o.setValue(n,i);break}}saveOriginalState(){let t=this.binding,e=this.buffer,n=this.valueSize,i=n*this._origIndex;t.getValue(e,i);for(let s=n,a=i;s!==a;++s)e[s]=e[i+s%n];this._setIdentity(),this.cumulativeWeight=0,this.cumulativeWeightAdditive=0}restoreOriginalState(){let t=this.valueSize*3;this.binding.setValue(this.buffer,t)}_setAdditiveIdentityNumeric(){let t=this._addIndex*this.valueSize,e=t+this.valueSize;for(let n=t;n<e;n++)this.buffer[n]=0}_setAdditiveIdentityQuaternion(){this._setAdditiveIdentityNumeric(),this.buffer[this._addIndex*this.valueSize+3]=1}_setAdditiveIdentityOther(){let t=this._origIndex*this.valueSize,e=this._addIndex*this.valueSize;for(let n=0;n<this.valueSize;n++)this.buffer[e+n]=this.buffer[t+n]}_select(t,e,n,i,s){if(i>=.5)for(let a=0;a!==s;++a)t[e+a]=t[n+a]}_slerp(t,e,n,i){Be.slerpFlat(t,e,t,e,t,n,i)}_slerpAdditive(t,e,n,i,s){let a=this._workIndex*s;Be.multiplyQuaternionsFlat(t,a,t,e,t,n),Be.slerpFlat(t,e,t,e,t,a,i)}_lerp(t,e,n,i,s){let a=1-i;for(let o=0;o!==s;++o){let c=e+o;t[c]=t[c]*a+t[n+o]*i}}_lerpAdditive(t,e,n,i,s){for(let a=0;a!==s;++a){let o=e+a;t[o]=t[o]+t[n+a]*i}}},fl="\\[\\]\\.:\\/",av=new RegExp("["+fl+"]","g"),pl="[^"+fl+"]",ov="[^"+fl.replace("\\.","")+"]",cv=/((?:WC+[\/:])*)/.source.replace("WC",pl),lv=/(WCOD+)?/.source.replace("WCOD",ov),hv=/(?:\.(WC+)(?:\[(.+)\])?)?/.source.replace("WC",pl),uv=/\.(WC+)(?:\[(.+)\])?/.source.replace("WC",pl),dv=new RegExp("^"+cv+lv+hv+uv+"$"),fv=["material","materials","bones","map"],nl=class{constructor(t,e,n){let i=n||Qt.parseTrackName(e);this._targetGroup=t,this._bindings=t.subscribe_(e,i)}getValue(t,e){this.bind();let n=this._targetGroup.nCachedObjects_,i=this._bindings[n];i!==void 0&&i.getValue(t,e)}setValue(t,e){let n=this._bindings;for(let i=this._targetGroup.nCachedObjects_,s=n.length;i!==s;++i)n[i].setValue(t,e)}bind(){let t=this._bindings;for(let e=this._targetGroup.nCachedObjects_,n=t.length;e!==n;++e)t[e].bind()}unbind(){let t=this._bindings;for(let e=this._targetGroup.nCachedObjects_,n=t.length;e!==n;++e)t[e].unbind()}},Qt=class r{constructor(t,e,n){this.path=e,this.parsedPath=n||r.parseTrackName(e),this.node=r.findNode(t,this.parsedPath.nodeName),this.rootNode=t,this.getValue=this._getValue_unbound,this.setValue=this._setValue_unbound}static create(t,e,n){return t&&t.isAnimationObjectGroup?new r.Composite(t,e,n):new r(t,e,n)}static sanitizeNodeName(t){return t.replace(/\s/g,"_").replace(av,"")}static parseTrackName(t){let e=dv.exec(t);if(e===null)throw new Error("PropertyBinding: Cannot parse trackName: "+t);let n={nodeName:e[2],objectName:e[3],objectIndex:e[4],propertyName:e[5],propertyIndex:e[6]},i=n.nodeName&&n.nodeName.lastIndexOf(".");if(i!==void 0&&i!==-1){let s=n.nodeName.substring(i+1);fv.indexOf(s)!==-1&&(n.nodeName=n.nodeName.substring(0,i),n.objectName=s)}if(n.propertyName===null||n.propertyName.length===0)throw new Error("PropertyBinding: can not parse propertyName from trackName: "+t);return n}static findNode(t,e){if(e===void 0||e===""||e==="."||e===-1||e===t.name||e===t.uuid)return t;if(t.skeleton){let n=t.skeleton.getBoneByName(e);if(n!==void 0)return n}if(t.children){let n=function(s){for(let a=0;a<s.length;a++){let o=s[a];if(o.name===e||o.uuid===e)return o;let c=n(o.children);if(c)return c}return null},i=n(t.children);if(i)return i}return null}_getValue_unavailable(){}_setValue_unavailable(){}_getValue_direct(t,e){t[e]=this.targetObject[this.propertyName]}_getValue_array(t,e){let n=this.resolvedProperty;for(let i=0,s=n.length;i!==s;++i)t[e++]=n[i]}_getValue_arrayElement(t,e){t[e]=this.resolvedProperty[this.propertyIndex]}_getValue_toArray(t,e){this.resolvedProperty.toArray(t,e)}_setValue_direct(t,e){this.targetObject[this.propertyName]=t[e]}_setValue_direct_setNeedsUpdate(t,e){this.targetObject[this.propertyName]=t[e],this.targetObject.needsUpdate=!0}_setValue_direct_setMatrixWorldNeedsUpdate(t,e){this.targetObject[this.propertyName]=t[e],this.targetObject.matrixWorldNeedsUpdate=!0}_setValue_array(t,e){let n=this.resolvedProperty;for(let i=0,s=n.length;i!==s;++i)n[i]=t[e++]}_setValue_array_setNeedsUpdate(t,e){let n=this.resolvedProperty;for(let i=0,s=n.length;i!==s;++i)n[i]=t[e++];this.targetObject.needsUpdate=!0}_setValue_array_setMatrixWorldNeedsUpdate(t,e){let n=this.resolvedProperty;for(let i=0,s=n.length;i!==s;++i)n[i]=t[e++];this.targetObject.matrixWorldNeedsUpdate=!0}_setValue_arrayElement(t,e){this.resolvedProperty[this.propertyIndex]=t[e]}_setValue_arrayElement_setNeedsUpdate(t,e){this.resolvedProperty[this.propertyIndex]=t[e],this.targetObject.needsUpdate=!0}_setValue_arrayElement_setMatrixWorldNeedsUpdate(t,e){this.resolvedProperty[this.propertyIndex]=t[e],this.targetObject.matrixWorldNeedsUpdate=!0}_setValue_fromArray(t,e){this.resolvedProperty.fromArray(t,e)}_setValue_fromArray_setNeedsUpdate(t,e){this.resolvedProperty.fromArray(t,e),this.targetObject.needsUpdate=!0}_setValue_fromArray_setMatrixWorldNeedsUpdate(t,e){this.resolvedProperty.fromArray(t,e),this.targetObject.matrixWorldNeedsUpdate=!0}_getValue_unbound(t,e){this.bind(),this.getValue(t,e)}_setValue_unbound(t,e){this.bind(),this.setValue(t,e)}bind(){let t=this.node,e=this.parsedPath,n=e.objectName,i=e.propertyName,s=e.propertyIndex;if(t||(t=r.findNode(this.rootNode,e.nodeName),this.node=t),this.getValue=this._getValue_unavailable,this.setValue=this._setValue_unavailable,!t){console.warn("THREE.PropertyBinding: No target node found for track: "+this.path+".");return}if(n){let l=e.objectIndex;switch(n){case"materials":if(!t.material){console.error("THREE.PropertyBinding: Can not bind to material as node does not have a material.",this);return}if(!t.material.materials){console.error("THREE.PropertyBinding: Can not bind to material.materials as node.material does not have a materials array.",this);return}t=t.material.materials;break;case"bones":if(!t.skeleton){console.error("THREE.PropertyBinding: Can not bind to bones as node does not have a skeleton.",this);return}t=t.skeleton.bones;for(let h=0;h<t.length;h++)if(t[h].name===l){l=h;break}break;case"map":if("map"in t){t=t.map;break}if(!t.material){console.error("THREE.PropertyBinding: Can not bind to material as node does not have a material.",this);return}if(!t.material.map){console.error("THREE.PropertyBinding: Can not bind to material.map as node.material does not have a map.",this);return}t=t.material.map;break;default:if(t[n]===void 0){console.error("THREE.PropertyBinding: Can not bind to objectName of node undefined.",this);return}t=t[n]}if(l!==void 0){if(t[l]===void 0){console.error("THREE.PropertyBinding: Trying to bind to objectIndex of objectName, but is undefined.",this,t);return}t=t[l]}}let a=t[i];if(a===void 0){let l=e.nodeName;console.error("THREE.PropertyBinding: Trying to update property for track: "+l+"."+i+" but it wasn't found.",t);return}let o=this.Versioning.None;this.targetObject=t,t.needsUpdate!==void 0?o=this.Versioning.NeedsUpdate:t.matrixWorldNeedsUpdate!==void 0&&(o=this.Versioning.MatrixWorldNeedsUpdate);let c=this.BindingType.Direct;if(s!==void 0){if(i==="morphTargetInfluences"){if(!t.geometry){console.error("THREE.PropertyBinding: Can not bind to morphTargetInfluences because node does not have a geometry.",this);return}if(!t.geometry.morphAttributes){console.error("THREE.PropertyBinding: Can not bind to morphTargetInfluences because node does not have a geometry.morphAttributes.",this);return}t.morphTargetDictionary[s]!==void 0&&(s=t.morphTargetDictionary[s])}c=this.BindingType.ArrayElement,this.resolvedProperty=a,this.propertyIndex=s}else a.fromArray!==void 0&&a.toArray!==void 0?(c=this.BindingType.HasFromToArray,this.resolvedProperty=a):Array.isArray(a)?(c=this.BindingType.EntireArray,this.resolvedProperty=a):this.propertyName=i;this.getValue=this.GetterByBindingType[c],this.setValue=this.SetterByBindingTypeAndVersioning[c][o]}unbind(){this.node=null,this.getValue=this._getValue_unbound,this.setValue=this._setValue_unbound}};Qt.Composite=nl;Qt.prototype.BindingType={Direct:0,EntireArray:1,ArrayElement:2,HasFromToArray:3};Qt.prototype.Versioning={None:0,NeedsUpdate:1,MatrixWorldNeedsUpdate:2};Qt.prototype.GetterByBindingType=[Qt.prototype._getValue_direct,Qt.prototype._getValue_array,Qt.prototype._getValue_arrayElement,Qt.prototype._getValue_toArray];Qt.prototype.SetterByBindingTypeAndVersioning=[[Qt.prototype._setValue_direct,Qt.prototype._setValue_direct_setNeedsUpdate,Qt.prototype._setValue_direct_setMatrixWorldNeedsUpdate],[Qt.prototype._setValue_array,Qt.prototype._setValue_array_setNeedsUpdate,Qt.prototype._setValue_array_setMatrixWorldNeedsUpdate],[Qt.prototype._setValue_arrayElement,Qt.prototype._setValue_arrayElement_setNeedsUpdate,Qt.prototype._setValue_arrayElement_setMatrixWorldNeedsUpdate],[Qt.prototype._setValue_fromArray,Qt.prototype._setValue_fromArray_setNeedsUpdate,Qt.prototype._setValue_fromArray_setMatrixWorldNeedsUpdate]];var Zu=class{constructor(){this.isAnimationObjectGroup=!0,this.uuid=Ye(),this._objects=Array.prototype.slice.call(arguments),this.nCachedObjects_=0;let t={};this._indicesByUUID=t;for(let n=0,i=arguments.length;n!==i;++n)t[arguments[n].uuid]=n;this._paths=[],this._parsedPaths=[],this._bindings=[],this._bindingsIndicesByPath={};let e=this;this.stats={objects:{get total(){return e._objects.length},get inUse(){return this.total-e.nCachedObjects_}},get bindingsPerObject(){return e._bindings.length}}}add(){let t=this._objects,e=this._indicesByUUID,n=this._paths,i=this._parsedPaths,s=this._bindings,a=s.length,o,c=t.length,l=this.nCachedObjects_;for(let h=0,u=arguments.length;h!==u;++h){let d=arguments[h],f=d.uuid,m=e[f];if(m===void 0){m=c++,e[f]=m,t.push(d);for(let _=0,g=a;_!==g;++_)s[_].push(new Qt(d,n[_],i[_]))}else if(m<l){o=t[m];let _=--l,g=t[_];e[g.uuid]=m,t[m]=g,e[f]=_,t[_]=d;for(let p=0,v=a;p!==v;++p){let x=s[p],y=x[_],C=x[m];x[m]=y,C===void 0&&(C=new Qt(d,n[p],i[p])),x[_]=C}}else t[m]!==o&&console.error("THREE.AnimationObjectGroup: Different objects with the same UUID detected. Clean the caches or recreate your infrastructure when reloading scenes.")}this.nCachedObjects_=l}remove(){let t=this._objects,e=this._indicesByUUID,n=this._bindings,i=n.length,s=this.nCachedObjects_;for(let a=0,o=arguments.length;a!==o;++a){let c=arguments[a],l=c.uuid,h=e[l];if(h!==void 0&&h>=s){let u=s++,d=t[u];e[d.uuid]=h,t[h]=d,e[l]=u,t[u]=c;for(let f=0,m=i;f!==m;++f){let _=n[f],g=_[u],p=_[h];_[h]=g,_[u]=p}}}this.nCachedObjects_=s}uncache(){let t=this._objects,e=this._indicesByUUID,n=this._bindings,i=n.length,s=this.nCachedObjects_,a=t.length;for(let o=0,c=arguments.length;o!==c;++o){let l=arguments[o],h=l.uuid,u=e[h];if(u!==void 0)if(delete e[h],u<s){let d=--s,f=t[d],m=--a,_=t[m];e[f.uuid]=u,t[u]=f,e[_.uuid]=d,t[d]=_,t.pop();for(let g=0,p=i;g!==p;++g){let v=n[g],x=v[d],y=v[m];v[u]=x,v[d]=y,v.pop()}}else{let d=--a,f=t[d];d>0&&(e[f.uuid]=u),t[u]=f,t.pop();for(let m=0,_=i;m!==_;++m){let g=n[m];g[u]=g[d],g.pop()}}}this.nCachedObjects_=s}subscribe_(t,e){let n=this._bindingsIndicesByPath,i=n[t],s=this._bindings;if(i!==void 0)return s[i];let a=this._paths,o=this._parsedPaths,c=this._objects,l=c.length,h=this.nCachedObjects_,u=new Array(l);i=s.length,n[t]=i,a.push(t),o.push(e),s.push(u);for(let d=h,f=c.length;d!==f;++d){let m=c[d];u[d]=new Qt(m,t,e)}return u}unsubscribe_(t){let e=this._bindingsIndicesByPath,n=e[t];if(n!==void 0){let i=this._paths,s=this._parsedPaths,a=this._bindings,o=a.length-1,c=a[o],l=t[o];e[l]=n,a[n]=c,a.pop(),s[n]=s[o],s.pop(),i[n]=i[o],i.pop()}}},il=class{constructor(t,e,n=null,i=e.blendMode){this._mixer=t,this._clip=e,this._localRoot=n,this.blendMode=i;let s=e.tracks,a=s.length,o=new Array(a),c={endingStart:Xi,endingEnd:Xi};for(let l=0;l!==a;++l){let h=s[l].createInterpolant(null);o[l]=h,h.settings=c}this._interpolantSettings=c,this._interpolants=o,this._propertyBindings=new Array(a),this._cacheIndex=null,this._byClipCacheIndex=null,this._timeScaleInterpolant=null,this._weightInterpolant=null,this.loop=Qf,this._loopCount=-1,this._startTime=null,this.time=0,this.timeScale=1,this._effectiveTimeScale=1,this.weight=1,this._effectiveWeight=1,this.repetitions=1/0,this.paused=!1,this.enabled=!0,this.clampWhenFinished=!1,this.zeroSlopeAtStart=!0,this.zeroSlopeAtEnd=!0}play(){return this._mixer._activateAction(this),this}stop(){return this._mixer._deactivateAction(this),this.reset()}reset(){return this.paused=!1,this.enabled=!0,this.time=0,this._loopCount=-1,this._startTime=null,this.stopFading().stopWarping()}isRunning(){return this.enabled&&!this.paused&&this.timeScale!==0&&this._startTime===null&&this._mixer._isActiveAction(this)}isScheduled(){return this._mixer._isActiveAction(this)}startAt(t){return this._startTime=t,this}setLoop(t,e){return this.loop=t,this.repetitions=e,this}setEffectiveWeight(t){return this.weight=t,this._effectiveWeight=this.enabled?t:0,this.stopFading()}getEffectiveWeight(){return this._effectiveWeight}fadeIn(t){return this._scheduleFading(t,0,1)}fadeOut(t){return this._scheduleFading(t,1,0)}crossFadeFrom(t,e,n){if(t.fadeOut(e),this.fadeIn(e),n){let i=this._clip.duration,s=t._clip.duration,a=s/i,o=i/s;t.warp(1,a,e),this.warp(o,1,e)}return this}crossFadeTo(t,e,n){return t.crossFadeFrom(this,e,n)}stopFading(){let t=this._weightInterpolant;return t!==null&&(this._weightInterpolant=null,this._mixer._takeBackControlInterpolant(t)),this}setEffectiveTimeScale(t){return this.timeScale=t,this._effectiveTimeScale=this.paused?0:t,this.stopWarping()}getEffectiveTimeScale(){return this._effectiveTimeScale}setDuration(t){return this.timeScale=this._clip.duration/t,this.stopWarping()}syncWith(t){return this.time=t.time,this.timeScale=t.timeScale,this.stopWarping()}halt(t){return this.warp(this._effectiveTimeScale,0,t)}warp(t,e,n){let i=this._mixer,s=i.time,a=this.timeScale,o=this._timeScaleInterpolant;o===null&&(o=i._lendControlInterpolant(),this._timeScaleInterpolant=o);let c=o.parameterPositions,l=o.sampleValues;return c[0]=s,c[1]=s+n,l[0]=t/a,l[1]=e/a,this}stopWarping(){let t=this._timeScaleInterpolant;return t!==null&&(this._timeScaleInterpolant=null,this._mixer._takeBackControlInterpolant(t)),this}getMixer(){return this._mixer}getClip(){return this._clip}getRoot(){return this._localRoot||this._mixer._root}_update(t,e,n,i){if(!this.enabled){this._updateWeight(t);return}let s=this._startTime;if(s!==null){let c=(t-s)*n;c<0||n===0?e=0:(this._startTime=null,e=n*c)}e*=this._updateTimeScale(t);let a=this._updateTime(e),o=this._updateWeight(t);if(o>0){let c=this._interpolants,l=this._propertyBindings;switch(this.blendMode){case Fd:for(let h=0,u=c.length;h!==u;++h)c[h].evaluate(a),l[h].accumulateAdditive(o);break;case ol:default:for(let h=0,u=c.length;h!==u;++h)c[h].evaluate(a),l[h].accumulate(i,o)}}}_updateWeight(t){let e=0;if(this.enabled){e=this.weight;let n=this._weightInterpolant;if(n!==null){let i=n.evaluate(t)[0];e*=i,t>n.parameterPositions[1]&&(this.stopFading(),i===0&&(this.enabled=!1))}}return this._effectiveWeight=e,e}_updateTimeScale(t){let e=0;if(!this.paused){e=this.timeScale;let n=this._timeScaleInterpolant;if(n!==null){let i=n.evaluate(t)[0];e*=i,t>n.parameterPositions[1]&&(this.stopWarping(),e===0?this.paused=!0:this.timeScale=e)}}return this._effectiveTimeScale=e,e}_updateTime(t){let e=this._clip.duration,n=this.loop,i=this.time+t,s=this._loopCount,a=n===jf;if(t===0)return s===-1?i:a&&(s&1)===1?e-i:i;if(n===Kf){s===-1&&(this._loopCount=0,this._setEndings(!0,!0,!1));t:{if(i>=e)i=e;else if(i<0)i=0;else{this.time=i;break t}this.clampWhenFinished?this.paused=!0:this.enabled=!1,this.time=i,this._mixer.dispatchEvent({type:"finished",action:this,direction:t<0?-1:1})}}else{if(s===-1&&(t>=0?(s=0,this._setEndings(!0,this.repetitions===0,a)):this._setEndings(this.repetitions===0,!0,a)),i>=e||i<0){let o=Math.floor(i/e);i-=e*o,s+=Math.abs(o);let c=this.repetitions-s;if(c<=0)this.clampWhenFinished?this.paused=!0:this.enabled=!1,i=t>0?e:0,this.time=i,this._mixer.dispatchEvent({type:"finished",action:this,direction:t>0?1:-1});else{if(c===1){let l=t<0;this._setEndings(l,!l,a)}else this._setEndings(!1,!1,a);this._loopCount=s,this.time=i,this._mixer.dispatchEvent({type:"loop",action:this,loopDelta:o})}}else this.time=i;if(a&&(s&1)===1)return e-i}return i}_setEndings(t,e,n){let i=this._interpolantSettings;n?(i.endingStart=qi,i.endingEnd=qi):(t?i.endingStart=this.zeroSlopeAtStart?qi:Xi:i.endingStart=$r,e?i.endingEnd=this.zeroSlopeAtEnd?qi:Xi:i.endingEnd=$r)}_scheduleFading(t,e,n){let i=this._mixer,s=i.time,a=this._weightInterpolant;a===null&&(a=i._lendControlInterpolant(),this._weightInterpolant=a);let o=a.parameterPositions,c=a.sampleValues;return o[0]=s,c[0]=e,o[1]=s+t,c[1]=n,this}},pv=new Float32Array(1),Ju=class extends hn{constructor(t){super(),this._root=t,this._initMemoryManager(),this._accuIndex=0,this.time=0,this.timeScale=1}_bindAction(t,e){let n=t._localRoot||this._root,i=t._clip.tracks,s=i.length,a=t._propertyBindings,o=t._interpolants,c=n.uuid,l=this._bindingsByRootAndName,h=l[c];h===void 0&&(h={},l[c]=h);for(let u=0;u!==s;++u){let d=i[u],f=d.name,m=h[f];if(m!==void 0)++m.referenceCount,a[u]=m;else{if(m=a[u],m!==void 0){m._cacheIndex===null&&(++m.referenceCount,this._addInactiveBinding(m,c,f));continue}let _=e&&e._propertyBindings[u].binding.parsedPath;m=new el(Qt.create(n,f,_),d.ValueTypeName,d.getValueSize()),++m.referenceCount,this._addInactiveBinding(m,c,f),a[u]=m}o[u].resultBuffer=m.buffer}}_activateAction(t){if(!this._isActiveAction(t)){if(t._cacheIndex===null){let n=(t._localRoot||this._root).uuid,i=t._clip.uuid,s=this._actionsByClip[i];this._bindAction(t,s&&s.knownActions[0]),this._addInactiveAction(t,i,n)}let e=t._propertyBindings;for(let n=0,i=e.length;n!==i;++n){let s=e[n];s.useCount++===0&&(this._lendBinding(s),s.saveOriginalState())}this._lendAction(t)}}_deactivateAction(t){if(this._isActiveAction(t)){let e=t._propertyBindings;for(let n=0,i=e.length;n!==i;++n){let s=e[n];--s.useCount===0&&(s.restoreOriginalState(),this._takeBackBinding(s))}this._takeBackAction(t)}}_initMemoryManager(){this._actions=[],this._nActiveActions=0,this._actionsByClip={},this._bindings=[],this._nActiveBindings=0,this._bindingsByRootAndName={},this._controlInterpolants=[],this._nActiveControlInterpolants=0;let t=this;this.stats={actions:{get total(){return t._actions.length},get inUse(){return t._nActiveActions}},bindings:{get total(){return t._bindings.length},get inUse(){return t._nActiveBindings}},controlInterpolants:{get total(){return t._controlInterpolants.length},get inUse(){return t._nActiveControlInterpolants}}}}_isActiveAction(t){let e=t._cacheIndex;return e!==null&&e<this._nActiveActions}_addInactiveAction(t,e,n){let i=this._actions,s=this._actionsByClip,a=s[e];if(a===void 0)a={knownActions:[t],actionByRoot:{}},t._byClipCacheIndex=0,s[e]=a;else{let o=a.knownActions;t._byClipCacheIndex=o.length,o.push(t)}t._cacheIndex=i.length,i.push(t),a.actionByRoot[n]=t}_removeInactiveAction(t){let e=this._actions,n=e[e.length-1],i=t._cacheIndex;n._cacheIndex=i,e[i]=n,e.pop(),t._cacheIndex=null;let s=t._clip.uuid,a=this._actionsByClip,o=a[s],c=o.knownActions,l=c[c.length-1],h=t._byClipCacheIndex;l._byClipCacheIndex=h,c[h]=l,c.pop(),t._byClipCacheIndex=null;let u=o.actionByRoot,d=(t._localRoot||this._root).uuid;delete u[d],c.length===0&&delete a[s],this._removeInactiveBindingsForAction(t)}_removeInactiveBindingsForAction(t){let e=t._propertyBindings;for(let n=0,i=e.length;n!==i;++n){let s=e[n];--s.referenceCount===0&&this._removeInactiveBinding(s)}}_lendAction(t){let e=this._actions,n=t._cacheIndex,i=this._nActiveActions++,s=e[i];t._cacheIndex=i,e[i]=t,s._cacheIndex=n,e[n]=s}_takeBackAction(t){let e=this._actions,n=t._cacheIndex,i=--this._nActiveActions,s=e[i];t._cacheIndex=i,e[i]=t,s._cacheIndex=n,e[n]=s}_addInactiveBinding(t,e,n){let i=this._bindingsByRootAndName,s=this._bindings,a=i[e];a===void 0&&(a={},i[e]=a),a[n]=t,t._cacheIndex=s.length,s.push(t)}_removeInactiveBinding(t){let e=this._bindings,n=t.binding,i=n.rootNode.uuid,s=n.path,a=this._bindingsByRootAndName,o=a[i],c=e[e.length-1],l=t._cacheIndex;c._cacheIndex=l,e[l]=c,e.pop(),delete o[s],Object.keys(o).length===0&&delete a[i]}_lendBinding(t){let e=this._bindings,n=t._cacheIndex,i=this._nActiveBindings++,s=e[i];t._cacheIndex=i,e[i]=t,s._cacheIndex=n,e[n]=s}_takeBackBinding(t){let e=this._bindings,n=t._cacheIndex,i=--this._nActiveBindings,s=e[i];t._cacheIndex=i,e[i]=t,s._cacheIndex=n,e[n]=s}_lendControlInterpolant(){let t=this._controlInterpolants,e=this._nActiveControlInterpolants++,n=t[e];return n===void 0&&(n=new Aa(new Float32Array(2),new Float32Array(2),1,pv),n.__cacheIndex=e,t[e]=n),n}_takeBackControlInterpolant(t){let e=this._controlInterpolants,n=t.__cacheIndex,i=--this._nActiveControlInterpolants,s=e[i];t.__cacheIndex=i,e[i]=t,s.__cacheIndex=n,e[n]=s}clipAction(t,e,n){let i=e||this._root,s=i.uuid,a=typeof t=="string"?us.findByName(i,t):t,o=a!==null?a.uuid:t,c=this._actionsByClip[o],l=null;if(n===void 0&&(a!==null?n=a.blendMode:n=ol),c!==void 0){let u=c.actionByRoot[s];if(u!==void 0&&u.blendMode===n)return u;l=c.knownActions[0],a===null&&(a=l._clip)}if(a===null)return null;let h=new il(this,a,e,n);return this._bindAction(h,l),this._addInactiveAction(h,o,s),h}existingAction(t,e){let n=e||this._root,i=n.uuid,s=typeof t=="string"?us.findByName(n,t):t,a=s?s.uuid:t,o=this._actionsByClip[a];return o!==void 0&&o.actionByRoot[i]||null}stopAllAction(){let t=this._actions,e=this._nActiveActions;for(let n=e-1;n>=0;--n)t[n].stop();return this}update(t){t*=this.timeScale;let e=this._actions,n=this._nActiveActions,i=this.time+=t,s=Math.sign(t),a=this._accuIndex^=1;for(let l=0;l!==n;++l)e[l]._update(i,t,s,a);let o=this._bindings,c=this._nActiveBindings;for(let l=0;l!==c;++l)o[l].apply(a);return this}setTime(t){this.time=0;for(let e=0;e<this._actions.length;e++)this._actions[e].time=0;return this.update(t)}getRoot(){return this._root}uncacheClip(t){let e=this._actions,n=t.uuid,i=this._actionsByClip,s=i[n];if(s!==void 0){let a=s.knownActions;for(let o=0,c=a.length;o!==c;++o){let l=a[o];this._deactivateAction(l);let h=l._cacheIndex,u=e[e.length-1];l._cacheIndex=null,l._byClipCacheIndex=null,u._cacheIndex=h,e[h]=u,e.pop(),this._removeInactiveBindingsForAction(l)}delete i[n]}}uncacheRoot(t){let e=t.uuid,n=this._actionsByClip;for(let a in n){let o=n[a].actionByRoot,c=o[e];c!==void 0&&(this._deactivateAction(c),this._removeInactiveAction(c))}let i=this._bindingsByRootAndName,s=i[e];if(s!==void 0)for(let a in s){let o=s[a];o.restoreOriginalState(),this._removeInactiveBinding(o)}}uncacheAction(t,e){let n=this.existingAction(t,e);n!==null&&(this._deactivateAction(n),this._removeInactiveAction(n))}},$u=class r{constructor(t){this.value=t}clone(){return new r(this.value.clone===void 0?this.value:this.value.clone())}},mv=0,Ku=class extends hn{constructor(){super(),this.isUniformsGroup=!0,Object.defineProperty(this,"id",{value:mv++}),this.name="",this.usage=ta,this.uniforms=[]}add(t){return this.uniforms.push(t),this}remove(t){let e=this.uniforms.indexOf(t);return e!==-1&&this.uniforms.splice(e,1),this}setName(t){return this.name=t,this}setUsage(t){return this.usage=t,this}dispose(){return this.dispatchEvent({type:"dispose"}),this}copy(t){this.name=t.name,this.usage=t.usage;let e=t.uniforms;this.uniforms.length=0;for(let n=0,i=e.length;n<i;n++){let s=Array.isArray(e[n])?e[n]:[e[n]];for(let a=0;a<s.length;a++)this.uniforms.push(s[a].clone())}return this}clone(){return new this.constructor().copy(this)}},Qu=class extends zs{constructor(t,e,n=1){super(t,e),this.isInstancedInterleavedBuffer=!0,this.meshPerAttribute=n}copy(t){return super.copy(t),this.meshPerAttribute=t.meshPerAttribute,this}clone(t){let e=super.clone(t);return e.meshPerAttribute=this.meshPerAttribute,e}toJSON(t){let e=super.toJSON(t);return e.isInstancedInterleavedBuffer=!0,e.meshPerAttribute=this.meshPerAttribute,e}},ju=class{constructor(t,e,n,i,s){this.isGLBufferAttribute=!0,this.name="",this.buffer=t,this.type=e,this.itemSize=n,this.elementSize=i,this.count=s,this.version=0}set needsUpdate(t){t===!0&&this.version++}setBuffer(t){return this.buffer=t,this}setType(t,e){return this.type=t,this.elementSize=e,this}setItemSize(t){return this.itemSize=t,this}setCount(t){return this.count=t,this}},td=class{constructor(t,e,n=0,i=1/0){this.ray=new _i(t,e),this.near=n,this.far=i,this.camera=null,this.layers=new Os,this.params={Mesh:{},Line:{threshold:1},LOD:{},Points:{threshold:1},Sprite:{}}}set(t,e){this.ray.set(t,e)}setFromCamera(t,e){e.isPerspectiveCamera?(this.ray.origin.setFromMatrixPosition(e.matrixWorld),this.ray.direction.set(t.x,t.y,.5).unproject(e).sub(this.ray.origin).normalize(),this.camera=e):e.isOrthographicCamera?(this.ray.origin.set(t.x,t.y,(e.near+e.far)/(e.near-e.far)).unproject(e),this.ray.direction.set(0,0,-1).transformDirection(e.matrixWorld),this.camera=e):console.error("THREE.Raycaster: Unsupported camera type: "+e.type)}intersectObject(t,e=!0,n=[]){return sl(t,this,n,e),n.sort(ed),n}intersectObjects(t,e=!0,n=[]){for(let i=0,s=t.length;i<s;i++)sl(t[i],this,n,e);return n.sort(ed),n}};function ed(r,t){return r.distance-t.distance}function sl(r,t,e,n){if(r.layers.test(t.layers)&&r.raycast(t,e),n===!0){let i=r.children;for(let s=0,a=i.length;s<a;s++)sl(i[s],t,e,!0)}}var nd=class{constructor(t=1,e=0,n=0){return this.radius=t,this.phi=e,this.theta=n,this}set(t,e,n){return this.radius=t,this.phi=e,this.theta=n,this}copy(t){return this.radius=t.radius,this.phi=t.phi,this.theta=t.theta,this}makeSafe(){return this.phi=Math.max(1e-6,Math.min(Math.PI-1e-6,this.phi)),this}setFromVector3(t){return this.setFromCartesianCoords(t.x,t.y,t.z)}setFromCartesianCoords(t,e,n){return this.radius=Math.sqrt(t*t+e*e+n*n),this.radius===0?(this.theta=0,this.phi=0):(this.theta=Math.atan2(t,n),this.phi=Math.acos(he(e/this.radius,-1,1))),this}clone(){return new this.constructor().copy(this)}},id=class{constructor(t=1,e=0,n=0){return this.radius=t,this.theta=e,this.y=n,this}set(t,e,n){return this.radius=t,this.theta=e,this.y=n,this}copy(t){return this.radius=t.radius,this.theta=t.theta,this.y=t.y,this}setFromVector3(t){return this.setFromCartesianCoords(t.x,t.y,t.z)}setFromCartesianCoords(t,e,n){return this.radius=Math.sqrt(t*t+n*n),this.theta=Math.atan2(t,n),this.y=e,this}clone(){return new this.constructor().copy(this)}},sd=new Z,rd=class{constructor(t=new Z(1/0,1/0),e=new Z(-1/0,-1/0)){this.isBox2=!0,this.min=t,this.max=e}set(t,e){return this.min.copy(t),this.max.copy(e),this}setFromPoints(t){this.makeEmpty();for(let e=0,n=t.length;e<n;e++)this.expandByPoint(t[e]);return this}setFromCenterAndSize(t,e){let n=sd.copy(e).multiplyScalar(.5);return this.min.copy(t).sub(n),this.max.copy(t).add(n),this}clone(){return new this.constructor().copy(this)}copy(t){return this.min.copy(t.min),this.max.copy(t.max),this}makeEmpty(){return this.min.x=this.min.y=1/0,this.max.x=this.max.y=-1/0,this}isEmpty(){return this.max.x<this.min.x||this.max.y<this.min.y}getCenter(t){return this.isEmpty()?t.set(0,0):t.addVectors(this.min,this.max).multiplyScalar(.5)}getSize(t){return this.isEmpty()?t.set(0,0):t.subVectors(this.max,this.min)}expandByPoint(t){return this.min.min(t),this.max.max(t),this}expandByVector(t){return this.min.sub(t),this.max.add(t),this}expandByScalar(t){return this.min.addScalar(-t),this.max.addScalar(t),this}containsPoint(t){return!(t.x<this.min.x||t.x>this.max.x||t.y<this.min.y||t.y>this.max.y)}containsBox(t){return this.min.x<=t.min.x&&t.max.x<=this.max.x&&this.min.y<=t.min.y&&t.max.y<=this.max.y}getParameter(t,e){return e.set((t.x-this.min.x)/(this.max.x-this.min.x),(t.y-this.min.y)/(this.max.y-this.min.y))}intersectsBox(t){return!(t.max.x<this.min.x||t.min.x>this.max.x||t.max.y<this.min.y||t.min.y>this.max.y)}clampPoint(t,e){return e.copy(t).clamp(this.min,this.max)}distanceToPoint(t){return this.clampPoint(t,sd).distanceTo(t)}intersect(t){return this.min.max(t.min),this.max.min(t.max),this.isEmpty()&&this.makeEmpty(),this}union(t){return this.min.min(t.min),this.max.max(t.max),this}translate(t){return this.min.add(t),this.max.add(t),this}equals(t){return t.min.equals(this.min)&&t.max.equals(this.max)}},ad=new w,Or=new w,od=class{constructor(t=new w,e=new w){this.start=t,this.end=e}set(t,e){return this.start.copy(t),this.end.copy(e),this}copy(t){return this.start.copy(t.start),this.end.copy(t.end),this}getCenter(t){return t.addVectors(this.start,this.end).multiplyScalar(.5)}delta(t){return t.subVectors(this.end,this.start)}distanceSq(){return this.start.distanceToSquared(this.end)}distance(){return this.start.distanceTo(this.end)}at(t,e){return this.delta(e).multiplyScalar(t).add(this.start)}closestPointToPointParameter(t,e){ad.subVectors(t,this.start),Or.subVectors(this.end,this.start);let n=Or.dot(Or),s=Or.dot(ad)/n;return e&&(s=he(s,0,1)),s}closestPointToPoint(t,e,n){let i=this.closestPointToPointParameter(t,e);return this.delta(n).multiplyScalar(i).add(this.start)}applyMatrix4(t){return this.start.applyMatrix4(t),this.end.applyMatrix4(t),this}equals(t){return t.start.equals(this.start)&&t.end.equals(this.end)}clone(){return new this.constructor().copy(this)}},cd=new w,ld=class extends Kt{constructor(t,e){super(),this.light=t,this.matrix=t.matrixWorld,this.matrixAutoUpdate=!1,this.color=e,this.type="SpotLightHelper";let n=new Wt,i=[0,0,0,0,0,1,0,0,0,1,0,1,0,0,0,-1,0,1,0,0,0,0,1,1,0,0,0,0,-1,1];for(let a=0,o=1,c=32;a<c;a++,o++){let l=a/c*Math.PI*2,h=o/c*Math.PI*2;i.push(Math.cos(l),Math.sin(l),1,Math.cos(h),Math.sin(h),1)}n.setAttribute("position",new xt(i,3));let s=new Ie({fog:!1,toneMapped:!1});this.cone=new rn(n,s),this.add(this.cone),this.update()}dispose(){this.cone.geometry.dispose(),this.cone.material.dispose()}update(){this.light.updateWorldMatrix(!0,!1),this.light.target.updateWorldMatrix(!0,!1);let t=this.light.distance?this.light.distance:1e3,e=t*Math.tan(this.light.angle);this.cone.scale.set(e,e,t),cd.setFromMatrixPosition(this.light.target.matrixWorld),this.cone.lookAt(cd),this.color!==void 0?this.cone.material.color.set(this.color):this.cone.material.color.copy(this.light.color)}},Dn=new w,Fr=new It,Ao=new It,hd=class extends rn{constructor(t){let e=ef(t),n=new Wt,i=[],s=[],a=new pt(0,0,1),o=new pt(0,1,0);for(let l=0;l<e.length;l++){let h=e[l];h.parent&&h.parent.isBone&&(i.push(0,0,0),i.push(0,0,0),s.push(a.r,a.g,a.b),s.push(o.r,o.g,o.b))}n.setAttribute("position",new xt(i,3)),n.setAttribute("color",new xt(s,3));let c=new Ie({vertexColors:!0,depthTest:!1,depthWrite:!1,toneMapped:!1,transparent:!0});super(n,c),this.isSkeletonHelper=!0,this.type="SkeletonHelper",this.root=t,this.bones=e,this.matrix=t.matrixWorld,this.matrixAutoUpdate=!1}updateMatrixWorld(t){let e=this.bones,n=this.geometry,i=n.getAttribute("position");Ao.copy(this.root.matrixWorld).invert();for(let s=0,a=0;s<e.length;s++){let o=e[s];o.parent&&o.parent.isBone&&(Fr.multiplyMatrices(Ao,o.matrixWorld),Dn.setFromMatrixPosition(Fr),i.setXYZ(a,Dn.x,Dn.y,Dn.z),Fr.multiplyMatrices(Ao,o.parent.matrixWorld),Dn.setFromMatrixPosition(Fr),i.setXYZ(a+1,Dn.x,Dn.y,Dn.z),a+=2)}n.getAttribute("position").needsUpdate=!0,super.updateMatrixWorld(t)}dispose(){this.geometry.dispose(),this.material.dispose()}};function ef(r){let t=[];r.isBone===!0&&t.push(r);for(let e=0;e<r.children.length;e++)t.push.apply(t,ef(r.children[e]));return t}var ud=class extends ge{constructor(t,e,n){let i=new ba(e,4,2),s=new An({wireframe:!0,fog:!1,toneMapped:!1});super(i,s),this.light=t,this.color=n,this.type="PointLightHelper",this.matrix=this.light.matrixWorld,this.matrixAutoUpdate=!1,this.update()}dispose(){this.geometry.dispose(),this.material.dispose()}update(){this.light.updateWorldMatrix(!0,!1),this.color!==void 0?this.material.color.set(this.color):this.material.color.copy(this.light.color)}},gv=new w,dd=new pt,fd=new pt,pd=class extends Kt{constructor(t,e,n){super(),this.light=t,this.matrix=t.matrixWorld,this.matrixAutoUpdate=!1,this.color=n,this.type="HemisphereLightHelper";let i=new Sa(e);i.rotateY(Math.PI*.5),this.material=new An({wireframe:!0,fog:!1,toneMapped:!1}),this.color===void 0&&(this.material.vertexColors=!0);let s=i.getAttribute("position"),a=new Float32Array(s.count*3);i.setAttribute("color",new Jt(a,3)),this.add(new ge(i,this.material)),this.update()}dispose(){this.children[0].geometry.dispose(),this.children[0].material.dispose()}update(){let t=this.children[0];if(this.color!==void 0)this.material.color.set(this.color);else{let e=t.geometry.getAttribute("color");dd.copy(this.light.color),fd.copy(this.light.groundColor);for(let n=0,i=e.count;n<i;n++){let s=n<i/2?dd:fd;e.setXYZ(n,s.r,s.g,s.b)}e.needsUpdate=!0}this.light.updateWorldMatrix(!0,!1),t.lookAt(gv.setFromMatrixPosition(this.light.matrixWorld).negate())}},md=class extends rn{constructor(t=10,e=10,n=4473924,i=8947848){n=new pt(n),i=new pt(i);let s=e/2,a=t/e,o=t/2,c=[],l=[];for(let d=0,f=0,m=-o;d<=e;d++,m+=a){c.push(-o,0,m,o,0,m),c.push(m,0,-o,m,0,o);let _=d===s?n:i;_.toArray(l,f),f+=3,_.toArray(l,f),f+=3,_.toArray(l,f),f+=3,_.toArray(l,f),f+=3}let h=new Wt;h.setAttribute("position",new xt(c,3)),h.setAttribute("color",new xt(l,3));let u=new Ie({vertexColors:!0,toneMapped:!1});super(h,u),this.type="GridHelper"}dispose(){this.geometry.dispose(),this.material.dispose()}},gd=class extends rn{constructor(t=10,e=16,n=8,i=64,s=4473924,a=8947848){s=new pt(s),a=new pt(a);let o=[],c=[];if(e>1)for(let u=0;u<e;u++){let d=u/e*(Math.PI*2),f=Math.sin(d)*t,m=Math.cos(d)*t;o.push(0,0,0),o.push(f,0,m);let _=u&1?s:a;c.push(_.r,_.g,_.b),c.push(_.r,_.g,_.b)}for(let u=0;u<n;u++){let d=u&1?s:a,f=t-t/n*u;for(let m=0;m<i;m++){let _=m/i*(Math.PI*2),g=Math.sin(_)*f,p=Math.cos(_)*f;o.push(g,0,p),c.push(d.r,d.g,d.b),_=(m+1)/i*(Math.PI*2),g=Math.sin(_)*f,p=Math.cos(_)*f,o.push(g,0,p),c.push(d.r,d.g,d.b)}}let l=new Wt;l.setAttribute("position",new xt(o,3)),l.setAttribute("color",new xt(c,3));let h=new Ie({vertexColors:!0,toneMapped:!1});super(l,h),this.type="PolarGridHelper"}dispose(){this.geometry.dispose(),this.material.dispose()}},_d=new w,Br=new w,xd=new w,vd=class extends Kt{constructor(t,e,n){super(),this.light=t,this.matrix=t.matrixWorld,this.matrixAutoUpdate=!1,this.color=n,this.type="DirectionalLightHelper",e===void 0&&(e=1);let i=new Wt;i.setAttribute("position",new xt([-e,e,0,e,e,0,e,-e,0,-e,-e,0,-e,e,0],3));let s=new Ie({fog:!1,toneMapped:!1});this.lightPlane=new Tn(i,s),this.add(this.lightPlane),i=new Wt,i.setAttribute("position",new xt([0,0,0,0,0,1],3)),this.targetLine=new Tn(i,s),this.add(this.targetLine),this.update()}dispose(){this.lightPlane.geometry.dispose(),this.lightPlane.material.dispose(),this.targetLine.geometry.dispose(),this.targetLine.material.dispose()}update(){this.light.updateWorldMatrix(!0,!1),this.light.target.updateWorldMatrix(!0,!1),_d.setFromMatrixPosition(this.light.matrixWorld),Br.setFromMatrixPosition(this.light.target.matrixWorld),xd.subVectors(Br,_d),this.lightPlane.lookAt(Br),this.color!==void 0?(this.lightPlane.material.color.set(this.color),this.targetLine.material.color.set(this.color)):(this.lightPlane.material.color.copy(this.light.color),this.targetLine.material.color.copy(this.light.color)),this.targetLine.lookAt(Br),this.targetLine.scale.z=xd.length()}},zr=new w,le=new Fs,yd=class extends rn{constructor(t){let e=new Wt,n=new Ie({color:16777215,vertexColors:!0,toneMapped:!1}),i=[],s=[],a={};o("n1","n2"),o("n2","n4"),o("n4","n3"),o("n3","n1"),o("f1","f2"),o("f2","f4"),o("f4","f3"),o("f3","f1"),o("n1","f1"),o("n2","f2"),o("n3","f3"),o("n4","f4"),o("p","n1"),o("p","n2"),o("p","n3"),o("p","n4"),o("u1","u2"),o("u2","u3"),o("u3","u1"),o("c","t"),o("p","c"),o("cn1","cn2"),o("cn3","cn4"),o("cf1","cf2"),o("cf3","cf4");function o(m,_){c(m),c(_)}function c(m){i.push(0,0,0),s.push(0,0,0),a[m]===void 0&&(a[m]=[]),a[m].push(i.length/3-1)}e.setAttribute("position",new xt(i,3)),e.setAttribute("color",new xt(s,3)),super(e,n),this.type="CameraHelper",this.camera=t,this.camera.updateProjectionMatrix&&this.camera.updateProjectionMatrix(),this.matrix=t.matrixWorld,this.matrixAutoUpdate=!1,this.pointMap=a,this.update();let l=new pt(16755200),h=new pt(16711680),u=new pt(43775),d=new pt(16777215),f=new pt(3355443);this.setColors(l,h,u,d,f)}setColors(t,e,n,i,s){let o=this.geometry.getAttribute("color");o.setXYZ(0,t.r,t.g,t.b),o.setXYZ(1,t.r,t.g,t.b),o.setXYZ(2,t.r,t.g,t.b),o.setXYZ(3,t.r,t.g,t.b),o.setXYZ(4,t.r,t.g,t.b),o.setXYZ(5,t.r,t.g,t.b),o.setXYZ(6,t.r,t.g,t.b),o.setXYZ(7,t.r,t.g,t.b),o.setXYZ(8,t.r,t.g,t.b),o.setXYZ(9,t.r,t.g,t.b),o.setXYZ(10,t.r,t.g,t.b),o.setXYZ(11,t.r,t.g,t.b),o.setXYZ(12,t.r,t.g,t.b),o.setXYZ(13,t.r,t.g,t.b),o.setXYZ(14,t.r,t.g,t.b),o.setXYZ(15,t.r,t.g,t.b),o.setXYZ(16,t.r,t.g,t.b),o.setXYZ(17,t.r,t.g,t.b),o.setXYZ(18,t.r,t.g,t.b),o.setXYZ(19,t.r,t.g,t.b),o.setXYZ(20,t.r,t.g,t.b),o.setXYZ(21,t.r,t.g,t.b),o.setXYZ(22,t.r,t.g,t.b),o.setXYZ(23,t.r,t.g,t.b),o.setXYZ(24,e.r,e.g,e.b),o.setXYZ(25,e.r,e.g,e.b),o.setXYZ(26,e.r,e.g,e.b),o.setXYZ(27,e.r,e.g,e.b),o.setXYZ(28,e.r,e.g,e.b),o.setXYZ(29,e.r,e.g,e.b),o.setXYZ(30,e.r,e.g,e.b),o.setXYZ(31,e.r,e.g,e.b),o.setXYZ(32,n.r,n.g,n.b),o.setXYZ(33,n.r,n.g,n.b),o.setXYZ(34,n.r,n.g,n.b),o.setXYZ(35,n.r,n.g,n.b),o.setXYZ(36,n.r,n.g,n.b),o.setXYZ(37,n.r,n.g,n.b),o.setXYZ(38,i.r,i.g,i.b),o.setXYZ(39,i.r,i.g,i.b),o.setXYZ(40,s.r,s.g,s.b),o.setXYZ(41,s.r,s.g,s.b),o.setXYZ(42,s.r,s.g,s.b),o.setXYZ(43,s.r,s.g,s.b),o.setXYZ(44,s.r,s.g,s.b),o.setXYZ(45,s.r,s.g,s.b),o.setXYZ(46,s.r,s.g,s.b),o.setXYZ(47,s.r,s.g,s.b),o.setXYZ(48,s.r,s.g,s.b),o.setXYZ(49,s.r,s.g,s.b),o.needsUpdate=!0}update(){let t=this.geometry,e=this.pointMap,n=1,i=1;le.projectionMatrixInverse.copy(this.camera.projectionMatrixInverse),de("c",e,t,le,0,0,-1),de("t",e,t,le,0,0,1),de("n1",e,t,le,-n,-i,-1),de("n2",e,t,le,n,-i,-1),de("n3",e,t,le,-n,i,-1),de("n4",e,t,le,n,i,-1),de("f1",e,t,le,-n,-i,1),de("f2",e,t,le,n,-i,1),de("f3",e,t,le,-n,i,1),de("f4",e,t,le,n,i,1),de("u1",e,t,le,n*.7,i*1.1,-1),de("u2",e,t,le,-n*.7,i*1.1,-1),de("u3",e,t,le,0,i*2,-1),de("cf1",e,t,le,-n,0,1),de("cf2",e,t,le,n,0,1),de("cf3",e,t,le,0,-i,1),de("cf4",e,t,le,0,i,1),de("cn1",e,t,le,-n,0,-1),de("cn2",e,t,le,n,0,-1),de("cn3",e,t,le,0,-i,-1),de("cn4",e,t,le,0,i,-1),t.getAttribute("position").needsUpdate=!0}dispose(){this.geometry.dispose(),this.material.dispose()}};function de(r,t,e,n,i,s,a){zr.set(i,s,a).unproject(n);let o=t[r];if(o!==void 0){let c=e.getAttribute("position");for(let l=0,h=o.length;l<h;l++)c.setXYZ(o[l],zr.x,zr.y,zr.z)}}var Vr=new Le,Md=class extends rn{constructor(t,e=16776960){let n=new Uint16Array([0,1,1,2,2,3,3,0,4,5,5,6,6,7,7,4,0,4,1,5,2,6,3,7]),i=new Float32Array(24),s=new Wt;s.setIndex(new Jt(n,1)),s.setAttribute("position",new Jt(i,3)),super(s,new Ie({color:e,toneMapped:!1})),this.object=t,this.type="BoxHelper",this.matrixAutoUpdate=!1,this.update()}update(t){if(t!==void 0&&console.warn("THREE.BoxHelper: .update() has no longer arguments."),this.object!==void 0&&Vr.setFromObject(this.object),Vr.isEmpty())return;let e=Vr.min,n=Vr.max,i=this.geometry.attributes.position,s=i.array;s[0]=n.x,s[1]=n.y,s[2]=n.z,s[3]=e.x,s[4]=n.y,s[5]=n.z,s[6]=e.x,s[7]=e.y,s[8]=n.z,s[9]=n.x,s[10]=e.y,s[11]=n.z,s[12]=n.x,s[13]=n.y,s[14]=e.z,s[15]=e.x,s[16]=n.y,s[17]=e.z,s[18]=e.x,s[19]=e.y,s[20]=e.z,s[21]=n.x,s[22]=e.y,s[23]=e.z,i.needsUpdate=!0,this.geometry.computeBoundingSphere()}setFromObject(t){return this.object=t,this.update(),this}copy(t,e){return super.copy(t,e),this.object=t.object,this}dispose(){this.geometry.dispose(),this.material.dispose()}},Sd=class extends rn{constructor(t,e=16776960){let n=new Uint16Array([0,1,1,2,2,3,3,0,4,5,5,6,6,7,7,4,0,4,1,5,2,6,3,7]),i=[1,1,1,-1,1,1,-1,-1,1,1,-1,1,1,1,-1,-1,1,-1,-1,-1,-1,1,-1,-1],s=new Wt;s.setIndex(new Jt(n,1)),s.setAttribute("position",new xt(i,3)),super(s,new Ie({color:e,toneMapped:!1})),this.box=t,this.type="Box3Helper",this.geometry.computeBoundingSphere()}updateMatrixWorld(t){let e=this.box;e.isEmpty()||(e.getCenter(this.position),e.getSize(this.scale),this.scale.multiplyScalar(.5),super.updateMatrixWorld(t))}dispose(){this.geometry.dispose(),this.material.dispose()}},bd=class extends Tn{constructor(t,e=1,n=16776960){let i=n,s=[1,-1,0,-1,1,0,-1,-1,0,1,1,0,-1,1,0,-1,-1,0,1,-1,0,1,1,0],a=new Wt;a.setAttribute("position",new xt(s,3)),a.computeBoundingSphere(),super(a,new Ie({color:i,toneMapped:!1})),this.type="PlaneHelper",this.plane=t,this.size=e;let o=[1,1,0,-1,1,0,-1,-1,0,1,1,0,-1,-1,0,1,-1,0],c=new Wt;c.setAttribute("position",new xt(o,3)),c.computeBoundingSphere(),this.add(new ge(c,new An({color:i,opacity:.2,transparent:!0,depthWrite:!1,toneMapped:!1})))}updateMatrixWorld(t){this.position.set(0,0,0),this.scale.set(.5*this.size,.5*this.size,1),this.lookAt(this.plane.normal),this.translateZ(-this.plane.constant),super.updateMatrixWorld(t)}dispose(){this.geometry.dispose(),this.material.dispose(),this.children[0].geometry.dispose(),this.children[0].material.dispose()}},Ed=new w,kr,To,Ad=class extends Kt{constructor(t=new w(0,0,1),e=new w(0,0,0),n=1,i=16776960,s=n*.2,a=s*.2){super(),this.type="ArrowHelper",kr===void 0&&(kr=new Wt,kr.setAttribute("position",new xt([0,0,0,0,1,0],3)),To=new Hs(0,.5,1,5,1),To.translate(0,-.5,0)),this.position.copy(e),this.line=new Tn(kr,new Ie({color:i,toneMapped:!1})),this.line.matrixAutoUpdate=!1,this.add(this.line),this.cone=new ge(To,new An({color:i,toneMapped:!1})),this.cone.matrixAutoUpdate=!1,this.add(this.cone),this.setDirection(t),this.setLength(n,s,a)}setDirection(t){if(t.y>.99999)this.quaternion.set(0,0,0,1);else if(t.y<-.99999)this.quaternion.set(1,0,0,0);else{Ed.set(t.z,0,-t.x).normalize();let e=Math.acos(t.y);this.quaternion.setFromAxisAngle(Ed,e)}}setLength(t,e=t*.2,n=e*.2){this.line.scale.set(1,Math.max(1e-4,t-e),1),this.line.updateMatrix(),this.cone.scale.set(n,e,n),this.cone.position.y=t,this.cone.updateMatrix()}setColor(t){this.line.material.color.set(t),this.cone.material.color.set(t)}copy(t){return super.copy(t,!1),this.line.copy(t.line),this.cone.copy(t.cone),this}dispose(){this.line.geometry.dispose(),this.line.material.dispose(),this.cone.geometry.dispose(),this.cone.material.dispose()}},Td=class extends rn{constructor(t=1){let e=[0,0,0,t,0,0,0,0,0,0,t,0,0,0,0,0,0,t],n=[1,0,0,1,.6,0,0,1,0,.6,1,0,0,0,1,0,.6,1],i=new Wt;i.setAttribute("position",new xt(e,3)),i.setAttribute("color",new xt(n,3));let s=new Ie({vertexColors:!0,toneMapped:!1});super(i,s),this.type="AxesHelper"}setColors(t,e,n){let i=new pt,s=this.geometry.attributes.color.array;return i.set(t),i.toArray(s,0),i.toArray(s,3),i.set(e),i.toArray(s,6),i.toArray(s,9),i.set(n),i.toArray(s,12),i.toArray(s,15),this.geometry.attributes.color.needsUpdate=!0,this}dispose(){this.geometry.dispose(),this.material.dispose()}},wd=class{constructor(){this.type="ShapePath",this.color=new pt,this.subPaths=[],this.currentPath=null}moveTo(t,e){return this.currentPath=new os,this.subPaths.push(this.currentPath),this.currentPath.moveTo(t,e),this}lineTo(t,e){return this.currentPath.lineTo(t,e),this}quadraticCurveTo(t,e,n,i){return this.currentPath.quadraticCurveTo(t,e,n,i),this}bezierCurveTo(t,e,n,i,s,a){return this.currentPath.bezierCurveTo(t,e,n,i,s,a),this}splineThru(t){return this.currentPath.splineThru(t),this}toShapes(t){function e(p){let v=[];for(let x=0,y=p.length;x<y;x++){let C=p[x],T=new Gn;T.curves=C.curves,v.push(T)}return v}function n(p,v){let x=v.length,y=!1;for(let C=x-1,T=0;T<x;C=T++){let R=v[C],U=v[T],S=U.x-R.x,E=U.y-R.y;if(Math.abs(E)>Number.EPSILON){if(E<0&&(R=v[T],S=-S,U=v[C],E=-E),p.y<R.y||p.y>U.y)continue;if(p.y===R.y){if(p.x===R.x)return!0}else{let N=E*(p.x-R.x)-S*(p.y-R.y);if(N===0)return!0;if(N<0)continue;y=!y}}else{if(p.y!==R.y)continue;if(U.x<=p.x&&p.x<=R.x||R.x<=p.x&&p.x<=U.x)return!0}}return y}let i=bn.isClockWise,s=this.subPaths;if(s.length===0)return[];let a,o,c,l=[];if(s.length===1)return o=s[0],c=new Gn,c.curves=o.curves,l.push(c),l;let h=!i(s[0].getPoints());h=t?!h:h;let u=[],d=[],f=[],m=0,_;d[m]=void 0,f[m]=[];for(let p=0,v=s.length;p<v;p++)o=s[p],_=o.getPoints(),a=i(_),a=t?!a:a,a?(!h&&d[m]&&m++,d[m]={s:new Gn,p:_},d[m].s.curves=o.curves,h&&m++,f[m]=[]):f[m].push({h:o,p:_[0]});if(!d[0])return e(s);if(d.length>1){let p=!1,v=0;for(let x=0,y=d.length;x<y;x++)u[x]=[];for(let x=0,y=d.length;x<y;x++){let C=f[x];for(let T=0;T<C.length;T++){let R=C[T],U=!0;for(let S=0;S<d.length;S++)n(R.p,d[S].p)&&(x!==S&&v++,U?(U=!1,u[S].push(R)):p=!0);U&&u[x].push(R)}}v>0&&p===!1&&(f=u)}let g;for(let p=0,v=d.length;p<v;p++){c=d[p].s,l.push(c),g=f[p];for(let x=0,y=g.length;x<y;x++)c.holes.push(g[x].h)}return l}};typeof __THREE_DEVTOOLS__<"u"&&__THREE_DEVTOOLS__.dispatchEvent(new CustomEvent("register",{detail:{revision:"160"}}));typeof window<"u"&&(window.__THREE__?console.warn("WARNING: Multiple instances of Three.js being imported."):window.__THREE__="160");export{zf as ACESFilmicToneMapping,oi as AddEquation,Nf as AddOperation,Fd as AdditiveAnimationBlendMode,Sl as AdditiveBlending,kf as AgXToneMapping,Xf as AlphaFormat,lp as AlwaysCompare,Rf as AlwaysDepth,jl as AlwaysStencilFunc,qc as AmbientLight,il as AnimationAction,us as AnimationClip,Tu as AnimationLoader,Ju as AnimationMixer,Zu as AnimationObjectGroup,ey as AnimationUtils,sc as ArcCurve,ko as ArrayCamera,Ad as ArrowHelper,wl as AttachedBindMode,tl as Audio,Yu as AudioAnalyser,Ca as AudioContext,Wu as AudioListener,Bu as AudioLoader,Td as AxesHelper,He as BackSide,tp as BasicDepthPacking,Mv as BasicShadowMap,tc as BatchedMesh,fa as Bone,qn as BooleanKeyframeTrack,rd as Box2,Le as Box3,Sd as Box3Helper,ns as BoxGeometry,Md as BoxHelper,Jt as BufferAttribute,Wt as BufferGeometry,Qc as BufferGeometryLoader,Gf as ByteType,Bn as Cache,Fs as Camera,yd as CameraHelper,vu as CanvasTexture,lc as CapsuleGeometry,rc as CatmullRomCurve3,Bf as CineonToneMapping,hc as CircleGeometry,Fe as ClampToEdgeWrapping,jc as Clock,pt as Color,Ta as ColorKeyframeTrack,jt as ColorManagement,_u as CompressedArrayTexture,xu as CompressedCubeTexture,Vs as CompressedTexture,wu as CompressedTextureLoader,uc as ConeGeometry,Af as ConstantAlphaFactor,bf as ConstantColorFactor,Uo as CubeCamera,Xn as CubeReflectionMapping,mi as CubeRefractionMapping,ss as CubeTexture,Ru as CubeTextureLoader,Ys as CubeUVReflectionMapping,ma as CubicBezierCurve,ac as CubicBezierCurve3,Nc as CubicInterpolant,Ml as CullFaceBack,lf as CullFaceFront,yv as CullFaceFrontBack,cf as CullFaceNone,Qe as Curve,cc as CurvePath,uf as CustomBlending,Vf as CustomToneMapping,Hs as CylinderGeometry,id as Cylindrical,ia as Data3DTexture,Ns as DataArrayTexture,Hn as DataTexture,Cu as DataTextureLoader,ty as DataUtils,Uv as DecrementStencilOp,Nv as DecrementWrapStencilOp,nv as DefaultLoadingManager,di as DepthFormat,ts as DepthStencilFormat,la as DepthTexture,Hf as DetachedBindMode,Xc as DirectionalLight,vd as DirectionalLightHelper,Oc as DiscreteInterpolant,cl as DisplayP3ColorSpace,dc as DodecahedronGeometry,Mn as DoubleSide,xf as DstAlphaFactor,yf as DstColorFactor,$v as DynamicCopyUsage,Wv as DynamicDrawUsage,Yv as DynamicReadUsage,fc as EdgesGeometry,ks as EllipseCurve,rp as EqualCompare,Pf as EqualDepth,zv as EqualStencilFunc,Wr as EquirectangularReflectionMapping,Xr as EquirectangularRefractionMapping,sa as Euler,hn as EventDispatcher,gc as ExtrudeGeometry,un as FileLoader,Mh as Float16BufferAttribute,xt as Float32BufferAttribute,Sh as Float64BufferAttribute,cn as FloatType,qo as Fog,Xo as FogExp2,gu as FramebufferTexture,Wn as FrontSide,rs as Frustum,ju as GLBufferAttribute,Qv as GLSL1,th as GLSL3,ap as GreaterCompare,If as GreaterDepth,cp as GreaterEqualCompare,Lf as GreaterEqualDepth,Gv as GreaterEqualStencilFunc,kv as GreaterStencilFunc,md as GridHelper,li as Group,Is as HalfFloatType,zc as HemisphereLight,pd as HemisphereLightHelper,_c as IcosahedronGeometry,Fu as ImageBitmapLoader,ds as ImageLoader,na as ImageUtils,Iv as IncrementStencilOp,Dv as IncrementWrapStencilOp,xi as InstancedBufferAttribute,Kc as InstancedBufferGeometry,Qu as InstancedInterleavedBuffer,Qo as InstancedMesh,vh as Int16BufferAttribute,yh as Int32BufferAttribute,gh as Int8BufferAttribute,Pd as IntType,zs as InterleavedBuffer,as as InterleavedBufferAttribute,cs as Interpolant,Zr as InterpolateDiscrete,Jr as InterpolateLinear,Ga as InterpolateSmooth,Ov as InvertStencilOp,bi as KeepStencilOp,je as KeyframeTrack,Jo as LOD,Ma as LatheGeometry,Os as Layers,sp as LessCompare,Cf as LessDepth,zd as LessEqualCompare,Gr as LessEqualDepth,Vv as LessEqualStencilFunc,Bv as LessStencilFunc,wn as Light,Jc as LightProbe,Tn as Line,od as Line3,Ie as LineBasicMaterial,ga as LineCurve,oc as LineCurve3,Uc as LineDashedMaterial,ec as LineLoop,rn as LineSegments,La as LinearDisplayP3ColorSpace,Bd as LinearEncoding,me as LinearFilter,Aa as LinearInterpolant,Tv as LinearMipMapLinearFilter,Av as LinearMipMapNearestFilter,gi as LinearMipmapLinearFilter,Cd as LinearMipmapNearestFilter,En as LinearSRGBColorSpace,Of as LinearToneMapping,Kr as LinearTransfer,ze as Loader,Ra as LoaderUtils,wa as LoadingManager,Kf as LoopOnce,jf as LoopPingPong,Qf as LoopRepeat,Yf as LuminanceAlphaFormat,qf as LuminanceFormat,xv as MOUSE,Te as Material,$c as MaterialLoader,jv as MathUtils,Gt as Matrix3,It as Matrix4,Tl as MaxEquation,ge as Mesh,An as MeshBasicMaterial,ha as MeshDepthMaterial,ua as MeshDistanceMaterial,Lc as MeshLambertMaterial,Ic as MeshMatcapMaterial,Pc as MeshNormalMaterial,Rc as MeshPhongMaterial,wc as MeshPhysicalMaterial,Ea as MeshStandardMaterial,Cc as MeshToonMaterial,Al as MinEquation,Yr as MirroredRepeatWrapping,Df as MixOperation,El as MultiplyBlending,Pa as MultiplyOperation,pe as NearestFilter,Ev as NearestMipMapLinearFilter,bv as NearestMipMapNearestFilter,Hr as NearestMipmapLinearFilter,Co as NearestMipmapNearestFilter,ip as NeverCompare,wf as NeverDepth,Fv as NeverStencilFunc,zn as NoBlending,$e as NoColorSpace,Vn as NoToneMapping,ol as NormalAnimationBlendMode,Ki as NormalBlending,op as NotEqualCompare,Uf as NotEqualDepth,Hv as NotEqualStencilFunc,ls as NumberKeyframeTrack,Kt as Object3D,Du as ObjectLoader,np as ObjectSpaceNormalMap,Sa as OctahedronGeometry,mf as OneFactor,Tf as OneMinusConstantAlphaFactor,Ef as OneMinusConstantColorFactor,vf as OneMinusDstAlphaFactor,Mf as OneMinusDstColorFactor,Ro as OneMinusSrcAlphaFactor,_f as OneMinusSrcColorFactor,Bs as OrthographicCamera,jr as P3Primaries,Rd as PCFShadowMap,hf as PCFSoftShadowMap,ca as PMREMGenerator,os as Path,be as PerspectiveCamera,yn as Plane,oa as PlaneGeometry,bd as PlaneHelper,Gc as PointLight,ud as PointLightHelper,ic as Points,pa as PointsMaterial,gd as PolarGridHelper,vi as PolyhedronGeometry,qu as PositionalAudio,Qt as PropertyBinding,el as PropertyMixer,_a as QuadraticBezierCurve,xa as QuadraticBezierCurve3,Be as Quaternion,Mi as QuaternionKeyframeTrack,Fc as QuaternionLinearInterpolant,Kl as RED_GREEN_RGTC2_Format,$f as RED_RGTC1_Format,_v as REVISION,ep as RGBADepthPacking,qe as RGBAFormat,Nd as RGBAIntegerFormat,Xl as RGBA_ASTC_10x10_Format,Hl as RGBA_ASTC_10x5_Format,Gl as RGBA_ASTC_10x6_Format,Wl as RGBA_ASTC_10x8_Format,ql as RGBA_ASTC_12x10_Format,Yl as RGBA_ASTC_12x12_Format,Dl as RGBA_ASTC_4x4_Format,Nl as RGBA_ASTC_5x4_Format,Ol as RGBA_ASTC_5x5_Format,Fl as RGBA_ASTC_6x5_Format,Bl as RGBA_ASTC_6x6_Format,zl as RGBA_ASTC_8x5_Format,Vl as RGBA_ASTC_8x6_Format,kl as RGBA_ASTC_8x8_Format,Ha as RGBA_BPTC_Format,Ul as RGBA_ETC2_EAC_Format,Ll as RGBA_PVRTC_2BPPV1_Format,Pl as RGBA_PVRTC_4BPPV1_Format,za as RGBA_S3TC_DXT1_Format,Va as RGBA_S3TC_DXT3_Format,ka as RGBA_S3TC_DXT5_Format,Zl as RGB_BPTC_SIGNED_Format,Jl as RGB_BPTC_UNSIGNED_Format,Od as RGB_ETC1_Format,Il as RGB_ETC2_Format,Cl as RGB_PVRTC_2BPPV1_Format,Rl as RGB_PVRTC_4BPPV1_Format,Ba as RGB_S3TC_DXT1_Format,Jf as RGFormat,Dd as RGIntegerFormat,Tc as RawShaderMaterial,_i as Ray,td as Raycaster,Qr as Rec709Primaries,Yc as RectAreaLight,Zf as RedFormat,Ud as RedIntegerFormat,Ff as ReinhardToneMapping,Io as RenderTarget,qr as RepeatWrapping,Lv as ReplaceStencilOp,ff as ReverseSubtractEquation,xc as RingGeometry,Ql as SIGNED_RED_GREEN_RGTC2_Format,$l as SIGNED_RED_RGTC1_Format,Se as SRGBColorSpace,se as SRGBTransfer,Yo as Scene,kt as ShaderChunk,on as ShaderLib,sn as ShaderMaterial,Ac as ShadowMaterial,Gn as Shape,vc as ShapeGeometry,wd as ShapePath,bn as ShapeUtils,Wf as ShortType,Ko as Skeleton,hd as SkeletonHelper,$o as SkinnedMesh,On as Source,Ae as Sphere,ba as SphereGeometry,nd as Spherical,Zc as SphericalHarmonics3,va as SplineCurve,kc as SpotLight,ld as SpotLightHelper,Zo as Sprite,da as SpriteMaterial,wo as SrcAlphaFactor,Sf as SrcAlphaSaturateFactor,gf as SrcColorFactor,Jv as StaticCopyUsage,ta as StaticDrawUsage,qv as StaticReadUsage,ku as StereoCamera,Kv as StreamCopyUsage,Xv as StreamDrawUsage,Zv as StreamReadUsage,Yn as StringKeyframeTrack,df as SubtractEquation,bl as SubtractiveBlending,vv as TOUCH,Si as TangentSpaceNormalMap,yc as TetrahedronGeometry,Ee as Texture,Pu as TextureLoader,Mc as TorusGeometry,Sc as TorusKnotGeometry,Fn as Triangle,Cv as TriangleFanDrawMode,Rv as TriangleStripDrawMode,wv as TrianglesDrawMode,bc as TubeGeometry,Sv as TwoPassDoubleSide,rl as UVMapping,ra as Uint16BufferAttribute,aa as Uint32BufferAttribute,_h as Uint8BufferAttribute,xh as Uint8ClampedBufferAttribute,$u as Uniform,Ku as UniformsGroup,ot as UniformsLib,Hp as UniformsUtils,kn as UnsignedByteType,ui as UnsignedInt248Type,Nn as UnsignedIntType,Ld as UnsignedShort4444Type,Id as UnsignedShort5551Type,al as UnsignedShortType,vn as VSMShadowMap,Z as Vector2,w as Vector3,te as Vector4,hs as VectorKeyframeTrack,mu as VideoTexture,Wo as WebGL1Renderer,ah as WebGL3DRenderTarget,rh as WebGLArrayRenderTarget,ln as WebGLCoordinateSystem,Do as WebGLCubeRenderTarget,oh as WebGLMultipleRenderTargets,Ke as WebGLRenderTarget,Go as WebGLRenderer,px as WebGLUtils,Us as WebGPUCoordinateSystem,Ec as WireframeGeometry,$r as WrapAroundEnding,Xi as ZeroCurvatureEnding,pf as ZeroFactor,qi as ZeroSlopeEnding,Pv as ZeroStencilOp,Po as _SRGBAFormat,Ap as createCanvasElement,fi as sRGBEncoding};
