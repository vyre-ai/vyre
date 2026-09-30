import sys, os
import export as E
from export import full_sq, template, wrap, DEFS_INNER
OUTF=sys.argv[2]
def icon_inline(size):
    return f'<svg class="micon" {E.NS} width="{size}" height="{size}" viewBox="0 0 1024 1024"><defs>{DEFS_INNER}</defs>{full_sq("lumen",sig=False)}</svg>'
glyph='''<svg class="gl" viewBox="0 0 1024 1024" width="26" height="26"><mask id="gm"><rect width="1024" height="1024" fill="#fff"/><circle cx="716" cy="308" r="150" fill="#000"/></mask>
<circle class="gr" cx="480" cy="548" r="340" pathLength="1" fill="none" stroke="currentColor" stroke-width="112" stroke-linecap="round" mask="url(#gm)" transform="rotate(-90 480 548)"/><circle class="gb" cx="716" cy="308" r="98" fill="currentColor"/></svg>'''
html=f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Vyre Lumen motion</title>
<style>
:root{{--bg:#0E0D0C;--panel:#161513;--rule:#2B2926;--text:#F1EEE6;--text2:#B3AEA4;--label:#8C877D;--hover:#1E1C1A}}
*{{box-sizing:border-box}}body{{margin:0;background:var(--bg);color:var(--text);font:14px/21px "Instrument Sans",-apple-system,sans-serif;padding:40px 24px 80px}}
.wrap{{max-width:900px;margin:0 auto}}h1{{font-size:26px;margin:0 0 6px}}p{{color:var(--text2);max-width:640px}}h2{{font-size:16px;margin:36px 0 6px}}
button{{font:600 12px "Instrument Sans",sans-serif;height:32px;padding:0 14px;border-radius:8px;background:var(--hover);color:var(--text);border:1px solid #3A3733;cursor:pointer;margin-right:8px}}
.stage{{position:relative;height:220px;border-radius:18px;background:radial-gradient(500px 240px at 20% 0,#3a332b,transparent 70%),linear-gradient(140deg,#5c5247,#262d36);margin:12px 0;overflow:hidden}}
.open{{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);display:flex;align-items:center;gap:20px;opacity:0}}
.open .lt{{font:600 38px/1 "Instrument Sans",sans-serif;letter-spacing:-.02em;opacity:0}}.open .lt b{{opacity:.62;font-weight:600}}
.open .micon{{filter:drop-shadow(0 16px 18px rgba(0,0,0,.5))}}
.bar{{position:absolute;left:50%;top:50%;width:min(560px,86%);height:52px;transform:translate(-50%,-50%);border-radius:14px;background:rgba(20,18,16,.42);backdrop-filter:blur(30px) saturate(1.5);-webkit-backdrop-filter:blur(30px) saturate(1.5);box-shadow:inset 0 0 0 1px rgba(255,255,255,.2),0 24px 50px -20px rgba(0,0,0,.6);display:flex;align-items:center;gap:12px;padding:0 16px;opacity:0;color:#F1EEE6}}
.bar .ph{{color:rgba(241,238,230,.6);font-size:15px}}
.flare{{transform:scale(0);opacity:0}}
.gr{{stroke-dasharray:1;stroke-dashoffset:1}}.gb{{opacity:0}}
.stage.open-on .open{{animation:hold 1600ms linear both}}
.stage.open-on .micon{{animation:tile 320ms cubic-bezier(.2,.7,.2,1) both}}
.stage.open-on .flare{{animation:bloom 260ms ease-out 380ms both}}
.stage.open-on .lt{{animation:lt 300ms ease-out 640ms both}}
.stage.summon-on .bar{{animation:barin 220ms ease-out both}}
.stage.summon-on .gr{{animation:draw 260ms ease-out 60ms both}}.stage.summon-on .gb{{animation:pop 160ms ease-out 260ms both}}
@keyframes hold{{0%{{opacity:1}}82%{{opacity:1}}100%{{opacity:0}}}}
@keyframes tile{{from{{opacity:0;transform:scale(.94)}}to{{opacity:1;transform:none}}}}
@keyframes bloom{{from{{transform:scale(0);opacity:0}}60%{{opacity:1}}to{{transform:scale(1);opacity:1}}}}
@keyframes lt{{from{{opacity:0;transform:translateX(8px)}}to{{opacity:1;transform:none}}}}
@keyframes barin{{from{{opacity:0;transform:translate(-50%,-46%)}}to{{opacity:1;transform:translate(-50%,-50%)}}}}
@keyframes draw{{to{{stroke-dashoffset:0}}}}@keyframes pop{{from{{opacity:0}}to{{opacity:1}}}}
@media (prefers-reduced-motion:reduce){{.stage *{{animation-duration:1ms!important;animation-delay:0s!important}}}}
</style></head><body><div class="wrap"><h1>Vyre Lumen motion</h1><p>Two moments, both quiet, both in the same glass as the icon. No glow pulse, no bounce, nothing loops.</p>
<h2>Open, first launch and app start (1.6 s)</h2><p>The tile eases in (320 ms), the lens catches its point of light (flare blooms from 0 at 380 ms, 260 ms), the "Vyre Lumen" lockup slides in 8 px and fades in (from 640 ms, 300 ms), then everything fades out over the last 300 ms.</p>
<div class="stage" id="s1"><div class="open">{icon_inline(150)}<span class="lt"><b>Vyre</b> Lumen</span></div></div><button data-m="open-on" data-s="s1">Replay open</button>
<h2>Summon, every time (260 ms)</h2><p>The bar arrives over 220 ms (opacity and a 4 px rise). Inside it the lens mark draws: the ring strokes round over 260 ms starting at 60 ms, the bead fades in at 260 ms over 160 ms. Dismiss is a plain fade with no mark animation. Reduced motion: shown at once.</p>
<div class="stage" id="s2"><div class="bar">{glyph}<span class="ph">Search apps, files and commands</span></div></div><button data-m="summon-on" data-s="s2">Replay summon</button>
<script>const run=(id,m)=>{{const st=document.getElementById(id);st.className='stage';void st.offsetWidth;st.classList.add(m)}};document.querySelectorAll('button').forEach(b=>b.onclick=()=>run(b.dataset.s,b.dataset.m));run('s1','open-on');run('s2','summon-on');</script>
</div></body></html>'''
open(OUTF,'w').write(html)
