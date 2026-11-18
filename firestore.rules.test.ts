import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const rulesText = fs.readFileSync(new URL('./firestore.rules', import.meta.url), 'utf8');
const blueprint = JSON.parse(fs.readFileSync(new URL('./firebase-blueprint.json', import.meta.url), 'utf8')) as {
  entities: Record<string, { required: string[]; properties: Record<string, { maxLength?: number; pattern?: string }> }>;
  firestore: Record<string, unknown>;
};

test('Firestore rules enforce Eight Pillars and match firebase-blueprint.json', () => {
  // 1. Default deny catch-all present
  assert.match(rulesText, /match \/\{document=\*\*\} \{\s*allow read, write: if false;/);

  // 2. Every collection in blueprint has a match rule
  for (const colPath of Object.keys(blueprint.firestore)) {
    const segment = colPath.split('/').filter((s) => s && !s.startsWith('{')).pop()!;
    assert.ok(rulesText.includes(`match /${segment}/`), `Missing match block for blueprint collection ${colPath}`);
  }

  // 3. No get() or exists() inside any allow list block
  const allowListMatches = rulesText.match(/allow list:[^;]+;/g) ?? [];
  assert.ok(allowListMatches.length >= 6);
  for (const ruleLine of allowListMatches) {
    assert.equal(/\b(get|exists|getAfter|existsAfter)\s*\(/.test(ruleLine), false, `Forbidden DB lookup in list rule: ${ruleLine}`);
    assert.equal(ruleLine.includes('isAdmin()'), false, `isAdmin() contains exists() and must not appear in allow list: ${ruleLine}`);
  }

  // 4. Verified email + request.time checks enforced
  assert.match(rulesText, /request\.auth\.token\.email_verified == true/);
  assert.match(rulesText, /request\.time/);
  assert.match(rulesText, /existsAfter\(/);
  assert.match(rulesText, /existing\(\)\.recalled == false/);
});
