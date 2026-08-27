import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  GRAPHICS_BRAND_COLORS,
  GRAPHICS_SIZES,
  addGraphicsObject,
  createGraphicsDocument,
  deleteGraphicsObject,
  duplicateGraphicsObject,
  reorderGraphicsObject,
  resizeGraphicsDocument,
  updateGraphicsObject,
} from '../packages/studio/src/components/graphicsStudioModel.js';

test('Graphics Studio starts with static social formats and the G.FURY brand palette', () => {
  assert.deepEqual(GRAPHICS_SIZES.map(({ id }) => id), ['square', 'portrait', 'story', 'landscape']);
  assert.deepEqual(GRAPHICS_BRAND_COLORS.slice(0, 4), ['#08080a', '#be123c', '#e11d48', '#f4bd50']);
  const document = createGraphicsDocument();
  assert.equal(document.sizeId, 'square');
  assert.equal(document.background, '#08080a');
  assert.ok(document.objects.some((object) => object.type === 'text'));
  assert.ok(document.objects.some((object) => object.type === 'rectangle'));
});

test('add, update, duplicate, reorder, and delete keep a clean local graphics document', () => {
  const empty = createGraphicsDocument({ title: 'Test design', objects: [] });
  const added = addGraphicsObject(empty, 'text', { id: 'headline', content: 'Track is culture' });
  assert.equal(added.selectedObjectId, 'headline');
  assert.equal(added.document.objects[0].content, 'Track is culture');

  const updated = updateGraphicsObject(added.document, 'headline', { color: '#f4bd50', x: 180 });
  assert.equal(updated.objects[0].color, '#f4bd50');
  assert.equal(updated.objects[0].x, 180);

  const withShape = addGraphicsObject(updated, 'rectangle', { id: 'shape' }).document;
  const duplicated = duplicateGraphicsObject(withShape, 'headline', { id: 'headline-copy' });
  assert.equal(duplicated.selectedObjectId, 'headline-copy');
  assert.equal(duplicated.document.objects[1].content, 'Track is culture');
  assert.equal(duplicated.document.objects[1].x, 204);

  const moved = reorderGraphicsObject(duplicated.document, 'headline-copy', 'forward');
  assert.equal(moved.objects.at(-1).id, 'headline-copy');
  const deleted = deleteGraphicsObject(moved, 'headline-copy');
  assert.equal(deleted.document.objects.some((object) => object.id === 'headline-copy'), false);
  assert.equal(deleted.selectedObjectId, null);
});

test('changing output format scales existing layer geometry without adding persistence', () => {
  const document = createGraphicsDocument({
    objects: [{
      id: 'shape', type: 'rectangle', name: 'Shape', x: 100, y: 100,
      width: 200, height: 300, color: '#be123c', cornerRadius: 0, opacity: 1,
    }],
  });
  const landscape = resizeGraphicsDocument(document, 'landscape');
  assert.equal(landscape.sizeId, 'landscape');
  assert.equal(landscape.objects[0].x, 178);
  assert.equal(landscape.objects[0].y, 100);
  assert.equal(landscape.objects[0].width, 356);
  assert.equal(landscape.objects[0].height, 300);
});

test('Graphics Studio is a secure local-only route with no browser provider credential or request path', async () => {
  const graphicsSource = await readFile(new URL('../packages/studio/src/components/GraphicsStudio.jsx', import.meta.url), 'utf8');
  const modelSource = await readFile(new URL('../packages/studio/src/components/graphicsStudioModel.js', import.meta.url), 'utf8');
  const shellSource = await readFile(new URL('../components/StandaloneShell.js', import.meta.url), 'utf8');
  const source = `${graphicsSource}\n${modelSource}`;

  assert.match(graphicsSource, /FileReader/);
  assert.match(graphicsSource, /canvas\.toBlob\(resolve, "image\/png"\)/);
  assert.match(shellSource, /'graphics'/);
  assert.match(shellSource, /<GraphicsStudio \/>/);
  assert.doesNotMatch(source, /fetch\(|axios|x-api-key|authorization/i);
  assert.doesNotMatch(source, /MUAPI_(?:API_KEY|PRODUCTION_API_KEY)|ELEVENLABS_API_KEY|HEYGEN_API_KEY|YOUTUBE_CLIENT_SECRET/);
  assert.doesNotMatch(source, /localStorage\.setItem\(["']token/);
});
