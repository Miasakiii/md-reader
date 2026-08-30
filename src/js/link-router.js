const SCHEME_PATTERN = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;

export function classifyLinkHref(href) {
  const url = typeof href === 'string' ? href : '';

  if (url.trim() === '' || url.startsWith('#')) {
    return { kind: 'internal', url };
  }

  const schemeMatch = url.match(SCHEME_PATTERN);
  if (!schemeMatch) {
    return { kind: 'local-path', url };
  }

  const scheme = schemeMatch[1].toLowerCase();
  if (scheme === 'http' || scheme === 'https') {
    return { kind: 'external', url };
  }
  if (scheme === 'mailto') {
    return { kind: 'mailto', url };
  }
  return { kind: 'blocked', url };
}

export function handleRenderedLinkClick(event, { classify, openExternal }) {
  const anchor = event?.target?.closest?.('a');
  if (!anchor) {
    return 'default';
  }

  const rawHref = typeof anchor.getAttribute === 'function'
    ? anchor.getAttribute('href')
    : anchor.href;
  const { kind, url } = classify(rawHref);

  if (kind === 'external' || kind === 'mailto') {
    event.preventDefault();
    openExternal(url);
    return 'open';
  }

  if (kind === 'blocked' || kind === 'local-path') {
    event.preventDefault();
    return 'intercepted';
  }

  return 'default';
}

export function createOpenExternal({
  isTauriAvailable,
  invoke,
  browserOpen,
  onError = () => {},
}) {
  return async function openExternal(url) {
    try {
      if (isTauriAvailable()) {
        await invoke('plugin:opener|open_url', { url });
        return;
      }
      browserOpen(url);
    } catch (error) {
      try {
        onError(error);
      } catch {
        // Reporting must not poison future link opens.
      }
    }
  };
}
