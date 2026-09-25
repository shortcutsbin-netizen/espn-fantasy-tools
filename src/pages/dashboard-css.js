/**
 * The dashboard's stylesheet.
 *
 * Sits on top of BASE_CSS from ui.js and redefines no token. Apart from the
 * markup it dresses because the two change for different reasons.
 */
export const DASHBOARD_CSS = `
    /* A notice, not a destination.
       The instructions dialog is a full-page sheet because it explains a whole
       surface; this says a handful of sentences and gets out of the way, so it
       is a small box over the site with the page still visible behind it. The
       layout rule is scoped past [hidden] — an author display declaration
       outranks the attribute, and this element spends most of its life hidden. */
    .uplayer { position:fixed; inset:0; z-index:90; padding:20px;
      background:rgba(3,6,4,.66); }
    .uplayer:not([hidden]) { display:flex; align-items:center; justify-content:center; }
    .upbox { width:min(440px,100%); max-height:min(78vh,620px); overflow:hidden;
      background:var(--panel,#111713); color:var(--ink,#E6F2E4);
      border:1px solid var(--line-2,#2C3B2E); border-radius:14px;
      box-shadow:0 24px 60px rgba(0,0,0,.55); }
    .upbody { max-height:min(78vh,620px); padding:20px 20px 18px; }
    .upbox .vbar { top:8px; bottom:8px; right:5px; }
    .uphead { display:flex; align-items:flex-start; gap:12px; margin-bottom:14px; }
    .uphead h2 { flex:1; margin:0; font-size:16px; font-weight:900;
      letter-spacing:-.01em; color:var(--ink,#E6F2E4); }
    .uphead .ctlbtn { margin-top:1px; }

    .uplist { margin:0 0 16px; padding-left:17px; }
    .uplist li { font-size:12.5px; line-height:1.55; color:var(--ink-2); margin-bottom:8px; }
    .uplist li:last-child { margin-bottom:0; }
    .uplist li::marker { color:var(--accent); }

    .tickhead { display:flex; align-items:center; gap:9px; margin-bottom:11px; }
    .tickttl { font-size:11px; font-weight:900; text-transform:uppercase; letter-spacing:.16em;
      background:linear-gradient(94deg,var(--ink) 10%,var(--accent) 150%);
      -webkit-background-clip:text; background-clip:text;
      color:transparent; -webkit-text-fill-color:transparent; }
    .tickmeta { margin-left:auto; font-size:10px; font-weight:900; letter-spacing:.14em;
                text-transform:uppercase; color:var(--ink-3); }
    .dot { width:7px; height:7px; flex:none; background:var(--ink-3); transform:rotate(45deg); }
    .dot.live { background:var(--accent); animation:pip 1.9s ease-in-out infinite; }
    @keyframes pip { 0%,100% { opacity:1; } 50% { opacity:.35; } }

    /* Fixed widths for the metrics, never for the names. A score changing
       mid-scroll must not shift the loop, so the numbers and the state keep a
       reserved width; a team's name is as long as it is, and a cell simply
       runs wider to hold it. The loop measures the strip after it is laid out,
       so cells of different widths cost it nothing. */
    .tk { display:flex; align-items:center; gap:9px; padding:7px 18px;
          border-right:1px solid var(--line); white-space:nowrap; }
    .tkside { display:flex; align-items:center; gap:6px; }
    .tklogo { width:19px; height:19px; object-fit:contain; flex:none; }
    .tkab { font-size:12.5px; font-weight:900; letter-spacing:.01em; }
    .tkpts { font-size:12.5px; font-weight:900; font-variant-numeric:tabular-nums;
             color:var(--accent); letter-spacing:.02em;
             min-width:4.2ch; text-align:right; display:inline-block; }
    .tkvs { font-size:9.5px; font-weight:900; letter-spacing:.14em; color:var(--ink-3); }
    /* Width is reserved per strip, from the longest state that strip can show,
       rather than from one number big enough for the worst case anywhere. A
       fixed 120px fitted the NFL strip's "9/13 - 1:00 PM EDT" and left the
       fantasy strip's "Week 1" trailing most of an inch of empty rule. */
    .tkstate { font-size:9.5px; font-weight:900; letter-spacing:.1em; text-transform:uppercase;
               color:var(--ink-3); margin-left:4px; display:inline-block;
               min-width:var(--sw, 5ch); flex:none; }
    .tk.live .tkstate { color:var(--accent); }
    .tk.win .tkab { color:var(--accent); }

    /* team card */
    .tickstrip { pointer-events:none; }
    .cardlogo { width:38px; height:38px; object-fit:contain; flex:none; }
    .cardstats { display:flex; gap:18px; margin-top:9px; }
    .stat b { display:block; font-size:19px; font-weight:900; font-variant-numeric:tabular-nums;
              color:var(--accent); letter-spacing:-.02em; }
    .stat span { display:block; font-size:9.5px; font-weight:900; letter-spacing:.15em;
                 text-transform:uppercase; color:var(--ink-3); margin-top:1px; }
    .vsrow { display:flex; align-items:center; gap:14px; min-height:104px; }
    .vsme, .vsopp { display:flex; align-items:center; gap:11px; min-width:0; flex:1; }
    .vsopp { justify-content:flex-end; text-align:right; }
    /* The opponent's line mirrors the reader's own, hard against the far edge,
       so the two seasons read as a pair rather than as a list. */
    .vsopp .cardstats { justify-content:flex-end; }
    .vsid { min-width:0; }
    /* Wraps rather than truncating: the full team name is the point, and a
       clipped one is no more readable than a wrapped one is untidy. */
    .vsname { display:block; font-size:13px; font-weight:900; letter-spacing:.1em;
      text-transform:uppercase; overflow-wrap:anywhere; hyphens:auto;
      background:linear-gradient(94deg,var(--ink) 10%,var(--accent) 155%);
      -webkit-background-clip:text; background-clip:text;
      color:transparent; -webkit-text-fill-color:transparent; }
    .vsowner { display:block; font-size:10.5px; font-weight:800; letter-spacing:.14em;
      text-transform:uppercase; color:var(--ink-3); margin-top:3px; }
    .vsopp .vsid { text-align:right; }
    /* Below this the three-across arrangement stops working: a 38px crest and a
       fixed centre column either side of two names leaves each name about two
       characters of room, and both teams render as an ellipsis. Stacking keeps
       the DOM order — you, the state of the game, then them — which is how a
       fixture reads anyway, and gives each name the full width. */
    @media (max-width:620px) {
      .vsrow { flex-direction:column; align-items:stretch; gap:12px; min-height:0; }
      /* Centred on the card, not on what is left over beside the crest.
         With the logo in the flow it took its width out of the centring, so a
         team's name and figures sat measurably left of the countdown directly
         beneath them. The crest is pinned to the edge and the text centres on
         the full width, which is the same axis the scores use. */
      .vsme, .vsopp { position:relative; justify-content:center; text-align:center;
                      width:100%; min-height:44px; }
      .vsme .cardlogo, .vsopp .cardlogo { position:absolute; left:0; top:50%;
                      margin:0; transform:translateY(-50%); }
      .vsme .vsid, .vsopp .vsid { text-align:center; width:100%; min-width:0;
                      padding:0 44px; }
      .vsme .cardstats, .vsopp .cardstats { justify-content:center; }
      /* Scoped through .vsrow deliberately: the base .vsmid rule is declared
         after this block, and at equal specificity source order would win. */
      .vsrow .vsmid { min-width:0; width:100%; text-align:center; padding:10px 0;
               border-top:1px solid var(--line); border-bottom:1px solid var(--line); }
      .cardstats { gap:14px; }
      .stat b { font-size:16px; }
    }
    .vsmid { flex:none; text-align:center; min-width:150px; }
    .cdnote { margin-top:5px; font-size:10px; font-weight:700; color:var(--ink-3);
              letter-spacing:.04em; }
    .vslabel { font-size:9.5px; font-weight:900; letter-spacing:.15em; text-transform:uppercase;
               color:var(--ink-3); margin-top:2px; }
    /* The dial sits between the two scores, each on the side its team is on and
       in that team's colour, with the state of the game above it. Stacking both
       scores on one side and putting the dial next to them read as two separate
       readouts of the same fixture. */
    .vsgrid { display:grid; grid-template-columns:1fr auto 1fr;
              align-items:center; justify-items:center; column-gap:clamp(8px,2vw,20px); }
    .vsgrid .vslabel { grid-area:1 / 2; margin:0 0 5px; white-space:nowrap; }
    .vsscore { grid-row:2; display:flex; flex-direction:column; align-items:center;
               gap:2px; min-width:0; }
    .vsscore.mine { grid-column:1; }
    .vsscore.theirs { grid-column:3; }
    .vsgrid .wgauge { grid-area:2 / 2; }
    .vsscore b { font-size:clamp(19px,2.6vw,25px); font-weight:900;
                 font-variant-numeric:tabular-nums; letter-spacing:-.02em;
                 line-height:1.1; }
    .smine { color:var(--accent); }
    .stheirs { color:var(--sky); }
    /* The projection trails its own score: what has happened, then where it is
       heading, in that order and never the same weight. */
    .sproj { font-size:10.5px; font-weight:800; font-variant-numeric:tabular-nums;
             color:var(--ink-2); }

    /* A decided matchup. Gold is the site's settled-result colour, and the
       margin is the thing a reader wants that neither score gives on its own. */
    .vslabel.isfinal { color:var(--gold); }
    .vsscore.won b { color:var(--gold); text-shadow:0 0 18px var(--gold-glow); }
    .vsmargin { grid-area:2 / 2; font-size:11px; font-weight:900; letter-spacing:.1em;
                text-transform:uppercase; white-space:nowrap; padding:6px 11px;
                border:1px solid var(--gold); color:var(--gold);
                box-shadow:0 0 16px -2px var(--gold-glow); }
    .vsmargin.lost { border-color:var(--line-2); color:var(--ink-3); box-shadow:none; }
    .vsmargin.tied { border-color:var(--line-2); color:var(--ink-2); box-shadow:none; }
    @media (max-width:560px) {
      .vsgrid { column-gap:8px; }
      .vsmargin { font-size:9.5px; padding:5px 8px; letter-spacing:.06em; }
    }

    .wgauge { position:relative; flex:none; width:52px; height:52px; }
    .wgauge svg { width:100%; height:100%; transform:rotate(0deg); }
    .wgauge circle { fill:none; stroke-width:9; }
    .wgtrack { stroke:var(--line-2); }
    .wgmine { stroke:var(--accent); }
    .wgtheirs { stroke:var(--sky); }
    .wgmid { position:absolute; inset:0; display:flex; align-items:center;
             justify-content:center; font-size:12px; font-weight:900;
             font-variant-numeric:tabular-nums; letter-spacing:-.02em; }
    .wgmid i { font-style:normal; font-size:8px; margin-left:1px; }
    .countdown { font-size:19px; font-weight:900; font-variant-numeric:tabular-nums;
                 letter-spacing:.02em; color:var(--ink); }
    .countdown em { font-style:normal; color:var(--ink-3); font-size:12px; margin:0 1px 0 1px; }

    /* standings */
    /* The table and its scroller are the shared ones from src/ui.js. These
       are the additions this season's table makes on top of them. */
    .medal { display:inline-flex; align-items:center; justify-content:center;
             width:22px; height:22px; border-radius:50%; font-size:10px;
             font-weight:900; color:var(--field); }
    .medal.g { background:var(--gold); box-shadow:0 0 12px -2px var(--gold-glow); }
    .medal.s { background:#C8D2D6; }
    .medal.b { background:#CD8A4D; }
    /* Silver is light enough that the site's own ink disappears on it in the
       light theme; the number is set dark on that one badge only. */
    .medal.s { color:#1C2B24; }
    .stflag { display:inline-block; font-size:8.5px; font-weight:900; letter-spacing:.11em;
              text-transform:uppercase; padding:3px 8px; border:1px solid currentColor; }
    .stflag.in { color:var(--accent); }
    .stflag.out { color:var(--flag); }
    .stupd { opacity:.55; }
    /* The line under the last playoff place, drawn as Fortune Teller draws it. */
    table.stbl tr.porow td { padding:0; height:20px; border:0; position:relative; background:transparent; }
    table.stbl tr.porow td::before { content:""; position:absolute; left:0; right:0; top:50%; height:1px;
      background:repeating-linear-gradient(90deg,var(--accent) 0 7px,transparent 7px 11px); opacity:.9; }
    table.stbl tr.porow td span { position:absolute; left:10px; top:50%; transform:translateY(-50%); z-index:2; display:inline-flex; align-items:center; gap:6px; padding:0 7px 0 5px;
      font-size:7.5px; font-weight:900; letter-spacing:.18em; text-transform:uppercase; color:var(--accent); background:var(--panel); line-height:1; }
    table.stbl tr.porow td span i { width:6px; height:6px; background:var(--accent); transform:rotate(45deg); box-shadow:0 0 8px var(--accent-glow); }
    .stbl tr.me td { background:var(--accent-glow); }

    /* injuries */
    .inj { display:flex; align-items:center; gap:11px; padding:9px 0;
           border-bottom:1px solid var(--line); }
    .inj:last-child { border-bottom:0; }
    .injtag { flex:none; font-size:9px; font-weight:900; letter-spacing:.1em; padding:3px 6px;
              border:1px solid currentColor; }
    .injtag.OUT, .injtag.IR { color:var(--flag); }
    .injtag.QUESTIONABLE, .injtag.DOUBTFUL { color:var(--signal); }
    .injtag.SUSPENSION, .injtag.DAY_TO_DAY { color:var(--signal); }
    .injname { display:block; font-size:13.5px; font-weight:800; line-height:1.25; }
    .injmeta { display:block; font-size:11px; color:var(--ink-3); margin-top:2px; }
    .injslot { margin-left:auto; font-size:10px; font-weight:900; letter-spacing:.12em;
               color:var(--ink-3); }

    /* transactions */
    .ranges { margin-left:auto; display:flex; gap:4px; }
    .ranges button { background:none; border:1px solid var(--line); color:var(--ink-3);
      font-family:inherit; font-size:9.5px; font-weight:900; letter-spacing:.1em;
      padding:4px 7px; cursor:pointer; transition:all .15s ease; }
    .ranges button:hover { color:var(--ink-2); border-color:var(--line-2); }
    .ranges button.on { color:var(--accent); border-color:var(--accent); }
    /* One row per transaction, not per item. A waiver claim is one thing a
       member did, and a six-player trade is one deal — listing their parts
       separately described the database rather than the league. */
    .txrow { display:grid; grid-template-columns:minmax(0,auto) minmax(0,1fr) auto auto;
             align-items:center; gap:8px 14px; padding:11px 0;
             border-bottom:1px solid var(--line); font-size:13px; }
    .txrow:last-child { border-bottom:0; }

    .txwho { display:flex; align-items:center; gap:7px; min-width:0; }
    .txteam { display:flex; align-items:center; gap:6px; min-width:0; }
    .txteam .tklogo, .txteam .lgo { width:20px; height:20px; flex:none; }
    .txteam b { font-size:12px; font-weight:900; letter-spacing:-.01em;
                overflow-wrap:anywhere; }
    .txswap { flex:none; color:var(--accent-deep); font-weight:900; font-size:12px; }

    .txbody { display:flex; align-items:center; gap:6px 12px; flex-wrap:wrap; min-width:0; }
    .txgroup { display:flex; align-items:center; gap:5px; flex-wrap:wrap; min-width:0; }
    .txp { font-size:12px; font-weight:800; white-space:nowrap; }
    .txp em { font-style:normal; font-weight:700; color:var(--ink-3); font-size:10.5px;
              margin-left:3px; }
    .txsign { font-weight:900; margin-right:2px; }
    .txp.add .txsign { color:var(--accent); }
    .txp.drop .txsign { color:var(--flag); }
    .txp.drop { color:var(--ink-2); }

    .txtags { display:flex; align-items:center; gap:6px; flex-wrap:wrap; justify-self:end; }
    .txkind { font-size:8.5px; font-weight:900; letter-spacing:.12em; text-transform:uppercase;
              padding:3px 7px; border:1px solid var(--line-2); color:var(--ink-3);
              white-space:nowrap; }
    .txkind.trade { color:var(--accent-2); border-color:var(--accent-deep); }
    .txkind.waiver { color:var(--sky); border-color:var(--sky); }
    /* Each kind reads at a glance rather than as another grey outline: coming
       in is the accent, going out is the flag, a swap is both at once. */
    .txkind.add { color:var(--accent); border-color:var(--accent); }
    .txkind.drop { color:var(--flag); border-color:var(--flag); }
    .txkind.swap { color:var(--signal); border-color:var(--signal); }
    .txstat { font-size:8.5px; font-weight:900; letter-spacing:.12em; text-transform:uppercase;
              padding:3px 7px; border:1px solid currentColor; white-space:nowrap; }
    /* The five states a deal passes through, each said once. A trade keeps the
       same row for its whole life and this is the part that changes. */
    .txstat.completed { color:var(--accent); }
    .txstat.on_the_table { color:var(--sky); }
    .txstat.pending_approval { color:var(--signal); }
    .txstat.rejected { color:var(--flag); }
    /* Withdrawn by whoever offered it. Not a refusal, so not the refusal
       colour, and not nothing either. */
    .txstat.cancelled { color:var(--ink-2); }
    .txstat.expired { color:var(--signal); }
    .txbid { font-size:9px; font-weight:900; color:var(--signal); white-space:nowrap; }

    .txwhen { font-size:10px; font-weight:800; letter-spacing:.1em;
              color:var(--ink-3); white-space:nowrap; justify-self:end; }

    @media (max-width:760px) {
      .txrow { grid-template-columns:minmax(0,1fr) auto; gap:7px 10px; }
      .txwho { grid-column:1; }
      .txwhen { grid-column:2; }
      .txbody { grid-column:1 / -1; }
      .txtags { grid-column:1 / -1; justify-self:start; }
      .txteam b { max-width:none; }
    }

    .tiles { display:grid; grid-template-columns:1fr; gap:10px; }
    @media (min-width:560px) { .tiles { grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); } }
    .tile { position:relative; display:flex; align-items:center; gap:13px;
      background:var(--panel); border:1px solid var(--line); padding:16px 17px;
      text-decoration:none; color:var(--ink); overflow:hidden;
      transition:border-color .18s ease, transform .18s ease; }
    .tile::before { content:""; position:absolute; left:0; top:0; bottom:0; width:2px;
      background:var(--accent); transform:scaleY(0); transform-origin:top;
      transition:transform .22s cubic-bezier(.3,.8,.4,1); }
    .tile:hover { border-color:var(--line-2); transform:translateX(2px); }
    .tile:hover::before { transform:scaleY(1); }
    .tile:hover .tilearrow { opacity:1; transform:translateX(0); }
    .tileidx { position:absolute; right:10px; bottom:-6px; font-size:44px; font-weight:900;
      color:var(--ink); opacity:var(--ghost-opacity); line-height:1;
      font-variant-numeric:tabular-nums; pointer-events:none; letter-spacing:-.05em; }
    .tileicon { flex:none; width:26px; height:26px; color:var(--accent); }
    .tileicon svg { width:100%; height:100%; }
    .tiletext { display:flex; flex-direction:column; min-width:0; z-index:1; padding-right:58px; }
    .tiletext b { font-size:14.5px; font-weight:900; letter-spacing:-.01em; }
    .tiletext i { font-style:normal; font-size:12px; color:var(--ink-2); margin-top:2px; }
    .tilearrow { position:absolute; right:14px; top:50%; margin-top:-9px; z-index:2;
      color:var(--accent); font-size:15px; opacity:0; transform:translateX(-4px);
      transition:opacity .2s ease, transform .2s ease; }
    .tag { position:absolute; top:9px; right:11px; font-size:8.5px; font-weight:900;
           text-transform:uppercase; letter-spacing:.16em; color:var(--signal); }

    .newsitem { display:grid; grid-template-columns:26px 1fr; gap:10px; align-items:baseline;
                padding:10px 0; border-bottom:1px solid var(--line); text-decoration:none;
                color:var(--ink); font-size:13.5px; line-height:1.45;
                transition:color .16s ease, padding-left .16s ease; }
    .newsitem:last-child { border-bottom:0; }
    .newsitem:hover { color:var(--accent); padding-left:4px; }
    .newsitem em { font-style:normal; font-size:10.5px; font-weight:900; color:var(--ink-3);
                   font-variant-numeric:tabular-nums; letter-spacing:.06em; }
    .nh span { display:block; font-size:9.5px; font-weight:900; letter-spacing:.14em;
               text-transform:uppercase; color:var(--ink-3); margin-top:3px; }

    .teampanel::after { display:none; }
    /* The picker itself (.teamrow, .teamlab, .teamsel) is shared, in ui.js. */

    .cardname { font-size:11px !important; font-weight:900; letter-spacing:.16em;
      text-transform:uppercase;
      background:linear-gradient(94deg,var(--ink) 10%,var(--accent) 150%);
      -webkit-background-clip:text; background-clip:text;
      color:transparent; -webkit-text-fill-color:transparent; }
  `;
