import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeFrame, frameReader } from '../../src/util.mjs';

test('length-prefixed framing survives arbitrary chunk boundaries', async () => {
  const values = [{operation:'sezu.health',args:{}},{operation:'sezu.exec',target:'u',args:{argv:['printf','x']}}];
  const wire = Buffer.concat(values.map(encodeFrame));
  const got = [];
  const read = frameReader(v => got.push(v), e => { throw e; });
  for (let i=0;i<wire.length;i+=3) read(wire.subarray(i,i+3));
  assert.deepEqual(got, values);
});
