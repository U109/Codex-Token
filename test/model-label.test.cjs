const test = require('node:test');
const assert = require('node:assert/strict');

test('opaque configured routes use explicit readable catalog names without provider duplication or suffixes', async () => {
  const { modelDisplayName } = await import('../src/core/model-label.mjs');
  const id = 'api-subagents/cpa/0123456789abcdef0123456789abcdef';
  const value = modelDisplayName(
    { provider: 'api_subagents', id, basis: 'configured' },
    { [id]: 'cpa · gpt-6.1-sol' },
  );
  assert.equal(value.label, 'cpa · gpt-6.1-sol');
  assert.match(value.title, /会话配置/);
  assert.doesNotMatch(value.label, /api_subagents|api-subagents|0123456789|（配置）/);
});

test('unresolved aliases and hashes stay unconfirmed instead of being guessed', async () => {
  const { modelDisplayName } = await import('../src/core/model-label.mjs');
  for (const id of [
    'api-subagents/cpa/0123456789abcdef0123456789abcdef',
    '0123456789abcdef0123456789abcdef',
    'provider/0123456789abcdef0123456789abcdef',
  ]) {
    assert.equal(modelDisplayName({ id }).label, '未确认');
  }
  assert.equal(modelDisplayName({}).label, '未确认');
});

test('ordinary model identifiers are concise and unrelated catalog entries cannot relabel them', async () => {
  const { modelDisplayName } = await import('../src/core/model-label.mjs');
  assert.equal(modelDisplayName({ provider: 'openai', id: 'gpt-6.1-sol' }).label, 'gpt-6.1-sol');
  assert.equal(modelDisplayName({ id: 'openai/gpt-6.1-sol' }).label, 'gpt-6.1-sol');
  assert.equal(
    modelDisplayName({ id: 'opaque/route/hash' }, { unrelated: 'gpt-6.1-sol' }).label,
    '未确认',
  );
});

test('catalog names reject control characters, markup, route paths and inherited properties', async () => {
  const { modelDisplayName, isReadableModelName } = await import('../src/core/model-label.mjs');
  const model = { id: 'api-subagents/cpa/opaque', basis: 'configured' };
  for (const name of [
    '',
    ' bad ',
    'bad\nname',
    'bad\u202ename',
    '<script>',
    'api-subagents/cpa/opaque',
    'x'.repeat(101),
  ]) {
    assert.equal(isReadableModelName(name), false);
    assert.equal(modelDisplayName(model, { [model.id]: name }).label, '未确认');
  }
  assert.equal(
    modelDisplayName(model, Object.create({ [model.id]: 'wrong-model' })).label,
    '未确认',
  );
});
