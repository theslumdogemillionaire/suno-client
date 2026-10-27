/**
 * Editing the account's own profile: name, bio, links and avatar, the way
 * suno.com's "Edit profile" does. Measured live on 2026-10-27, by writing back
 * the values already there.
 *
 * The PATCH is partial: only the fields sent change. The handle is not offered:
 * changing it moves the profile's address on suno.com.
 */
import { z } from 'zod';

import { pathSegment, type SunoClient } from '../client.js';
import { SunoError } from '../errors.js';

export const PROFILE_V2_PATH = '/api/profiles/v2';
export const IMAGE_UPLOAD_PATH = '/api/uploads/image';

export const EditableProfileSchema = z
  .object({
    user_id: z.string().nullish(),
    metadata: z
      .object({
        handle: z.string(),
        display_name: z.string().nullish(),
        avatar_image_url: z.string().nullish(),
        cover_photo_url: z.string().nullish(),
        is_verified: z.boolean().nullish(),
      })
      .passthrough(),
    bio: z
      .object({
        profile_description: z.string().nullish(),
        user_inputted_genres: z.array(z.string()).nullish(),
      })
      .passthrough()
      .nullish(),
    social_links: z.record(z.string().nullish()).nullish(),
    stats: z.record(z.unknown()).nullish(),
  })
  .passthrough();

export type EditableProfile = z.infer<typeof EditableProfileSchema>;

/**
 * A profile as its owner edits it: name, avatar, bio, genres, links. Readable
 * for any handle; needs a session.
 */
export async function getEditableProfile(
  client: SunoClient,
  handle: string,
  signal?: AbortSignal,
): Promise<EditableProfile> {
  return client.request({
    method: 'GET',
    path: `${PROFILE_V2_PATH}/${pathSegment(handle.trim())}`,
    schema: EditableProfileSchema,
    endpointKey: 'profile.v2',
    ...(signal ? { signal } : {}),
  });
}

export const SOCIAL_LINKS = ['spotify', 'soundcloud', 'x', 'instagram', 'youtube', 'tiktok'] as const;
export type SocialLink = (typeof SOCIAL_LINKS)[number];

export interface ProfileChanges {
  displayName?: string;
  /** The text under the name. */
  bio?: string;
  genres?: readonly string[];
  /** `null` removes a link. */
  links?: Partial<Record<SocialLink, string | null>>;
  /** An `uploadId` from `uploadImage()`. */
  avatarUploadId?: string;
}

const UpdateResponseSchema = z
  .object({
    success: z.boolean().nullish(),
    updated_fields: z.array(z.string()).default([]),
    errors: z.record(z.unknown()).nullish(),
  })
  .passthrough();

/**
 * Change the account's own profile. Only what `changes` names is sent.
 *
 * The server wants `display_name` and `handle` with any name or avatar change,
 * so those are read from the profile first when not given. Returns the fields
 * Suno reports as written; a refusal per field (`errors`) is thrown.
 */
export async function updateProfile(
  client: SunoClient,
  handle: string,
  changes: ProfileChanges,
  signal?: AbortSignal,
): Promise<string[]> {
  const name = handle.trim();
  if (name === '') throw new SunoError({ code: 'invalid_input', message: 'a profile handle cannot be empty' });
  if (changes.displayName !== undefined && changes.displayName.trim() === '') {
    throw new SunoError({ code: 'invalid_input', message: 'a display name cannot be empty' });
  }
  const body: Record<string, unknown> = {};
  if (changes.displayName !== undefined || changes.avatarUploadId !== undefined) {
    const displayName =
      changes.displayName ?? (await getEditableProfile(client, name, signal)).metadata.display_name ?? name;
    body['metadata'] = {
      display_name: displayName,
      handle: name,
      ...(changes.avatarUploadId !== undefined
        ? { avatar_upload_id: changes.avatarUploadId, avatar_is_ai_generated: false }
        : {}),
    };
  }
  if (changes.bio !== undefined || changes.genres !== undefined) {
    body['bio'] = {
      ...(changes.bio !== undefined ? { profile_description: changes.bio } : {}),
      ...(changes.genres !== undefined ? { user_inputted_genres: [...changes.genres] } : {}),
    };
  }
  if (changes.links !== undefined) {
    body['social_links'] = Object.fromEntries(
      Object.entries(changes.links).map(([key, value]) => [`${key}_link`, value ?? null]),
    );
  }
  if (Object.keys(body).length === 0) return [];

  const data = await client.request({
    method: 'PATCH',
    path: `${PROFILE_V2_PATH}/${pathSegment(name)}`,
    body,
    schema: UpdateResponseSchema,
    endpointKey: 'profile.update',
    ...(signal ? { signal } : {}),
  });
  if (data.success === false || (data.errors && Object.keys(data.errors).length > 0)) {
    throw new SunoError({
      code: 'invalid_input',
      message: `Suno refused the profile change: ${JSON.stringify(data.errors ?? {})}`,
    });
  }
  return data.updated_fields;
}

const SlotSchema = z
  .object({ id: z.string(), url: z.string(), fields: z.record(z.string()) })
  .passthrough();

const FinishSchema = z
  .object({ upload_id: z.string(), moderation_status: z.string().nullish() })
  .passthrough();

export const IMAGE_TYPES = { jpeg: 'image/jpeg', jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' } as const;
export type ImageExtension = keyof typeof IMAGE_TYPES;

export interface UploadedImage {
  uploadId: string;
  /** `approved` on the image measured. Anything else will not show. */
  moderation: string | undefined;
}

/**
 * Upload an image to Suno: ask for a slot, send the bytes straight to its
 * storage with the signed form it hands out, then confirm. The confirmation is
 * where moderation answers.
 */
export async function uploadImage(
  client: SunoClient,
  bytes: Uint8Array,
  extension: ImageExtension,
  signal?: AbortSignal,
): Promise<UploadedImage> {
  const type = IMAGE_TYPES[extension];
  if (type === undefined) {
    throw new SunoError({ code: 'invalid_input', message: `extension must be one of ${Object.keys(IMAGE_TYPES).join(', ')}` });
  }
  if (bytes.byteLength === 0) throw new SunoError({ code: 'invalid_input', message: 'an image cannot be empty' });

  const slot = await client.request({
    method: 'POST',
    path: IMAGE_UPLOAD_PATH,
    body: { extension: extension === 'jpg' ? 'jpeg' : extension },
    schema: SlotSchema,
    endpointKey: 'upload.image',
    ...(signal ? { signal } : {}),
  });

  const form = new FormData();
  for (const [key, value] of Object.entries(slot.fields)) form.append(key, value);
  form.append('file', new Blob([bytes], { type }), `image.${extension}`);
  const sent = await fetch(slot.url, { method: 'POST', body: form, ...(signal ? { signal } : {}) });
  if (!sent.ok) {
    throw new SunoError({ code: 'api_error', message: `image upload refused by storage: HTTP ${sent.status}`, status: sent.status });
  }

  const done = await client.request({
    method: 'POST',
    path: `${IMAGE_UPLOAD_PATH}/${pathSegment(slot.id)}/upload-finish`,
    body: {},
    schema: FinishSchema,
    endpointKey: 'upload.imageFinish',
    ...(signal ? { signal } : {}),
  });
  return { uploadId: done.upload_id, moderation: done.moderation_status ?? undefined };
}

/** Upload an image and make it the account's avatar. */
export async function setAvatar(
  client: SunoClient,
  handle: string,
  bytes: Uint8Array,
  extension: ImageExtension,
  signal?: AbortSignal,
): Promise<UploadedImage> {
  const image = await uploadImage(client, bytes, extension, signal);
  if (image.moderation !== undefined && image.moderation !== 'approved') {
    throw new SunoError({ code: 'invalid_input', message: `Suno did not approve the image: ${image.moderation}` });
  }
  await updateProfile(client, handle, { avatarUploadId: image.uploadId }, signal);
  return image;
}
