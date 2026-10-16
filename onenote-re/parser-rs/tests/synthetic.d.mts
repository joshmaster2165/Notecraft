// Types for synthetic.mjs, so TypeScript tests can build revision stores with it.
export interface Eg {
  guid: Uint8Array;
  n: number;
}
export interface Value {
  id: number;
  type: number;
}
type StrOpts = { bom?: boolean; nul?: boolean; odd?: boolean };
export declare const V: {
  none(id: number): Value;
  bool(id: number, v: boolean): Value;
  u8(id: number, v: number): Value;
  u16(id: number, v: number): Value;
  u32(id: number, v: number): Value;
  f32(id: number, v: number): Value;
  u64(id: number, v: number | bigint): Value;
  bytes(id: number, bytes: Uint8Array): Value;
  str(id: number, s: string, o?: StrOpts): Value;
  oid(id: number, e: Eg): Value;
  oids(id: number, es: Eg[]): Value;
  osid(id: number, e: Eg): Value;
  osids(id: number, es: Eg[]): Value;
  ctx(id: number, e: Eg): Value;
  ctxs(id: number, es: Eg[]): Value;
  sets(id: number, sets: unknown[], innerType?: number): Value;
  set(id: number, props: Value[]): Value;
};
export declare const J: Record<string, number>;
export interface Rng {
  next(): number;
  int(n: number): number;
  chance(p: number): boolean;
  pick<T>(a: T[]): T;
  bytes(n: number): Uint8Array;
}
export declare function makeRng(seed: number): Rng;
export interface Space {
  gosid: Eg;
  encrypted: boolean;
}
export interface Revision {
  rid: Eg;
  roots: [number, Eg][];
}
export declare class StoreBuilder {
  constructor(rng: Rng, kind: "one" | "toc");
  eg(): Eg;
  space(opts?: { encrypted?: boolean }): Space;
  revision(space: Space, opts?: { role?: number; context?: Eg | null; dependent?: Eg | null }): Revision;
  object(rev: Revision, jcid: number, props: Value[], oid?: Eg): Eg;
  fileObject(rev: Revision, jcid: number, reference: string, extension: string): Eg;
  addFileData(bytes: Uint8Array): string;
  build(): Uint8Array;
}
export declare function guidString(b: Uint8Array): string;
export declare function generateSection(seed: number): Uint8Array;
export declare function generateToc(seed: number): Uint8Array;
export declare function generateDeep(kind: "props" | "outline", depth: number, seed?: number): Uint8Array;
