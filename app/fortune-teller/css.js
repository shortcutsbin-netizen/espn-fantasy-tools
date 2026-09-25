// The token block, tool header, section header and footer rules every React
// tool shares, taken verbatim from the LLM Data Export so this sample matches.
export const CHROME_CSS = `
:root {
  --fs-micro: 9px; --fs-small: 11px; --fs-base: 13px; --fs-lg: 16px;
  --sp-1: 6px; --sp-2: 14px; --sp-3: 26px; --sp-4: clamp(36px, 5vw, 58px);
  --ease-out: cubic-bezier(.22,.7,.3,1); --ease-io: cubic-bezier(.5,0,.2,1);
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
}
* { box-sizing:border-box; }
button { -webkit-tap-highlight-color:transparent; font-family:inherit; }
.wrap { display:flex; flex-direction:column; }
/* --- tool header --------------------------------------------------------- */
.toolhead { display:flex; align-items:center; gap:18px; padding:0 0 var(--sp-2);
  border-bottom:1px solid var(--line); }
.toolmark { flex:none; width:min(46%,340px); }
.toolmark, .homelink { display:block; text-decoration:none; color:inherit; }
.toolid { flex:1; min-width:0; text-align:right; }
.toolid .eyebrow { margin-bottom:4px; justify-content:flex-end; }
.toolid .eyebrow::after { display:none; }
.toolleague { font-size:clamp(15px,2.4vw,22px); font-weight:900; letter-spacing:-.02em;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  background:linear-gradient(96deg,var(--ink) 30%,var(--accent) 130%);
  -webkit-background-clip:text; background-clip:text;
  color:transparent; -webkit-text-fill-color:transparent; }
.toolctl { flex:none; display:flex; gap:4px; position:relative; }
.toolctl .settings { top:38px; }
@media (max-width:700px) {
  .toolhead { flex-wrap:wrap; gap:10px; }
  .toolmark { width:calc(100% - 74px); }
  .toolid { width:100%; text-align:left; order:3; }
  .toolid .eyebrow { justify-content:flex-start; }
}
.toolmark:hover .mark .m2 { fill:var(--accent); }
/* --- section headers ------------------------------------------------------ */
.sechead { display:flex; flex-wrap:wrap; align-items:center; gap:10px var(--sp-2);
  margin:var(--sp-4) 0 var(--sp-3); }
.sechead::before { content:""; width:9px; height:9px; background:var(--accent);
  transform:rotate(45deg); flex:none; }
.sechead .t { font-size:clamp(15px,2.2vw,21px); font-weight:900; letter-spacing:.18em;
  text-transform:uppercase; line-height:1.1; flex:0 1 auto; min-width:0; overflow-wrap:anywhere;
  background:linear-gradient(94deg,var(--ink) 10%,var(--accent) 150%);
  -webkit-background-clip:text; background-clip:text;
  color:transparent; -webkit-text-fill-color:transparent; }
.sechead .rule { flex:1 1 32px; min-width:32px; height:1px;
  background:linear-gradient(90deg,var(--line-2),transparent); }
/* The subtitle drops to its own line rather than pushing past the edge. */
.sechead .count { flex:0 1 auto; max-width:100%; font-size:var(--fs-micro); font-weight:900;
  letter-spacing:.14em; text-transform:uppercase; color:var(--ink-3); line-height:1.3;
  overflow-wrap:anywhere; }
.ctlrow .grow { flex:1 1 auto; }
.toolfoot { margin-top:var(--sp-2); padding:10px 0 4px; text-align:center;
  border-top:1px solid var(--line); }
.toolfoot .gh { display:inline-flex; align-items:center; gap:7px; color:var(--ink-3);
  font-size:10px; text-transform:uppercase; letter-spacing:.16em; font-weight:900;
  text-decoration:none; }
.toolfoot .gh::before { content:""; width:5px; height:5px; background:currentColor;
  transform:rotate(45deg); }
.toolfoot .gh:hover { color:var(--accent); }
`;

// Fortune Teller's own styles, on the site's tokens from src/ui.js. Motion is
// transform and opacity only, 220-320ms, and stills under reduce-motion.
export const FT_CSS = `
.pickrow { margin:var(--sp-3) 0 0; }
.ftbtn:focus-visible, .seg:focus-visible, .mv:focus-visible, .grip:focus-visible, .sttoggle:focus-visible,
.jump:focus-visible, .seg2 button:focus-visible { outline:2px solid var(--sky); outline-offset:2px; }
.chip { display:inline-flex; align-items:center; gap:6px; padding:4px 8px; font-size:9.5px; font-weight:900; letter-spacing:.12em;
  text-transform:uppercase; color:var(--ink-2); background:var(--panel-2); border:1px solid var(--line-2); white-space:nowrap; }
.chip i { width:6px; height:6px; background:currentColor; transform:rotate(45deg); flex:none; }
.chip strong { color:var(--ink); font-weight:900; }
.panelhead { flex-wrap:wrap; row-gap:4px; }
.panelhead .count { flex:0 1 auto; margin-left:6px; font-size:var(--fs-micro); font-weight:900; letter-spacing:.14em; text-transform:uppercase; color:var(--ink-3); }

/* --- hero: overall figures only ------------------------------------------------ */
.hero { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1.75fr); gap:14px; margin-top:14px; }
@media (max-width:940px) { .hero { grid-template-columns:minmax(0,1fr); } }
.hero .panel { margin:0; }
.gaugewrap { position:relative; width:min(270px,100%); margin:-4px auto 0; }
.gauge { display:block; width:100%; height:auto; overflow:visible; }
.gauge .gtrack { fill:none; stroke:var(--inset); stroke-width:12; stroke-linecap:round; }
.gauge .gval { fill:none; stroke:url(#gaugefill); stroke-width:12; stroke-linecap:round; }
.gauge .gglow { fill:none; stroke:url(#gaugefill); stroke-width:12; stroke-linecap:round; opacity:.45; filter:blur(7px); }
.gauge .gticks line { stroke:var(--line-2); stroke-width:1.2; } .gauge .gticks line.maj { stroke:var(--ink-3); stroke-width:1.6; }
.gauge .gend { font-size:9px; font-weight:900; letter-spacing:.08em; fill:var(--ink-3); }
.gauge .gs0 { stop-color:var(--accent-deep); } .gauge .gs1 { stop-color:var(--accent); }
.gauge.cut .gs0 { stop-color:var(--signal); } .gauge.cut .gs1 { stop-color:var(--gold); }
.gauge.out .gs0, .gauge.out .gs1 { stop-color:var(--flag); }
.gaugeval { position:absolute; left:0; right:0; top:37%; text-align:center; }
.gaugeval b { display:block; font-size:clamp(38px,4.6vw,52px); font-weight:900; letter-spacing:-.04em; line-height:1;
  background:linear-gradient(96deg,var(--ink) 25%,var(--accent) 140%); -webkit-background-clip:text; background-clip:text; color:transparent; -webkit-text-fill-color:transparent; }
.gaugeval.cut b { background:linear-gradient(96deg,var(--ink) 15%,var(--signal) 120%); -webkit-background-clip:text; background-clip:text; }
.gaugeval.out b { background:linear-gradient(96deg,var(--ink) 15%,var(--flag) 120%); -webkit-background-clip:text; background-clip:text; }
.gaugeval span { display:block; margin-top:8px; font-size:9.5px; font-weight:900; letter-spacing:.14em; text-transform:uppercase; color:var(--ink-3); }
.gaugeval span strong { color:var(--ink-2); }
.oddspanel .chips { display:flex; flex-wrap:wrap; justify-content:center; gap:6px; margin:-8px 0 0; }
.chip.st.hunt { color:var(--sky); border-color:var(--sky); } .chip.st.in { color:var(--accent); border-color:var(--accent); }
.chip.st.out { color:var(--flag); border-color:var(--flag); } .chip.own { color:var(--gold); border-color:var(--gold); }
.stats { display:grid; grid-template-columns:repeat(6,minmax(0,1fr)); gap:1px; margin-top:16px; background:var(--line); border:1px solid var(--line); }
.stat { grid-column:span 2; background:var(--panel-2); padding:10px 6px 11px; text-align:center; }
.stat.wide { grid-column:span 3; }
.stat > span { display:block; font-size:9px; font-weight:900; letter-spacing:.1em; text-transform:uppercase; color:var(--ink-3); white-space:nowrap; overflow:hidden; }
.stat b { display:block; margin-top:5px; font-size:19px; font-weight:900; letter-spacing:-.02em; color:var(--ink); font-variant-numeric:tabular-nums; }
.stat.in b { color:var(--accent); } .stat.cut b { color:var(--signal); } .stat.out b { color:var(--flag); }

/* the finish board: two zones, each headed by its share, over one place axis. It fills
   its panel, and keeps to the site's greens and muted greys rather than white. */
.hero .finpanel { display:flex; flex-direction:column; }
.fboard { --gap:8px; flex:1 1 auto; display:flex; flex-direction:column; min-height:0; }
.fzones, .fchart, .faxis { display:grid; grid-template-columns:repeat(var(--n),minmax(0,1fr)); column-gap:var(--gap); }
.fz { display:flex; flex-wrap:wrap; align-items:baseline; gap:2px 10px; padding:10px 12px 12px; border-top:2px solid var(--line-2); }
.fz.po { border-top-color:var(--accent); background:linear-gradient(180deg,color-mix(in srgb,var(--accent) 10%,transparent),color-mix(in srgb,var(--accent) 0%,transparent) 140%); }
.fz .zl { flex-basis:100%; font-size:9.5px; font-weight:900; letter-spacing:.16em; text-transform:uppercase; color:var(--ink-3); }
.fz.po .zl { color:var(--accent); }
.fz b { font-size:clamp(26px,3vw,36px); font-weight:900; letter-spacing:-.045em; line-height:1; font-variant-numeric:tabular-nums; color:var(--ink-3); }
.fz.po b { background:linear-gradient(96deg,var(--accent) 0%,var(--accent-deep) 120%); -webkit-background-clip:text; background-clip:text; color:transparent; -webkit-text-fill-color:transparent; }
.fz .zs { font-size:9px; font-weight:800; letter-spacing:.1em; text-transform:uppercase; color:var(--ink-3); opacity:.8; }
.fchart { position:relative; flex:0 0 auto; height:176px; border-bottom:1px solid var(--line-2); }
.fchart > * { grid-row:1; }
.fbg { align-self:stretch; background:repeating-linear-gradient(0deg,transparent 0 31px,color-mix(in srgb,var(--ink) 4%,transparent) 31px 32px); }
.fbg.po { background:repeating-linear-gradient(0deg,transparent 0 31px,color-mix(in srgb,var(--accent) 7%,transparent) 31px 32px), linear-gradient(180deg,color-mix(in srgb,var(--accent) 5%,transparent),color-mix(in srgb,var(--accent) 1%,transparent)); }
.fcol { position:relative; z-index:1; display:flex; flex-direction:column; align-items:center; justify-content:flex-end; gap:6px; min-width:0; padding-top:8px; }
.fv { display:flex; flex-direction:column; align-items:center; gap:3px; font-size:10px; font-weight:800; color:var(--ink-3); font-variant-numeric:tabular-nums; white-space:nowrap; }
.fcol.po .fv { color:var(--accent); } .fcol.zero .fv { opacity:.4; }
.fv i { font-style:normal; padding:1px 4px; font-size:7.5px; font-weight:900; letter-spacing:.12em; text-transform:uppercase; color:var(--ink-2); border:1px solid var(--line-2); }
.fcol.po .fv i { color:var(--accent); border-color:color-mix(in srgb,var(--accent) 50%,transparent); }
.fbar { position:relative; flex:1 1 auto; width:46%; min-height:44px; }
.fbar i { position:absolute; inset:0; transform-origin:50% 100%; transition:transform .34s cubic-bezier(.22,.7,.3,1);
  background:linear-gradient(180deg,color-mix(in srgb,var(--ink-3) 55%,transparent),color-mix(in srgb,var(--ink-3) 12%,transparent)); border-top:2px solid color-mix(in srgb,var(--ink-3) 80%,transparent); }
.fcol.po .fbar i { background:linear-gradient(180deg,color-mix(in srgb,var(--accent) 85%,transparent),color-mix(in srgb,var(--accent-deep) 35%,transparent)); border-top-color:var(--accent); box-shadow:0 0 16px var(--accent-glow); }
.fcol.likely .fbar i { border-top-width:3px; }
.fcut { position:relative; z-index:2; justify-self:start; align-self:stretch; width:0; margin-left:calc(var(--gap) / -2 - 1px);
  border-left:1px dashed var(--accent); pointer-events:none; }
.fcut em { position:absolute; top:4px; left:0; transform:translateX(-50%); padding:1px 4px; font-style:normal; font-size:7.5px; font-weight:900;
  letter-spacing:.14em; text-transform:uppercase; color:var(--accent); background:var(--panel); border:1px solid color-mix(in srgb,var(--accent) 50%,transparent); }
.faxis span { padding-top:7px; text-align:center; font-size:10.5px; font-weight:900; color:var(--ink-3); }
.faxis span.po { color:var(--accent); }
.faxis span.likely { position:relative; color:var(--ink); }
.faxis span.likely::before { content:""; position:absolute; left:50%; top:1px; width:5px; height:5px; margin-left:-2.5px; background:currentColor; transform:rotate(45deg); }
.stillness .fbar i { transition:none; }

@media (max-width:600px) {
  .fboard { --gap:3px; } .fz { padding:8px 8px 10px; } .fz .zs { display:none; } .fz b { font-size:24px; }
  .fchart { height:150px; } .fbar { width:62%; } .fv { font-size:8.5px; letter-spacing:-.02em; }
  .fv i { width:6px; height:6px; padding:0; font-size:0; border:0; background:currentColor; transform:rotate(45deg); } .faxis span { font-size:9px; }
}

/* --- brackets (below the map: they are what the map produces) ------------------ */
.bkrow { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:14px; }
.bkrow.solo { grid-template-columns:minmax(0,1fr); }
@media (max-width:1020px) { .bkrow { grid-template-columns:minmax(0,1fr); } }
.bkrow .panel { margin:0; }
.board { position:relative; display:grid; grid-template-columns:minmax(0,1.25fr) minmax(0,1fr); gap:12px 42px; }
.bcol { position:relative; z-index:1; display:flex; flex-direction:column; justify-content:space-around; gap:14px; }
.bklinks { position:absolute; inset:0; width:100%; height:100%; overflow:visible; pointer-events:none; }
.bklinks path { fill:none; stroke:var(--line-2); stroke-width:1.5; } .bklinks path.l { stroke-dasharray:3 4; opacity:.75; }
@media (max-width:640px) { .board { grid-template-columns:minmax(0,1fr); gap:12px; } .bklinks { display:none; } }
.match { background:var(--panel-2); border:1px solid var(--line); }
.match.hasme { border-color:var(--accent); box-shadow:0 0 0 1px var(--accent-glow), 0 0 22px var(--accent-glow); }
.match .rnd { display:block; padding:5px 10px 4px; font-size:9px; font-weight:900; letter-spacing:.16em; text-transform:uppercase; color:var(--ink-3); background:var(--inset); border-bottom:1px solid var(--line); }
.slot { display:flex; align-items:center; gap:8px; padding:7px 10px; min-height:38px; }
.slot + .slot { border-top:1px solid var(--line); }
.slot .sd { flex:none; width:21px; height:21px; display:grid; place-items:center; font-size:10.5px; font-weight:900; color:var(--ink-2); background:var(--inset); border:1px solid var(--line-2); }
.slot.me .sd { background:var(--accent); border-color:var(--accent); color:#04170A; }
.slot .lg { flex:none; width:22px; height:22px; } .slot .lg img, .slot .lg svg { width:22px; height:22px; display:block; }
.slot .nm { flex:1; min-width:0; font-size:12.5px; font-weight:800; line-height:1.25; overflow-wrap:break-word; }
.slot.me .nm { color:var(--accent); }
.slot.tbd .nm { color:var(--ink-3); font-weight:700; font-size:11.5px; }
.slot.tbd .sd { background:transparent; border-style:dashed; color:var(--ink-3); font-size:9.5px; }
.slot .tiemark[data-tone="b"] { background:#FF7A45; }
.slot .tiemark { flex:none; width:18px; height:18px; display:grid; place-items:center; font-size:10px; font-weight:900; color:#1A1000; background:var(--signal);
  clip-path:polygon(0 0,100% 0,100% calc(100% - 5px),calc(100% - 5px) 100%,0 100%); cursor:help; }

/* --- control bar: jumps, this path, toggles -------------------------------------- */
.ctlbar { display:flex; flex-direction:column; gap:12px; margin:0 0 20px; padding:14px; background:var(--panel); border:1px solid var(--line); }
.jumps { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
.jlab { margin-right:4px; font-size:9.5px; font-weight:900; letter-spacing:.16em; text-transform:uppercase; color:var(--ink-3); }
.jump { display:inline-flex; align-items:center; gap:8px; padding:9px 13px; font:inherit; font-size:10.5px; font-weight:900; letter-spacing:.12em; text-transform:uppercase;
  color:var(--ink); background:var(--panel-2); border:1px solid var(--line-2); cursor:pointer; border-radius:9px; }
.jump svg { width:15px; height:15px; } .jump svg path { fill:none; stroke:currentColor; stroke-width:1.7; stroke-linecap:round; stroke-linejoin:round; }
.jump:hover { border-color:var(--accent); }
.jump.on { color:#04170A; background:var(--accent); border-color:var(--accent); }
.pathsum { display:flex; flex-wrap:wrap; align-items:stretch; gap:8px; }
.psum { display:flex; flex-direction:column; justify-content:center; gap:2px; min-width:112px; padding:7px 12px; background:var(--panel-2); border:1px solid var(--line); border-radius:9px; }
.psum small { font-size:9px; font-weight:900; letter-spacing:.12em; text-transform:uppercase; color:var(--ink-3); }
.psum b { font-size:20px; font-weight:900; letter-spacing:-.02em; line-height:1.05; color:var(--ink); }
.psum em { font-style:normal; font-size:10.5px; font-weight:700; color:var(--ink-3); }
.psum.in b { color:var(--accent); } .psum.cut b { color:var(--signal); } .psum.out b { color:var(--flag); }
.pathbtns { display:flex; flex-wrap:nowrap; align-items:center; gap:8px; margin-left:auto; align-self:center; }
.pathbtns .ftbtn { white-space:nowrap; }
.ftbtn { display:inline-flex; align-items:center; gap:8px; font:inherit; font-size:10.5px; font-weight:900; letter-spacing:.12em; text-transform:uppercase; padding:9px 12px;
  border:1px solid var(--line-2); background:var(--panel-2); color:var(--ink); cursor:pointer; border-radius:9px; }
.ftbtn svg { width:14px; height:14px; } .ftbtn svg path { fill:none; stroke:currentColor; stroke-width:1.9; stroke-linecap:round; }
.ftbtn:not([disabled]):hover { border-color:var(--accent); color:var(--accent); } .ftbtn[disabled] { opacity:.4; cursor:default; }
.toggles { display:flex; flex-wrap:wrap; gap:10px 22px; padding-top:12px; border-top:1px solid var(--line); }
.tog { display:inline-flex; align-items:center; gap:10px; font-size:10.5px; font-weight:900; letter-spacing:.1em; text-transform:uppercase; color:var(--ink-2); }
.tog.off { opacity:.45; }
.tog.on { color:var(--ink); }
.ftsw { position:relative; flex:none; width:46px; height:24px; padding:0; cursor:pointer; border-radius:999px; border:1px solid var(--line-2);
  background:linear-gradient(180deg,var(--inset),var(--panel-2)); box-shadow:inset 0 1px 3px rgba(0,0,0,.45); transition:background .22s ease, border-color .22s ease; }
.ftsw i { position:absolute; top:2px; left:2px; width:18px; height:18px; border-radius:50%; background:var(--ink-3);
  box-shadow:0 1px 3px rgba(0,0,0,.5); transition:transform .24s cubic-bezier(.3,.7,.3,1), background .22s ease; }
.ftsw i::after { content:""; position:absolute; left:50%; top:50%; width:6px; height:6px; margin:-3px 0 0 -3px; border-radius:50%; background:var(--panel); }
.ftsw.on { border-color:var(--accent); background:linear-gradient(90deg,var(--accent-deep),var(--accent)); box-shadow:inset 0 1px 3px rgba(0,0,0,.25), 0 0 12px var(--accent-glow); }
.ftsw.on i { transform:translateX(22px); background:var(--field); }
.ftsw.on i::after { width:7px; height:4px; margin:-3px 0 0 -4px; border-radius:0; background:none; border-left:2px solid var(--accent); border-bottom:2px solid var(--accent); transform:rotate(-45deg); }
.ftsw:focus-visible { outline:2px solid var(--sky); outline-offset:3px; }
.ftsw[disabled] { cursor:default; }
.stillness .ftsw, .stillness .ftsw i { transition:none; }
@media (max-width:600px) { .pathbtns { margin-left:0; width:100%; } .pathbtns .ftbtn { flex:1 1 0; min-width:0; justify-content:center; gap:6px; padding:8px 6px; font-size:10px; letter-spacing:.05em; white-space:normal; text-align:center; line-height:1.2; } .psum { flex:1 1 100%; min-width:0; } }

/* --- the map ----------------------------------------------------------------------- */
.ftgrid { display:grid; grid-template-columns:minmax(0,1fr) 440px; gap:20px; align-items:start; }
@media (max-width:1080px) { .ftgrid { grid-template-columns:minmax(0,1fr); } }
.map { position:relative; padding-left:80px; padding-top:22px; }
.ghost { position:absolute; z-index:0; pointer-events:none; }
.lane { position:absolute; left:0; top:0; width:64px; height:100%; overflow:visible; pointer-events:none; z-index:1; }
.lanekey { position:absolute; left:0; top:0; width:64px; height:14px; }
.lanekey span { position:absolute; top:0; transform:translateX(-50%); font-size:8.5px; font-weight:900; letter-spacing:.1em; text-transform:uppercase; color:var(--ink-3); }
.lanekey span:nth-child(1) { left:19%; } .lanekey span:nth-child(2) { left:50%; } .lanekey span:nth-child(3) { left:81%; }
@media (max-width:600px) { .map { padding-left:52px; } .lane, .lanekey { width:42px; } .lanekey span:nth-child(2) { display:none; } }
.lane .rails line { stroke:var(--line-2); stroke-width:1; stroke-dasharray:1 6; stroke-linecap:round; }
.lane .stations line { stroke:var(--line-2); stroke-width:1; }
.lane .stations rect { fill:var(--panel-2); stroke:var(--ink-3); stroke-width:1.5; }
.lane .stations .now line { stroke:var(--sky); } .lane .stations .now rect { fill:var(--sky); stroke:var(--sky); }
.lane .glow { fill:none; stroke:var(--accent); stroke-opacity:.16; stroke-width:10; stroke-linecap:round; }
.lane .line { fill:none; stroke:url(#linegrad); stroke-width:2.6; stroke-linecap:round; }
.lane .ls0 { stop-color:var(--accent); } .lane .ls1 { stop-color:var(--sky); }
.lane .bead circle, .lane .bead rect { fill:var(--ink-3); stroke:var(--field); stroke-width:2.5; }
.lane .bead.in circle, .lane .bead.in rect { fill:var(--accent); } .lane .bead.cut circle, .lane .bead.cut rect { fill:var(--signal); }
.lane .bead.out circle, .lane .bead.out rect { fill:var(--flag); } .lane .bead circle.ring { fill:none; stroke:var(--sky); stroke-width:1.6; }

.week { position:relative; padding:0 0 4px; }
.week + .week { margin-top:30px; }
.week::before { content:""; position:absolute; left:-80px; right:0; top:-16px; height:1px; background:linear-gradient(90deg,var(--line-2),var(--line-2) 60%,transparent); }
.week:first-of-type::before { display:none; }
.week.now::before { background:linear-gradient(90deg,var(--sky),var(--sky) 40%,transparent); }
@media (max-width:600px) { .week::before { left:-52px; } }
.wkhead { display:flex; flex-wrap:wrap; align-items:center; gap:8px 12px; margin:0 0 14px; }
.wkno { display:inline-flex; align-items:baseline; gap:7px; }
.wkno small { font-size:10px; font-weight:900; letter-spacing:.18em; text-transform:uppercase; color:var(--ink-3); }
.wkno b { font-size:28px; font-weight:900; letter-spacing:-.04em; line-height:1;
  background:linear-gradient(96deg,var(--ink) 20%,var(--accent) 150%); -webkit-background-clip:text; background-clip:text; color:transparent; -webkit-text-fill-color:transparent; }
.week.now .wkno b { background:linear-gradient(96deg,var(--ink) 20%,var(--sky) 130%); -webkit-background-clip:text; background-clip:text; }
.wkchips { display:flex; flex-wrap:wrap; gap:6px; }
.chip.now { color:#041017; background:var(--sky); border-color:var(--sky); }
.chip.played { color:var(--sky); border-color:var(--sky); }
.chip.hid { border-style:dashed; color:var(--ink-3); }
.wkrule { flex:1 1 40px; min-width:40px; height:2px; background:linear-gradient(90deg,var(--line-2),transparent); }
.week.now .wkrule { background:linear-gradient(90deg,var(--sky),transparent); }
.game { position:relative; margin:0 0 14px; }
.gmeta { display:flex; flex-wrap:wrap; gap:5px; margin:0 0 6px; }
.tag { font-size:9px; font-weight:900; letter-spacing:.12em; text-transform:uppercase; padding:2px 6px; border:1px solid var(--line-2); color:var(--ink-3); }
.tag.mine { color:var(--accent); border-color:var(--accent); } .tag.proj, .tag.final { font-variant-numeric:tabular-nums; }
.tag.final { color:var(--sky); border-color:var(--sky); }
.tag.wif { color:#1A1000; background:var(--signal); border-color:var(--signal); } .tag.pin { color:var(--sky); border-color:var(--sky); }
.game.mine .switch { border-color:var(--line-2); box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--accent) 12%,transparent); }
.tag strong { color:var(--ink); font-weight:900; }
.switch { display:grid; grid-template-columns:minmax(0,1fr) minmax(84px,.5fr) minmax(0,1fr); min-height:var(--segh,0px);
  background:var(--panel); border:1px solid var(--line); }
.seg { --c:var(--ink-3); --soft:transparent; position:relative; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:4px;
  min-width:0; padding:10px 10px 9px; font:inherit; text-align:center; color:var(--ink); background:transparent; border:0; cursor:pointer; }
.seg + .seg { border-left:1px solid var(--line); }
.seg.in { --c:var(--accent); --soft:var(--accent-glow); } .seg.cut { --c:var(--signal); --soft:var(--signal-soft); } .seg.out { --c:var(--flag); --soft:var(--flag-soft); }
.seg .fill { position:absolute; inset:-1px; pointer-events:none; opacity:0; transition:opacity .22s ease;
  background:linear-gradient(180deg,var(--soft),transparent 140%); border:1px solid var(--c); box-shadow:inset 0 2px 0 var(--c); }
.seg[aria-checked="true"] { z-index:1; } .seg[aria-checked="true"] .fill { opacity:1; }
.seg[aria-checked="false"]:not([disabled]):hover .fill { opacity:.4; }
.seg .lg { position:relative; flex:1 1 46px; min-height:46px; width:100%; display:flex; align-items:center; justify-content:center; }
.seg .lg > .lgo { height:100%; max-height:104px; max-width:100%; min-height:40px; width:auto; aspect-ratio:1 / 1; }
.seg .tieglyph { position:relative; flex:1 1 24px; min-height:24px; max-height:46px; aspect-ratio:1 / 1; display:grid; place-items:center; font-size:15px; font-weight:900; color:var(--ink-2); border:1px solid var(--line-2); }
.seg .nm { position:relative; max-width:100%; font-size:12.5px; font-weight:800; line-height:1.2; overflow-wrap:break-word; }
.seg[aria-checked="false"] .nm { color:var(--ink-2); } .seg.self .nm { color:var(--accent); }
.seg .sub { position:relative; font-size:10.5px; font-weight:800; color:var(--ink-3); font-variant-numeric:tabular-nums; }
.seg .res { position:relative; display:flex; flex-direction:column; align-items:center; gap:4px; width:100%; max-width:150px; margin-top:2px; }
.seg .rl { display:flex; align-items:baseline; justify-content:center; gap:8px; }
.seg .rl b { font-size:10.5px; font-weight:900; color:var(--c); white-space:nowrap; }
.seg .rl em { font-style:normal; font-size:10.5px; font-weight:800; color:var(--ink-2); font-variant-numeric:tabular-nums; white-space:nowrap; }
.seg .meter { position:relative; width:100%; height:3px; overflow:hidden; background:var(--inset); }
.seg .meter i { position:absolute; inset:0; background:var(--c); transform-origin:0 50%; transition:transform .28s cubic-bezier(.22,.7,.3,1); }
.seg[disabled] { cursor:default; } .seg[disabled][aria-checked="false"] { opacity:.4; }
.seg.best::after { content:""; position:absolute; inset:4px; border:1px dashed var(--accent); pointer-events:none; }
.seg .besttag { position:absolute; top:-8px; left:50%; transform:translateX(-50%); z-index:2; padding:1px 5px; font-size:8.5px; font-weight:900;
  letter-spacing:.14em; text-transform:uppercase; color:#04170A; background:var(--accent); }
.game.irrelevant .switch { opacity:.5; filter:saturate(0); }
@media (max-width:600px) {
  .switch { grid-template-columns:minmax(0,1fr) minmax(58px,.42fr) minmax(0,1fr); }
  .seg { padding:8px 6px 7px; gap:3px; } .seg .nm { font-size:12px; }
  .seg .lg { flex-basis:36px; min-height:36px; } .seg .lg > .lgo { max-height:78px; min-height:32px; }
  .seg .rl { flex-direction:column; align-items:center; gap:1px; }
}

/* --- final standings: the site's datatable, with tied places highlighted and draggable */
.stpanel { position:relative; margin:0; }
.sttoggle { margin-left:auto; width:28px; height:28px; display:grid; place-items:center; padding:0; cursor:pointer; background:transparent; border:1px solid var(--line-2); }
.sttoggle i { width:8px; height:8px; margin-top:4px; border-left:2px solid var(--ink-2); border-top:2px solid var(--ink-2); transform:rotate(45deg); transition:transform .2s ease; }
.sttoggle[aria-expanded="false"] i { margin-top:-4px; transform:rotate(225deg); }
.stbody[hidden] { display:none; }
.tiecall { margin:0 0 14px; padding:11px 12px; border:1px solid var(--signal); background:var(--signal-soft); }
.tctop { display:flex; align-items:center; gap:9px; }
.tctop svg { flex:none; width:18px; height:18px; } .tctop svg path { fill:none; stroke:var(--signal); stroke-width:2; }
.tctop b { font-size:10.5px; font-weight:900; letter-spacing:.14em; text-transform:uppercase; color:var(--signal); }
.tcchips { display:flex; flex-wrap:wrap; gap:6px; margin-top:9px; }
.tcchips .chip { background:transparent; border-color:color-mix(in srgb,var(--signal) 45%,transparent); white-space:normal; }
.chip.drag i { width:9px; height:11px; transform:none; background:radial-gradient(var(--signal) 1px,transparent 1.3px) 0 0/4.5px 4.5px; }
table.ftst { width:100%; min-width:0; }
/* Under 360px the cells tighten; anything still wider scrolls in the shared drawn scroller. */
@media (max-width:360px) { table.ftst th, table.ftst td { padding-left:4px; padding-right:4px; } }
table.ftst th, table.ftst td { padding:9px 8px; }
table.ftst td.col-team { white-space:normal; text-align:left; }
table.ftst .stname { min-width:0; } table.ftst .stnamewrap { min-width:0; }
table.ftst .stnamewrap b { white-space:normal; overflow-wrap:break-word; }
table.ftst td.c-num small.gap { display:block; font-size:10px; font-weight:800; } table.ftst small.gap.up { color:var(--accent); } table.ftst small.gap.dn { color:var(--signal); }
table.ftst .tklogo, table.ftst .stname img, table.ftst .stname svg { width:22px; height:22px; flex:none; }
table.ftst .medal { display:inline-flex; align-items:center; justify-content:center; width:22px; height:22px; border-radius:50%; font-size:10px; font-weight:900; color:var(--field); }
table.ftst .medal.g { background:var(--gold); box-shadow:0 0 12px -2px var(--gold-glow); } table.ftst .medal.s { background:#C8D2D6; color:#1C2B24; } table.ftst .medal.b { background:#CD8A4D; }
table.ftst tr.po td:first-child { box-shadow:inset 2px 0 0 var(--accent); }
table.ftst tr.tie td:first-child { box-shadow:inset 3px 0 0 var(--tc); }
table.ftst tr.me td { background:var(--accent-glow); }
table.ftst tr[data-tone="a"] { --tc:var(--signal); --tcs:var(--signal-soft); --tcl:color-mix(in srgb,var(--signal) 45%,transparent); }
table.ftst tr[data-tone="b"] { --tc:#FF7A45; --tcs:rgba(255,122,69,.13); --tcl:rgba(255,122,69,.5); }
table.ftst tr.tie td { background:var(--tcs); }
table.ftst tr.tie.me td { background:linear-gradient(var(--accent-glow),var(--accent-glow)), linear-gradient(var(--tcs),var(--tcs)); }
table.ftst tr.tierow td { padding:7px 10px; text-align:left; background:var(--tcs); border-top:1px solid var(--tcl); box-shadow:inset 3px 0 0 var(--tc); }
table.ftst tr.tierow b { font-size:10px; font-weight:900; letter-spacing:.14em; text-transform:uppercase; color:var(--tc); }
table.ftst tr.tierow span { margin-left:10px; font-size:9.5px; font-weight:800; letter-spacing:.08em; text-transform:uppercase; color:var(--ink-2); }
table.ftst .stflag { display:inline-block; font-size:8.5px; font-weight:900; letter-spacing:.11em; text-transform:uppercase; padding:3px 8px; border:1px solid currentColor; }
table.ftst .stflag.in { color:var(--accent); } table.ftst .stflag.out { color:var(--flag); } table.ftst .dim { color:color-mix(in srgb,var(--ink) 55%,transparent); }
table.ftst tr.porow td { padding:0; height:20px; border:0; position:relative; background:transparent; }
table.ftst tr.porow td::before { content:""; position:absolute; left:0; right:0; top:50%; height:1px;
  background:repeating-linear-gradient(90deg,var(--accent) 0 7px,transparent 7px 11px); opacity:.9; }
table.ftst tr.porow td span { position:absolute; left:10px; top:50%; transform:translateY(-50%); z-index:2; display:inline-flex; align-items:center; gap:6px; padding:0 7px 0 5px;
  font-size:7.5px; font-weight:900; letter-spacing:.18em; text-transform:uppercase; color:var(--accent); background:var(--panel); line-height:1; }
table.ftst tr.porow td span i { width:6px; height:6px; background:var(--accent); transform:rotate(45deg); box-shadow:0 0 8px var(--accent-glow); }
.tplace { display:inline-flex; align-items:center; gap:6px; }
.tpill { display:inline-block; padding:2px 6px 3px; font-size:12px; font-weight:900; line-height:1; color:#1A1000; background:var(--tc,var(--signal)); clip-path:polygon(0 0,100% 0,100% calc(100% - 5px),calc(100% - 5px) 100%,0 100%); }
.grip { position:relative; width:12px; height:24px; padding:0; border:0; cursor:grab; touch-action:none; background:transparent; }
.grip i { position:absolute; inset:2px 1px; background:radial-gradient(var(--tc,var(--signal)) 1.2px,transparent 1.5px) 0 0/5px 5px; }
.grip:active { cursor:grabbing; }
.moves { display:inline-flex; flex-direction:column; gap:2px; }
.mv { width:22px; height:17px; display:grid; place-items:center; padding:0; cursor:pointer; background:transparent; border:1px solid color-mix(in srgb,var(--signal) 35%,transparent); }
.mv i { width:6px; height:6px; margin-top:3px; border-left:1.5px solid var(--signal); border-top:1.5px solid var(--signal); transform:rotate(45deg); }
.mv.dn i { margin-top:-3px; transform:rotate(225deg); } .mv[disabled] { opacity:.25; cursor:default; }
table.ftst tr.dragging td { position:relative; z-index:6; background:var(--panel-2); box-shadow:0 10px 22px rgba(0,0,0,.5); }
table.ftst tr.dragging td:first-child { box-shadow:0 10px 22px rgba(0,0,0,.5), inset 2px 0 0 var(--signal); }
.stnote { margin:12px 0 0; font-size:11px; line-height:1.5; color:var(--ink-3); }
@media (max-width:520px) { table.ftst th, table.ftst td { padding:8px 5px; } table.ftst th .lbl { letter-spacing:.06em; } .tplace { gap:4px; } }

/* --- motion: entrances and changes of team (transform and opacity only) ----------- */
.ftin { animation:ftin .55s cubic-bezier(.22,.7,.3,1) both; animation-delay:var(--d,0ms); }
.ftfade { animation:ftfade .38s ease both; }
.pop { display:inline-block; animation:ftpop .36s cubic-bezier(.22,.7,.3,1) both; }
@keyframes ftin { from { opacity:0; transform:translateY(14px); } to { opacity:1; transform:none; } }
@keyframes ftfade { from { opacity:0; } to { opacity:1; } }
@keyframes ftpop { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:none; } }
.hero.busy { opacity:.6; transition:opacity .2s ease; }
.stillness .ftin, .stillness .ftfade, .stillness .pop { animation:none; }
.ftstate { margin-top:var(--sp-3); }

/* --- flags, sharing, and odds by week ------------------------------------------------ */
.tag.big { color:#1A1400; background:var(--gold); border-color:var(--gold); box-shadow:0 0 12px -2px var(--gold-glow); }
.tag.big strong { color:#1A1400; }
.jump[disabled] { opacity:.45; cursor:default; }
.ftbtn.share { border-color:var(--sky); color:var(--sky); }
.ftbtn.share:hover { border-color:var(--sky); color:var(--ink); }
.linknote { border-radius:9px; display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:8px 14px; margin:0 0 16px; padding:10px 14px;
  font-size:12.5px; font-weight:700; border:1px solid var(--sky); background:color-mix(in srgb,var(--sky) 12%,transparent); color:var(--ink); }
.linknote.bad { border-color:var(--signal); background:var(--signal-soft); }
.oddsweek { flex:1 1 auto; display:flex; flex-direction:column; min-height:170px; margin-top:16px; padding-top:12px; border-top:1px solid var(--line); }
.owhead { display:flex; flex-wrap:wrap; align-items:baseline; justify-content:space-between; gap:4px 12px; margin-bottom:8px; }
.owhead .zl { font-size:9.5px; font-weight:900; letter-spacing:.16em; text-transform:uppercase; color:var(--ink-3); }
.owkey { display:inline-flex; align-items:center; gap:6px; font-size:9px; font-weight:800; letter-spacing:.1em; text-transform:uppercase; color:var(--ink-3); }
.owkey i { display:inline-block; width:16px; height:0; border-top:2px solid var(--accent); margin-left:6px; }
.owkey i.dash { border-top:2px dashed var(--sky); }
.owplot { position:relative; flex:1 1 auto; min-height:120px; margin:0 6px 0 30px; }
.owplot svg { position:absolute; inset:0; width:100%; height:100%; overflow:visible; }
.owgrid { position:absolute; left:0; right:0; height:0; border-top:1px dashed color-mix(in srgb,var(--ink) 8%,transparent); }
.owgrid em { position:absolute; left:-30px; top:-7px; width:26px; text-align:right; font-style:normal; font-size:9px; font-weight:800; color:var(--ink-3); }
.owarea { fill:url(#owfill); stroke:none; } .of0 { stop-color:var(--accent); stop-opacity:.28; } .of1 { stop-color:var(--accent); stop-opacity:0; }
.owline { fill:none; stroke:var(--accent); stroke-width:2.5; stroke-linejoin:round; vector-effect:non-scaling-stroke; }
.owproj { fill:none; stroke:var(--sky); stroke-width:2; stroke-dasharray:5 5; vector-effect:non-scaling-stroke; }
/* ESPN's own figures, before the simulation: a quieter line of its own, named in the key. */
.owaxis span.hid { visibility:hidden; }
.owespn { fill:none; stroke:color-mix(in srgb,var(--ink) 55%,transparent); stroke-width:1.6; stroke-linejoin:round; vector-effect:non-scaling-stroke; opacity:.9; }
.owdot.espn { background:var(--panel); border:2px solid color-mix(in srgb,var(--ink) 55%,transparent); }
.owdot.espn b { color:color-mix(in srgb,var(--ink) 55%,transparent); }
.owkey i.espnk { display:inline-block; width:14px; height:0; border-top:2px solid color-mix(in srgb,var(--ink) 55%,transparent); margin:0 6px 0 0; vertical-align:middle; }
.seedby { display:flex; flex-wrap:wrap; gap:8px; margin:0 0 12px; }
.seedby .ftbtn[aria-pressed="true"] { color:var(--accent); border-color:var(--accent); background:var(--accent-glow); }
.owdot { position:absolute; z-index:2; width:10px; height:10px; margin:-5px 0 0 -5px; border-radius:50%; background:var(--accent); box-shadow:0 0 0 3px var(--panel); }
.owdot.projected { background:var(--panel); border:2px solid var(--sky); }
.owdot.now { width:14px; height:14px; margin:-7px 0 0 -7px; box-shadow:0 0 0 3px var(--panel), 0 0 0 5px var(--accent), 0 0 16px var(--accent-glow); }
.owdot b { position:absolute; bottom:calc(100% + 6px); left:50%; transform:translateX(-50%); font-size:10.5px; font-weight:900; color:var(--ink); white-space:nowrap; font-variant-numeric:tabular-nums; }
.owdot.projected b { color:var(--sky); }
.owdot b.below, .owdot.high b { bottom:auto; top:calc(100% + 6px); }
.owdot.high b.below { top:auto; bottom:calc(100% + 6px); }
.owdot b.hid, .fv.hid { visibility:hidden; }
.owwipe { position:absolute; z-index:3; top:-24px; bottom:-4px; left:-2px; right:-8px; background:var(--panel); transform-origin:100% 50%; transform:scaleX(0); pointer-events:none; }
.owaxis { position:relative; height:22px; margin:6px 6px 0 30px; }
.owaxis span { position:absolute; top:4px; transform:translateX(-50%); font-size:9.5px; font-weight:900; letter-spacing:.06em; text-transform:uppercase; color:var(--ink-3); white-space:nowrap; }
.owaxis span.now { color:var(--accent); }
@media (max-width:600px) { .oddsweek { min-height:150px; } .owdot b { font-size:9.5px; } .owkey { font-size:8px; } }
.pickrow { display:flex; flex-wrap:wrap; align-items:center; gap:10px; }
.pickrow > :first-child { flex:1 1 320px; }
.chip.loadchip { color:var(--sky); border-color:var(--sky); }
.chip.loadchip i { animation:ftpulse 1s ease-in-out infinite; }
@keyframes ftpulse { 50% { opacity:.25; } }
.stillness .chip.loadchip i { animation:none; }
.ftstate .placeholder .ftprog { display:block; width:min(320px,100%); height:6px; margin:14px auto 0; overflow:hidden; border-radius:3px; background:var(--inset); }
.ftstate .placeholder .ftprog i { display:block; height:100%; background:linear-gradient(90deg,var(--accent-deep),var(--accent)); transform-origin:0 50%; transition:transform .6s ease; }
.ftstate .placeholder .ftbtn { margin-top:14px; text-decoration:none; }
.ftnote { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:8px 14px; margin:0 0 14px; padding:10px 14px; border-radius:9px;
  font-size:12.5px; font-weight:700; color:var(--ink); border:1px solid var(--sky); background:color-mix(in srgb,var(--sky) 12%,transparent); }
.ftnote.warn { border-color:var(--signal); background:var(--signal-soft); }
.ftnote.done { border-color:var(--gold); background:color-mix(in srgb,var(--gold) 12%,transparent); }
.ftnote.fresh { border-color:var(--accent); background:var(--accent-glow); }
/* The odds chart on its own, where the live page has the finish board and the chart together. */
.hero .finpanel.chartonly { min-height:545px; }   /* measured: the live page's finish board and chart together */
.hero .finpanel.chartonly.natural { min-height:0; }   /* the final page sizes to its own content */
.finpanel.chartonly .oddsweek { margin-top:4px; padding-top:0; border-top:0; }
.finpanel.chartonly .owhead .zl { display:none; }
.finpanel.chartonly .owhead { justify-content:flex-start; }
.ownote { margin:10px 6px 0; font-size:11.5px; line-height:1.45; color:color-mix(in srgb,var(--ink) 60%,transparent); }
/* The season's end: a banner, and the result in place of a dial. */
.ftfinal { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:12px 18px; padding:16px 18px; margin:14px 0 0;
  border-top:2px solid var(--gold); background:linear-gradient(180deg,color-mix(in srgb,var(--gold) 10%,transparent),transparent 70%), var(--panel); }
.ftfinal .fftxt { display:flex; flex-direction:column; gap:5px; min-width:0; flex:1 1 320px; }
.ftfinal .zl { font-size:10px; font-weight:900; letter-spacing:.16em; text-transform:uppercase; color:var(--gold); }
.ftfinal b { font-size:17px; line-height:1.3; color:var(--ink); }
.ftfinal .fftxt > span:last-child { font-size:12.5px; color:color-mix(in srgb,var(--ink) 65%,transparent); }
.ftfinal .ffact { display:flex; flex-wrap:wrap; gap:8px; }
.ftfinal .ffact .ftbtn { text-decoration:none; }
.finalres { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:8px; padding:26px 0 22px; }
.finalres .fplace { font-size:64px; line-height:1; font-weight:900; letter-spacing:-.02em; }
.finalres .fplace.in { color:var(--accent); text-shadow:0 0 24px var(--accent-glow); } .finalres .fplace.out { color:var(--ink); }
.finalres > span { font-size:11px; font-weight:800; letter-spacing:.14em; text-transform:uppercase; color:color-mix(in srgb,var(--ink) 60%,transparent); }
.finalres .stflag, .ftst .stflag, .ftfinal .stflag { display:inline-block; font-size:8.5px; font-weight:900; letter-spacing:.11em; text-transform:uppercase; padding:3px 8px; border:1px solid currentColor; }
.finalres .stflag.in { color:var(--accent); } .finalres .stflag.out { color:var(--flag); }
`;
