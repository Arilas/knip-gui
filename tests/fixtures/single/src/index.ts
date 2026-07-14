import { usedHelper, Color, Geo, reexportSource } from './used.js';
import { listUsed, Config, dupeSource, dupeAlias } from './forms.js';
import type { Shape } from './shapes.js';
import { usedExtra } from './extra.js';

const s: Shape = { kind: 'circle' };
console.log(
  usedHelper(s.kind),
  Color.Red,
  new Geo().perimeter(),
  listUsed(),
  Config.usedFlag,
  dupeSource,
  dupeAlias,
  reexportSource(),
  usedExtra(),
);
