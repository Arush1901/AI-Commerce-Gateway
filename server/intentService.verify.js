'use strict';

const { parseIntent } = require('./intentService');

const VARIANTS = [
  'gaming setup under ₹10000, headset matters most',
  'I need a gaming rig for under 10000 rupees. Headset is my top priority.',
  'budget is ₹10k for gaming gear — headset locked, keyboard and mouse secondary',
  'Want to build a gaming setup. Max spend ₹10000. Must have a good headset.',
  'gaming peripherals ₹10000 budget. headset = locked, rest = low',
];

async function run() {
  console.log('\n🧪 parseIntent — verification (5 variants)\n');
  let allPassed = true;

  for (let i = 0; i < VARIANTS.length; i++) {
    const input = VARIANTS[i];
    process.stdout.write(`[${i + 1}/5] "${input.slice(0, 55)}…"\n       → `);
    try {
      const intent = await parseIntent(input);

      // Basic shape assertions
      const errors = [];
      if (typeof intent.goal !== 'string' || !intent.goal) errors.push('missing goal');
      if (typeof intent.budget !== 'number') errors.push('budget not a number');
      if (typeof intent.preferences !== 'object') errors.push('preferences not an object');

      if (errors.length) {
        console.log(`❌ FAIL: ${errors.join(', ')}`);
        allPassed = false;
      } else {
        console.log(`✅ OK`);
        console.log(`       goal: "${intent.goal}"`);
        console.log(`       budget: ₹${intent.budget}`);
        console.log(`       preferences: ${JSON.stringify(intent.preferences)}\n`);
      }
    } catch (err) {
      console.log(`❌ ERROR: ${err.message}\n`);
      allPassed = false;
    }
  }

  console.log('─'.repeat(50));
  if (allPassed) {
    console.log('All 5 variants returned valid Intent objects ✅');
  } else {
    console.error('One or more variants failed ❌');
    process.exit(1);
  }
}

run();
