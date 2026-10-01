import { expect, test, type Page } from '@playwright/test';

async function login(page: Page, email: string) {
  await page.goto('/login');
  await page.fill('#email', email);
  await page.fill('#password', 'Passw0rd!demo');
  await page.click('button[type=submit]');
}

test('student tests and reports; IT resolves; dashboard reflects it', async ({ browser }) => {
  // Student: quick speed test at Library Floor 2, then report with the test attached
  const s = await (await browser.newContext()).newPage();
  await login(s, 'student01@campus.local');
  await s.click('#loc-picker');
  await s.fill('input[aria-label="Search locations"]', 'Library Floor 2');
  await s.keyboard.press('Enter');
  await s.click('button[role=radio]:has-text("Campus network")'); // measure against this server (offline-safe)
  await s.click('text=Run speed test');
  await expect(s.getByText('How was this score calculated?')).toBeVisible({ timeout: 45_000 });
  await s.click('text=Report a problem');
  await s.fill('#c-desc', 'Wi-Fi disconnects every few minutes near the study rooms');
  await expect(s.getByText('Suggested: Frequent Disconnection')).toBeVisible();
  await s.click('text=Submit complaint');
  await expect(s.getByText('Attached speed test')).toBeVisible();
  const url = s.url();

  // IT: open dashboard, then move the complaint through every state
  const it = await (await browser.newContext()).newPage();
  await login(it, 'it1@campus.local');
  await expect(it.getByText('Tests today')).toBeVisible();
  const openBefore = Number(await it.locator('text=Open complaints >> xpath=following-sibling::div').innerText());
  await it.goto(url.replace(/^https?:\/\/[^/]+/, ''));
  await it.click('text=Mark as reviewed');
  await it.selectOption('#assignee', { label: 'Kamran Javed (me)' });
  await it.click('button:has-text("Assign")');
  await it.click('text=Start investigation');
  await it.fill('#tnote', 'Moved the AP to channel 11.');
  await it.click('text=Mark as resolved');
  await expect(it.getByText(/^Resolved .*reporter has been notified/)).toBeVisible();
  await it.goto('/it');
  const openAfter = Number(await it.locator('text=Open complaints >> xpath=following-sibling::div').innerText());
  expect(openAfter).toBe(openBefore - 1);

  // Student sees the resolution notification
  await s.goto('/notifications');
  await expect(s.getByText('Your complaint at Library Floor 2 was resolved')).toBeVisible();

  // Manager sees analytics
  const m = await (await browser.newContext()).newPage();
  await login(m, 'manager@campus.local');
  await m.goto('/analytics');
  await expect(m.getByText('Speed by location')).toBeVisible();
  await expect(m.getByText('Complaints by building')).toBeVisible();
});
