import { usedHelper, Color, Geo } from './used.js';
import type { Shape } from './shapes.js';

const s: Shape = { kind: 'circle' };
console.log(usedHelper(s.kind), Color.Red, new Geo().perimeter());
