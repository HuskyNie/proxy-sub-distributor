import test from 'node:test';
import assert from 'node:assert/strict';

import { extractSubscriptionLinks } from '../src/fib.js';

test('extracts the Clash subscription URL from the FIB user page', () => {
  const html = `
    <button type="button" class="dropdown-item copy-text"
      data-clipboard-text="https://sub.example.com/fibsrcapi/once-clash?token=a&amp;type=clash">
      复制 Clash 订阅
    </button>
    <button type="button" class="dropdown-item copy-text"
      data-clipboard-text="https://sub.example.com/fibsrcapi/once-shadowrocket">
      复制 Shadowrocket 订阅
    </button>
  `;

  const links = extractSubscriptionLinks(html);

  assert.equal(
    links.clash,
    'https://sub.example.com/fibsrcapi/once-clash?token=a&type=clash'
  );
});

test('throws a clear error when the Clash subscription button is absent', () => {
  assert.throws(
    () => extractSubscriptionLinks('<button>复制 Shadowrocket 订阅</button>'),
    /Clash subscription link/
  );
});
