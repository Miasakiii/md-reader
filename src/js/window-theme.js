const NATIVE_WINDOW_THEMES = Object.freeze({
  light: 'light',
  dark: 'dark',
  sepia: 'light',
});

export function getNativeWindowTheme(theme) {
  return NATIVE_WINDOW_THEMES[theme] || 'light';
}

export function createNativeWindowThemeSynchronizer({
  isAvailable,
  getCurrentWindow,
  onError = () => {},
}) {
  let pending = null;
  let queuedTheme = null;

  async function applyQueuedThemes() {
    let applied = false;

    while (queuedTheme !== null) {
      const nativeTheme = queuedTheme;
      queuedTheme = null;
      if (!isAvailable()) return applied;

      try {
        const currentWindow = await getCurrentWindow();
        await currentWindow.setTheme(nativeTheme);
        applied = true;
      } catch (error) {
        try {
          onError(error);
        } catch {
          // Reporting must not poison future native theme updates.
        }
      }
    }

    return applied;
  }

  return function syncNativeWindowTheme(theme) {
    if (!isAvailable()) return Promise.resolve(false);
    queuedTheme = getNativeWindowTheme(theme);

    if (!pending) {
      pending = applyQueuedThemes().finally(() => {
        pending = null;
      });
    }

    return pending;
  };
}
