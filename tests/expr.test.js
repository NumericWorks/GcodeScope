// Controller variable arithmetic (js/expr.js): Fanuc #vars, Siemens R / user vars, Heidenhain Q, Okuma VC
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');

const ctx = { Math };
ctx.self = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'expr.js'), 'utf8'), ctx, { filename: 'expr.js' });
const { evaluate } = ctx.GSExpr;
const { parseText } = require('./harness');

const VARS = { '#1': 3, '#100': 10, '#101': 2.5, R1: 4, Q5: -2, VC1: 7, DEPTH: 12, 'ARR[2]': 9 };
const ev = (s) => evaluate(s, (n) => VARS[n]);
const near = (a, b) => Math.abs(a - b) < 1e-9;

module.exports = async (t) => {
  t.check('precedence: 2+3*4 = 14, (2+3)*4 = 20, [2+3]*4 = 20', ev('2+3*4') === 14 && ev('(2+3)*4') === 20 && ev('[2+3]*4') === 20, [ev('2+3*4'), ev('(2+3)*4')]);
  t.check('power is right-associative: 2^3^2 = 512, 2**3 = 8', ev('2^3^2') === 512 && ev('2**3') === 8, ev('2^3^2'));
  t.check('unary signs: -2^2 = -4, --3 = 3, +-1 = -1', ev('-2^2') === -4 && ev('--3') === 3 && ev('+-1') === -1, [ev('-2^2'), ev('--3')]);
  t.check('numbers: .5, 5., 1.5E2', ev('.5') === 0.5 && ev('5.') === 5 && ev('1.5E2') === 150, ev('1.5E2'));
  t.check('MOD and DIV', ev('17 MOD 5') === 2 && ev('17 DIV 5') === 3 && ev('-7 DIV 2') === -3, [ev('17 MOD 5'), ev('17 DIV 5')]);

  t.check('variables: #100*#101, R1+Q5, VC1, DEPTH/2, ARR[2]',
    ev('#100*#101') === 25 && ev('R1+Q5') === 2 && ev('VC1') === 7 && ev('DEPTH/2') === 6 && ev('ARR[2]') === 9, null);
  t.check('lower-case identifiers resolve upper-case', ev('r1 * depth') === 48, ev('r1 * depth'));
  t.check('undefined variable reads as 0 (vacant)', ev('#500 + 1') === 1 && ev('UNKNOWN') === 0, ev('#500 + 1'));
  t.check('Fanuc indirect #[#1+97] → #100', ev('#[#1+97]') === 10, ev('#[#1+97]'));

  t.check('trig in degrees: SIN[30], COS[60], TAN[45]', near(ev('SIN[30]'), 0.5) && near(ev('COS[60]'), 0.5) && near(ev('TAN[45]'), 1), [ev('SIN[30]'), ev('COS[60]')]);
  t.check('inverse trig: ASIN(1)=90, ATAN[1]/[1]=45 style, ATAN2(1,-1)=135', near(ev('ASIN(1)'), 90) && near(ev('ATAN(1)'), 45) && near(ev('ATAN2(1,-1)'), 135) && near(ev('ATAN(1,-1)'), 135), [ev('ASIN(1)'), ev('ATAN2(1,-1)')]);
  t.check('rounding: ROUND/FIX/FUP/TRUNC on negatives', ev('ROUND[2.5]') === 3 && ev('FIX[-1.5]') === -2 && ev('FUP[1.2]') === 2 && ev('TRUNC(-1.7)') === -1, [ev('FIX[-1.5]'), ev('TRUNC(-1.7)')]);
  t.check('SQRT, SQR/POT, ABS, MIN/MAX with several args', ev('SQRT[16]') === 4 && ev('SQR(3)') === 9 && ev('POT(4)') === 16 && ev('ABS[-3]') === 3 && ev('MIN(3,1,2)') === 1 && ev('MAX(3,1,2)') === 3, null);
  t.check('constants PI, $PI, TRUE, FALSE', near(ev('PI'), Math.PI) && near(ev('$PI'), Math.PI) && ev('TRUE') === 1 && ev('FALSE') === 0, null);

  t.check('Fanuc comparisons: EQ NE GT GE LT LE', [ev('#100 EQ 10'), ev('#100 NE 10'), ev('3 GT 2'), ev('2 GE 2'), ev('1 LT 2'), ev('3 LE 2')].join() === '1,0,1,1,1,0', null);
  t.check('Siemens / Heidenhain comparisons: == <> != > < >= <= =', [ev('R1==4'), ev('R1<>4'), ev('R1!=5'), ev('R1>3'), ev('R1<3'), ev('R1>=4'), ev('R1<=3'), ev('R1=4')].join() === '1,0,1,1,0,1,0,1', null);
  t.check('equality tolerates float noise: 0.1+0.2 == 0.3', ev('0.1+0.2 == 0.3') === 1, ev('0.1+0.2 == 0.3'));
  t.check('logic: AND OR XOR NOT with comparisons', ev('[#1 GT 2] AND [#100 LT 20]') === 1 && ev('1 XOR 1') === 0 && ev('0 OR 2') === 1 && ev('NOT 0') === 1 && ev('NOT R1') === 0, null);

  t.check('malformed input → NaN: unbalanced, trailing operator, stray token, empty',
    [ev('(1+2'), ev('1+'), ev('1 2'), ev('3 @ 4'), ev('')].every(Number.isNaN), [ev('(1+2'), ev('1+'), ev('1 2'), ev('')]);
  t.check('function name without call reads as a variable', ev('SIN') === 0, ev('SIN'));
  t.check('non-string input is stringified', evaluate(42, () => 0) === 42, evaluate(42, () => 0));

  // end to end: a Fanuc macro program positions a drill hole with SIN[30] / COS[60]
  const r = await parseText([
    'O1000', '(FANUC 0I-MF)', 'G90 G17 G21 G54', 'T1 M6 (DRILL D=6.)', 'S1000 M3',
    '#1=100*SIN[30]', '#2=100*COS[60]+-2^2', 'G0 X0 Y0 Z10', 'G81 X#1 Y#2 Z-5 R2 F100', 'G80', 'M30',
  ].join('\n'), 'sin.nc');
  const h = r.holes[0] || {};
  t.check('Fanuc program: G81 X[100*SIN[30]] Y[100*COS[60]-4] → hole at 50,46', r.holes.length === 1 && Math.abs(h.x - 50) < 1e-6 && Math.abs(h.y - 46) < 1e-6, r.holes);
};
