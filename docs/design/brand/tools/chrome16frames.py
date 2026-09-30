"""Working animation frames for the Vyre for Chrome toolbar icon: the white bead travels along the
address bar and back (16 x 16 pixel grid, same art as chrome16.py). Writes frames/working-00..11.png
and working-sprite.png (12 frames side by side) into <export/chrome/extension>.
Usage: python3 chrome16frames.py <export/chrome/extension dir>"""
import subprocess, sys, os
OUT=os.path.join(sys.argv[1],'frames'); os.makedirs(OUT,exist_ok=True)
TILE='#171513'; EDGE_T='#3A3733'; EDGE_L='#2C2925'; EDGE_B='#0B0A09'
BONE='#EDE8DC'; FILL='#26221F'; BAR='#4C4640'; LINE='#6B665D'; DIM='#3F3A35'; HALO='#5A5247'; WHITE='#FFFFFF'
def grid(bx):
    P={}
    clipped={(0,0),(1,0),(0,1),(14,0),(15,0),(15,1),(0,14),(0,15),(1,15),(15,14),(15,15),(14,15)}
    for y in range(16):
        for x in range(16):
            if (x,y) in clipped: continue
            P[(x,y)]=EDGE_T if y==0 else EDGE_L if x==0 else EDGE_B if (y==15 or x==15) else TILE
    out=[(4,3),(5,3),(6,3),(3,4),(7,4),(2,5),(3,5)]+[(x,5) for x in range(8,14)]
    out+=[(2,y) for y in range(6,12)]+[(13,y) for y in range(6,12)]+[(x,12) for x in range(2,14)]
    for pt in out: P[pt]=BONE
    for y in range(6,12):
        for x in range(3,13): P[(x,y)]=FILL
    for x in (4,5,6):
        P[(x,4)]=FILL; P[(x,5)]=FILL
    for x in range(3,13): P[(x,8)]=DIM
    for x in range(3,13): P[(x,6)]=BAR; P[(x,7)]=BAR
    for x in (bx-1,bx+2):
        if 3<=x<=12: P[(x,6)]=HALO; P[(x,7)]=HALO
    for pt in ((bx,6),(bx+1,6),(bx,7),(bx+1,7)): P[pt]=WHITE
    for x in range(4,10): P[(x,9)]=LINE
    for x in range(4,8): P[(x,10)]=DIM
    return P
seq=[4,5,6,7,8,9,10,9,8,7,6,5]
files=[]
for i,bx in enumerate(seq):
    P=grid(bx); path=os.path.join(OUT,f'working-{i:02d}.png'); cmd=['magick','-size','16x16','xc:none']
    for (x,y),c in sorted(P.items()): cmd+=['-fill',c,'-draw',f'point {x},{y}']
    cmd.append('PNG32:'+path); subprocess.run(cmd,check=True); files.append(path)
subprocess.run(['magick',*files,'+append','PNG32:'+os.path.join(OUT,'working-sprite.png')],check=True)
