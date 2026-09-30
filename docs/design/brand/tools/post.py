import os, sys, json, subprocess, shutil, glob
import export as E
from export import PROD, OUT, full_sq, wrap, render_png
T=json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)),'text.json')))
sh=lambda *a: subprocess.run(a,check=True)

def lockup_svg(p,theme):
    name=PROD[p][0]; H=96; fs=60; gap=22; sc=fs/100
    ink='#F1EEE6' if theme=='dark' else '#141311'
    vw=T['Vyre']['w']*sc; sp=T['space']*sc; nw=T[name]['w']*sc
    W=H+gap+vw+sp+nw+4
    base=H/2+fs*0.7/2
    icon=full_sq(p,sig=False)
    txt=(f'<g transform="translate({H+gap} {base:.1f}) scale({sc})" fill="{ink}" stroke="{ink}" stroke-width="2.6" stroke-linejoin="round">'
         f'<path d="{T["Vyre"]["d"]}" opacity=".62"/></g>'
         f'<g transform="translate({H+gap+vw+sp:.1f} {base:.1f}) scale({sc})" fill="{ink}" stroke="{ink}" stroke-width="2.6" stroke-linejoin="round"><path d="{T[name]["d"]}"/></g>')
    inner=f'<svg x="0" y="0" width="{H}" height="{H}" viewBox="0 0 1024 1024">{icon}</svg>{txt}'
    return f'<svg {E.NS} width="{W:.0f}" height="{H}" viewBox="0 0 {W:.1f} {H}" role="img" aria-label="Vyre {name}"><defs>{E.DEFS_INNER}{E.EXTRA}</defs>{inner}</svg>', W, H

def main():
    jobs=[]
    for p,(name,_) in PROD.items():
        if p in ('chrome','vyre'): continue
        R=os.path.join(OUT,p)
        # icns
        sh('iconutil','-c','icns',os.path.join(R,'macos',f'{name}.iconset'),'-o',os.path.join(R,'macos',f'{name}.icns'))
        # windows ico
        W=os.path.join(R,'windows')
        sizes=(16,20,24,32,40,48,64,96,128,256)
        sh('magick',*[f'{W}/png/{p}-{s}.png' for s in sizes],os.path.join(W,f'{p}.ico'))
        for col in ('white','black'):
            sh('magick',*[f'{W}/tray/{p}-tray-{col}-{s}.png' for s in (16,20,24,32)],os.path.join(W,f'{p}-tray-{col}.ico'))
        # favicon.ico
        Wb=os.path.join(R,'web')
        sh('magick',*[f'{Wb}/favicon-{s}.png' for s in (16,32,48)],os.path.join(Wb,'favicon.ico'))
        shutil.copy(os.path.join(R,f'{p}-small.svg'),os.path.join(Wb,'favicon.svg'))
        # ios contents
        open(os.path.join(R,'ios','Contents.json'),'w').write(json.dumps({"images":[{"filename":"AppIcon-1024.png","idiom":"universal","platform":"ios","size":"1024x1024"}],"info":{"author":"xcode","version":1}},indent=2))
        # android round + xml
        A=os.path.join(R,'android')
        for d,l in {'mdpi':48,'hdpi':72,'xhdpi':96,'xxhdpi':144,'xxxhdpi':192}.items():
            out=f'{A}/mipmap-{d}/ic_launcher_round.png'
            ns=f'{E.TMP}/{p}-sqns.png'; render_png(E.art_svg(full_sq(p,sig=False,clip=False),256),256,256,ns)
            sh('magick',ns,'-resize',f'{l}x{l}','(','-size',f'{l}x{l}','xc:black','-fill','white','-draw',f'circle {l/2},{l/2} {l/2},0',')','-alpha','off','-compose','CopyOpacity','-composite',out)
        os.makedirs(f'{A}/mipmap-anydpi-v26',exist_ok=True)
        open(f'{A}/mipmap-anydpi-v26/ic_launcher.xml','w').write('<?xml version="1.0" encoding="utf-8"?>\n<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n    <background android:drawable="@drawable/ic_launcher_background"/>\n    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>\n    <monochrome android:drawable="@mipmap/ic_launcher_monochrome"/>\n</adaptive-icon>\n')
        open(os.path.join(Wb,f'{p}-glyph.svg'),'w').write(f'<svg {E.NS} viewBox="0 0 1024 1024" width="24" height="24" fill="currentColor">{E.template(p,"currentColor")}</svg>')
        os.makedirs(f'{A}/drawable-nodpi',exist_ok=True); shutil.copy(f'{A}/ic_launcher_background.png',f'{A}/drawable-nodpi/ic_launcher_background.png'); os.remove(f'{A}/ic_launcher_background.png')
        # lockups
        L=os.path.join(R,'lockup'); os.makedirs(L,exist_ok=True)
        for th in ('dark','light'):
            svg,w,h=lockup_svg(p,th)
            open(f'{L}/{p}-lockup-{th}.svg','w').write(svg)
            jobs.append((svg.replace(f'width="{w:.0f}" height="{h}"',f'width="{int(w*2)}" height="{h*2}"'),int(w*2),h*2,f'{L}/{p}-lockup-{th}@2x.png'))
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(4) as ex: list(ex.map(lambda j: render_png(*j),jobs))
def post_chrome():
    p='chrome'; R=os.path.join(OUT,p); L=os.path.join(R,'lockup'); os.makedirs(L,exist_ok=True); jobs=[]
    for th in ('dark','light'):
        svg,w,h=lockup_svg(p,th); open(f'{L}/{p}-lockup-{th}.svg','w').write(svg)
        jobs.append((svg.replace(f'width="{w:.0f}" height="{h}"',f'width="{int(w*2)}" height="{h*2}"'),int(w*2),h*2,f'{L}/{p}-lockup-{th}@2x.png'))
    sh('magick',*[f'{R}/web/favicon-{s}.png' for s in (16,32)],f'{R}/web/favicon.ico')
    shutil.copy(f'{R}/chrome-small.svg',f'{R}/web/favicon.svg')
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(4) as ex: list(ex.map(lambda j: render_png(*j),jobs))
def post_vyre():
    p='vyre'; R=os.path.join(OUT,p); A=f'{R}/android'; Wb=f'{R}/web'
    sh('magick',*[f'{Wb}/favicon-{s}.png' for s in (16,32,48)],f'{Wb}/favicon.ico'); shutil.copy(f'{R}/vyre-small.svg',f'{Wb}/favicon.svg')
    open(f'{Wb}/vyre-glyph.svg','w').write(f'<svg {E.NS} viewBox="0 0 1024 1024" width="24" height="24" fill="currentColor">{E.template(p,"currentColor")}</svg>')
    open(f'{R}/ios/Contents.json','w').write(json.dumps({"images":[{"filename":"AppIcon-1024.png","idiom":"universal","platform":"ios","size":"1024x1024"}],"info":{"author":"xcode","version":1}},indent=2))
    ns=f'{E.TMP}/vyre-sqns.png'; render_png(E.art_svg(full_sq(p,sig=False,clip=False),256),256,256,ns)
    for d,l in {'mdpi':48,'hdpi':72,'xhdpi':96,'xxhdpi':144,'xxxhdpi':192}.items():
        sh('magick',ns,'-resize',f'{l}x{l}','(','-size',f'{l}x{l}','xc:black','-fill','white','-draw',f'circle {l/2},{l/2} {l/2},0',')','-alpha','off','-compose','CopyOpacity','-composite',f'{A}/mipmap-{d}/ic_launcher_round.png')
    os.makedirs(f'{A}/mipmap-anydpi-v26',exist_ok=True)
    open(f'{A}/mipmap-anydpi-v26/ic_launcher.xml','w').write('<?xml version="1.0" encoding="utf-8"?>\n<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n    <background android:drawable="@drawable/ic_launcher_background"/>\n    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>\n    <monochrome android:drawable="@mipmap/ic_launcher_monochrome"/>\n</adaptive-icon>\n')

if __name__=='__main__': {'chrome':post_chrome,'vyre':post_vyre}.get(sys.argv[2] if len(sys.argv)>2 else '',main)()
