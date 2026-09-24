/* GcodeScope — CNC controller / dialect detection.
 * Loaded into the parser worker with importScripts(); exposes self.GSController.detect(text, name).
 *
 * Two independent signals are combined:
 *  1. Syntax cues — things only one control family understands (Klartext "BEGIN PGM",
 *     Sinumerik "CYCLE81(", Okuma "G15 H1", Fagor "#MSG", Haas "G187"...).
 *  2. Header comments — CAM post-processors usually write the machine/control name
 *     ("(MACHINE: MAZAK VCN-530C SMOOTHG)", "; TNC 640"), which is the only reliable way to tell
 *     Fanuc-compatible ISO controls (Fanuc, Mitsubishi, Mazak EIA, Kitamura, Doosan...) apart.
 * The version is inferred from features introduced in a given generation (post-2000 controls),
 * so it reads "iTNC 530 or newer" rather than pretending to know the exact model.
 */
'use strict';
(function () {
  const SCAN = 3e6; // syntax cues: first 3 MB is plenty

  // [family, regex, weight, evidence label]
  const SYNTAX = [
    ['heidenhain', /^\s*\d*\s*BEGIN PGM\s+\S+\s+(?:MM|INCH)\b/im, 20, 'BEGIN PGM'],
    ['heidenhain', /^\s*\d+\s+(?:TOOL CALL|CYCL DEF|LBL|CALL LBL|CC\s|L\s+[XYZIJKABC][-+]|CR\s|CT\s|RND\s|BLK FORM)/im, 10, 'Klartext blocks'],
    ['heidenhain', /\bFMAX\b/, 4, 'FMAX'],
    ['heidenhainIso', /^%\S+\s+G7[01]\s*\*\s*$/im, 20, '%PGM G71 *'],
    ['siemens', /^\s*;?\s*%_N_\w+_(?:MPF|SPF)\b/im, 20, '%_N_..._MPF'],
    ['siemens', /\b(?:CYCLE\d{2,3}|POCKET[1-4]|SLOT[12]|LONGHOLE|HOLES[12]|WORKPIECE)\s*\(/, 12, 'SINUMERIK cycles'],
    ['siemens', /^\s*(?:N\d+\s+)?(?:MCALL|TRANS|ATRANS|AROT|ROT|TRAORI|TRAFOOF|SUPA|DIAMON|DIAMOF)\b/im, 8, 'frames / MCALL'],
    ['siemens', /=\s*(?:AC|IC)\s*\(/, 6, '=AC() / =IC()'],
    ['siemens', /\bT\s*=\s*"[^"]+"/, 6, 'T="name"'],
    ['siemens', /^\s*(?:N\d+\s+)?(?:DEF\s+(?:REAL|INT|BOOL|STRING)|ENDIF|ENDWHILE|ENDLOOP|ENDFOR)\b/im, 5, 'DEF / ENDIF'],
    ['siemens', /\b(?:SOFT|BRISK|FFWON|COMPCAD|COMPCURV|G642|G645)\b/, 3, 'SOFT / G642'],
    ['okuma', /\bG15\s*H\d/, 12, 'G15 H'],
    ['okuma', /\bV[CS]\d+\s*=/, 8, 'VC variables'],
    ['okuma', /\b(?:NCYL|NOEX)\b|\bCALL\s+O\w+/, 8, 'NCYL / CALL O'],
    ['fagor', /^\s*(?:N\d+\s+)?#(?:MSG|CALL|PCALL|MCALL|TRAFO|RTCP|CS|ACS|SELECT|HSC|CAX|TIME|WAIT|FLUSH|ROUNDPAR|DGWZ)\b/im, 14, '#MSG / #CALL'],
    ['fagor', /^\s*(?:N\d+\s+)?\$(?:IF|FOR|WHILE|GOTO|ELSE|ENDIF)\b/im, 8, '$IF / $FOR'],
    ['fagor8055', /\((?:RPT|ORGX\d+|CALL\s+\d|IF\s+|GOTO\s+N|PCALL)/i, 10, '(RPT) / (ORGX)'],
    ['haas', /\bG187\b/, 8, 'G187'],
    ['haas', /\bG(?:47|150)\b/, 6, 'G47 / G150'],
    ['haas', /\bM97\s*P\d/, 8, 'M97 P'],
    ['haas', /\bG154\s*P\d/, 8, 'G154 P'],
    ['haas', /\bG(?:234|254|255|268|269)\b/, 8, 'G234 / G254'],
    ['brother', /\bG100\s*T\d/, 12, 'G100 T'],
    ['linuxcnc', /^\s*[oO]<\w+>\s*(?:sub|call|if|while)\b|#<_?\w+>/im, 14, 'o<sub> / #<var>'],
    ['grbl', /^\s*\$(?:H|X|J=|#|\$|\d+=)/m, 14, '$H / $$'],
    ['fanucFamily', /^\s*O\d{1,5}\b/m, 3, 'O number'],
    ['fanucFamily', /\bG0?5\.1\s*Q1\b|\bG0?5\s*P10000\b|\bG0?8\s*P1\b/, 4, 'G05.1 Q1 / G05 P10000'],
    ['fanucFamily', /\bG43\.[45]\b|\bG68\.2\b|\bG53\.1\b/, 3, 'G43.4 / G68.2'],
    ['fanucFamily', /\bG54\.1\s*P\d|\bG10\s*L\d|\bM98\s*P\d|#\d+\s*=/, 3, 'G54.1 / M98 / macros'],
    ['fanucFamily', /\bG(?:73|8[1-9])\b[^\n]*\bR[-+]?[.\d]/, 2, 'G8x canned cycles'],
    ['mazakMitsu', /\bG61\.1\b/, 5, 'G61.1'],
    ['mazak', /\bG0?5\s*P2\b/, 5, 'G05 P2'],
    ['mazak', /\bG10\.9\b|\bG109\b|\bM20[03]\b/, 4, 'G10.9 / G109'],
    ['mitsubishi', /\bG120\.1\b|\bG0?5\s*P20000\b/, 5, 'G120.1 / G05 P20000'],
  ];

  // Names written into header comments by CAM post-processors or programmers.
  // [family, regex, model builder]
  const NAMES = [
    ['heidenhain', /\bTNC\s*-?\s*(7|128|320|407|410|426|430|530|620|640)\b/i, (m) => (m[1] === '7' ? 'TNC7' : m[1] === '530' ? 'iTNC 530' : 'TNC ' + m[1])],
    ['heidenhain', /\bHEIDENHAIN\b/i, null],
    ['siemens', /\bSINUMERIK\s+ONE\b/i, () => 'SINUMERIK ONE'],
    ['siemens', /\b(840\s*D\s*SL|840\s*D(?:E)?\s*(?:PL|POWERLINE)?|828\s*D|808\s*D|802\s*D(?:\s*SL)?|810\s*D)\b/i, (m) => m[1].toUpperCase().replace(/\s+/g, ' ').replace(/^(\d{3})\s*D/, '$1D').replace('POWERLINE', 'pl').replace(/ SL$/, ' sl').replace(/ PL$/, ' pl')],
    ['siemens', /\b(SINUMERIK|SIEMENS|SHOPMILL|SHOPTURN)\b/i, null],
    ['fanuc', /\bFANUC\s*(?:SERIES\s*)?(0I-?[MT]?[A-F](?:\s*PLUS)?|3[0-2]I(?:-[AB](?:5|PLUS)?)?|1[68]I(?:-[MT][AB])?|21I(?:-[MT][AB])?|OI-?[MT]?[A-F])/i, (m) => 'Series ' + m[1].toUpperCase().replace(/^OI/, '0I').replace(/I/g, 'i').replace('PLUS', ' Plus')],
    ['fanuc', /\bFANUC\b/i, null],
    ['mazak', /\b(MAZATROL\s*SMOOTH\s*(?:AI|X|G|C|EZ|CX)?|SMOOTH\s*(?:AI|X|G|C|EZ|CX)|MATRIX\s*(?:2|NEXUS)?|NEXUS\s*2?|640\s*(?:M|MT|T)(?:\s*PRO)?|FUSION\s*640)\b/i, (m) => mazakModel(m[1])],
    ['mazak', /\b(MAZAK|MAZATROL|INTEGREX|VARIAXIS|VORTEX|VCN-?\d|VCU-?\d|QUICK\s*TURN|HCN-?\d)\b/i, null],
    ['mitsubishi', /\b(M8[03]0[VSW]?|M7[02]0[VS]?|M80V?|M70V?|M6[45]0M|C80|E80)\b(?=[^\n]*\b(?:MITSUBISHI|MELDAS|SERIES|CNC)\b)|\b(?:MITSUBISHI|MELDAS)\s*(?:CNC\s*)?(M8[03]0[VSW]?|M7[02]0[VS]?|M80V?|M70V?|M6[45]0M|E80|C80)\b/i, (m) => (m[1] || m[2]).toUpperCase() + ' Series'],
    ['mitsubishi', /\b(MITSUBISHI|MELDAS)\b/i, null],
    ['kitamura', /\bARUMATIK\s*-?\s*(MI\s*(?:II|2|NEO)?|NEO|ZEUS)?/i, (m) => 'Arumatik' + (m[1] ? '-' + m[1].toUpperCase().replace(/^MI/, 'Mi').replace('NEO', 'Neo') : '')],
    ['kitamura', /\b(KITAMURA|MYCENTER|SUPERCELL)\b/i, null],
    ['okuma', /\bOSP\s*-?\s*(P\d{3}[A-Z]{0,2}|E\d{3}|U\d{2}|7000)\b/i, (m) => 'OSP-' + m[1].toUpperCase()],
    ['okuma', /\b(OKUMA|OSP)\b/i, null],
    ['haas', /\b(NGC|NEXT\s*GEN(?:ERATION)?\s*CONTROL)\b/i, () => 'NGC (Next Generation Control)'],
    ['haas', /\bHAAS\b/i, null],
    ['brother', /\bCNC-?([A-D]00)\b/i, (m) => 'CNC-' + m[1].toUpperCase()],
    ['brother', /\b(BROTHER|SPEEDIO)\b/i, null],
    ['fagor', /\bFAGOR\s*(80[5-7][05]|8058|8037|8040|QUERCUS)/i, (m) => 'CNC ' + m[1].toUpperCase()],
    ['fagor', /\bFAGOR\b/i, null],
    ['doosan', /\b(DOOSAN|DN\s*SOLUTIONS|PUMA|DNM|DVF)\b/i, null],
    ['hurco', /\b(HURCO|WINMAX|MAX\s*5)\b/i, null],
    ['dmgmori', /\b(DMG\s*MORI|DMG|MORI\s*SEIKI|CELOS|MAPPS)\b/i, null],
    ['linuxcnc', /\bLINUXCNC\b|\bEMC2\b/i, null],
    ['mach', /\bMACH\s*([34])\b/i, (m) => 'Mach' + m[1]],
    ['grbl', /\bGRBL\b/i, null],
  ];

  const CAM = [
    [/\bFUSION\s*360\b|\bAUTODESK\s*(?:FUSION|CAM)\b|\bINVENTOR\s*CAM\b|\bHSMWORKS\b/i, 'Autodesk Fusion / HSM'],
    [/\bMASTERCAM\b/i, 'Mastercam'], [/\bHYPERMILL\b/i, 'hyperMILL'], [/\bSOLIDCAM\b/i, 'SolidCAM'],
    [/\bPOWERMILL\b|\bDELCAM\b/i, 'PowerMill'], [/\bSIEMENS\s*NX\b|\bNX\s*CAM\b|\bUNIGRAPHICS\b/i, 'Siemens NX'],
    [/\bESPRIT\b/i, 'ESPRIT'], [/\bCATIA\b/i, 'CATIA'], [/\bGIBBSCAM\b/i, 'GibbsCAM'], [/\bEDGECAM\b/i, 'Edgecam'],
    [/\bTOPSOLID\b/i, 'TopSolid'], [/\bCIMATRON\b/i, 'Cimatron'], [/\bWORKNC\b/i, 'WorkNC'], [/\bFEATURECAM\b/i, 'FeatureCAM'],
    [/\bVCARVE\b|\bASPIRE\b|\bVECTRIC\b/i, 'Vectric'], [/\bCARBIDE\s*CREATE\b/i, 'Carbide Create'], [/\bESTLCAM\b/i, 'Estlcam'],
  ];

  const FAMILY = {
    heidenhain: 'HEIDENHAIN', siemens: 'Siemens SINUMERIK', fanuc: 'FANUC', mazak: 'Mazak', mitsubishi: 'Mitsubishi',
    kitamura: 'Kitamura', okuma: 'Okuma', haas: 'Haas', brother: 'Brother', fagor: 'Fagor', doosan: 'DN Solutions (Doosan)',
    hurco: 'Hurco', dmgmori: 'DMG MORI', linuxcnc: 'LinuxCNC', mach: 'Mach3/Mach4', grbl: 'GRBL', iso: 'ISO G-code',
  };
  // Which control a machine builder's ISO programs run on when the header does not say.
  const DIALECT = {
    heidenhain: 'klartext', siemens: 'sinumerik', okuma: 'okuma', fagor: 'fagor', linuxcnc: 'iso', grbl: 'iso', mach: 'iso',
  };

  function mazakModel(s) {
    s = s.toUpperCase().replace(/\s+/g, ' ').replace(/^MAZATROL /, '').trim();
    const m = /^SMOOTH ?(\w*)$/.exec(s);
    if (m) return 'MAZATROL Smooth' + ({ AI: 'Ai', EZ: 'Ez' }[m[1]] || m[1]);
    return 'MAZATROL ' + s.replace('MATRIX', 'Matrix').replace('NEXUS', 'Nexus').replace('FUSION', 'Fusion');
  }

  function headerComments(text) {
    // Comments from the first 200 lines (and the file tail, where some posts put a footer)
    const head = text.slice(0, 40000).split('\n', 200);
    const tail = text.length > 40000 ? text.slice(-4000).split('\n') : [];
    const out = [];
    for (const l of head.concat(tail)) {
      const s = l.indexOf(';'), p = l.indexOf('(');
      if (s !== -1) out.push(l.slice(s + 1));
      if (p !== -1) out.push(l.slice(p + 1).replace(/\)\s*$/, ''));
    }
    return out.join('\n');
  }

  function detect(text, name) {
    const src = text.length > SCAN ? text.slice(0, SCAN) : text;
    const score = {}, evidence = {};
    for (const [fam, re, w, label] of SYNTAX) {
      if (re.test(src)) { score[fam] = (score[fam] || 0) + w; (evidence[fam] = evidence[fam] || []).push(label); }
    }
    const comments = headerComments(text) + '\n' + (name || '');
    let named = null, model = null;
    for (const [fam, re, build] of NAMES) {
      const m = re.exec(comments);
      if (!m) continue;
      if (!named) named = fam;
      if (fam === named && build && !model) model = build(m);
      if (named && model) break;
    }
    let cam = null;
    for (const [re, label] of CAM) if (re.test(comments)) { cam = label; break; }

    // syntax family (strong cues win; Fanuc-compatible ISO is the fallback)
    const pick = (keys) => keys.reduce((a, k) => ((score[k] || 0) > (score[a] || 0) ? k : a), keys[0]);
    let syntax = pick(['heidenhain', 'heidenhainIso', 'siemens', 'okuma', 'fagor', 'fagor8055', 'linuxcnc', 'grbl']);
    if (!((score[syntax] || 0) >= 10)) syntax = null;

    let family, dialect, confidence;
    if (syntax) {
      family = syntax === 'heidenhainIso' ? 'heidenhain' : syntax === 'fagor8055' ? 'fagor' : syntax;
      dialect = syntax === 'heidenhainIso' ? 'heidenhainIso' : syntax === 'fagor8055' ? 'fagor' : DIALECT[family] || 'iso';
      confidence = named === family || !named ? 'high' : 'medium';
    } else if (named) {
      family = named;
      dialect = DIALECT[family] || 'iso';
      confidence = model ? 'high' : 'medium';
    } else {
      // ISO: vendor-specific codes nudge the guess, otherwise "Fanuc-compatible"
      const iso = pick(['haas', 'brother', 'mazak', 'mitsubishi', 'mazakMitsu']);
      const s = score[iso] || 0;
      if (s >= 8 && (iso === 'haas' || iso === 'brother')) family = iso;
      else if (s >= 5 && iso === 'mazak') family = 'mazak';
      else if (s >= 5 && iso === 'mitsubishi') family = 'mitsubishi';
      else family = 'iso';
      dialect = 'iso';
      confidence = family === 'iso' ? 'low' : 'medium';
    }

    const ev = [];
    const add = (k) => { for (const e of evidence[k] || []) if (!ev.includes(e)) ev.push(e); };
    if (family === 'heidenhain') { add('heidenhain'); add('heidenhainIso'); }
    else if (family === 'fagor') { add('fagor'); add('fagor8055'); }
    else if (family === 'iso' || family === 'fanuc' || family === 'mazak' || family === 'mitsubishi' || family === 'kitamura' || family === 'doosan') {
      add(family); add('mazakMitsu'); add('fanucFamily');
    } else add(family);
    if (named) ev.unshift('header: ' + (FAMILY[named] || named));

    const ver = version(family, dialect, src, score, evidence, model);
    return {
      family, dialect, confidence,
      name: FAMILY[family] || family,
      model: ver.model,
      era: ver.era,
      evidence: ev.slice(0, 6),
      cam,
    };
  }

  const has = (src, re) => re.test(src);

  // Feature-based generation guess. Returns { model, era }.
  function version(family, dialect, src, score, evidence, named) {
    if (named) return { model: named, era: eraOf(family, named) };
    switch (family) {
      case 'heidenhain': {
        if (dialect === 'heidenhainIso') return { model: 'TNC (DIN/ISO programming)', era: null };
        if (has(src, /\bFUNCTION\s+MODE\s+TURN\b|\bCYCL DEF 8\d\d\b/)) return { model: 'TNC 640 / TNC7 (mill-turn)', era: '2012+' };
        if (has(src, /\bFUNCTION\s+(?:PROG PATH|LIFTOFF|S-PULSE|DWELL|CORRDATA|FEED DWELL|POLARKIN|COUNT|SPINDLE)\b|\bCYCL DEF (?:23[89]|12\d\d)\b/))
          return { model: 'TNC 620 / TNC 640 / TNC7', era: '2011+' };
        if (has(src, /\bPLANE\s+(?:SPATIAL|PROJECTED|EULER|VECTOR|POINTS|RELATIV|AXIAL|RESET)\b|\bFUNCTION\s+TCPM\b|\bTOOL CALL\s+"|\bCYCL DEF 2(?:5\d|6\d|7\d)\b/))
          return { model: 'iTNC 530 or newer (TNC 320/620/640)', era: '2004+' };
        if (has(src, /\bCYCL DEF 2\d\d\b|\bCYCL DEF 19\b/)) return { model: 'TNC 426 / 430 or newer', era: '1997+' };
        return { model: 'TNC (Klartext)', era: null };
      }
      case 'siemens': {
        const operate = has(src, /\bCYCLE(?:6[1-4]|7[0-9]|80[12]|952|830|99)\s*\(|\bWORKPIECE\s*\(|\bCYCLE832\s*\([^)]*_ORI_|\bCYCLE800\s*\((?:[^,)]*,){16}/);
        if (operate) return { model: '840D sl / 828D (SINUMERIK Operate) or ONE', era: '2008+' };
        if (has(src, /\bCYCLE8(?:00|32)\s*\(|\bTRAORI\b|\bT\s*=\s*"/)) return { model: '840D / 840D sl / 828D', era: '2002+' };
        if (has(src, /\b(?:CYCLE(?:7[1-9]|8\d|90)|POCKET[34]|SLOT[12]|LONGHOLE|HOLES[12])\s*\(/)) return { model: '810D / 840D / 802D (classic cycles)', era: '1998+' };
        return { model: 'SINUMERIK', era: null };
      }
      case 'fagor':
        if ((score.fagor || 0) >= 10) return { model: 'CNC 8060 / 8065 / 8070', era: '2008+' };
        if (score.fagor8055) return { model: 'CNC 8055 / 8050', era: '1998+' };
        return { model: 'CNC', era: null };
      case 'okuma':
        return { model: has(src, /\bG1(?:69|70)\b|\bTCP\b/) ? 'OSP-P200 or newer' : 'OSP', era: null };
      case 'haas':
        return has(src, /\bG(?:268|269|253)\b/) ? { model: 'NGC (Next Generation Control)', era: '2016+' } : { model: 'Classic / NGC', era: null };
      case 'mazak':
        return { model: 'EIA/ISO program (MAZATROL control)', era: has(src, /\bG0?5\s*P2\b|\bG61\.1\b/) ? '2000+' : null };
      case 'mitsubishi':
        return { model: has(src, /\bG120\.1\b|\bG0?5\s*P20000\b/) ? 'M700V / M70V / M800 / M80' : 'M-series', era: '2004+' };
      default: {
        // Fanuc-compatible ISO: feature level tells the generation
        if (has(src, /\bG43\.[45]\b|\bG68\.[24]\b|\bG53\.1\b/)) return { model: 'Fanuc-compatible, 5-axis TCP / tilted plane (30i/0i-F class)', era: '2003+' };
        if (has(src, /\bG0?5\.1\s*Q1\b|\bG0?5\s*P10000\b|\bG0?8\s*P1\b/)) return { model: 'Fanuc-compatible, AI contour / HPCC (0i/16i/18i/30i class)', era: '1998+' };
        return { model: family === 'iso' ? 'Fanuc-compatible (Fanuc, Mitsubishi, Mazak EIA, Kitamura…)' : null, era: null };
      }
    }
  }

  function eraOf(family, model) {
    const m = model.toUpperCase();
    const table = [
      [/TNC7/, '2022+'], [/TNC 640/, '2012+'], [/TNC 620/, '2011+'], [/TNC 320/, '2008+'], [/TNC 128/, '2013+'], [/ITNC 530/, '2004+'], [/TNC 4[23]0/, '1993–2007'],
      [/ONE/, '2019+'], [/840D SL|828D/, '2008+'], [/808D/, '2011+'], [/802D/, '2002+'], [/840D|810D/, '1996–2012'],
      [/0I-?F PLUS/, '2019+'], [/0I-?[MT]?F/, '2015+'], [/0I-?[MT]?D/, '2008+'], [/0I-?[MT]?C/, '2004+'], [/3[0-2]I-B/, '2012+'], [/3[0-2]I/, '2003+'], [/1[68]I|21I/, '1996–2010'],
      [/SMOOTH ?AI/, '2019+'], [/SMOOTH/, '2013+'], [/MATRIX 2|NEXUS/, '2008+'], [/MATRIX/, '2004+'], [/640/, '2000–2005'],
      [/M8[03]0/, '2014+'], [/M8\d?V?\b|M80/, '2014+'], [/M7[02]0|M70/, '2004+'],
      [/MI NEO|NEO/, '2019+'], [/MI (II|2)/, '2010+'], [/ARUMATIK-MI/, '2003+'],
      [/P500/, '2021+'], [/P300/, '2012+'], [/P200/, '2004+'],
      [/NGC/, '2016+'], [/CNC-D00/, '2014+'], [/CNC-C00/, '2007+'], [/806[05]|8070/, '2008+'], [/8055/, '1998+'],
    ];
    for (const [re, era] of table) if (re.test(m)) return era;
    return null;
  }

  self.GSController = { detect };
})();
