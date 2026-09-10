import { describe, expect, it } from 'vitest';

import {
  baseWireBody,
  buildCustomBody,
  buildMetadata,
  buildDescribeBody,
  DEFAULT_MODEL,
  validateSubmission,
} from '../../src/api/generate.js';
import { buildCoverBody, buildExtendBody, buildRemasterBody } from '../../src/api/derive.js';

/**
 * These tests pin OUR side of the contract, not Suno's.
 *
 * Be clear about what that buys: nothing here would have caught the August 2026
 * drift, because Suno changed and we did not. Only the live canary sees that.
 * What these DO catch is us breaking ourselves - a refactor that drops a
 * required field, or "tidies" title back to null. That failure mode is at least
 * as common, and unlike the drift it is free to detect.
 */

const REQUIRED_KEYS = [
  'token',
  'generation_type',
  'title',
  'tags',
  'negative_tags',
  'mv',
  'prompt',
  'make_instrumental',
  'user_uploaded_images_b64',
  'metadata',
  'override_fields',
  'cover_clip_id',
  'cover_start_s',
  'cover_end_s',
  'persona_id',
  'artist_clip_id',
  'artist_start_s',
  'artist_end_s',
  'continue_clip_id',
  'continued_aligned_prompt',
  'continue_at',
  'transaction_uuid',
];

const REQUIRED_METADATA_KEYS = [
  'web_client_pathname',
  'is_max_mode',
  'is_mumble',
  'create_mode',
  'user_tier',
  'create_session_token',
  'disable_volume_normalization',
];

describe('generate wire body', () => {
  it('carries every field v2-web requires', () => {
    const body = baseWireBody(DEFAULT_MODEL, 'custom');
    for (const key of REQUIRED_KEYS) {
      expect(Object.keys(body), `missing ${key}`).toContain(key);
    }
    for (const key of REQUIRED_METADATA_KEYS) {
      expect(Object.keys(body.metadata), `missing metadata.${key}`).toContain(key);
    }
  });

  it('never sends title as null', () => {
    // The regression that took the reference client down for two weeks:
    // title: null began returning 422 body.params.title around 2026-08-01.
    expect(baseWireBody(DEFAULT_MODEL, 'custom').title).toBe('');
    expect(typeof buildDescribeBody({ prompt: 'x' }).title).toBe('string');
    expect(typeof buildCoverBody('clip-1').title).toBe('string');
    expect(typeof buildRemasterBody('clip-1').title).toBe('string');
    expect(typeof buildExtendBody('clip-1', { at: 10 }).title).toBe('string');
  });

  it('never sends token_provider', () => {
    // v2-web types it as an integer and 422s on a string. Sending it "for
    // completeness" breaks every generation.
    for (const body of [
      baseWireBody(DEFAULT_MODEL, 'custom'),
      buildCustomBody({ title: 't', tags: 'a', lyrics: 'l' }),
      buildDescribeBody({ prompt: 'p' }),
      buildCoverBody('c'),
    ]) {
      expect(body).not.toHaveProperty('token_provider');
    }
  });

  it('sends negative_tags as an empty string, never null', () => {
    expect(baseWireBody(DEFAULT_MODEL, 'custom').negative_tags).toBe('');
    expect(buildCustomBody({ title: 't', tags: 'a', lyrics: 'l' }).negative_tags).toBe('');
  });

  it('leaves token null when no captcha is required', () => {
    expect(buildCustomBody({ title: 't', tags: 'a', lyrics: 'l' }).token).toBeNull();
    expect(
      buildCustomBody({ title: 't', tags: 'a', lyrics: 'l', captchaToken: 'solved' }).token,
    ).toBe('solved');
  });

  it('puts lyrics in prompt for custom mode', () => {
    const body = buildCustomBody({ title: 'T', tags: 'pop', lyrics: '[Verse]\nhello' });
    expect(body.prompt).toBe('[Verse]\nhello');
    expect(body.tags).toBe('pop');
    expect(body.metadata.create_mode).toBe('custom');
  });

  it('puts the description in prompt for inspiration mode, not gpt_description_prompt', () => {
    // v2-web dropped gpt_description_prompt; clients still sending it are
    // talking to the retired /api/generate/v2/ route.
    const body = buildDescribeBody({ prompt: 'a rainy lo-fi track' });
    expect(body.prompt).toBe('a rainy lo-fi track');
    expect(body).not.toHaveProperty('gpt_description_prompt');
    expect(body.metadata.create_mode).toBe('inspiration');
  });

  it('gives every request a fresh transaction uuid and session token', () => {
    const a = baseWireBody(DEFAULT_MODEL, 'custom');
    const b = baseWireBody(DEFAULT_MODEL, 'custom');
    expect(a.transaction_uuid).not.toBe(b.transaction_uuid);
    expect(a.metadata.create_session_token).not.toBe(b.metadata.create_session_token);
  });

  it('omits control_sliders unless asked', () => {
    expect(baseWireBody(DEFAULT_MODEL, 'custom').metadata.control_sliders).toBeUndefined();
    const withSliders = buildCustomBody({
      title: 't',
      tags: 'a',
      lyrics: 'l',
      sliders: { audioWeight: 0.65 },
    });
    expect(withSliders.metadata.control_sliders).toEqual({ audio_weight: 0.65 });
  });

  it('lets extraFields override anything, so a new required field needs no release', () => {
    const body = buildCustomBody({
      title: 't',
      tags: 'a',
      lyrics: 'l',
      extraFields: { token_provider: null, brand_new_required_field: 42 },
    });
    expect(body['brand_new_required_field']).toBe(42);
    expect(body).toHaveProperty('token_provider');
  });

  it('routes cover, remaster and extend through their own ids', () => {
    expect(buildCoverBody('src-1').cover_clip_id).toBe('src-1');
    expect(buildRemasterBody('src-2').cover_clip_id).toBe('src-2');
    const ext = buildExtendBody('src-3', { at: 42.5 });
    expect(ext.continue_clip_id).toBe('src-3');
    expect(ext.continue_at).toBe(42.5);
  });
});

describe('submission validation', () => {
  it('treats HTTP 200 with status error as a failure', () => {
    // Suno quotes credits and creates nothing. Reading 200 as success reports
    // a generation that does not exist.
    expect(() => validateSubmission({ status: 'error', clips: [] })).toThrow(/rejected/i);
  });

  it('treats an empty clip list as a failure', () => {
    expect(() => validateSubmission({ clips: [] })).toThrow(/no clips/i);
  });

  it('accepts a real submission', () => {
    const clips = validateSubmission({
      clips: [
        {
          id: 'a',
          title: 'T',
          status: 'submitted',
          model_name: 'chirp-fenix',
          created_at: '2026-08-17T00:00:00Z',
        },
      ],
    });
    expect(clips).toHaveLength(1);
    expect(clips[0]?.id).toBe('a');
  });
});

describe('the v6 creativity slider', () => {
  it('travels as aug_creativity when set', () => {
    const wire = buildMetadata('custom', { augCreativity: 0.75 });
    expect(wire.control_sliders?.aug_creativity).toBe(0.75);
  });

  it('is absent when unset, because it is optional despite appearances', () => {
    // A traffic capture shows it on every web-app create and on every v6 clip,
    // which reads exactly like a new required field. Probed against the live
    // endpoint on 2026-09-10: a slider object with it and one without validate
    // identically, so sending it unasked would be cargo cult.
    const wire = buildMetadata('custom', { styleWeight: 0.5 });
    expect(wire.control_sliders).toEqual({ style_weight: 0.5 });
    expect(wire.control_sliders).not.toHaveProperty('aug_creativity');
  });

  it('leaves control_sliders off entirely when no dial is set', () => {
    expect(buildMetadata('custom', {}).control_sliders).toBeUndefined();
    expect(buildMetadata('custom').control_sliders).toBeUndefined();
  });
});
