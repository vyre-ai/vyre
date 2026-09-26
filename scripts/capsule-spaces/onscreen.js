ObjC.import('CoreGraphics'); ObjC.import('AppKit');
function run(argv) {
  const list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, 0));
  const out = [];
  for (let i = 0; i < list.count; i++) { const w = list.objectAtIndex(i); out.push({ pid: w.objectForKey('kCGWindowOwnerPID').js, owner: w.objectForKey('kCGWindowOwnerName').js, layer: w.objectForKey('kCGWindowLayer').js, name: (w.objectForKey('kCGWindowName') || $()).js }); }
  const f = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  return JSON.stringify({ front: { pid: f.processIdentifier, name: f.localizedName.js }, windows: out.filter(w => !argv.length || argv.includes(String(w.pid))) });
}
