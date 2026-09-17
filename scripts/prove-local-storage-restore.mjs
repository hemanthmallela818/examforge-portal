#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { readLocalSupabase } from '../e2e/support/local-supabase.mjs';

const BUCKET = 'exam-assets';
const local = readLocalSupabase();
const client = createClient(local.url, local.serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false }
});
const storage = client.storage.from(BUCKET);
const objectPath = `restore-proof/${randomUUID()}.png`;
const fixture = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl8V2sAAAAASUVORK5CYII=',
  'base64'
));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

const requireSuccess = (error, operation) => {
  if (error) throw new Error(`${operation} failed: ${error.message}`);
};

let objectPresent = false;
try {
  const { data: buckets, error: bucketError } = await client.storage.listBuckets();
  requireSuccess(bucketError, 'Bucket inspection');
  const bucket = buckets.find(item => item.name === BUCKET);
  if (!bucket || bucket.public) throw new Error('The exam-assets bucket is missing or is not private.');

  const { error: uploadError } = await storage.upload(objectPath, fixture, {
    contentType: 'image/png',
    cacheControl: '60',
    upsert: false
  });
  requireSuccess(uploadError, 'Fixture upload');
  objectPresent = true;

  const { data: exportedBlob, error: exportError } = await storage.download(objectPath);
  requireSuccess(exportError, 'Private asset export');
  const exported = new Uint8Array(await exportedBlob.arrayBuffer());
  if (digest(exported) !== digest(fixture)) throw new Error('Exported private asset hash mismatch.');

  const { data: publicLocation } = storage.getPublicUrl(objectPath);
  const publicResponse = await fetch(publicLocation.publicUrl, { redirect: 'manual' });
  if (publicResponse.ok) throw new Error('Private asset was retrievable without a signed URL.');

  const { error: removeError } = await storage.remove([objectPath]);
  requireSuccess(removeError, 'Pre-restore removal');
  objectPresent = false;

  const { error: restoreError } = await storage.upload(objectPath, exported, {
    contentType: 'image/png',
    cacheControl: '60',
    upsert: false
  });
  requireSuccess(restoreError, 'Private asset restore');
  objectPresent = true;

  const { data: restoredBlob, error: downloadError } = await storage.download(objectPath);
  requireSuccess(downloadError, 'Restored private asset download');
  const restored = new Uint8Array(await restoredBlob.arrayBuffer());
  if (digest(restored) !== digest(fixture)) throw new Error('Restored private asset hash mismatch.');

  const { data: signed, error: signedError } = await storage.createSignedUrl(objectPath, 60);
  requireSuccess(signedError, 'Signed URL creation');
  const signedResponse = await fetch(signed.signedUrl);
  if (!signedResponse.ok) throw new Error(`Signed asset retrieval failed with HTTP ${signedResponse.status}.`);
  const signedBytes = new Uint8Array(await signedResponse.arrayBuffer());
  if (digest(signedBytes) !== digest(fixture)) throw new Error('Signed asset hash mismatch.');

  console.log(JSON.stringify({
    status: 'PRIVATE_STORAGE_RESTORE_VERIFIED',
    bucket: BUCKET,
    bytes: restored.byteLength,
    sha256: digest(restored),
    anonymousReadBlocked: true,
    signedReadVerified: true
  }, null, 2));
} finally {
  if (objectPresent) {
    const { error } = await storage.remove([objectPath]);
    if (error) console.error(`Temporary restore-proof object cleanup failed: ${error.message}`);
  }
}
