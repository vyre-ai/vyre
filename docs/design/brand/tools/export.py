import os, sys, math, json, subprocess, hashlib, shutil, tempfile
from concurrent.futures import ThreadPoolExecutor
import gen
from gen import ACC, SC, SQ, CONCEPTS, SIG, circ, rr, poly, sphere, orb, uid

OUT=sys.argv[1]
TMP=os.path.join(os.path.dirname(os.path.abspath(__file__)),'tmp'); os.makedirs(TMP,exist_ok=True)
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PROD={'lumen':('Lumen','L1'),'drive':('Drive','D2'),'vault':('Vault','V3'),'memory':('Memory','M3'),'chrome':('for Chrome','C1')}
D=gen.DEFS; DEFS_INNER=D[D.index('<defs>')+6:D.index('</defs>')]
EXTRA='<filter id="ms" filterUnits="userSpaceOnUse" x="-100" y="-100" width="1224" height="1224"><feDropShadow dx="0" dy="16" stdDeviation="16" flood-color="#000" flood-opacity=".5"/></filter>'
NS='xmlns="http://www.w3.org/2000/svg"'
def wrap(inner,w=1024,h=1024,vb='0 0 1024 1024'):
    return f'<svg {NS} width="{w}" height="{h}" viewBox="{vb}"><defs>{DEFS_INNER}{EXTRA}</defs>{inner}</svg>'

# ---------- full-detail art ----------
def tile_layers(k):
    a=ACC[k]
    return (f'<rect width="1024" height="1024" fill="url(#tile)"/><ellipse cx="512" cy="1010" rx="560" ry="340" fill="{a}" opacity=".2" filter="url(#b70)"/>')
def top_layers():
    return ('<rect width="1024" height="1024" filter="url(#grain)" opacity=".13"/><rect width="1024" height="1024" fill="url(#sheen)"/>'
            '<path d="M0 0H1024V420C820 300 560 260 0 300Z" fill="#fff" opacity=".035"/>')
def body_of(key,mult=1.0):
    ck=PROD[key][1]; body,k=CONCEPTS[ck][1](); sc,cy=SC[ck]; sc*=mult
    return f'<g transform="translate(512 500) scale({sc}) translate(-512 {-cy})">{body}</g>',k
def full_sq(key,sig=True,clip=True):
    body,k=body_of(key)
    inner=tile_layers(k)+body+top_layers()+(SIG if sig else '')
    if clip: return f'<g clip-path="url(#sq)">{inner}</g><path d="{SQ}" fill="none" stroke="url(#rim)" stroke-width="5" opacity=".7"/>'
    return inner
def mac_art(key,sig=True):
    return f'<g filter="url(#ms)"><g transform="translate(100 100) scale(.8047)">{full_sq(key,sig)}</g></g>'
def fg_art(key):
    body,k=body_of(key,.86); return body
def bg_art(key):
    k=PROD_K[key]; return tile_layers(k)+top_layers()
PROD_K={p:CONCEPTS[v[1]][1]()[1] for p,v in PROD.items()}

# ---------- hand-simplified small art ----------
def small_art(key,micro=False,clip=True,sig=False):
    k=PROD_K[key]; a=ACC[k]
    m=1.14 if micro else 1.0
    L=[]
    if key=='lumen':
        cx,cy=512,548
        L.append(f'<circle cx="688" cy="352" r="{200 if not micro else 170}" fill="{a}" opacity=".35" filter="url(#b40)"/>')
        L.append(f'<circle cx="{cx}" cy="{cy}" r="{250*m:.0f}" fill="none" stroke="url(#rg)" stroke-width="{(92 if not micro else 116)}"/>')
        L.append(f'<circle cx="688" cy="352" r="{104 if not micro else 116}" fill="#161311"/>')
        L.append(f'<circle cx="688" cy="352" r="{64 if not micro else 78}" fill="#fff"/><circle cx="688" cy="352" r="{100}" fill="{a}" opacity=".45" filter="url(#b14)"/>')
        rg='<linearGradient id="rg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#A9A398"/></linearGradient>'
    elif key=='drive':
        rg=('<linearGradient id="fl" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6B7782"/><stop offset="1" stop-color="#2B3238"/></linearGradient>'
            '<linearGradient id="fr" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#C4D2DE"/><stop offset="1" stop-color="#6C7986"/></linearGradient>')
        g=1.16*m
        def P(x,y,dy=0): return (512+(x-512)*g, 540+(y-540)*g+dy)
        top=[P(512,330),P(711,445),P(512,560),P(313,445)]
        Lf=[P(313,445),P(512,560),P(512,790),P(313,675)]; Rf=[P(512,560),P(711,445),P(711,675),P(512,790)]
        lid=[(x,y-58*g) for x,y in top]
        pl=lambda pts:'M'+' L'.join(f'{x:.0f} {y:.0f}' for x,y in pts)+' Z'
        L.append(f'<path d="{pl(top)}" fill="{a}" opacity=".9" filter="url(#b24)"/>')
        L.append(f'<path d="{pl(Lf)}" fill="url(#fl)" stroke="#fff" stroke-opacity=".5" stroke-width="10" stroke-linejoin="round"/>')
        L.append(f'<path d="{pl(Rf)}" fill="url(#fr)" stroke="#fff" stroke-opacity=".6" stroke-width="10" stroke-linejoin="round"/>')
        L.append(f'<path d="{pl(top)}" fill="#fff" opacity=".95"/>')
        L.append(f'<path d="{pl(lid)}" fill="#DCEBF6" stroke="#fff" stroke-width="12" stroke-linejoin="round"/>')
    elif key=='vault':
        g=1.08*m
        arch=f'M{512-200*g:.0f} {560+250*g:.0f} V{560-120*g:.0f} A{200*g:.0f} {200*g:.0f} 0 0 1 {512+200*g:.0f} {560-120*g:.0f} V{560+250*g:.0f} Z'
        key_=f'M512 {560-140*g:.0f} m-{56*g:.0f} 0 a{56*g:.0f} {56*g:.0f} 0 1 0 {112*g:.0f} 0 a{56*g:.0f} {56*g:.0f} 0 1 0 -{112*g:.0f} 0 Z M{512-32*g:.0f} {560-100*g:.0f} L{512+32*g:.0f} {560-100*g:.0f} L{512+58*g:.0f} {560+130*g:.0f} L{512-58*g:.0f} {560+130*g:.0f} Z'
        rg='<linearGradient id="ar" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4A443F"/><stop offset="1" stop-color="#1B1917"/></linearGradient>'
        L.append(f'<ellipse cx="512" cy="{560+270*g:.0f}" rx="{280*g:.0f}" ry="{60*g:.0f}" fill="{a}" opacity=".7" filter="url(#b24)"/>')
        L.append(f'<circle cx="512" cy="{560-40*g:.0f}" r="{260*g:.0f}" fill="{a}" opacity=".3" filter="url(#b40)"/>')
        L.append(f'<path d="{arch}" fill="url(#ar)" stroke="#fff" stroke-opacity=".6" stroke-width="14" stroke-linejoin="round"/>')
        L.append(f'<path d="{key_}" fill="{a}" filter="url(#b14)"/><path d="{key_}" fill="#fff"/>')
    elif key=='chrome':
        rg='<linearGradient id="wg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4A443F"/><stop offset="1" stop-color="#1B1917"/></linearGradient>'
        SIL="M180 440 V322 A70 70 0 0 1 250 252 H404 A70 70 0 0 1 474 322 V352 H774 A70 70 0 0 1 844 422 V722 A70 70 0 0 1 774 792 H250 A70 70 0 0 1 180 722 Z"
        L.append(f'<circle cx="330" cy="480" r="330" fill="{a}" opacity=".22" filter="url(#b40)"/>')
        L.append(f'<path d="{SIL}" fill="url(#wg)" stroke="#fff" stroke-opacity=".7" stroke-width="16" stroke-linejoin="round"/>')
        L.append(f'<path d="{rr(246,404,532,96,48)}" fill="#0a0908" opacity=".75"/><circle cx="326" cy="452" r="90" fill="{a}" opacity=".5" filter="url(#b14)"/><circle cx="326" cy="452" r="38" fill="#fff"/>')
        L.append('<path d="M186 546 H838" stroke="#fff" stroke-opacity=".55" stroke-width="10"/><rect x="246" y="620" width="430" height="34" rx="17" fill="#fff" opacity=".28"/><rect x="246" y="694" width="320" height="34" rx="17" fill="#fff" opacity=".16"/>')
    else:
        rg='<radialGradient id="pg" cx=".34" cy=".28" r=".85"><stop offset="0" stop-color="#fff"/><stop offset=".5" stop-color="#F6D6CA"/><stop offset="1" stop-color="#B98F82"/></radialGradient>'
        L.append(f'<path d="M190 830 L840 222" stroke="{a}" stroke-width="{34*m:.0f}" stroke-linecap="round" opacity=".55" filter="url(#b14)"/><path d="M190 830 L840 222" stroke="#fff" stroke-width="{16*m:.0f}" stroke-linecap="round" opacity=".9"/>')
        for cx,cy,r in ((316,706,96),(520,530,146),(736,342,102)):
            r=r*(1.08 if micro else 1)
            L.append(f'<circle cx="{cx}" cy="{cy}" r="{r:.0f}" fill="url(#pg)" stroke="#fff" stroke-opacity=".55" stroke-width="8"/><ellipse cx="{cx-r*.32:.0f}" cy="{cy-r*.42:.0f}" rx="{r*.28:.0f}" ry="{r*.14:.0f}" fill="#fff" transform="rotate(-32 {cx-r*.32:.0f} {cy-r*.42:.0f})"/>')
    defs=f'<defs>{rg}</defs>'
    inner=(f'<rect width="1024" height="1024" fill="url(#tile)"/><ellipse cx="512" cy="1010" rx="560" ry="340" fill="{a}" opacity=".2" filter="url(#b70)"/>'
           +defs+''.join(L)+'<rect width="1024" height="1024" fill="url(#sheen)"/>'+(SIG if sig else ''))
    if clip: return f'<g clip-path="url(#sq)">{inner}</g><path d="{SQ}" fill="none" stroke="url(#rim)" stroke-width="8" opacity=".8"/>'
    return inner

# ---------- template glyphs (one colour) ----------
def template(key,col='#000'):
    if key=='lumen':
        return (f'<mask id="tm"><rect width="1024" height="1024" fill="#fff"/><circle cx="716" cy="308" r="150" fill="#000"/></mask>'
                f'<circle cx="480" cy="548" r="340" fill="none" stroke="{col}" stroke-width="112" mask="url(#tm)"/><circle cx="716" cy="308" r="98" fill="{col}"/>')
    if key=='drive':
        top=[(512,240),(780,392),(512,544),(244,392)]
        pl=lambda pts:'M'+' L'.join(f'{x} {y}' for x,y in pts)+' Z'
        lid=[(x,y-70) for x,y in top]
        return (f'<g fill="none" stroke="{col}" stroke-width="70" stroke-linejoin="round" stroke-linecap="round"><path d="M244 462 V706 L512 862 L780 706 V462"/><path d="M512 574 V862"/><path d="{pl(lid)}"/></g>')
    if key=='chrome':
        return (f'<g fill="none" stroke="{col}" stroke-width="60" stroke-linejoin="round" stroke-linecap="round"><path d="M200 440 V322 A62 62 0 0 1 262 260 H394 A62 62 0 0 1 456 322 V368 H762 A62 62 0 0 1 824 430 V716 A62 62 0 0 1 762 778 H262 A62 62 0 0 1 200 716 Z"/><path d="M210 560 H814"/></g><circle cx="318" cy="464" r="60" fill="{col}"/><rect x="420" y="438" width="270" height="52" rx="26" fill="{col}"/>')
    if key=='vault':
        arch='M232 900 V440 A280 280 0 0 1 792 440 V900 Z'
        keyh='M512 380 m-86 0 a86 86 0 1 0 172 0 a86 86 0 1 0 -172 0 Z M470 470 L554 470 L590 720 L434 720 Z'
        return f'<path d="{arch} {keyh}" fill="{col}" fill-rule="evenodd"/>'
    return (f'<path d="M266 774 L762 262" stroke="{col}" stroke-width="52" stroke-linecap="round"/>'
            f'<circle cx="266" cy="774" r="100" fill="{col}"/><circle cx="512" cy="520" r="132" fill="{col}"/><circle cx="762" cy="262" r="92" fill="{col}"/>')

# ---------- rendering ----------
def render_png(svg,w,h,out):
    os.makedirs(os.path.dirname(out),exist_ok=True)
    key=hashlib.md5((svg+f'{w}x{h}').encode()).hexdigest()[:12]
    cache=os.path.join(TMP,key+'.png')
    if not os.path.exists(cache):
        import uuid; u=uuid.uuid4().hex[:8]; html=os.path.join(TMP,key+u+'.html'); tmp=os.path.join(TMP,key+u+'.raw.png')
        open(html,'w').write(f'<!doctype html><html><body style="margin:0;background:transparent">{svg}</body></html>')
        W,H=max(w,500),max(h,500)
        subprocess.run([CHROME,'--headless=new','--hide-scrollbars','--default-background-color=00000000',f'--window-size={W},{H}',f'--screenshot={tmp}',f'file://{html}'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=120)
        if (W,H)!=(w,h): subprocess.run(['magick',tmp,'-crop',f'{w}x{h}+0+0','+repage','PNG32:'+cache+u],check=True)
        else: shutil.copy(tmp,cache+u)
        os.replace(cache+u,cache)
        os.remove(tmp); os.remove(html)
    shutil.copy(cache,out)
def art_svg(art,size,vb='0 0 1024 1024'): return wrap(art,size,size,vb)

def job(p,kind,size,out,extra=None):
    """kind: sq, square, mac, fg, bg, small, smallsq, tpl(color)"""
    if kind=='sq': art=full_sq(p,sig=size>=100)
    elif kind=='square': art=full_sq(p,sig=size>=100,clip=False)
    elif kind=='mac': art=mac_art(p,size>=100)
    elif kind=='fg': art=fg_art(p)
    elif kind=='bg': art=bg_art(p)
    elif kind=='small': art=small_art(p,micro=(size<=20))
    elif kind=='smallsq': art=small_art(p,micro=(size<=24),clip=False)
    elif kind=='macsmall': art=f'<g filter="url(#ms)"><g transform="translate(100 100) scale(.8047)">{small_art(p,micro=(size<=32))}</g></g>'
    elif kind=='tpl': art=template(p,extra or '#000')
    return (art_svg(art,size),size,size,out)

def main():
    jobs=[]; svgs={}
    for p,(name,ck) in PROD.items():
        if p=='chrome': continue
        R=os.path.join(OUT,p); N=name
        # masters
        open(os.path.join(R,'master.svg'),'w') if False else None
        os.makedirs(R,exist_ok=True)
        open(os.path.join(R,f'{p}-master.svg'),'w').write(art_svg(full_sq(p),1024))
        open(os.path.join(R,f'{p}-small.svg'),'w').write(art_svg(small_art(p),1024))
        open(os.path.join(R,f'{p}-template.svg'),'w').write(art_svg(template(p,'#000'),1024))
        jobs.append(job(p,'sq',1024,f'{R}/{p}-master-1024.png'))
        jobs.append(job(p,'square',1024,f'{R}/{p}-master-square-1024.png'))
        # macOS iconset
        for base,px in ((16,16),(16,32),(32,32),(32,64),(128,128),(128,256),(256,256),(256,512),(512,512),(512,1024)):
            nm=f'icon_{base}x{base}'+('@2x' if px!=base else '')+'.png'
            kind='macsmall' if px<=64 else 'mac'
            if px<=64: jobs.append(job(p,'small',px,f'{R}/macos/{N}.iconset/{nm}'))
            else:
                jobs.append(job(p,'mac',px,f'{R}/macos/{N}.iconset/{nm}'))
        # menu bar templates
        for suf,px in (('',18),('@2x',36),('@3x',54)):
            jobs.append(job(p,'tpl',px,f'{R}/macos/menubar/{p}Template{suf}.png','#000'))
        # windows
        for px in (16,20,24,32,40,48,64,96,128,256):
            jobs.append(job(p,'small' if px<=32 else 'sq',px,f'{R}/windows/png/{p}-{px}.png'))
        for px in (16,20,24,32):
            jobs.append(job(p,'tpl',px,f'{R}/windows/tray/{p}-tray-white-{px}.png','#fff'))
            jobs.append(job(p,'tpl',px,f'{R}/windows/tray/{p}-tray-black-{px}.png','#000'))
        # iOS (square, opaque)
        for px in (20,29,40,58,60,76,80,87,120,152,167,180,1024):
            jobs.append(job(p,'smallsq' if px<=60 else 'square',px,f'{R}/ios/AppIcon-{px}.png'))
        # android
        dens={'mdpi':(48,108),'hdpi':(72,162),'xhdpi':(96,216),'xxhdpi':(144,324),'xxxhdpi':(192,432)}
        for d,(l,f) in dens.items():
            jobs.append(job(p,'sq',l,f'{R}/android/mipmap-{d}/ic_launcher.png'))
            jobs.append(job(p,'fg',f,f'{R}/android/mipmap-{d}/ic_launcher_foreground.png'))
            jobs.append(job(p,'tpl',f,f'{R}/android/mipmap-{d}/ic_launcher_monochrome.png','#000'))
        jobs.append(job(p,'bg',432,f'{R}/android/ic_launcher_background.png'))
        jobs.append(job(p,'square',512,f'{R}/android/playstore-512.png'))
        # web
        for px in (16,32,48): jobs.append(job(p,'small',px,f'{R}/web/favicon-{px}.png'))
        jobs.append(job(p,'square',180,f'{R}/web/apple-touch-icon.png'))
        for px in (192,512):
            jobs.append(job(p,'sq',px,f'{R}/web/icon-{px}.png'))
        # maskable: full-bleed square with content scaled into the safe zone
        for px in (192,512):
            body,k=body_of(p,.8)
            art=tile_layers(k)+body+top_layers()
            jobs.append((art_svg(art,px),px,px,f'{R}/web/maskable-{px}.png'))
    print(len(jobs),'renders'); sys.stdout.flush()
    with ThreadPoolExecutor(4) as ex: list(ex.map(lambda j: render_png(*j),jobs))

def main_chrome():
    p='chrome'; R=os.path.join(OUT,p); os.makedirs(R,exist_ok=True)
    open(os.path.join(R,'chrome-master.svg'),'w').write(art_svg(full_sq(p),1024))
    open(os.path.join(R,'chrome-small.svg'),'w').write(art_svg(small_art(p),1024))
    open(os.path.join(R,'chrome-template.svg'),'w').write(art_svg(template(p,'#000'),1024))
    open(os.path.join(R,'chrome-glyph.svg'),'w').write(f'<svg {NS} viewBox="0 0 1024 1024" width="24" height="24" fill="currentColor">{template(p,"currentColor")}</svg>')
    jobs=[job(p,'sq',1024,f'{R}/chrome-master-1024.png')]
    for px in (16,32,48): jobs.append(job(p,'small',px,f'{R}/extension/icon-{px}.png'))
    art=f'<g transform="translate(128 128) scale(.75)">{full_sq(p,sig=False)}</g>'
    jobs.append((art_svg(art,128),128,128,f'{R}/extension/icon-128.png'))
    for px in (19,38): jobs.append(job(p,'small',px,f'{R}/extension/toolbar-{px}.png'))
    jobs.append(job(p,'sq',512,f'{R}/extension/store-512.png'))
    for px in (16,32): jobs.append(job(p,'small',px,f'{R}/web/favicon-{px}.png'))
    with ThreadPoolExecutor(4) as ex: list(ex.map(lambda j: render_png(*j),jobs))

if __name__=='__main__':
    (main_chrome if len(sys.argv)>2 and sys.argv[2]=='chrome' else main)()
