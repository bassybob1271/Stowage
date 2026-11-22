import { test, expect, type Page } from '@playwright/test';
import { join } from 'node:path';

const FIX = join(import.meta.dirname, '..', 'fixtures');
const FILES = ['photo.jpg', 'video.mp4', 'audio.mp3', 'audio2.mp3', 'doc.pdf', 'readme.md'];

async function login(page: Page) {
  await page.goto('/');
  await expect(page.getByText('Enter access code.')).toBeVisible();
  await page.getByLabel('Enter access code.').fill('nope');
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByRole('alert')).toContainText('Wrong code');
  await page.getByLabel('Enter access code.').fill('42');
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByRole('navigation', { name: 'Sidebar' })).toBeVisible();
}

/** Mount link in the sidebar (its accessible name also carries the health-dot label). */
const mountLink = (page: Page, label: string) =>
  page.getByRole('navigation', { name: 'Sidebar' }).getByRole('link', { name: new RegExp('^' + label + '\\b') });
const row = (page: Page, name: string) => page.getByRole('row').filter({ hasText: name });
const preview = (page: Page) => page.getByRole('dialog', { name: /^Preview / });

async function deleteRow(page: Page, name: string) {
  await row(page, name).click({ button: 'right' });
  await page.getByRole('menu').getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(row(page, name)).toHaveCount(0);
}

test('API rejects requests without a session', async ({ request }) => {
  expect((await request.get('/api/mounts')).status()).toBe(401);
  expect((await request.get('/api/fs/s3/list?path=')).status()).toBe(401);
  expect((await request.get('/api/health')).status()).toBe(200);
});

for (const mount of ['s3', 'ipfs'] as const) {
  const label = mount === 's3' ? 'S3' : 'IPFS';
  const other = mount === 's3' ? 'IPFS' : 'S3';

  test.describe(`${mount} mount`, () => {
    const folder = `e2e-${Date.now().toString(36)}`;

    test('upload → preview each type → seek → download → delete', async ({ page }) => {
      await login(page);
      await mountLink(page, label).click();
      await expect(page).toHaveURL(new RegExp('/browse/' + mount + '$'));

      // New folder
      await page.getByRole('button', { name: 'New folder' }).click();
      await page.getByRole('dialog').getByRole('textbox').fill(folder);
      await page.getByRole('button', { name: 'Create' }).click();
      await row(page, folder).getByRole('button', { name: folder }).click();
      await expect(page).toHaveURL(new RegExp('/browse/' + mount + '/' + folder + '$'));

      // Upload (tus)
      await page.locator('input[type=file][multiple]').setInputFiles(FILES.map((f) => join(FIX, f)));
      const tray = page.getByRole('region', { name: 'Uploads' });
      await expect(tray.getByText('Uploads complete')).toBeVisible({ timeout: 60_000 });
      for (const f of FILES) await expect(row(page, f)).toBeVisible();

      // Image
      await row(page, 'photo.jpg').getByRole('button', { name: 'photo.jpg' }).click();
      const img = preview(page).getByRole('img', { name: 'photo.jpg' });
      await expect(img).toBeVisible();
      await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(1600);
      if (mount === 'ipfs') await expect(preview(page)).toContainText(/baf[a-z0-9]{10,}/); // CID shown

      // Video: streamed with Range (206), seek lands where asked
      await page.keyboard.press('Escape');
      const partials: string[] = [];
      page.on('response', (r) => {
        if (r.url().includes('video.mp4') && r.status() === 206) partials.push(r.headers()['content-range'] ?? '');
      });
      await row(page, 'video.mp4').getByRole('button', { name: 'video.mp4' }).click();
      const video = preview(page).locator('video');
      await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 20_000 }).toBeGreaterThanOrEqual(1);
      await video.evaluate((v: HTMLVideoElement) => {
        v.muted = true;
        v.currentTime = 9;
      });
      await expect.poll(() => video.evaluate((v: HTMLVideoElement) => Math.round(v.currentTime))).toBe(9);
      await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.seeking)).toBe(false);
      expect(partials.length, 'video is streamed with Range (206)').toBeGreaterThan(0);
      expect(partials[0]).toMatch(/^bytes \d+-\d+\/1335124$/);

      // PDF
      await page.keyboard.press('Escape');
      await row(page, 'doc.pdf').getByRole('button', { name: 'doc.pdf' }).click();
      await expect(preview(page).getByText('3 pages')).toBeVisible({ timeout: 20_000 });
      await expect(preview(page).locator('#pdf-page-1 canvas')).toBeVisible();
      await preview(page).getByLabel('Search in PDF').fill('needle');
      await preview(page).getByLabel('Search in PDF').press('Enter');
      await expect(preview(page).getByText('1/1')).toBeVisible();

      // Markdown (sanitized)
      await page.keyboard.press('Escape');
      await row(page, 'readme.md').getByRole('button', { name: 'readme.md' }).click();
      await expect(preview(page).getByRole('heading', { name: 'Stowage fixture' })).toBeVisible();
      await page.waitForTimeout(300);
      expect(await page.evaluate(() => (window as unknown as { __mdxss?: number }).__mdxss)).toBeUndefined();

      // Download from the previewer
      const dl = page.waitForEvent('download');
      await preview(page).getByRole('link', { name: 'Download' }).click();
      expect((await dl).suggestedFilename()).toBe('readme.md');

      // Audio: plays via the global player, survives navigation, folder = playlist
      await page.keyboard.press('Escape');
      await row(page, 'audio.mp3').getByRole('button', { name: 'audio.mp3' }).click();
      const player = page.getByRole('region', { name: 'Audio player' });
      await expect(player).toContainText('audio.mp3');
      await page.keyboard.press('Escape');
      await mountLink(page, other).click();
      await expect(page).toHaveURL(new RegExp('/browse/' + (mount === 's3' ? 'ipfs' : 's3') + '$'));
      await expect(player).toContainText('audio.mp3');
      await player.getByRole('button', { name: 'Next' }).click();
      await expect(player).toContainText('audio2.mp3');
      await player.getByRole('button', { name: 'Close player' }).click();
      await page.goBack();
      await expect(row(page, 'photo.jpg')).toBeVisible();

      // Multi-select (click + shift-click) + Delete key
      await row(page, 'audio.mp3').first().click();
      await row(page, 'video.mp4').click({ modifiers: ['Shift'] });
      await expect(page.getByText('6 selected')).toBeVisible();
      await page.keyboard.press('Delete');
      await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
      await expect(page.getByText('This folder is empty')).toBeVisible();

      // Delete the folder itself
      await mountLink(page, label).click();
      await deleteRow(page, folder);
    });
  });
}

test('uploaded HTML/SVG cannot run script on the app origin', async ({ page }) => {
  await login(page);
  await mountLink(page, 'S3').click();
  await page.locator('input[type=file][multiple]').setInputFiles([join(FIX, 'evil.html'), join(FIX, 'evil.svg')]);
  await expect(page.getByRole('region', { name: 'Uploads' }).getByText('Uploads complete')).toBeVisible({ timeout: 30_000 });

  // SVG in the previewer renders through <img>, which never executes script.
  await row(page, 'evil.svg').getByRole('button', { name: 'evil.svg' }).click();
  await expect(preview(page).getByRole('img', { name: 'evil.svg' })).toBeVisible();
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (window as unknown as { __svgxss?: number }).__svgxss)).toBeUndefined();
  await page.keyboard.press('Escape');

  // Opening the raw files directly: CSP sandbox blocks script and gives an opaque origin.
  let apiCalls = 0;
  page.on('request', (r) => {
    if (r.url().endsWith('/api/mounts')) apiCalls++;
  });
  for (const name of ['evil.html', 'evil.svg']) {
    const res = await page.goto(`/api/fs/s3/raw?path=${name}`);
    expect(res!.headers()['content-security-policy']).toMatch(/^sandbox/);
    expect(res!.headers()['x-content-type-options']).toBe('nosniff');
    await page.waitForTimeout(500);
    expect(await page.title()).not.toBe('LEAKED');
  }
  expect(apiCalls, 'sandboxed content made no API calls').toBe(0);

  await page.goto('/browse/s3');
  await deleteRow(page, 'evil.html');
  await deleteRow(page, 'evil.svg');
});

test('resumable upload survives a page refresh', async ({ page }) => {
  await login(page);
  await mountLink(page, 'S3').click();
  // Throttle uploads so the transfer is mid-flight when we reload.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 20, downloadThroughput: -1, uploadThroughput: 1024 * 1024 });
  const big = Buffer.alloc(24 * 1024 * 1024, 7);
  await page.locator('input[type=file][multiple]').setInputFiles({ name: 'resume.bin', mimeType: 'application/octet-stream', buffer: big });
  const tray = page.getByRole('region', { name: 'Uploads' });
  await expect(tray.getByText('resume.bin')).toBeVisible();
  // Wait for at least one 8 MiB chunk to be committed server-side.
  await page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().includes('/api/tus/') && r.status() === 204, { timeout: 60_000 });

  const resumedHead = page.waitForRequest((r) => r.method() === 'HEAD' && r.url().includes('/api/tus/'), { timeout: 30_000 });
  await page.reload();
  // After reload the tray restores the upload from IndexedDB and resumes it (tus HEAD → offset).
  await resumedHead;
  await expect(page.getByRole('region', { name: 'Uploads' }).getByText('resume.bin')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Uploads' }).getByText('Uploads complete')).toBeVisible({ timeout: 90_000 });
  await expect(row(page, 'resume.bin')).toContainText('24 MB');
  await deleteRow(page, 'resume.bin');
});
