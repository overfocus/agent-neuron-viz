// The slice of d3-force-3d this project uses (the package ships no types).
declare module "d3-force-3d" {
  export interface SimNode {
    index?: number;
    x?: number;
    y?: number;
    z?: number;
    vx?: number;
    vy?: number;
    vz?: number;
    fx?: number | null;
    fy?: number | null;
    fz?: number | null;
  }
  export interface Force<N> {
    (alpha: number): void;
    initialize?(nodes: N[], ...args: unknown[]): void;
  }
  export interface Simulation<N extends SimNode> {
    force(name: string, force: Force<N> | null): this;
    stop(): this;
    tick(iterations?: number): this;
    nodes(): N[];
    randomSource?(source: () => number): this;
  }
  export function forceSimulation<N extends SimNode>(nodes: N[], numDimensions?: number): Simulation<N>;
  export function forceLink<N extends SimNode, L>(links: L[]): Force<N> & {
    id(fn: (n: N) => string): ReturnType<typeof forceLink<N, L>>;
    distance(d: number | ((l: L) => number)): ReturnType<typeof forceLink<N, L>>;
    strength(s: number | ((l: L) => number)): ReturnType<typeof forceLink<N, L>>;
  };
  export function forceManyBody<N extends SimNode>(): Force<N> & {
    strength(s: number | ((n: N) => number)): ReturnType<typeof forceManyBody<N>>;
  };
  export function forceCollide<N extends SimNode>(radius?: number | ((n: N) => number)): Force<N> & {
    strength(s: number): ReturnType<typeof forceCollide<N>>;
  };
  export function forceX<N extends SimNode>(x?: number | ((n: N) => number)): Force<N> & {
    strength(s: number | ((n: N) => number)): ReturnType<typeof forceX<N>>;
  };
  export function forceY<N extends SimNode>(y?: number | ((n: N) => number)): Force<N> & {
    strength(s: number): ReturnType<typeof forceY<N>>;
  };
  export function forceZ<N extends SimNode>(z?: number | ((n: N) => number)): Force<N> & {
    strength(s: number): ReturnType<typeof forceZ<N>>;
  };
}
