import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createNativeWindowThemeSynchronizer,
  getNativeWindowTheme,
} from '../src/js/window-theme.js';

test('app themes map to the native light/dark title-bar contract', () => {
  assert.equal(getNativeWindowTheme('light'), 'light');
  assert.equal(getNativeWindowTheme('dark'), 'dark');
  assert.equal(getNativeWindowTheme('sepia'), 'light');
  assert.equal(getNativeWindowTheme('unknown'), 'light');
});

test('browser mode skips native window access', async () => {
  let windowAccesses = 0;
  const syncTheme = createNativeWindowThemeSynchronizer({
    isAvailable: () => false,
    getCurrentWindow: async () => {
      windowAccesses += 1;
      throw new Error('browser mode must not access a native window');
    },
  });

  assert.equal(await syncTheme('dark'), false);
  assert.equal(windowAccesses, 0);
});

test('native theme updates stay serialized and coalesce to the latest request', async () => {
  const appliedThemes = [];
  let activeUpdates = 0;
  let maxActiveUpdates = 0;
  let releaseFirstUpdate;
  let markFirstUpdateStarted;
  const firstUpdateStarted = new Promise(resolve => {
    markFirstUpdateStarted = resolve;
  });
  const firstUpdateBlocked = new Promise(resolve => {
    releaseFirstUpdate = resolve;
  });
  const syncTheme = createNativeWindowThemeSynchronizer({
    isAvailable: () => true,
    getCurrentWindow: async () => ({
      async setTheme(theme) {
        activeUpdates += 1;
        maxActiveUpdates = Math.max(maxActiveUpdates, activeUpdates);
        appliedThemes.push(theme);
        if (appliedThemes.length === 1) {
          markFirstUpdateStarted();
          await firstUpdateBlocked;
        }
        activeUpdates -= 1;
      },
    }),
  });

  const darkUpdate = syncTheme('dark');
  await firstUpdateStarted;
  const sepiaUpdate = syncTheme('sepia');
  const lightUpdate = syncTheme('light');
  releaseFirstUpdate();
  await Promise.all([darkUpdate, sepiaUpdate, lightUpdate]);

  assert.equal(maxActiveUpdates, 1);
  assert.deepEqual(appliedThemes, ['dark', 'light']);
});

test('a failed native update is reported without blocking the next theme', async () => {
  const errors = [];
  const appliedThemes = [];
  let shouldFail = true;
  const syncTheme = createNativeWindowThemeSynchronizer({
    isAvailable: () => true,
    getCurrentWindow: async () => ({
      async setTheme(theme) {
        if (shouldFail) {
          shouldFail = false;
          throw new Error('injected native theme failure');
        }
        appliedThemes.push(theme);
      },
    }),
    onError: error => errors.push(error.message),
  });

  assert.equal(await syncTheme('dark'), false);
  assert.equal(await syncTheme('sepia'), true);
  assert.deepEqual(errors, ['injected native theme failure']);
  assert.deepEqual(appliedThemes, ['light']);
});

test('an error reporter cannot poison later native theme updates', async () => {
  const appliedThemes = [];
  let shouldFail = true;
  const syncTheme = createNativeWindowThemeSynchronizer({
    isAvailable: () => true,
    getCurrentWindow: async () => ({
      async setTheme(theme) {
        if (shouldFail) {
          shouldFail = false;
          throw new Error('injected native theme failure');
        }
        appliedThemes.push(theme);
      },
    }),
    onError: () => {
      throw new Error('injected reporter failure');
    },
  });

  assert.equal(await syncTheme('dark'), false);
  assert.equal(await syncTheme('light'), true);
  assert.deepEqual(appliedThemes, ['light']);
});
