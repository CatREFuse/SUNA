// Official API reference prices verified 2026-10-31. These do not represent
// ChatGPT subscription charges. See docs/design/model-pricing-evidence-20261031.md.
export const OFFICIAL_PRICES_VERIFIED_AT = '2026-10-31';
export const OPENAI_PRICE_ROWS = Object.freeze([
  ['gpt-6.1-sol', 2, .1, 2.5, 5, 10],
  ['gpt-6.1-terra', 1, .05, 1.25, 2.5, 5],
  ['gpt-6-astra', 10, 1, 12.5, 25, 50],
  ['gpt-6-sol', 2, .2, 2.5, 5, 10],
  ['gpt-6-luna', .1, .01, .125, .25, .5],
  ['gpt-5.6-sol', 4, .4, 5, 10, 20],
  ['gpt-5.6-terra', 2, .2, 2.5, 5, 12],
  ['gpt-5.6-luna', .2, .02, .25, .5, 1.2],
].map(row => Object.freeze(row)));
