"""Hand-tuned 16 x 16 pixel grid for the Vyre for Chrome icon (Chrome toolbar and favicon).
Writes icon-16.png, and icon-32.png as an exact 2x of the same grid. Needs ImageMagick.
Usage: python3 chrome16.py <export/chrome dir>"""
import subprocess, sys, os
OUT=sys.argv[1]
TILE='#171513'; EDGE_T='#3A3733'; EDGE_L='#2C2925'; EDGE_B='#0B0A09'
BONE='#EDE8DC'; FILL='#26221F'; BAR='#4C4640'; LINE='#6B665D'; DIM='#3F3A35'; HALO='#5A5247'; WHITE='#FFFFFF'
P={}
def put(x,y,c): P[(x,y)]=c
clipped={(0,0),(1,0),(0,1),(14,0),(15,0),(15,1),(0,14),(0,15),(1,15),(15,14),(15,15),(14,15)}
for y in range(16):
    for x in range(16):
        if (x,y) in clipped: continue
        c=TILE
        if y==0: c=EDGE_T
        elif x==0: c=EDGE_L
        elif y==15 or x==15: c=EDGE_B
        put(x,y,c)
# window silhouette: tab (x3..7, y3..5) merged into body (x2..13, y5..12)
out=[(4,3),(5,3),(6,3),(3,4),(7,4),(2,5),(3,5)]+[(x,5) for x in range(8,13)]+[(13,5)]
out+=[(2,y) for y in range(6,12)]+[(13,y) for y in range(6,12)]+[(x,12) for x in range(3,13)]+[(2,12),(13,12)]
for pt in out: put(*pt,BONE)
for y in range(6,12):
    for x in range(3,13): put(x,y,FILL)
for x in (4,5,6):
    put(x,4,FILL); put(x,5,FILL)
# toolbar divider, bar, bead, halo
for x in range(3,13): put(x,8,DIM)
for x in range(7,12):
    put(x,6,BAR); put(x,7,BAR)
put(3,6,HALO); put(3,7,HALO); put(6,6,HALO); put(6,7,HALO)
for pt in ((4,6),(5,6),(4,7),(5,7)): put(*pt,WHITE)
# content lines
for x in range(4,10): put(x,9,LINE)
for x in range(4,8): put(x,10,DIM)
def render(scale,path):
    cmd=['magick','-size',f'{16*scale}x{16*scale}','xc:none']
    for (x,y),c in sorted(P.items()):
        cmd+=['-fill',c,'-draw',f'rectangle {x*scale},{y*scale} {x*scale+scale-1},{y*scale+scale-1}']
    cmd.append('PNG32:'+path)
    subprocess.run(cmd,check=True)
os.makedirs(os.path.join(OUT,'extension'),exist_ok=True); os.makedirs(os.path.join(OUT,'web'),exist_ok=True)
render(1,os.path.join(OUT,'extension','icon-16.png')); render(2,os.path.join(OUT,'extension','icon-32.png'))
render(1,os.path.join(OUT,'web','favicon-16.png')); render(2,os.path.join(OUT,'web','favicon-32.png'))
