#!/usr/bin/env python3
"""Type text into the VM's console through the QEMU monitor (for when ssh is not up yet).
   usage: type.py 'text'   (append \\n in the text to press Enter)   Runs on the testbox."""
import socket, sys, time
MON = "/srv/vyre-test/win11/run/monitor.sock"
SHIFT = {'!':'1','@':'2','#':'3','$':'4','%':'5','^':'6','&':'7','*':'8','(':'9',')':'0','_':'minus','+':'equal','{':'bracket_left','}':'bracket_right','|':'backslash',':':'semicolon','"':'apostrophe','<':'comma','>':'dot','?':'slash','~':'grave_accent'}
PLAIN = {' ':'spc','-':'minus','=':'equal','[':'bracket_left',']':'bracket_right','\\':'backslash',';':'semicolon',"'":'apostrophe',',':'comma','.':'dot','/':'slash','`':'grave_accent','\n':'ret','\t':'tab'}
def key(c):
    if c.isalpha() and c.isupper(): return 'shift-' + c.lower()
    if c.isalnum(): return c
    if c in SHIFT: return 'shift-' + SHIFT[c]
    return PLAIN[c]
s = socket.socket(socket.AF_UNIX); s.connect(MON); s.settimeout(1)
try: s.recv(4096)
except Exception: pass
for c in sys.argv[1].encode().decode('unicode_escape'):
    s.sendall(('sendkey ' + key(c) + '\n').encode()); time.sleep(0.06)
    try: s.recv(4096)
    except Exception: pass
