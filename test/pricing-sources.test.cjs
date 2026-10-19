const test = require('node:test');
const assert = require('node:assert/strict');
const evidence = require('../test/fixtures/pricing-sources.json');
const pricing = import('../src/core/pricing.mjs');
const request = (changes) => ({
  provider: 'openai',
  priceVersion: evidence.priceVersion,
  startedAt: '2026-10-15T04:30:00Z',
  serviceTier: 'standard',
  endpoint: 'global',
  billingMode: 'api',
  modality: 'text',
  usage: { input: 1000, cachedRead: 0, cachedWrite: 0, output: 1 },
  ...changes,
});
const dollars = (text) => [...text.matchAll(/\$([\d.]+)/g)].map((match) => Number(match[1]));
test('OpenAI rate matrix exactly matches the retrieved official table snapshot', async () => {
  const { estimateRequestCost: estimate } = await pricing;
  const tables = evidence.sources.find((source) => source.provider === 'openai').tables;
  for (const [index, tier] of ['standard', 'batch', 'flex', 'fast', 'ultrafast'].entries()) {
    for (const row of tables[index].rows.slice(2)) {
      for (const long of [false, true]) {
        const actual = estimate(
          request({
            model: row[0],
            serviceTier: tier,
            usage: { input: long ? 272001 : 272000, cachedRead: 1, cachedWrite: 0, output: 1 },
          }),
        );
        assert.equal(actual.status, 'estimated');
        const prices = row.slice(long ? 5 : 1, long ? 9 : 5).map((value) => dollars(value)[0]);
        assert.deepEqual(Object.values(actual.rates), prices, `${row[0]}/${tier}/${long}`);
      }
    }
  }
});
test('DeepSeek peak/off-peak matrix matches the official snapshot for both models', async () => {
  const { estimateRequestCost: estimate } = await pricing;
  const rows = evidence.sources
    .find((source) => source.provider === 'deepseek')
    .tables[0].rows.slice(2);
  for (const [column, model] of ['deepseek-flash', 'deepseek-v4-pro'].entries()) {
    for (const [index, billingPeriod] of ['off-peak', 'peak'].entries()) {
      const result = estimate(request({ provider: 'deepseek', model, billingPeriod }));
      const prices = rows
        .filter((_, row) => row % 2 === index)
        .map((row) => dollars(row.at(column - 2))[0]);
      assert.deepEqual([result.rates.cachedRead, result.rates.input, result.rates.output], prices);
    }
  }
});
test('Gemini paid text-token rates and published schedules match the official snapshot', async () => {
  const { estimateRequestCost: estimate } = await pricing;
  for (const table of evidence.sources.find((source) => source.provider === 'gemini').tables) {
    for (const later of [false, true]) {
      const pro = table.model === 'gemini-2.5-pro';
      const result = estimate(
        request({
          provider: 'google',
          model: table.model,
          serviceTier: table.heading.toLowerCase(),
          startedAt: later ? '2027-01-02T00:00:00Z' : '2026-10-15T04:30:00Z',
          usage: { input: pro && later ? 200001 : 1000, cachedRead: 0, cachedWrite: 0, output: 1 },
        }),
      );
      assert.equal(result.status, 'estimated');
      const prices = table.rows.slice(1, 4).map((row) => dollars(row.at(-1))[later ? 1 : 0]);
      assert.deepEqual(
        [result.rates.input, result.rates.output, result.rates.cachedRead],
        prices,
        `${table.model}/${table.heading}/${later}`,
      );
    }
  }
});
