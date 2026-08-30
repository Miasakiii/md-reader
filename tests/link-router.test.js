import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyLinkHref,
  createOpenExternal,
  handleRenderedLinkClick,
} from '../src/js/link-router.js';

function clickEventOn(href) {
  const anchor = { href };
  return {
    anchor,
    event: {
      target: { closest: selector => (selector === 'a' ? anchor : null) },
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
    },
  };
}

test('link classification separates internal, external, mailto, local, and blocked targets', () => {
  assert.deepEqual(classifyLinkHref(''), { kind: 'internal', url: '' });
  assert.deepEqual(classifyLinkHref('   '), { kind: 'internal', url: '   ' });
  assert.deepEqual(classifyLinkHref('#section'), { kind: 'internal', url: '#section' });
  assert.deepEqual(classifyLinkHref('#'), { kind: 'internal', url: '#' });

  assert.deepEqual(classifyLinkHref('https://example.com/a?b=1'), {
    kind: 'external',
    url: 'https://example.com/a?b=1',
  });
  assert.deepEqual(classifyLinkHref('HTTP://EXAMPLE.COM'), {
    kind: 'external',
    url: 'HTTP://EXAMPLE.COM',
  });
  assert.deepEqual(classifyLinkHref('mailto:someone@example.com'), {
    kind: 'mailto',
    url: 'mailto:someone@example.com',
  });
  assert.deepEqual(classifyLinkHref('MAILTO:someone@example.com'), {
    kind: 'mailto',
    url: 'MAILTO:someone@example.com',
  });

  assert.deepEqual(classifyLinkHref('other.md'), { kind: 'local-path', url: 'other.md' });
  assert.deepEqual(classifyLinkHref('./notes/todo.txt'), {
    kind: 'local-path',
    url: './notes/todo.txt',
  });
  assert.deepEqual(classifyLinkHref('/docs/guide.md'), {
    kind: 'local-path',
    url: '/docs/guide.md',
  });

  assert.deepEqual(classifyLinkHref('javascript:alert(1)'), {
    kind: 'blocked',
    url: 'javascript:alert(1)',
  });
  assert.deepEqual(classifyLinkHref('file:///C:/Windows'), {
    kind: 'blocked',
    url: 'file:///C:/Windows',
  });
  assert.deepEqual(classifyLinkHref('ftp://example.com/pub'), {
    kind: 'blocked',
    url: 'ftp://example.com/pub',
  });
  assert.deepEqual(classifyLinkHref('vscode://file/project'), {
    kind: 'blocked',
    url: 'vscode://file/project',
  });
  assert.deepEqual(classifyLinkHref('tel:+8613800000000'), {
    kind: 'blocked',
    url: 'tel:+8613800000000',
  });
});

test('clicks outside rendered anchors are left untouched', () => {
  const event = {
    target: { closest: () => null },
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
  };

  assert.equal(handleRenderedLinkClick(event, {
    classify: classifyLinkHref,
    openExternal: () => {
      throw new Error('must not open');
    },
  }), 'default');
  assert.equal(event.defaultPrevented, false);
});

test('external and mailto clicks are prevented and dispatched to the opener', () => {
  for (const href of ['https://example.com', 'mailto:someone@example.com']) {
    const { event } = clickEventOn(href);
    const opened = [];

    assert.equal(handleRenderedLinkClick(event, {
      classify: classifyLinkHref,
      openExternal: url => opened.push(url),
    }), 'open');
    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(opened, [href]);
  }
});

test('blocked protocols and local paths are intercepted without opening anything', () => {
  for (const href of ['javascript:alert(1)', 'file:///C:/x', 'notes/todo.md']) {
    const { event } = clickEventOn(href);

    assert.equal(handleRenderedLinkClick(event, {
      classify: classifyLinkHref,
      openExternal: () => {
        throw new Error('must not open');
      },
    }), 'intercepted');
    assert.equal(event.defaultPrevented, true);
  }
});

test('in-document anchors keep their default behavior', () => {
  const { event } = clickEventOn('#introduction');

  assert.equal(handleRenderedLinkClick(event, {
    classify: classifyLinkHref,
    openExternal: () => {
      throw new Error('must not open');
    },
  }), 'default');
  assert.equal(event.defaultPrevented, false);
});

test('native opener delegates to the injected invoke command', async () => {
  const openExternal = createOpenExternal({
    isTauriAvailable: () => true,
    invoke: async (command, args) => {
      assert.equal(command, 'plugin:opener|open_url');
      assert.deepEqual(args, { url: 'https://example.com' });
      return null;
    },
    browserOpen: () => {
      throw new Error('browser fallback must not run natively');
    },
  });

  await openExternal('https://example.com');
});

test('browser preview falls back to a safe popup and reports failures', async () => {
  const opened = [];
  const openExternal = createOpenExternal({
    isTauriAvailable: () => false,
    invoke: () => {
      throw new Error('invoke must not run in the browser');
    },
    browserOpen: url => {
      opened.push(url);
      return {};
    },
  });

  await openExternal('https://example.com');
  assert.deepEqual(opened, ['https://example.com']);

  const failures = [];
  const failing = createOpenExternal({
    isTauriAvailable: () => true,
    invoke: async () => {
      throw new Error('scope denied');
    },
    browserOpen: () => {
      throw new Error('browser fallback must not run natively');
    },
    onError: error => failures.push(error),
  });

  await failing('https://example.com');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].message, 'scope denied');
});
