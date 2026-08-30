import { isSupportedDocumentPath } from './file-types.js';

export function fileNameFromPath(path) {
  return String(path)
    .split(/[\\/]/)
    .filter(Boolean)
    .at(-1) ?? String(path);
}

function pathKey(path, platform) {
  const value = String(path);
  return platform === 'windows' ? value.replaceAll('/', '\\').toLowerCase() : value;
}

export function samePath(left, right, platform = 'posix') {
  return pathKey(left, platform) === pathKey(right, platform);
}

export function welcomePaths(paths) {
  return paths.slice(0, 8);
}

export function validateLibraryPaths(paths) {
  if (!Array.isArray(paths)) throw new Error('文件库数据无效');
  for (const path of paths) {
    if (!isSupportedDocumentPath(path)) {
      throw new Error(`文件库包含不支持的文档类型: ${path}`);
    }
  }
  return [...paths];
}

export function clampMenuPosition({
  x,
  y,
  width,
  height,
  viewportWidth,
  viewportHeight,
  margin = 8,
}) {
  return {
    left: Math.max(margin, Math.min(x, viewportWidth - width - margin)),
    top: Math.max(margin, Math.min(y, viewportHeight - height - margin)),
  };
}

export function nextMenuIndex(key, currentIndex, count) {
  if (key === 'Escape') return null;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  if (key === 'ArrowDown') return (currentIndex + 1) % count;
  if (key === 'ArrowUp') return (currentIndex - 1 + count) % count;
  return currentIndex;
}

export function menuKeyDecision(key, currentIndex, count) {
  if (key === 'Tab') {
    return { handled: false, close: true, restoreFocus: false, nextIndex: null };
  }
  if (key === 'Escape') {
    return { handled: true, close: true, restoreFocus: true, nextIndex: null };
  }
  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(key)) {
    return {
      handled: true,
      close: false,
      restoreFocus: false,
      nextIndex: nextMenuIndex(key, currentIndex, count),
    };
  }
  return { handled: false, close: false, restoreFocus: false, nextIndex: currentIndex };
}

export function nextSidePanel(current, requested) {
  if (!['library', 'toc'].includes(requested)) throw new Error('未知侧栏');
  return current === requested ? 'none' : requested;
}

export function createFileLibraryView({
  listElement,
  scrollElement,
  emptyElement,
  menuElement,
  platform,
  onOpen,
  onRemove,
  onError,
  documentRef = globalThis.document,
  windowRef = globalThis.window,
}) {
  const menuItems = [...menuElement.querySelectorAll('[role="menuitem"]')];
  let triggerButton = null;
  let activePath = '';

  function toError(error) {
    return error instanceof Error ? error : new Error(String(error));
  }

  function closeMenu({ restoreFocus = true } = {}) {
    menuElement.classList.add('hidden');
    menuElement.style.visibility = '';
    if (restoreFocus) triggerButton?.focus();
    triggerButton = null;
    activePath = '';
  }

  function openMenu(button, path, x, y) {
    triggerButton = button;
    activePath = path;
    menuElement.classList.remove('hidden');
    menuElement.style.visibility = 'hidden';
    const rect = menuElement.getBoundingClientRect();
    const position = clampMenuPosition({
      x,
      y,
      width: rect.width,
      height: rect.height,
      viewportWidth: windowRef.innerWidth,
      viewportHeight: windowRef.innerHeight,
    });
    menuElement.style.left = `${position.left}px`;
    menuElement.style.top = `${position.top}px`;
    menuElement.style.visibility = '';
    menuItems[0]?.focus();
  }

  function onDocumentPointerDown(event) {
    if (!menuElement.classList.contains('hidden') && !menuElement.contains(event.target)) {
      closeMenu({ restoreFocus: false });
    }
  }

  const onPanelScroll = () => closeMenu({ restoreFocus: false });
  const onWindowBlur = () => closeMenu({ restoreFocus: false });

  function onDocumentKeyDown(event) {
    if (menuElement.classList.contains('hidden')) return;
    const current = Math.max(0, menuItems.indexOf(documentRef.activeElement));
    const decision = menuKeyDecision(event.key, current, menuItems.length);
    if (decision.handled) event.preventDefault();
    if (decision.close) closeMenu({ restoreFocus: decision.restoreFocus });
    else if (decision.handled) menuItems[decision.nextIndex]?.focus();
  }

  async function onMenuClick(event) {
    const item = event.target?.closest?.('[data-action]');
    if (!item || !activePath) return;
    const path = activePath;
    const action = item.dataset.action;
    closeMenu();
    try {
      if (action === 'remove') await onRemove(path);
    } catch (error) {
      onError(toError(error));
    }
  }

  function render(paths, currentPath) {
    const validatedPaths = validateLibraryPaths(paths);
    closeMenu({ restoreFocus: false });
    listElement.replaceChildren();
    emptyElement.classList.toggle('hidden', validatedPaths.length > 0);
    for (const path of validatedPaths) {
      const row = documentRef.createElement('div');
      row.setAttribute('role', 'listitem');
      const button = documentRef.createElement('button');
      button.type = 'button';
      button.className = 'library-item';
      button.setAttribute('aria-haspopup', 'menu');
      if (samePath(path, currentPath, platform)) button.setAttribute('aria-current', 'page');

      const name = documentRef.createElement('span');
      name.className = 'library-item-name';
      name.textContent = fileNameFromPath(path);
      const fullPath = documentRef.createElement('span');
      fullPath.className = 'library-item-path';
      fullPath.textContent = path;
      button.append(name, fullPath);
      button.addEventListener('click', () => {
        Promise.resolve(onOpen(path)).catch(error => onError(toError(error)));
      });
      button.addEventListener('contextmenu', event => {
        event.preventDefault();
        openMenu(button, path, event.clientX, event.clientY);
      });
      button.addEventListener('keydown', event => {
        if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
        event.preventDefault();
        const rect = button.getBoundingClientRect();
        openMenu(button, path, rect.left, rect.bottom);
      });
      row.append(button);
      listElement.append(row);
    }
  }

  documentRef.addEventListener('pointerdown', onDocumentPointerDown);
  documentRef.addEventListener('keydown', onDocumentKeyDown);
  menuElement.addEventListener('click', onMenuClick);
  scrollElement.addEventListener('scroll', onPanelScroll);
  windowRef.addEventListener('blur', onWindowBlur);

  return {
    render,
    closeMenu,
    destroy() {
      documentRef.removeEventListener('pointerdown', onDocumentPointerDown);
      documentRef.removeEventListener('keydown', onDocumentKeyDown);
      menuElement.removeEventListener('click', onMenuClick);
      scrollElement.removeEventListener('scroll', onPanelScroll);
      windowRef.removeEventListener('blur', onWindowBlur);
      closeMenu({ restoreFocus: false });
    },
  };
}
