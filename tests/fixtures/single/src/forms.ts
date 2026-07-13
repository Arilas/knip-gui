function listUsed(): number {
  return 1;
}
function listUnused(): number {
  return 2;
}
export { listUsed, listUnused };

export default function defaultUnused(): string {
  return 'never imported';
}

export namespace Config {
  export const usedFlag = true;
  export const unusedFlag = false;
}

export const dupeSource = 42;
export const dupeAlias = dupeSource;

export { reexportSource } from './used.js';
