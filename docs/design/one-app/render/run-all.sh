#!/bin/sh
# Runs on testbox inside the synced folder. One board at a time (the box is shared).
CHROME=${CHROME:-/usr/local/bin/vyre-chrome}
BOARDS=${*:-$(ls *.dc.html | sed 's/\.dc\.html$//')}
: > png/summary.txt
for b in $BOARDS; do
  size=$(node size.cjs "$b.dc.html")
  h=${size#*,}; w=${size%,*}; size="$w,$((h+200))"
  flags="--headless=new --use-mock-keychain --password-store=basic --no-sandbox --disable-gpu --hide-scrollbars --allow-file-access-from-files --force-device-scale-factor=1 --virtual-time-budget=8000 --window-size=$size"
  "$CHROME" $flags --screenshot="png/$b.png" "file://$PWD/$b.dc.html" >/dev/null 2>&1
  "$CHROME" $flags --dump-dom "file://$PWD/$b.dc.html" 2>/dev/null > png/$b.dom.html
  node -e '
    const fs=require("fs"); const b=process.argv[1];
    const m=/<pre id="dc-audit"[^>]*>([\s\S]*?)<\/pre>/.exec(fs.readFileSync("png/"+b+".dom.html","utf8"));
    if(!m){console.log("FAIL "+b+": no audit (render failed)");process.exit()}
    const a=JSON.parse(m[1].replace(/&quot;/g,"\"").replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">"));
    const off=a.offscale||[]; const bad=a.fails.length+a.clipped.length+off.length;
    console.log((bad?"FAIL ":"ok   ")+b+": "+a.fails.length+" contrast, "+a.clipped.length+" clipped, "+off.length+" off-system");
    for(const f of a.fails) console.log("     contrast "+f.ratio+"<"+f.min+" \""+f.text+"\" "+f.color+" on "+f.bg+" ."+f.cls);
    for(const c of a.clipped.slice(0,8)) console.log("     clipped \""+c+"\"");
    for(const o of off.slice(0,12)) console.log("     off-system "+o);
  ' "$b" >> png/summary.txt
  rm -f png/$b.dom.html
done
