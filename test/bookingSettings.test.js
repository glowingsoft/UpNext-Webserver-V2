require("module-alias/register");

const test = require("node:test");
const assert = require("node:assert/strict");
const AdminSettings = require("@models/AdminSettings");

test("booking attempt limit defaults to 15 minutes", () => {
  const settings = new AdminSettings();
  assert.equal(settings.instant.maxAttemptMinutes, 15);
  assert.equal(settings.validateSync(), undefined);
});

test("attempt limit validation rejects zero minutes", () => {
  const settings = new AdminSettings({ instant: { maxAttemptMinutes: 0 } });
  assert.ok(settings.validateSync().errors["instant.maxAttemptMinutes"]);
});
