// @ts-check
// How the three typed kinds look (app-design's team/0.2/artifact-renderers.html): Bone tokens only,
// dark by default and paper on a light scheme, no hue. Artifact content never sets its own colours
// or CSS; everything here is drawn by Vyre from these tokens.

export const TOKENS = `:root{color-scheme:light dark;--bg:#F4F1EA;--panel:#FBFAF6;--hover:#EEEAE2;--rule:#DCD7CC;--rs:#C9C3B7;--text:#141311;--t2:#4A463F;--label:#6B665D;--focus:#141311;--s1:#141311;--s2:#6B665D;--bo:#CFC9BD;--ink:#F4F1EA;--slide:#FBFAF6}
@media (prefers-color-scheme:dark){:root{--bg:#0E0D0C;--panel:#161513;--hover:#1E1C1A;--rule:#2B2926;--rs:#3A3733;--text:#F1EEE6;--t2:#B3AEA4;--label:#8C877D;--focus:#F1EEE6;--s1:#F1EEE6;--s2:#A9A398;--bo:#3F3A35;--ink:#0E0D0C;--slide:#0E0D0C}}
*{box-sizing:border-box}body{margin:0;background:var(--panel);color:var(--text);font:13px/18px var(--font,"Instrument Sans",-apple-system,"Helvetica Neue",Arial,sans-serif);overflow-wrap:anywhere}h1,h2,h3{font-family:var(--hfont,inherit)}
.pbody{padding:14px 16px 16px}h1{font-size:15px;line-height:20px;margin:0 0 10px}.lab{font-size:11px;color:var(--label)}
.state{border:1px solid var(--rule);border-left:2px solid var(--rs);border-radius:10px;padding:12px 14px;margin:0 0 12px}.state b{display:block;font-size:13px;margin-bottom:2px}.state span{color:var(--t2);font-size:12px}
pre.src{font:12px/18px ui-monospace,Menlo,monospace;background:var(--bg);border:1px solid var(--rule);border-radius:8px;padding:10px 12px;margin:8px 0 0;overflow:auto;white-space:pre}
.tabs{display:flex;gap:4px;margin:0 0 12px}.tabs label{height:28px;padding:0 12px;border-radius:999px;color:var(--label);font-weight:600;font-size:12px;line-height:28px;cursor:pointer}
input.r{position:absolute;opacity:0;pointer-events:none}input.r:focus-visible+label,input.r:focus-visible~.tabs label{outline:2px solid var(--focus);outline-offset:2px}
.note{border:1px solid var(--rule);border-radius:8px;padding:8px 10px;margin:0 0 12px;color:var(--t2);font-size:12px}`;

export const CHART_CSS = `.stats{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:0 0 14px}.stat{border:1px solid var(--rule);border-radius:10px;padding:10px 12px}
.stat .n{font-size:28px;line-height:32px;font-weight:600}.stat .l{font-size:11px;color:var(--label)}.stat .c{font-size:11px;color:var(--t2)}
#vt-chart:checked~.tabs label[for=vt-chart],#vt-table:checked~.tabs label[for=vt-table]{background:var(--hover);color:var(--text)}
.pane-table{display:none}#vt-table:checked~.pane-chart{display:none}#vt-table:checked~.pane-table{display:block}
.chart{width:100%;height:auto;display:block;overflow:visible}.chart .grid{stroke:var(--rule);stroke-width:1}.chart text{font:10px ui-monospace,Menlo,monospace;fill:var(--label)}
.chart text.v{fill:var(--text);font-weight:600}.chart text.nm{fill:var(--t2)}.chart .ring{stroke:var(--panel);stroke-width:2}
.chart .tip{opacity:0;pointer-events:none}.chart .hit{fill:transparent}.chart .hit:hover+.tip,.chart .hit:focus+.tip{opacity:1}.chart .hit:focus{outline:none}
.chart .tip rect{fill:var(--hover);stroke:var(--rs);stroke-width:1}.chart .tip text{fill:var(--text);font:11px -apple-system,Arial,sans-serif}.chart .tip line{stroke:var(--rs);stroke-dasharray:3 3}
.legend{display:flex;gap:14px;flex-wrap:wrap;margin:8px 0 0;font-size:11px;color:var(--t2)}.legend svg{width:24px;height:10px;vertical-align:middle;margin-right:6px}
table.data{border-collapse:collapse;width:100%;font-size:12px}table.data th,table.data td{border-bottom:1px solid var(--rule);padding:6px 8px;text-align:left}table.data th{color:var(--label);font-weight:600}table.data td.num{font-variant-numeric:tabular-nums}`;

export const DIAGRAM_CSS = `.fig{border:1px solid var(--rule);border-radius:10px;background:var(--bg);overflow:auto;max-height:70vh;padding:8px}
.fig svg{display:block;margin:0 auto;height:auto}.fig img{display:block;max-width:100%;height:auto;margin:0 auto}
input.z{position:absolute;opacity:0;pointer-events:none}
.ctl{display:flex;flex-wrap:wrap;gap:4px;align-items:center;margin:0 0 8px;font-size:11px;color:var(--label)}.ctl label{white-space:nowrap;height:24px;line-height:24px;padding:0 10px;border-radius:8px;border:1px solid var(--rs);color:var(--text);font-weight:600;cursor:pointer}
#z-fit:checked~.ctl label[for=z-fit],#z-100:checked~.ctl label[for=z-100],#z-150:checked~.ctl label[for=z-150],#z-200:checked~.ctl label[for=z-200],#src:checked~.ctl label[for=src]{background:var(--hover)}
input.z:focus-visible~.ctl label{outline:1px solid var(--focus)}
#z-100:checked~.fig svg{width:var(--w)}#z-150:checked~.fig svg{width:calc(var(--w)*1.5)}#z-200:checked~.fig svg{width:calc(var(--w)*2)}#z-fit:checked~.fig svg{width:max(100%,calc(var(--w)*.84));max-width:none}
.srcpane{display:none}#src:checked~.srcpane{display:block}#src:checked~.fig{display:none}
.dt{font:600 12px -apple-system,"Helvetica Neue",Arial,sans-serif;fill:var(--text)}.de{stroke:var(--t2);stroke-width:1.5;fill:none}.de.thick{stroke-width:2.6}.dl{font:11px -apple-system,Arial,sans-serif;fill:var(--label)}.dg{fill:none;stroke:var(--rule);stroke-dasharray:4 3}.dgt{font:11px -apple-system,Arial,sans-serif;fill:var(--label)}.dah{stroke:var(--t2);fill:none;stroke-width:1.5}
.dlg{fill:var(--bg);opacity:.85}.seqlife{stroke:var(--rule);stroke-dasharray:4 3}`;

export const DECK_CSS = `.deck{container-type:normal}.stage{position:relative}
.slide{container-type:inline-size;aspect-ratio:16/9;background:var(--slide);border:1px solid var(--rule);border-radius:10px;overflow:hidden;position:relative}
.slide .sc{position:absolute;inset:0;padding:var(--pad,9cqw);display:flex;flex-direction:column;justify-content:var(--valign,center);gap:2.4cqw;text-align:var(--align,left);align-items:var(--ai,stretch)}
.slide .logo{position:absolute;z-index:1;height:auto;margin:3cqw}.slide .logo.tl{top:0;left:0}.slide .logo.tr{top:0;right:0}.slide .logo.bl{bottom:0;left:0}.slide .logo.br{bottom:0;right:0}
.slide h1{font-size:7.4cqw;line-height:1.1;margin:0;font-weight:600}.slide h2{font-size:5.2cqw;line-height:1.15;margin:0;font-weight:600}.slide h3{font-size:4cqw;margin:0;font-weight:600}
.slide p,.slide li{font-size:3.3cqw;line-height:1.4;color:var(--t2);margin:0}.slide ul,.slide ol{margin:0;padding-left:4cqw;display:flex;flex-direction:column;gap:1.2cqw}
.slide .eyebrow{font-size:2.4cqw;color:var(--label)}.slide .big{font-size:20cqw;line-height:1;font-weight:600;margin:0;color:var(--text)}.slide blockquote{margin:0;font-size:4.6cqw;line-height:1.3;color:var(--text);border:0;padding:0}
.slide .cols{display:grid;grid-template-columns:1fr 1fr;gap:5cqw}.slide figure{margin:0;display:flex;flex-direction:column;gap:1.6cqw;min-height:0}.slide figure img{max-width:100%;max-height:46cqw;object-fit:contain}.slide figcaption{font-size:2.6cqw;color:var(--label)}
.frame{display:none}.frame:target,.frame.first{display:block}.frame:target~.frame.first{display:none}
.nav{display:flex;align-items:center;gap:8px;margin:8px 0;font-size:11px;color:var(--label)}.nav a,.nav label{height:24px;line-height:24px;padding:0 10px;border-radius:8px;border:1px solid var(--rs);color:var(--text);text-decoration:none;font-weight:600;cursor:pointer}.nav .sp{flex:1}.nav a.off{opacity:.4;pointer-events:none}
.strip{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin:10px 0 0}.strip a{display:block;position:relative;border:1px solid var(--rule);border-radius:6px;overflow:hidden;text-decoration:none;color:inherit}
.strip a:focus-visible{outline:2px solid var(--focus)}.strip .slide{border:0;border-radius:0}.strip b{position:absolute;top:2px;left:4px;font:10px ui-monospace,Menlo,monospace;color:var(--label);z-index:1}
.notes{display:none;border:1px solid var(--rule);border-radius:8px;padding:8px 10px;margin-top:8px;color:var(--t2);font-size:12px;white-space:pre-wrap}
#sn:checked~.stage .notes{display:block}
@media (prefers-reduced-motion:no-preference){.frame:target,.frame.first{animation:fade .2s}}@keyframes fade{from{opacity:.25}to{opacity:1}}`;
