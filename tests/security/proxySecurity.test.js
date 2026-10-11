import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildMuapiUrl,
} from '../../src/lib/muapiProxy.js';

test('proxy URL construction encodes path segments and rejects traversal', () => {
  assert.equal(
    buildMuapiUrl('api/v1', ['jobs', 'hello world'], '?limit=1'),
    'https://api.muapi.ai/api/v1/jobs/hello%20world?limit=1',
  );
  assert.throws(() => buildMuapiUrl('api/v1', ['..']), /Invalid proxy path/);
});
