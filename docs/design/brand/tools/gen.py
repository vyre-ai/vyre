import math, itertools
_c=itertools.count(1)
def uid(p='u'): return f'{p}{next(_c)}'

# ---------- squircle ----------
def squircle(n=5.0, N=240):
    pts=[]
    for i in range(N):
        t=2*math.pi*i/N
        c,s=math.cos(t),math.sin(t)
        x=512+512*math.copysign(abs(c)**(2/n),c); y=512+512*math.copysign(abs(s)**(2/n),s)
        pts.append(f'{x:.1f} {y:.1f}')
    return 'M'+' L'.join(pts)+' Z'
SQ=squircle()

ACC={'lumen':'#FFDFA8','drive':'#BFDCF0','vault':'#F3A25E','memory':'#F4C4B4','chrome':'#EDE8DC','vyre':'#F3EBDD'}
def radials():
    o=''
    for k,c in ACC.items():
        o+=f'<radialGradient id="g_{k}"><stop offset="0" stop-color="{c}" stop-opacity=".95"/><stop offset=".35" stop-color="{c}" stop-opacity=".38"/><stop offset="1" stop-color="{c}" stop-opacity="0"/></radialGradient>'
        o+=f'<radialGradient id="o_{k}" cx=".38" cy=".32" r=".8"><stop offset="0" stop-color="#fff"/><stop offset=".35" stop-color="{c}"/><stop offset="1" stop-color="{c}" stop-opacity=".55"/></radialGradient>'
    return o
def blurs():
    return ''.join(f'<filter id="b{b}" filterUnits="userSpaceOnUse" x="-300" y="-300" width="1624" height="1624"><feGaussianBlur stdDeviation="{b}"/></filter>' for b in (2,4,8,14,24,40,70))
DEFS=f'''<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
<clipPath id="sq"><path d="{SQ}"/></clipPath>
<linearGradient id="tile" x1=".25" y1="0" x2=".65" y2="1"><stop offset="0" stop-color="#2C2824"/><stop offset=".5" stop-color="#171513"/><stop offset="1" stop-color="#0A0908"/></linearGradient>
<radialGradient id="sheen" cx=".3" cy=".08" r=".75"><stop offset="0" stop-color="#fff" stop-opacity=".2"/><stop offset=".55" stop-color="#fff" stop-opacity="0"/></radialGradient>
<linearGradient id="rim" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".95"/><stop offset=".3" stop-color="#fff" stop-opacity=".2"/><stop offset=".7" stop-color="#fff" stop-opacity=".05"/><stop offset="1" stop-color="#fff" stop-opacity=".45"/></linearGradient>
<linearGradient id="gfill" x1="0" y1="0" x2=".7" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".28"/><stop offset=".5" stop-color="#fff" stop-opacity=".07"/><stop offset="1" stop-color="#fff" stop-opacity=".15"/></linearGradient>
<linearGradient id="gdark" x1="0" y1="0" x2=".7" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".16"/><stop offset=".45" stop-color="#0a0908" stop-opacity=".55"/><stop offset="1" stop-color="#0a0908" stop-opacity=".78"/></linearGradient>
<linearGradient id="gside" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#0a0908" stop-opacity=".75"/><stop offset="1" stop-color="#fff" stop-opacity=".06"/></linearGradient>
<linearGradient id="flare" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".95"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
<radialGradient id="sph" cx=".34" cy=".28" r=".85"><stop offset="0" stop-color="#fff" stop-opacity=".62"/><stop offset=".4" stop-color="#fff" stop-opacity=".14"/><stop offset="1" stop-color="#fff" stop-opacity=".06"/></radialGradient>
<filter id="grain" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="2" seed="7"/><feColorMatrix values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  1.1 0 0 0 -.42"/></filter>
{radials()}{blurs()}
</defs></svg>'''

def rr(x,y,w,h,r):
    return f'M{x+r} {y} H{x+w-r} A{r} {r} 0 0 1 {x+w} {y+r} V{y+h-r} A{r} {r} 0 0 1 {x+w-r} {y+h} H{x+r} A{r} {r} 0 0 1 {x} {y+h-r} V{y+r} A{r} {r} 0 0 1 {x+r} {y} Z'
def circ(cx,cy,r): return f'M{cx-r} {cy} a{r} {r} 0 1 0 {2*r} 0 a{r} {r} 0 1 0 {-2*r} 0 Z'
def poly(*p): return 'M'+' L'.join(f'{x} {y}' for x,y in p)+' Z'

def glass(d, behind='', cx=512, cy=512, mag=1.1, fill='gfill', eo=False, rim=1.0, edge=.24, blur=14, width=3.5):
    cid=uid('c'); fr=' fill-rule="evenodd" clip-rule="evenodd"' if eo else ''
    s=f'<clipPath id="{cid}"><path d="{d}"{fr}/></clipPath>'
    if behind:
        s+=f'<g clip-path="url(#{cid})"><g transform="translate({cx} {cy}) scale({mag}) translate({-cx} {-cy})" filter="url(#b{blur})">{behind}</g></g>'
    s+=f'<path d="{d}" fill="url(#{fill})"{fr}/>'
    s+=f'<g clip-path="url(#{cid})"><path d="{d}" fill="none" stroke="#fff" stroke-opacity="{edge}" stroke-width="30" filter="url(#b8)" transform="translate(5 8)"{fr}/></g>'
    s+=f'<path d="{d}" fill="none" stroke="url(#rim)" stroke-opacity="{rim}" stroke-width="{width}"{fr}/>'
    return s

def crm(pts, t=.5):
    d=f'M{pts[0][0]} {pts[0][1]}'
    P=[pts[0]]+pts+[pts[-1]]
    for i in range(1,len(P)-2):
        p0,p1,p2,p3=P[i-1],P[i],P[i+1],P[i+2]
        c1=(p1[0]+(p2[0]-p0[0])*t/3*2/1, p1[1]+(p2[1]-p0[1])*t/3*2/1)
        c2=(p2[0]-(p3[0]-p1[0])*t/3*2/1, p2[1]-(p3[1]-p1[1])*t/3*2/1)
        d+=f' C{c1[0]:.1f} {c1[1]:.1f} {c2[0]:.1f} {c2[1]:.1f} {p2[0]} {p2[1]}'
    return d

def sphere(cx,cy,r,behind='',mag=1.25):
    d=circ(cx,cy,r); cid=uid('c')
    s=f'<clipPath id="{cid}"><path d="{d}"/></clipPath>'
    if behind: s+=f'<g clip-path="url(#{cid})"><g transform="translate({cx} {cy}) scale({mag}) translate({-cx} {-cy})" filter="url(#b8)">{behind}</g></g>'
    s+=f'<path d="{d}" fill="url(#sph)"/>'
    s+=f'<g clip-path="url(#{cid})"><path d="{d}" fill="none" stroke="#fff" stroke-opacity=".2" stroke-width="{r*.3:.0f}" filter="url(#b8)" transform="translate({r*.06:.0f} {r*.1:.0f})"/></g>'
    s+=f'<path d="{d}" fill="none" stroke="url(#rim)" stroke-width="3"/>'
    s+=f'<ellipse cx="{cx-r*.34:.0f}" cy="{cy-r*.44:.0f}" rx="{r*.28:.0f}" ry="{r*.14:.0f}" fill="#fff" opacity=".7" filter="url(#b4)" transform="rotate(-32 {cx-r*.34:.0f} {cy-r*.44:.0f})"/>'
    return s

def orb(cx,cy,r,k):
    return f'<circle cx="{cx}" cy="{cy}" r="{r*3.2:.0f}" fill="url(#g_{k})"/><circle cx="{cx}" cy="{cy}" r="{r}" fill="url(#o_{k})"/><circle cx="{cx}" cy="{cy}" r="{r*.45:.0f}" fill="#fff" opacity=".9" filter="url(#b4)"/>'

# ---------- concepts ----------
def L1():
    k='lumen'
    outer=circ(512,520,262); inner=circ(512,520,176)
    beh=f'<circle cx="690" cy="345" r="300" fill="url(#g_{k})"/><circle cx="690" cy="345" r="40" fill="#fff"/>'
    s=f'<circle cx="690" cy="345" r="380" fill="url(#g_{k})" opacity=".55"/>'
    s+=glass(outer+' '+inner,beh,512,520,1.1,eo=True,edge=.3)
    s+=glass(inner,beh,512,520,-1.5,edge=.34)
    s+=f'<path d="M436 650 A150 150 0 0 1 366 544" fill="none" stroke="{ACC[k]}" stroke-width="26" stroke-linecap="round" opacity=".85" filter="url(#b14)"/>'
    s+=f'<path d="M436 650 A150 150 0 0 1 366 544" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" opacity=".8" filter="url(#b2)"/>'
    s+='<g class="flare" style="transform-origin:688px 352px">'
    s+=f'<circle cx="688" cy="352" r="90" fill="url(#g_{k})"/>'
    s+=f'<rect x="588" y="349" width="200" height="6" fill="url(#flare)" transform="rotate(-38 688 352)"/><rect x="588" y="349" width="200" height="6" fill="url(#flare)" transform="rotate(52 688 352)" opacity=".7"/>'
    s+=f'<circle cx="688" cy="352" r="17" fill="#fff"/><circle cx="688" cy="352" r="34" fill="#fff" opacity=".5" filter="url(#b8)"/>'
    s+='</g>'
    return s,k
def L2():
    k='lumen'
    pill=rr(192,397,640,230,115)
    beh=f'<circle cx="330" cy="512" r="250" fill="url(#g_{k})"/>'
    s=f'<ellipse cx="512" cy="720" rx="330" ry="44" fill="url(#g_{k})" opacity=".55" filter="url(#b24)"/>'
    s+=glass(pill,beh,330,512,1.15,edge=.3)
    s+=sphere(330,512,58,f'<circle cx="330" cy="512" r="46" fill="{ACC[k]}"/>',1.0)
    s+=f'<circle cx="330" cy="512" r="30" fill="#fff" opacity=".95" filter="url(#b8)"/><circle cx="330" cy="512" r="16" fill="#fff"/>'
    s+=f'<rect x="560" y="462" width="6" height="100" rx="3" fill="#fff" opacity=".42"/><rect x="600" y="500" width="150" height="4" rx="2" fill="#fff" opacity=".14"/>'
    return s,k
def L3():
    k='lumen'
    s=f'<circle cx="512" cy="512" r="300" fill="url(#g_{k})"/><circle cx="512" cy="512" r="66" fill="#fff" filter="url(#b24)"/><circle cx="512" cy="512" r="40" fill="#fff"/>'
    beh=f'<circle cx="512" cy="512" r="230" fill="url(#g_{k})"/><circle cx="512" cy="512" r="60" fill="#fff"/>'
    for i in range(6):
        s+=f'<g transform="rotate({60*i} 512 512)">'+glass(rr(440,84,214,318,48),beh,512,512,1.06,edge=.3,width=3)+'</g>'
    return s,k
def D1():
    k='drive'
    beh=f'<circle cx="520" cy="470" r="330" fill="url(#g_{k})"/>'
    g='<g transform="translate(104 0) skewX(-10)">'
    for i,y in enumerate((236,368,500)):
        g+=glass(rr(276,y,470,300,40),beh if i==2 else '',520,470,1.08,edge=.3)
    g+=f'<path d="M430 552 h86 l54 54 v118 h-140 Z M516 552 v54 h54" fill="none" stroke="{ACC[k]}" stroke-width="10" stroke-linejoin="round" stroke-linecap="round" opacity=".9" filter="url(#b4)"/>'
    g+=f'<path d="M430 552 h86 l54 54 v118 h-140 Z M516 552 v54 h54" fill="none" stroke="#fff" stroke-width="4" stroke-linejoin="round" stroke-linecap="round" opacity=".85"/>'
    g+='</g>'
    return f'<circle cx="520" cy="470" r="360" fill="url(#g_{k})" opacity=".5"/>'+g,k
def D2():
    k='drive'
    top=[(512,330),(711,445),(512,560),(313,445)]
    L=[(313,445),(512,560),(512,790),(313,675)]; R=[(512,560),(711,445),(711,675),(512,790)]
    s=f'<ellipse cx="512" cy="470" rx="330" ry="260" fill="url(#g_{k})" opacity=".6" filter="url(#b40)"/>'
    beh=f'<path d="{poly(*top)}" fill="#fff"/><circle cx="512" cy="470" r="260" fill="url(#g_{k})"/>'
    s+=glass(poly(*L),beh,512,470,1.12,fill='gside',edge=.2)
    s+=glass(poly(*R),beh,512,470,1.12,edge=.28)
    s+=f'<path d="{poly((512,300),(760,420),(512,560),(264,420))}" fill="url(#g_{k})" filter="url(#b24)" opacity=".9"/>'
    s+=f'<path d="{poly(*top)}" fill="#fff" opacity=".92" filter="url(#b8)" transform="translate(0 4)"/>'
    lt=[(x,y-46) for x,y in top]
    lidL=[lt[3],lt[2],(lt[2][0],lt[2][1]+26),(lt[3][0],lt[3][1]+26)]; lidR=[lt[2],lt[1],(lt[1][0],lt[1][1]+26),(lt[2][0],lt[2][1]+26)]
    s+=glass(poly(*lidL),'',fill='gside',edge=.2)+glass(poly(*lidR),'',edge=.2)
    s+=glass(poly(*lt),beh,512,400,1.05,edge=.4,width=4)
    s+=f'<path d="M313 445 L512 560 L711 445" fill="none" stroke="#fff" stroke-opacity=".9" stroke-width="5" stroke-linecap="round" filter="url(#b2)"/>'
    return s,k
def D3():
    k='drive'
    back='M180 300 H420 L470 360 H844 A40 40 0 0 1 884 400 V760 A40 40 0 0 1 844 800 H180 A40 40 0 0 1 140 760 V340 A40 40 0 0 1 180 300 Z'
    s=f'<ellipse cx="512" cy="520" rx="380" ry="260" fill="url(#g_{k})" opacity=".5" filter="url(#b40)"/>'
    s+=glass(back,'',fill='gdark',edge=.15)
    sheets=''
    sheets+=f'<g transform="rotate(-6 512 640)"><path d="{rr(220,300,560,420,30)}" fill="{ACC[k]}" opacity=".75"/></g><g transform="rotate(4 512 640)"><path d="{rr(250,330,560,420,30)}" fill="#fff" opacity=".55"/></g>'
    s+=f'<g opacity=".95">{sheets}</g>'
    s+=f'<circle cx="512" cy="470" r="220" fill="url(#g_{k})" filter="url(#b24)"/>'
    front=rr(140,440,744,360,44)
    s+=glass(front,sheets+f'<circle cx="512" cy="470" r="240" fill="url(#g_{k})"/>',512,470,1.06,edge=.34,width=4)
    s+=f'<path d="M184 441 H840" stroke="#fff" stroke-width="4" stroke-linecap="round" opacity=".9" filter="url(#b2)"/>'
    return s,k
def V1():
    k='vault'
    T=[(512,250),(694,355),(512,460),(330,355)]; Lf=[(330,355),(512,460),(512,780),(330,675)]; Rf=[(512,460),(694,355),(694,675),(512,780)]
    s=f'<ellipse cx="512" cy="800" rx="260" ry="40" fill="url(#g_{k})" opacity=".35" filter="url(#b24)"/><circle cx="512" cy="540" r="330" fill="url(#g_{k})" opacity=".45"/>'
    beh=f'<circle cx="512" cy="530" r="260" fill="url(#g_{k})"/><circle cx="512" cy="530" r="34" fill="#fff"/>'
    s+=orb(512,540,30,k)
    s+=glass(poly(*Lf),beh,512,540,1.25,fill='gdark',edge=.12)
    s+=glass(poly(*Rf),beh,512,540,1.25,fill='gdark',edge=.22)
    s+=f'<path d="M512 250 V570 M512 570 L330 675 M512 570 L694 675" fill="none" stroke="#fff" stroke-opacity=".16" stroke-width="3"/>'
    s+=glass(poly(*T),beh,512,540,1.2,fill='gfill',edge=.3,width=4)
    s+=f'<path d="M512 460 V780" stroke="#fff" stroke-width="5" stroke-linecap="round" opacity=".7" filter="url(#b2)"/>'
    return s,k
def V2():
    k='vault'
    s=f'<circle cx="512" cy="512" r="420" fill="url(#g_{k})" opacity=".28"/>'
    ring=circ(512,512,300)+' '+circ(512,512,214)
    s+=glass(ring,'',fill='gdark',eo=True,edge=.2,width=4)
    s+=glass(circ(512,512,206),f'<circle cx="640" cy="640" r="260" fill="url(#g_{k})"/>',512,512,1.2,fill='gdark',edge=.22)
    def pt(a,r): return 512+r*math.cos(math.radians(a)),512+r*math.sin(math.radians(a))
    x1,y1=pt(-30,212); x2,y2=pt(58,212)
    seam=f'M{x1:.0f} {y1:.0f} A212 212 0 0 1 {x2:.0f} {y2:.0f}'
    s+=f'<path d="{seam}" fill="none" stroke="{ACC[k]}" stroke-width="46" opacity=".7" filter="url(#b24)"/><path d="{seam}" fill="none" stroke="{ACC[k]}" stroke-width="14" stroke-linecap="round" filter="url(#b4)"/><path d="{seam}" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round"/>'
    for i in range(3):
        s+=f'<g transform="rotate({120*i-90} 512 512)">'+glass(rr(512-16,512-152,32,152,16),'',edge=.3,width=3)+'</g>'
    s+=glass(circ(512,512,58),'',edge=.4,width=3.5)
    s+=f'<circle cx="512" cy="512" r="14" fill="{ACC[k]}" opacity=".9"/>'
    return s,k
def V3():
    k='vault'
    arch='M312 810 V440 A200 200 0 0 1 712 440 V810 Z'
    key='M512 418 m-54 0 a54 54 0 1 0 108 0 a54 54 0 1 0 -108 0 Z M480 470 L544 470 L570 660 L454 660 Z'
    s=f'<circle cx="512" cy="500" r="360" fill="url(#g_{k})" opacity=".4"/>'
    s+=f'<path d="{poly((454,660),(570,660),(760,880),(264,880))}" fill="url(#g_{k})" opacity=".8" filter="url(#b24)"/>'
    s+=f'<path d="{key}" fill="#fff"/><circle cx="512" cy="520" r="120" fill="url(#g_{k})"/><path d="{key}" fill="{ACC[k]}" filter="url(#b8)"/><path d="{key}" fill="#fff" opacity=".95"/>'
    s+=glass(arch+' '+key,f'<circle cx="512" cy="540" r="300" fill="url(#g_{k})"/>',512,540,1.1,fill='gdark',eo=True,edge=.22,width=4)
    s+=f'<path d="M312 810 V440 A200 200 0 0 1 512 240" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" opacity=".55" filter="url(#b2)"/>'
    return s,k
def M1():
    k='memory'
    th='M230 720 C380 400 520 860 800 320'
    s=f'<circle cx="512" cy="540" r="340" fill="url(#g_{k})" opacity=".4"/>'
    beh=f'<path d="{th}" fill="none" stroke="{ACC[k]}" stroke-width="40" stroke-linecap="round"/><path d="{th}" fill="none" stroke="#fff" stroke-width="10" stroke-linecap="round"/>'
    s+=f'<path d="{th}" fill="none" stroke="{ACC[k]}" stroke-width="44" stroke-linecap="round" opacity=".8" filter="url(#b24)"/>'
    for ang,op in ((-17,'gfill'),(0,'gfill'),(17,'gfill')):
        s+=f'<g transform="rotate({ang} 512 860)">'+glass(rr(340,270,344,500,44),beh,512,540,1.06,edge=.3)+'</g>'
    s+=f'<path d="{th}" fill="none" stroke="{ACC[k]}" stroke-width="14" stroke-linecap="round" stroke-dasharray="0 640 300 2000" filter="url(#b4)"/><path d="{th}" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round" stroke-dasharray="0 640 300 2000"/>'
    return s,k
def M2():
    k='memory'
    def band(y0):
        return (f'M180 {y0} C300 {y0-46} 440 {y0+46} 560 {y0} C680 {y0-46} 760 {y0-20} 844 {y0} '
                f'V{y0+100} C760 {y0+80} 680 {y0+54} 560 {y0+100} C440 {y0+146} 300 {y0+54} 180 {y0+100} Z')
    vein='M180 500 C300 454 440 546 560 500 C680 454 760 480 844 500'
    s=f'<circle cx="512" cy="520" r="360" fill="url(#g_{k})" opacity=".35"/>'
    beh=f'<path d="{vein}" fill="none" stroke="{ACC[k]}" stroke-width="60"/><path d="{vein}" fill="none" stroke="#fff" stroke-width="16"/>'
    s+=f'<path d="{vein}" fill="none" stroke="{ACC[k]}" stroke-width="50" opacity=".8" filter="url(#b24)"/>'
    for i,y in enumerate((250,380,510,640)):
        s+=glass(band(y),beh,512,500,1.05,edge=.3,width=3.5)
    s+=f'<path d="M180 500 C300 454 440 546 560 500 C680 454 760 480 844 500" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" opacity=".9" filter="url(#b2)"/>'
    return s,k
def M3():
    k='memory'
    P=[(160,850),(258,764),(392,640),(548,552),(700,430),(800,300),(862,214)]
    th=crm(P)
    s=f'<circle cx="512" cy="560" r="380" fill="url(#g_{k})" opacity=".32"/>'
    s+=f'<path d="{th}" fill="none" stroke="{ACC[k]}" stroke-width="40" stroke-linecap="round" opacity=".75" filter="url(#b24)"/>'
    thb=f'<path d="{th}" fill="none" stroke="{ACC[k]}" stroke-width="30" stroke-linecap="round"/><path d="{th}" fill="none" stroke="#fff" stroke-width="9" stroke-linecap="round"/>'
    s+=f'<path d="{th}" fill="none" stroke="{ACC[k]}" stroke-width="12" stroke-linecap="round" filter="url(#b2)"/><path d="{th}" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round"/>'
    for (cx,cy),r in zip(P[1:6],(62,80,108,76,54)):
        core=orb(cx,cy,r*.34,k) if r>100 else ''
        s+=(core if core else '')+sphere(cx,cy,r,thb+(orb(cx,cy,r*.34,k) if r>100 else ''),1.3)
    return s,k

def C1():
    k='chrome'
    sil="M190 430 V322 A62 62 0 0 1 252 260 H400 A62 62 0 0 1 462 322 V352 H772 A62 62 0 0 1 834 414 V716 A62 62 0 0 1 772 778 H252 A62 62 0 0 1 190 716 Z"
    beh=f'<circle cx="330" cy="452" r="300" fill="url(#g_{k})"/><circle cx="330" cy="452" r="46" fill="#fff"/>'
    s=f'<ellipse cx="512" cy="830" rx="340" ry="46" fill="url(#g_{k})" opacity=".5" filter="url(#b24)"/><circle cx="330" cy="452" r="360" fill="url(#g_{k})" opacity=".4"/>'
    s+=glass(sil,beh,330,452,1.12,edge=.34,width=4)
    bar=rr(256,392,520,80,40)
    s+=f'<path d="{bar}" fill="#0a0908" opacity=".55"/><path d="{bar}" fill="none" stroke="url(#rim)" stroke-width="3" opacity=".8"/>'
    s+=orb(322,432,20,k)
    s+=f'<path d="M198 520 H826" stroke="#fff" stroke-opacity=".5" stroke-width="4" stroke-linecap="round"/>'
    s+=f'<rect x="256" y="582" width="400" height="22" rx="11" fill="#fff" opacity=".24"/><rect x="256" y="636" width="300" height="22" rx="11" fill="#fff" opacity=".15"/><rect x="256" y="690" width="230" height="22" rx="11" fill="#fff" opacity=".1"/>'
    return s,k

def V0():
    k='vyre'
    d='M256 320 L496 720 L634 490'; W=112
    def mk(i,extra): return f'<mask id="{i}" maskUnits="userSpaceOnUse" x="0" y="0" width="1024" height="1024">{extra}</mask>'
    mid=uid('m'); rid=uid('m')
    s=mk(mid,f'<path d="{d}" fill="none" stroke="#fff" stroke-width="{W}" stroke-linecap="round" stroke-linejoin="round"/>')
    s+=mk(rid,f'<path d="{d}" fill="none" stroke="#fff" stroke-width="{W}" stroke-linecap="round" stroke-linejoin="round"/><path d="{d}" fill="none" stroke="#000" stroke-width="{W-8}" stroke-linecap="round" stroke-linejoin="round"/>')
    bead=(736,320)
    glow=f'<circle cx="634" cy="490" r="240" fill="url(#g_{k})"/><circle cx="{bead[0]}" cy="{bead[1]}" r="420" fill="url(#g_{k})"/><circle cx="{bead[0]}" cy="{bead[1]}" r="60" fill="#fff"/>'
    o=s+f'<circle cx="{bead[0]}" cy="{bead[1]}" r="360" fill="url(#g_{k})" opacity=".5"/>'
    o+=f'<g mask="url(#{mid})"><g transform="translate(496 480) scale(1.08) translate(-496 -480)" filter="url(#b14)">{glow}</g></g>'
    o+=f'<g mask="url(#{mid})"><rect width="1024" height="1024" fill="url(#gfill)"/><path d="{d}" fill="none" stroke="#fff" stroke-opacity=".3" stroke-width="56" stroke-linecap="round" stroke-linejoin="round" filter="url(#b8)" transform="translate(7 11)"/></g>'
    o+=f'<g mask="url(#{rid})"><rect width="1024" height="1024" fill="url(#rim)"/></g>'
    o+=f'<path d="M288 324 L498 676" fill="none" stroke="#fff" stroke-opacity=".55" stroke-width="10" stroke-linecap="round" filter="url(#b2)" transform="translate(-18 -14)" />'
    o+=sphere(bead[0],bead[1],92,f'<circle cx="{bead[0]}" cy="{bead[1]}" r="70" fill="{ACC[k]}"/>',1.0)
    o+=f'<circle cx="{bead[0]}" cy="{bead[1]}" r="44" fill="#fff" opacity=".95" filter="url(#b8)"/><circle cx="{bead[0]}" cy="{bead[1]}" r="24" fill="#fff"/>'
    return o,k

CONCEPTS={
 'L1':('Lens',L1,'A glass lens catching one point of light on its rim. The core flips the image, as a real lens does.'),
 'L2':('Bar of light',L2,'The summoned bar as a glass pill with a bead of light waiting inside, ready to be asked.'),
 'L3':('Iris',L3,'Six glass blades opening on a lit centre. Lumen is the aperture you look through.'),
 'D1':('Slides',D1,'A stack of frosted slides, the front one etched with a page. Everything you keep, in one tray.'),
 'D2':('Parcel',D2,'A glass crate with its lid lifted and light escaping. Your files are delivered and safe.'),
 'D3':('Folder',D3,'A glass folder holding sheets that glow through its front. The oldest idea, made precious.'),
 'V1':('Obsidian',V1,'A block of cut black glass with a single ember sealed deep inside. Present, never shown.'),
 'V2':('Door',V2,'A thick glass vault door with one seam of ember light. Locked, and alive.'),
 'V3':('Keyhole',V3,'An arched slab with a keyhole that lets a little light through onto the floor.'),
 'M1':('Sheets and thread',M1,'Layers of glass pierced by one glowing thread. Every session, stitched together.'),
 'M2':('Strata',M2,'Bands of glass like sediment, with one luminous vein running through. Time, with a trace of what mattered.'),
 'V0':('Wire and light',V0,'The Vyre wire, drawn as a glass tube, ending in a bead of light.'),
 'C1':('Window',C1,'A glass browser window with a bead of light waiting in its address bar. Vyre, inside your Chrome.'),
 'M3':('Pearls',M3,'Glass pearls on a lit thread, the largest holding a glow. What Vyre keeps, and how it connects.'),
}
SC={'L1':(1.16,520),'L2':(1.3,512),'L3':(.84,512),'D1':(1.12,470),'D2':(1.2,560),'D3':(1.04,550),'V1':(1.14,515),'V2':(1.12,512),'V3':(.98,560),'M1':(1.0,540),'M2':(1.06,500),'M3':(1.02,540),'C1':(1.12,545),'V0':(1.12,490)}
SIG='<g transform="translate(482 916) scale(1.9)" fill="none" stroke="#F1EEE6" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" opacity=".55"><path d="M8 10L15.5 22.5L19.81 15.31"/><circle cx="23" cy="10" r="3" fill="#F1EEE6" stroke="none"/></g>'
def icon(key,size,sig=None,cls=''):
    body,k=CONCEPTS[key][1]()
    if sig is None: sig=size>=100
    a=ACC[k]; sc,cy=SC[key]
    body=f'<g transform="translate(512 500) scale({sc}) translate(-512 {-cy})">{body}</g>'
    return (f'<svg class="ic {cls}" width="{size}" height="{size}" viewBox="0 0 1024 1024" role="img" aria-label="{CONCEPTS[key][0]}"><g clip-path="url(#sq)">'
      f'<rect width="1024" height="1024" fill="url(#tile)"/><ellipse cx="512" cy="1010" rx="560" ry="340" fill="{a}" opacity=".2" filter="url(#b70)"/>'
      f'{body}<rect width="1024" height="1024" filter="url(#grain)" opacity=".13"/><rect width="1024" height="1024" fill="url(#sheen)"/>'
      f'<path d="M0 0H1024V420C820 300 560 260 0 300Z" fill="#fff" opacity=".035"/>{SIG if sig else ""}</g>'
      f'<path d="{SQ}" fill="none" stroke="url(#rim)" stroke-width="5" opacity=".7"/></svg>')

PRODUCTS=[('Lumen','L',('L1','L2','L3'),'L1','Search, ask and act from one bar.'),('Drive','D',('D1','D2','D3'),'D2','Your files, held in one place.'),('Vault','V',('V1','V2','V3'),'V3','Keys and logins. Names show, values never do.'),('Memory','M',('M1','M2','M3'),'M3','What Vyre remembers, and where from.')]
REC=[p[3] for p in PRODUCTS]

def lockup(key,name,size=64,theme='dark'):
    return f'<div class="lock {theme}">{icon(key,size,False)}<span class="lt"><b>Vyre</b> {name}</span></div>'

css='''
:root{--bg:#0E0D0C;--panel:#161513;--rule:#2B2926;--text:#F1EEE6;--text2:#B3AEA4;--label:#8C877D;--hover:#1E1C1A}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/21px "Instrument Sans",-apple-system,"Helvetica Neue",sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:1200px;margin:0 auto;padding:0 28px 120px}
header{padding:56px 0 34px;border-bottom:1px solid var(--rule)}h1{font:600 40px/44px "Instrument Sans",sans-serif;letter-spacing:-.02em;margin:0 0 12px}
header p{margin:0;max-width:760px;color:var(--text2);font-size:15px;line-height:23px}.eyebrow{font-size:12px;color:var(--label);margin-bottom:14px}
h2{font:600 26px/30px "Instrument Sans",sans-serif;letter-spacing:-.015em;margin:0 0 6px}.sub{color:var(--text2);margin:0 0 26px;max-width:640px}
section{padding:54px 0;border-bottom:1px solid var(--rule)}
.hero{border-radius:28px;overflow:hidden;position:relative;height:440px;display:flex;align-items:flex-end;justify-content:center;padding-bottom:34px;background:radial-gradient(900px 500px at 15% 10%,#c7b39d 0,transparent 60%),radial-gradient(800px 520px at 90% 95%,#4a5f78 0,transparent 60%),linear-gradient(140deg,#6b5f52,#2b323b)}
.hero.light{background:radial-gradient(900px 500px at 20% 0,#fff4e0 0,transparent 60%),radial-gradient(800px 520px at 95% 100%,#cfdcea 0,transparent 60%),linear-gradient(140deg,#efe6d8,#c9d3de)}
.dock{display:flex;gap:18px;padding:16px 20px;border-radius:30px;background:rgba(20,18,16,.32);backdrop-filter:blur(30px) saturate(1.5);-webkit-backdrop-filter:blur(30px) saturate(1.5);box-shadow:inset 0 0 0 1px rgba(255,255,255,.22),0 30px 60px -20px rgba(0,0,0,.5)}
.hero.light .dock{background:rgba(255,255,255,.4);box-shadow:inset 0 0 0 1px rgba(255,255,255,.8),0 30px 60px -20px rgba(60,50,40,.4)}
.dock .ic{filter:drop-shadow(0 12px 14px rgba(0,0,0,.45))}.dock .it{display:flex;flex-direction:column;align-items:center;gap:6px}.dock i{width:5px;height:5px;border-radius:50%;background:rgba(255,255,255,.7)}
.tabs{display:flex;gap:8px;margin-bottom:16px}button{font:600 12px "Instrument Sans",sans-serif;height:32px;padding:0 14px;border-radius:8px;background:var(--hover);color:var(--text);border:1px solid #3A3733;cursor:pointer}
.prod{padding:50px 0;border-bottom:1px solid var(--rule)}.cons{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:22px;margin-top:8px}
.con{background:var(--panel);border:1px solid var(--rule);border-radius:20px;padding:22px}.con .big{display:flex;justify-content:center;padding:18px 0 22px;background:radial-gradient(circle at 50% 30%,#2a2724,transparent 70%)}
.con .ic{filter:drop-shadow(0 22px 22px rgba(0,0,0,.55))}.con h3{margin:0 0 4px;font-size:16px;font-weight:600}.con p{margin:0;color:var(--text2);font-size:13px;line-height:19px}.con .tag{display:inline-block;margin-left:8px;padding:1px 8px;border-radius:99px;background:var(--hover);border:1px solid #3A3733;font-size:11px;font-weight:600;color:var(--text)}
.wp{border-radius:22px;padding:28px;display:flex;flex-wrap:wrap;gap:28px;align-items:flex-end}.wp.d{background:linear-gradient(140deg,#5e5449,#262d36)}.wp.l{background:linear-gradient(140deg,#efe6d8,#c9d3de)}
.wp figure{margin:0;display:flex;flex-direction:column;align-items:center;gap:8px}.wp figcaption{font-size:11px;color:rgba(255,255,255,.7)}.wp.l figcaption{color:rgba(0,0,0,.55)}.wp .ic{filter:drop-shadow(0 8px 10px rgba(0,0,0,.35))}
.ladder{display:grid;gap:22px}.row{display:flex;gap:26px;align-items:flex-end;flex-wrap:wrap}
.locks{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:18px}.lockw{border-radius:18px;padding:26px;display:flex;align-items:center;min-height:120px}.lockw.d{background:#12110f;border:1px solid var(--rule)}.lockw.l{background:#F4F1EA}
.lock{display:flex;align-items:center;gap:16px}.lock .lt{font:600 30px/1 "Instrument Sans",sans-serif;letter-spacing:-.02em}.lock .lt b{font-weight:600;opacity:.62}.lock.dark .lt{color:#F1EEE6}.lock.light .lt{color:#141311}.lock .ic{filter:drop-shadow(0 6px 8px rgba(0,0,0,.35))}
.note{color:var(--label);font-size:12px;margin-top:14px;max-width:760px}
@media (max-width:700px){h1{font-size:30px;line-height:34px}.hero{height:auto;padding:80px 12px 24px}.dock{gap:10px;padding:12px}.dock .ic{width:64px;height:64px}}
'''
def build():
    o=['<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Vyre brand icons</title>',
       '<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;600&display=swap" rel="stylesheet">',
       f'<style>{css}</style></head><body>{DEFS}<div class="wrap">']
    o.append('<header><div class="eyebrow">Vyre 0.2 &middot; brand identity &middot; internal, trademark check pending</div><h1>Four products, one glass family</h1><p>Each product gets a mark with an idea behind it, drawn as one material: frosted Deep glass over Bone neutrals, lit from the upper left, with a single restrained glow of its own. Three concepts per product, one recommended. The Vyre wire-and-dot stays as a small signature at the foot of each icon.</p></header>')
    o.append('<section><div class="tabs"><button onclick="document.querySelector(\'.hero\').classList.remove(\'light\')">Dark wallpaper</button><button onclick="document.querySelector(\'.hero\').classList.add(\'light\')">Light wallpaper</button></div>')
    o.append('<div class="hero"><div class="dock">'+''.join(f'<div class="it">{icon(r,120)}<i></i></div>' for r in REC)+'</div></div>')
    o.append('<p class="note">The recommended set: a lens, a crate, a keyhole slab and a string of pearls. Four silhouettes (circle, cube, arch, diagonal necklace) that stay apart at a glance, one material, one light direction.</p></section>')
    for name,pre,keys,rec,line in PRODUCTS:
        o.append(f'<div class="prod"><h2>Vyre {name}</h2><p class="sub">{line}</p><div class="cons">')
        for kk in keys:
            n,_,story=CONCEPTS[kk]
            o.append(f'<div class="con"><div class="big">{icon(kk,232)}</div><h3>{kk} {n}{"<span class=tag>Recommended</span>" if kk==rec else ""}</h3><p>{story}</p></div>')
        o.append('</div></div>')
    o.append('<section><h2>Size ladder</h2><p class="sub">The recommended four at 512, 128, 64, 32 and 16 px, on dark and light wallpaper. The signature drops out below 100 px.</p><div class="ladder">')
    for cls in ('d','l'):
        o.append(f'<div class="wp {cls}" style="display:grid;grid-template-columns:repeat(4,max-content);justify-content:space-between;gap:8px;padding:20px">')
        for r in REC:
            o.append('<div class="row" style="flex-wrap:nowrap;gap:8px">'+''.join(f'<figure>{icon(r,sz)}<figcaption>{sz}</figcaption></figure>' for sz in (128,64,32,16))+'</div>')
        o.append('</div>')
    o.append('</div></section><section><h2>At 512</h2><p class="sub">The same four at 512 px, the size the file is drawn for (it is a 1024 master).</p><div class="wp d" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(512px,1fr));justify-items:center">'+''.join(f'<figure>{icon(r,512)}<figcaption>{CONCEPTS[r][0]}</figcaption></figure>' for r in REC)+'</div></section>')
    o.append('<section><h2>Lockups</h2><p class="sub">The icon beside the product name. Vyre in a lighter weight, the product in full weight.</p><div class="locks">')
    for r,(name,*_) in zip(REC,PRODUCTS):
        o.append(f'<div class="lockw d">{lockup(r,name,72,"dark")}</div><div class="lockw l">{lockup(r,name,72,"light")}</div>')
    o.append('</div></section></div></body></html>')
    return ''.join(o)
if __name__=='__main__':
    import sys
    open(sys.argv[1] if len(sys.argv)>1 else 'brand-icons.html','w').write(build())
