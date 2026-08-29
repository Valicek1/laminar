const test = require('node:test');
const assert = require('node:assert/strict');

const {
  prependRecentRun,
} = require('../../src/resources/js/app-state.js');

test('recent runs retain only the 30 newest completions', () => {
  const recentRuns = [];

  for(let number = 1; number <= 300; ++number)
    prependRecentRun(recentRuns, { number: number });

  assert.deepEqual(
    recentRuns.map(run => run.number),
    [
      300, 299, 298, 297, 296, 295, 294, 293, 292, 291,
      290, 289, 288, 287, 286, 285, 284, 283, 282, 281,
      280, 279, 278, 277, 276, 275, 274, 273, 272, 271,
    ]
  );
});

test('recent runs are prepended without padding a short list', () => {
  const recentRuns = [{ number: 2 }, { number: 1 }];

  prependRecentRun(recentRuns, { number: 3 });

  assert.deepEqual(recentRuns, [
    { number: 3 },
    { number: 2 },
    { number: 1 },
  ]);
});
