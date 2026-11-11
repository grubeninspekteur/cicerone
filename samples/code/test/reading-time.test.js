import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readingTime } from '../src/reading-time.js';

test('is at least one minute', () => {
    assert.equal(readingTime('Short.'), 1);
});

test('rounds to whole minutes', () => {
    assert.equal(readingTime('word '.repeat(460)), 2);
});
