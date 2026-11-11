import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explainBrevoError } from '../src/lib/messaging.js';

test('Brevo errors are explained in plain words', () => {
  assert.match(explainBrevoError(401, '{"message":"Key not found","code":"unauthorized"}', 'xkeysib-abc'), /did not recognise BREVO_API_KEY/);
  assert.match(explainBrevoError(401, '{"message":"Key not found"}', 'xsmtpsib-abc'), /SMTP key/);
  assert.match(explainBrevoError(400, '{"message":"Sender is not valid"}', 'xkeysib-a', 'Leadway Estate <a@b.com>'), /refused the sender a@b\.com/);
  assert.match(explainBrevoError(500, 'oops'), /^Brevo HTTP 500 oops$/);
});
