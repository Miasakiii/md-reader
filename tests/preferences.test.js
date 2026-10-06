import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_PREFERENCES,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  parsePreferences,
  createPreferenceStore,
} from '../src/js/preferences.js';

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: key => data.delete(key),
    dump: () => Object.fromEntries(data),
  };
}

test('preferences fall back to defaults for missing or malformed input', () => {
  assert.deepEqual(parsePreferences(null), DEFAULT_PREFERENCES);
  assert.deepEqual(parsePreferences(undefined), DEFAULT_PREFERENCES);
  assert.deepEqual(parsePreferences('not an object'), DEFAULT_PREFERENCES);
  assert.deepEqual(parsePreferences({}), DEFAULT_PREFERENCES);
});

test('only known themes are accepted', () => {
  assert.equal(parsePreferences({ theme: 'dark' }).theme, 'dark');
  assert.equal(parsePreferences({ theme: 'sepia' }).theme, 'sepia');
  assert.equal(parsePreferences({ theme: 'neon' }).theme, 'light');
  assert.equal(parsePreferences({ theme: 1 }).theme, 'light');
});

test('font size is clamped into the supported range', () => {
  assert.equal(parsePreferences({ fontSize: 18 }).fontSize, 18);
  assert.equal(parsePreferences({ fontSize: 5 }).fontSize, FONT_SIZE_MIN);
  assert.equal(parsePreferences({ fontSize: 99 }).fontSize, FONT_SIZE_MAX);
  assert.equal(parsePreferences({ fontSize: 'abc' }).fontSize, DEFAULT_PREFERENCES.fontSize);
  assert.equal(parsePreferences({ fontSize: 16.6 }).fontSize, 17);
});

test('fullWidth keeps a boolean type and rejects other values', () => {
  assert.equal(parsePreferences({ fullWidth: true }).fullWidth, true);
  assert.equal(parsePreferences({ fullWidth: false }).fullWidth, false);
  assert.equal(parsePreferences({ fullWidth: 'yes' }).fullWidth, false);
});

test('the store survives corrupt JSON without losing all preferences', () => {
  const storage = memoryStorage({ 'md-reader-preferences': '{not json' });
  const store = createPreferenceStore(storage);

  assert.deepEqual(store.load(), DEFAULT_PREFERENCES);

  const next = store.set({ theme: 'dark' });
  assert.equal(next.theme, 'dark');
  assert.equal(next.fontSize, DEFAULT_PREFERENCES.fontSize);
});

test('the store round-trips through a single namespaced key', () => {
  const storage = memoryStorage();
  const store = createPreferenceStore(storage);

  store.set({ theme: 'sepia', fontSize: 20, fullWidth: true });

  const keys = Object.keys(storage.dump());
  assert.deepEqual(keys, ['md-reader-preferences']);

  assert.deepEqual(createPreferenceStore(storage).load(), {
    version: 1,
    theme: 'sepia',
    fontSize: 20,
    fullWidth: true,
  });
});

test('a storage write failure does not throw and keeps the in-memory value usable', () => {
  const storage = {
    getItem: () => null,
    setItem: () => {
      throw new Error('quota exceeded');
    },
  };
  const store = createPreferenceStore(storage);

  assert.doesNotThrow(() => store.set({ theme: 'dark' }));
  assert.doesNotThrow(() => store.load());
});

test('a partially valid payload does not import unrelated defaults blindly', () => {
  const parsed = parsePreferences({ theme: 'dark', fontSize: 300, fullWidth: true });

  assert.equal(parsed.theme, 'dark');
  assert.equal(parsed.fontSize, FONT_SIZE_MAX);
  assert.equal(parsed.fullWidth, true);
});