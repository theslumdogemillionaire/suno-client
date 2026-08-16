import { describe, expect, it } from 'vitest';

import { detectDrift } from '../../src/drift/detect.js';
import {
  containerOf,
  emptyBaseline,
  foldIntoBaseline,
  shapeOf,
  type Baseline,
} from '../../src/drift/shape.js';

/** Five samples is the floor at which the detector will call a field required. */
function baselineFrom(endpoint: string, samples: unknown[]): Baseline {
  return samples.reduce<Baseline>(
    (acc, s) => foldIntoBaseline(acc, s),
    emptyBaseline(endpoint, '2026-08-17T00:00:00Z'),
  );
}

function repeat<T>(value: T, times: number): T[] {
  return Array.from({ length: times }, () => value);
}

describe('shapeOf', () => {
  it('collapses arrays so page size does not change the fingerprint', () => {
    const one = shapeOf({ clips: [{ id: 'a' }] });
    const twenty = shapeOf({ clips: Array.from({ length: 20 }, (_, i) => ({ id: `id-${i}` })) });
    expect(one).toEqual(twenty);
  });

  it('unions types seen across array elements', () => {
    const shape = shapeOf({ clips: [{ audio_url: null }, { audio_url: 'https://x' }] });
    expect(shape['clips[].audio_url']).toEqual(['null', 'string']);
  });

  it('distinguishes null from absent', () => {
    expect(shapeOf({ a: null })).toHaveProperty('a', ['null']);
    expect(shapeOf({})).not.toHaveProperty('a');
  });
});

describe('containerOf', () => {
  it('resolves a path to the thing that could have carried it', () => {
    expect(containerOf('total_credits_left')).toBe('');
    expect(containerOf('plan.name')).toBe('');
    expect(containerOf('clips[].status')).toBe('clips[]');
    expect(containerOf('clips[].metadata.duration')).toBe('clips[]');
    expect(containerOf('a[].b[].c')).toBe('a[].b[]');
  });
});

describe('foldIntoBaseline', () => {
  it('counts presence per container, not per response', () => {
    // One page, two clips, one of which has display_tags. Counting per response
    // would call it 1-of-1 and therefore required. Per clip it is 1 of 2.
    const baseline = baselineFrom('feed.v3', [
      { clips: [{ id: 'a', display_tags: ['x'] }, { id: 'b' }] },
    ]);
    expect(baseline.paths['clips[].id']).toMatchObject({ seen: 2, total: 2 });
    expect(baseline.paths['clips[].display_tags']).toMatchObject({ seen: 1, total: 2 });
  });
});

describe('detectDrift', () => {
  const sample = {
    clips: [{ id: 'a', status: 'complete', audio_url: 'https://x', extra_stat: 1 }],
    next_cursor: 'abc',
    has_more: true,
  };

  it('is silent when nothing changed', () => {
    const report = detectDrift(baselineFrom('feed.v3', repeat(sample, 5)), sample);
    expect(report.findings).toHaveLength(0);
    expect(report.degraded).toBe(false);
  });

  it('reports a new field at info severity, never louder', () => {
    const baseline = baselineFrom('feed.v3', repeat(sample, 5));
    const report = detectDrift(baseline, {
      ...sample,
      clips: [{ ...sample.clips[0], brand_new: 'x' }],
    });
    const added = report.findings.filter((f) => f.kind === 'added');
    expect(added.map((f) => f.path)).toContain('clips[].brand_new');
    expect(added.every((f) => f.severity === 'info')).toBe(true);
    // A Suno feature launch must not page anyone.
    expect(report.degraded).toBe(false);
  });

  it('escalates a removed field we consume to error', () => {
    const baseline = baselineFrom('feed.v3', repeat(sample, 5));
    const report = detectDrift(
      baseline,
      { ...sample, clips: [{ id: 'a', audio_url: 'https://x', extra_stat: 1 }] },
      { consumedPaths: ['clips[].id', 'clips[].status'] },
    );
    const finding = report.findings.find((f) => f.path === 'clips[].status');
    expect(finding?.kind).toBe('removed');
    expect(finding?.severity).toBe('error');
    expect(report.degraded).toBe(true);
  });

  it('keeps a removed field we never read at warn', () => {
    const baseline = baselineFrom('feed.v3', repeat(sample, 5));
    const report = detectDrift(
      baseline,
      { ...sample, clips: [{ id: 'a', status: 'complete', audio_url: 'https://x' }] },
      { consumedPaths: ['clips[].id'] },
    );
    expect(report.findings.find((f) => f.path === 'clips[].extra_stat')?.severity).toBe('warn');
  });

  it('will not call a field required on a thin baseline', () => {
    // Two samples is a coincidence, not a pattern. Reporting on that basis is
    // how a drift detector becomes something everyone mutes.
    const baseline = baselineFrom('feed.v3', repeat(sample, 2));
    const report = detectDrift(baseline, { ...sample, clips: [{ id: 'a', audio_url: 'https://x' }] });
    expect(report.findings.filter((f) => f.kind === 'removed')).toHaveLength(0);
  });

  it('does not flag a field that only some array elements carry', () => {
    // The real false alarm this fixes: display_tags is set on some clips. Every
    // sampled page contained at least one clip that had it, so per-response
    // counting made it look mandatory, and a page of newer clips without it read
    // as "Suno removed the field".
    const baseline = baselineFrom(
      'feed.v3',
      repeat({ clips: [{ id: 'a', display_tags: ['x'] }, { id: 'b' }, { id: 'c' }] }, 5),
    );
    const report = detectDrift(baseline, { clips: [{ id: 'd' }, { id: 'e' }] });
    expect(report.findings.filter((f) => f.kind === 'removed')).toHaveLength(0);
  });

  it('does not flag anything under an empty array', () => {
    // `tags: []` means no tags[] container exists, so every path beneath it is
    // absent. That says nothing about the schema.
    const baseline = baselineFrom(
      'lyrics.result',
      repeat({ text: 't', tags: ['pop', 'warm'] }, 5),
    );
    const report = detectDrift(baseline, { text: 't', tags: [] }, { consumedPaths: ['tags'] });
    expect(report.findings.filter((f) => f.kind === 'removed')).toHaveLength(0);
  });

  it('does not flag a naturally optional field', () => {
    // audio_url is absent while a clip is queued and present once it renders.
    const baseline = baselineFrom('feed.v3', [
      ...repeat({ clips: [{ id: 'a' }] }, 3),
      ...repeat({ clips: [{ id: 'a', audio_url: 'https://x' }] }, 3),
    ]);
    const report = detectDrift(baseline, { clips: [{ id: 'a' }] }, { consumedPaths: ['clips[].audio_url'] });
    expect(report.findings.filter((f) => f.kind === 'removed')).toHaveLength(0);
  });

  it('treats a value going null as warn, not error, even on a consumed path', () => {
    // Suno leaves audio_url null until rendering finishes. Paging on that would
    // mean paging on every queued clip.
    const baseline = baselineFrom('feed.v3', repeat({ clips: [{ id: 'a', audio_url: 'https://x' }] }, 5));
    const report = detectDrift(baseline, { clips: [{ id: 'c', audio_url: null }] }, {
      consumedPaths: ['clips[].audio_url'],
    });
    const finding = report.findings.find((f) => f.path === 'clips[].audio_url');
    expect(finding?.kind).toBe('retyped');
    expect(finding?.severity).toBe('warn');
  });

  it('escalates a real retype on a consumed path', () => {
    const baseline = baselineFrom('billing.info', repeat({ total_credits_left: 100 }, 5));
    const report = detectDrift(baseline, { total_credits_left: '90' }, {
      consumedPaths: ['total_credits_left'],
    });
    const finding = report.findings.find((f) => f.path === 'total_credits_left');
    expect(finding?.kind).toBe('retyped');
    expect(finding?.severity).toBe('error');
  });

  it('sorts the worst findings first', () => {
    const baseline = baselineFrom('feed.v3', repeat(sample, 5));
    const report = detectDrift(baseline, { clips: [{ id: 'a', brand_new: 1 }] }, {
      consumedPaths: ['clips[].status'],
    });
    expect(report.findings[0]?.severity).toBe('error');
  });

  it('says nothing when the baseline has no samples', () => {
    const report = detectDrift(emptyBaseline('unseen', '2026-08-17T00:00:00Z'), { a: 1 });
    expect(report.findings.every((f) => f.severity === 'info')).toBe(true);
  });

  it('honours a lower sample threshold when the caller sets one', () => {
    const baseline = baselineFrom('feed.v3', repeat({ clips: [{ id: 'a', status: 'x' }] }, 2));
    const report = detectDrift(baseline, { clips: [{ id: 'a' }] }, {
      consumedPaths: ['clips[].status'],
      minSamplesForRequired: 2,
    });
    expect(report.findings.find((f) => f.path === 'clips[].status')?.severity).toBe('error');
  });
});
