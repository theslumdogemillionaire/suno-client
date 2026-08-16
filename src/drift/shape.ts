/**
 * Structural fingerprinting of JSON responses.
 *
 * The point is not validation. Zod already validates the fields we consume, and
 * it does so in passthrough mode on purpose: a REST API we do not own will add
 * fields, and failing on every addition would mean an outage every time Suno
 * ships a feature.
 *
 * What we actually need is the opposite signal - a field we DO consume quietly
 * disappearing or changing type. That is invisible to a passthrough parse until
 * something downstream reads `undefined`. So we fingerprint every response and
 * diff it against a baseline recorded from known-good traffic.
 *
 * Arrays collapse to a single `[]` element, unioned across all their items. A
 * 20-clip page and a 1-clip page therefore produce the same fingerprint, which
 * is what makes baselines stable enough to commit.
 */

export type TypeKind = 'string' | 'number' | 'boolean' | 'null' | 'array' | 'object';

/** path -> the set of types observed at that path, sorted for stable diffing. */
export type Shape = Record<string, TypeKind[]>;

export interface PathStats {
  types: TypeKind[];
  /** How many containers held this path. */
  seen: number;
  /** How many containers could have held it. `seen === total` means required. */
  total: number;
}

export interface Baseline {
  endpoint: string;
  /** How many responses were folded into this baseline. */
  samples: number;
  paths: Record<string, PathStats>;
  recordedAt: string;
}

function kindOf(value: unknown): TypeKind {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  switch (typeof value) {
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    default:
      return 'object';
  }
}

/**
 * The container a path belongs to: the longest prefix ending in `[]`, or the
 * response root.
 *
 * This is the fix for a false alarm that cost real debugging time.
 * `clips[].display_tags` is set on some clips and not others. Counting presence
 * per RESPONSE made it look mandatory, because at least one clip in every
 * sampled page happened to have it - and then a page of five newer clips
 * without it read as "the field was removed". Counting per CLIP gets it right:
 * 40% of clips carry it, so its absence means nothing.
 */
export function containerOf(path: string): string {
  const idx = path.lastIndexOf('[]');
  return idx === -1 ? '' : path.slice(0, idx + 2);
}

interface WalkAcc {
  /** path -> types seen */
  types: Map<string, Set<TypeKind>>;
  /** path -> number of containers that held it, this response */
  counts: Map<string, number>;
  /** container path -> number of container instances, this response */
  containers: Map<string, number>;
}

function bump(map: Map<string, number>, key: string, by = 1): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

function walk(value: unknown, path: string, acc: WalkAcc): void {
  const kind = kindOf(value);
  if (path !== '') {
    let set = acc.types.get(path);
    if (!set) {
      set = new Set();
      acc.types.set(path, set);
    }
    set.add(kind);
    bump(acc.counts, path);
  }

  if (kind === 'array') {
    const items = value as unknown[];
    // Each element is one container instance for everything beneath it.
    bump(acc.containers, `${path}[]`, items.length);
    for (const item of items) walk(item, `${path}[]`, acc);
    return;
  }
  if (kind === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      walk(v, path === '' ? k : `${path}.${k}`, acc);
    }
  }
}

function walkResponse(value: unknown): WalkAcc {
  const acc: WalkAcc = { types: new Map(), counts: new Map(), containers: new Map() };
  // The response itself is the root container, seen exactly once.
  acc.containers.set('', 1);
  walk(value, '', acc);
  return acc;
}

export function shapeOf(value: unknown): Shape {
  return fingerprint(value).shape;
}

export interface Fingerprint {
  shape: Shape;
  /** container path -> how many instances this response contained. */
  containers: Map<string, number>;
}

/**
 * Shape plus container counts.
 *
 * The counts matter for one specific false alarm: an EMPTY array. When
 * `tags: []` comes back, no `tags[]` container exists, so every path beneath it
 * is absent - but that says nothing about the schema. Without the counts, an
 * empty array reads as "Suno deleted these fields".
 */
export function fingerprint(value: unknown): Fingerprint {
  const acc = walkResponse(value);
  const shape: Shape = {};
  for (const [path, types] of acc.types) {
    shape[path] = [...types].sort();
  }
  return { shape, containers: acc.containers };
}

/** Fold one more observed response into a baseline. */
export function foldIntoBaseline(baseline: Baseline, value: unknown): Baseline {
  const acc = walkResponse(value);
  const paths: Record<string, PathStats> = { ...baseline.paths };

  // Every path already in the baseline gains this response's container count,
  // whether or not it appeared. That is what makes `seen / total` meaningful.
  const containerTotals = new Map(acc.containers);

  const allPaths = new Set([...Object.keys(paths), ...acc.counts.keys()]);
  for (const path of allPaths) {
    const container = containerOf(path);
    const totalHere = containerTotals.get(container) ?? 0;
    const seenHere = acc.counts.get(path) ?? 0;
    const observedTypes = acc.types.get(path);
    const prev = paths[path];

    if (prev) {
      const mergedTypes = observedTypes
        ? ([...new Set([...prev.types, ...observedTypes])].sort() as TypeKind[])
        : prev.types;
      paths[path] = {
        types: mergedTypes,
        seen: prev.seen + seenHere,
        total: prev.total + totalHere,
      };
    } else {
      paths[path] = {
        types: observedTypes ? ([...observedTypes].sort() as TypeKind[]) : [],
        seen: seenHere,
        total: totalHere,
      };
    }
  }

  return { ...baseline, paths, samples: baseline.samples + 1 };
}

export function emptyBaseline(endpoint: string, recordedAt: string): Baseline {
  return { endpoint, samples: 0, paths: {}, recordedAt };
}
