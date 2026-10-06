const STORAGE_KEY = 'md-reader-preferences';
const SCHEMA_VERSION = 1;

export const THEMES = Object.freeze(['light', 'dark', 'sepia']);
export const FONT_SIZE_MIN = 13;
export const FONT_SIZE_MAX = 22;

export const DEFAULT_PREFERENCES = Object.freeze({
  version: SCHEMA_VERSION,
  theme: 'light',
  fontSize: 16,
  fullWidth: false,
});

function clampFontSize(value) {
  const size = Number(value);
  if (!Number.isFinite(size)) return DEFAULT_PREFERENCES.fontSize;
  return Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, Math.round(size)));
}

/**
 * 解析持久化偏好。任何字段非法或版本不符时回退到默认值，而不是
 * 抛出或部分沿用——偏好读取失败不应阻断文档打开。
 */
export function parsePreferences(raw) {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_PREFERENCES };

  const theme = THEMES.includes(raw.theme) ? raw.theme : DEFAULT_PREFERENCES.theme;
  return {
    version: SCHEMA_VERSION,
    theme,
    fontSize: clampFontSize(raw.fontSize ?? DEFAULT_PREFERENCES.fontSize),
    fullWidth: typeof raw.fullWidth === 'boolean' ? raw.fullWidth : DEFAULT_PREFERENCES.fullWidth,
  };
}

export function createPreferenceStore(storage) {
  const read = () => {
    try {
      return parsePreferences(JSON.parse(storage.getItem(STORAGE_KEY)));
    } catch {
      return { ...DEFAULT_PREFERENCES };
    }
  };

  const write = preferences => {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(parsePreferences(preferences)));
      return true;
    } catch {
      return false;
    }
  };

  return {
    read,
    write,
    load: () => read(),
    save: write,
    set(partial) {
      const next = { ...read(), ...partial };
      return write(next) ? next : read();
    },
  };
}