/* GcodeScope — arithmetic for controller variables (Fanuc #100, Siemens R1 / DEF REAL, Heidenhain Q1,
 * Okuma VC1). Loaded into the parser worker with importScripts(); exposes self.GSExpr.
 *
 * evaluate(src, lookup) → number (NaN on error). Supports + - * / ^, ( ) and [ ], unary signs,
 * comparisons (EQ NE GT GE LT LE and == <> != > < >= <=), AND OR XOR NOT, MOD, and the usual
 * functions (angles in degrees, as on every control). lookup(name) resolves identifiers such as
 * "#100", "R1", "Q5", "VC1" or a Siemens user variable name.
 */
'use strict';
(function () {
  const D = Math.PI / 180;
  const FN = {
    SIN: (a) => Math.sin(a * D), COS: (a) => Math.cos(a * D), TAN: (a) => Math.tan(a * D),
    ASIN: (a) => Math.asin(a) / D, ACOS: (a) => Math.acos(a) / D, ATAN: (a, b) => (b === undefined ? Math.atan(a) : Math.atan2(a, b)) / D,
    ATAN2: (a, b) => Math.atan2(a, b) / D, SQRT: Math.sqrt, SQR: (a) => a * a, ABS: Math.abs, LN: Math.log, EXP: Math.exp,
    ROUND: Math.round, RND: Math.round, FIX: Math.floor, FUP: Math.ceil, TRUNC: Math.trunc, INT: Math.trunc,
    POT: (a) => a * a, MINVAL: Math.min, MAXVAL: Math.max, MIN: Math.min, MAX: Math.max,
    SGN: Math.sign, FRAC: (a) => a - Math.trunc(a), NEG: (a) => -a,
  };
  const TOKEN = /\s*(?:(\d+\.?\d*(?:E[-+]?\d+)?|\.\d+)|(#\d+|#\[|[A-Z_$][A-Z0-9_$]*(?:\[\d+\])?)|(==|<>|!=|>=|<=|\*\*|[-+*/^()[\],<>=]))/iy;

  function tokenize(s) {
    const out = [];
    TOKEN.lastIndex = 0;
    let m;
    while (TOKEN.lastIndex < s.length) {
      const at = TOKEN.lastIndex;
      if (!(m = TOKEN.exec(s))) {
        if (/^\s*$/.test(s.slice(at))) break;
        throw new Error('bad token');
      }
      if (m[1] !== undefined) out.push({ n: parseFloat(m[1]) });
      else if (m[2] !== undefined) {
        const id = m[2].toUpperCase(), fn = /^([A-Z_$][A-Z0-9_$]*)\[(\d+)\]$/.exec(id);
        if (fn && FN[fn[1]]) out.push({ id: fn[1] }, { op: '[' }, { n: +fn[2] }, { op: ']' }); // SIN[30] is a call, not an array
        else out.push({ id });
      }
      else out.push({ op: m[3] });
    }
    return out;
  }

  function evaluate(src, lookup) {
    let toks;
    try { toks = tokenize(String(src)); } catch { return NaN; }
    let i = 0;
    const peek = () => toks[i], isOp = (o) => toks[i] && toks[i].op === o, isId = (w) => toks[i] && toks[i].id === w;
    const cmpOps = { EQ: '==', NE: '<>', GT: '>', GE: '>=', LT: '<', LE: '<=' };
    function or() {
      let a = and();
      while (isId('OR') || isId('XOR')) { const x = toks[i++].id; const b = and(); a = x === 'OR' ? +(!!a || !!b) : +(!!a !== !!b); }
      return a;
    }
    function and() {
      let a = cmp();
      while (isId('AND')) { i++; const b = cmp(); a = +(!!a && !!b); }
      return a;
    }
    function cmp() {
      let a = add();
      for (;;) {
        const t = peek();
        if (!t) return a;
        let op = t.op || cmpOps[t.id];
        if (op === '=') op = '==';
        if (!['==', '<>', '!=', '>', '>=', '<', '<='].includes(op)) return a;
        i++;
        const b = add();
        a = op === '==' ? +(Math.abs(a - b) < 1e-9) : op === '<>' || op === '!=' ? +(Math.abs(a - b) >= 1e-9)
          : op === '>' ? +(a > b) : op === '>=' ? +(a >= b) : op === '<' ? +(a < b) : +(a <= b);
      }
    }
    function add() {
      let a = mul();
      while (isOp('+') || isOp('-')) { const o = toks[i++].op; const b = mul(); a = o === '+' ? a + b : a - b; }
      return a;
    }
    function mul() {
      let a = unary();
      while (isOp('*') || isOp('/') || isId('MOD') || isId('DIV')) {
        const t = toks[i++], b = unary();
        a = t.op === '*' ? a * b : t.op === '/' ? a / b : t.id === 'MOD' ? a % b : Math.trunc(a / b);
      }
      return a;
    }
    function unary() {
      if (isOp('-')) { i++; return -unary(); }
      if (isOp('+')) { i++; return unary(); }
      if (isId('NOT')) { i++; return +!unary(); }
      return pow();
    }
    function pow() { // binds tighter than a leading sign: -2^2 = -4
      const a = atom();
      if (isOp('^') || isOp('**')) { i++; return Math.pow(a, unary()); }
      return a;
    }
    function atom() {
      const t = toks[i++];
      if (!t) throw new Error('eof');
      if (t.n !== undefined) return t.n;
      if (t.op === '(' || t.op === '[') {
        const v = or();
        if (!(isOp(')') || isOp(']'))) throw new Error('paren');
        i++;
        return v;
      }
      if (t.id === '#[') { // Fanuc indirect variable #[expr]
        const v = or();
        if (!isOp(']')) throw new Error('paren');
        i++;
        return num(lookup('#' + Math.round(v)));
      }
      if (t.id) {
        if (FN[t.id] && (isOp('(') || isOp('['))) {
          i++;
          const args = [or()];
          while (isOp(',')) { i++; args.push(or()); }
          if (!(isOp(')') || isOp(']'))) throw new Error('paren');
          i++;
          return FN[t.id](...args);
        }
        if (t.id === 'PI' || t.id === '$PI') return Math.PI;
        if (t.id === 'TRUE') return 1;
        if (t.id === 'FALSE') return 0;
        return num(lookup(t.id));
      }
      throw new Error('unexpected ' + (t.op || ''));
    }
    const num = (v) => (typeof v === 'number' && !Number.isNaN(v) ? v : 0); // undefined variables read as 0 (#0 "vacant")
    try {
      const v = or();
      return i === toks.length ? v : NaN;
    } catch {
      return NaN;
    }
  }

  self.GSExpr = { evaluate };
})();
