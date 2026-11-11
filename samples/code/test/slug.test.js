import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify, uniqueSlug } from '../src/slug.js';

test('lower-cases and joins words with hyphens', () => {
    assert.equal(slugify('Hello, World!'), 'hello-world');
});

test('keeps accented letters readable', () => {
    assert.equal(slugify('Crème brûlée für alle'), 'creme-brulee-fur-alle');
});

test('does not end in a hyphen after truncation', () => {
    const slug = slugify('Everything we learned from my year of reading the terms and conditions');
    assert.ok(slug.length <= 60);
    assert.ok(!slug.endsWith('-'), `"${slug}" ends in a hyphen`);
});

test('numbers duplicates', () => {
    assert.equal(uniqueSlug('Hello', new Set(['hello', 'hello-2'])), 'hello-3');
});
