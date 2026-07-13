export function usedHelper(k: string): string {
  return k.toUpperCase();
}

export function unusedHelper(n: number): number {
  return n * 2;
}

export enum Color {
  Red,
  Blue,
}

export class Geo {
  perimeter(): number {
    return 4;
  }
  area(): number {
    return 1;
  }
}

export function reexportSource(): number {
  return 9;
}
