const test = require('node:test');
const assert = require('node:assert/strict');
const api = import('../src/ui/fast-mode-toggle.mjs');

function fixture(snapshot) {
  const calls = [];
  const React = {
    Fragment: 'fragment',
    createElement: (type, props, ...children) => ({ type, props, children }),
    useCallback: (fn) => fn,
    useSyncExternalStore: (_, get) => get(),
    useEffect() {},
  };
  const controller = {
    getSnapshot: () => snapshot,
    setEnabled(identity, enabled) {
      calls.push({ identity, enabled });
    },
  };
  const find = (node, type) =>
    node?.type === type ? node : node?.children?.map((child) => find(child, type)).find(Boolean);
  return { React, controller, calls, find };
}

test('Fast exposes checkbox state and Enter or Space performs the same selection as click', async () => {
  const { createFastModeToggle } = await api;
  const { React, controller, calls, find } = fixture({
    available: true,
    enabled: false,
    pending: false,
  });
  const identity = { threadId: 'A', model: 'synthetic-model' };
  const node = createFastModeToggle(React)({ controller, identity });
  const button = find(node, 'button');
  assert.equal(button.props.type, 'button');
  assert.equal(button.props.role, 'menuitemcheckbox');
  assert.equal(button.props['aria-checked'], false);
  assert.equal(button.props['aria-label'], '开启 Fast');
  for (const key of ['Enter', ' ']) {
    let prevented = false;
    button.props.onKeyDown({
      key,
      preventDefault() {
        prevented = true;
      },
      stopPropagation() {},
    });
    assert.equal(prevented, true);
  }
  button.props.onClick({ preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(
    calls,
    Array.from({ length: 3 }, () => ({ identity, enabled: true })),
  );
});

test('saving and managed settings disable the control; errors have an accessible alert', async () => {
  const { createFastModeToggle } = await api;
  for (const locked of [false, true]) {
    const { React, controller, calls, find } = fixture({
      available: true,
      enabled: true,
      pending: !locked,
      locked,
      error: true,
    });
    const node = createFastModeToggle(React)({ controller, identity: {} });
    const button = find(node, 'button');
    assert.equal(button.props.disabled, true);
    assert.equal(button.props['aria-label'], '关闭 Fast');
    button.props.onClick({ preventDefault() {}, stopPropagation() {} });
    assert.equal(calls.length, 0);
    assert.equal(find(node, 'span').props.role, 'alert');
  }
});

test('unavailable Fast and disabled indicators do not leave visible content', async () => {
  const { createFastModeToggle } = await api;
  for (const available of [false, true]) {
    const { React, controller } = fixture({ available, enabled: false });
    assert.equal(createFastModeToggle(React)({ controller, identity: {}, indicator: true }), null);
  }
});
