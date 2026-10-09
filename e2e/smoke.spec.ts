import { expect, test, type Page } from '@playwright/test';

// Unreachable info-hash with no trackers: stays in "Fetching metadata", so no network is needed.
const MAGNET =
  'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=DraxMax+E2E+Fixture';

const torrentRow = (page: Page) =>
  page
    .getByRole('list', { name: 'Torrents' })
    .getByRole('listitem')
    .filter({ hasText: 'DraxMax E2E Fixture' });

test.describe.configure({ mode: 'serial' });

test('first-run wizard walks through four steps and is not shown again', async ({ page }) => {
  await page.goto('/');
  const wizard = page.getByRole('dialog', { name: 'Welcome to DraxMax' });
  await expect(wizard).toBeVisible();
  await wizard.getByRole('radio', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Where should downloads go?' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Finding peers' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Upcoming releases (optional)' })).toBeVisible();
  await page.getByRole('button', { name: 'Start using DraxMax' }).click();
  await expect(page.getByRole('heading', { name: 'Upcoming releases (optional)' })).toBeHidden();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'No torrents yet' })).toBeVisible();
  await expect(page.getByText('Welcome to DraxMax')).toBeHidden();
});

test('add, pause, resume and remove a magnet; navigate every page', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/downloads$/);
  await expect(page.getByText('Connected')).toBeVisible();

  await page.getByRole('button', { name: 'Add your first torrent' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add torrents' });
  await dialog.getByRole('textbox').first().fill('not a magnet');
  await expect(dialog.getByText('One line is not a magnet link.')).toBeVisible();
  await dialog.getByRole('textbox').first().fill(MAGNET);
  await dialog.getByRole('button', { name: 'Options' }).click();
  await dialog.getByRole('combobox', { name: 'Category' }).fill('E2E');
  await dialog.getByRole('button', { name: 'Add torrent' }).click();
  await expect(dialog).toBeHidden();

  const row = torrentRow(page);
  await expect(row).toBeVisible();
  await expect(row.getByText('Fetching metadata')).toBeVisible();
  await expect(row.getByText('E2E', { exact: true })).toBeVisible();

  // Duplicate is rejected with a toast.
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await dialog.getByRole('textbox').first().fill(MAGNET);
  await dialog.getByRole('button', { name: 'Add torrent' }).click();
  await expect(page.getByText(/already in the list/)).toBeVisible();
  await page.keyboard.press('Escape');

  await row.getByRole('button', { name: /^Pause / }).click();
  await expect(row.getByText('Paused')).toBeVisible();
  await row.getByRole('button', { name: /^Resume / }).click();
  await expect(row.getByText('Fetching metadata')).toBeVisible();

  // Details drawer with tracker management.
  await row.dblclick();
  const sheet = page.getByRole('dialog', { name: /DraxMax E2E Fixture/ });
  await sheet.getByRole('tab', { name: /Trackers/ }).click();
  await sheet.getByRole('button', { name: 'Add trackers' }).click();
  await sheet
    .getByRole('textbox', { name: 'Tracker URLs' })
    .fill('udp://tracker.example.org:1337/announce');
  await sheet.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(sheet.getByText('udp://tracker.example.org:1337/announce')).toBeVisible();
  await page.keyboard.press('Escape');

  await page.reload();
  await expect(row).toBeVisible();

  for (const name of ['Upcoming', 'RSS', 'Stats', 'Settings', 'Downloads']) {
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name }).click();
    await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  }

  await row.getByRole('button', { name: /^More actions/ }).click();
  await page.getByRole('menuitem', { name: 'Remove…' }).click();
  await page
    .getByRole('dialog', { name: 'Remove torrent?' })
    .getByRole('button', { name: 'Remove' })
    .click();
  await expect(row).toBeHidden();
  await expect(page.getByRole('heading', { name: 'No torrents yet' })).toBeVisible();
});

test('adds a torrent into a folder chosen with the server folder browser', async ({
  page,
  request,
}) => {
  await page.goto('/downloads');
  await page.getByRole('button', { name: 'Add your first torrent' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add torrents' });
  await dialog.getByRole('textbox').first().fill(MAGNET);
  const saveTo = dialog.getByRole('combobox', { name: 'Save to' });
  await saveTo.fill('relative/path');
  await expect(dialog.getByText(/Use a full path/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Add torrent' })).toBeDisabled();
  await saveTo.fill('');

  await dialog.getByRole('button', { name: 'Browse for folder' }).click();
  const browser = page.getByRole('dialog', { name: 'Choose folder' });
  await expect(browser.getByText('No subfolders.')).toBeVisible();
  await browser.getByRole('button', { name: 'New folder' }).click();
  await browser.getByRole('textbox', { name: 'New folder name' }).fill('NAS share');
  await browser.getByRole('button', { name: 'Create' }).click();
  await expect(browser.getByRole('textbox', { name: 'Folder path' })).toHaveValue(/\/NAS share$/);
  await browser.getByRole('button', { name: 'Parent folder' }).click();
  await expect(
    browser.getByRole('list', { name: 'Subfolders' }).getByText('NAS share'),
  ).toBeVisible();
  await browser.getByRole('button', { name: 'NAS share' }).click();
  await browser.getByRole('button', { name: 'Use this folder' }).click();
  await expect(browser).toBeHidden();
  await expect(saveTo).toHaveValue(/\/NAS share$/);

  await dialog.getByRole('button', { name: 'Add torrent' }).click();
  await expect(dialog).toBeHidden();
  await expect(torrentRow(page)).toBeVisible();
  // The row shows where the torrent is saved.
  await expect(torrentRow(page).getByText(/NAS share$/)).toBeVisible();
  const torrents = (await (await request.get('/api/torrents')).json()) as {
    id: string;
    savePath: string;
  }[];
  expect(torrents[0]!.savePath).toMatch(/\/NAS share$/);
  await request.delete(`/api/torrents/${torrents[0]!.id}`);
});

test('RSS rule editor validates and saves rules', async ({ page }) => {
  await page.goto('/rss');
  await page.getByRole('tab', { name: 'Download rules' }).click();
  await page.getByRole('button', { name: 'Create a rule' }).click();
  await page.getByRole('textbox', { name: 'Rule name' }).fill('E2E rule');
  await page.getByRole('switch', { name: 'Use regular expressions' }).click();
  await page.getByRole('textbox', { name: /Must contain/ }).fill('(unclosed');
  await expect(page.getByText(/Invalid regular expression/).first()).toBeVisible();
  await page.getByRole('textbox', { name: /Must contain/ }).fill('^Show\\.Name');
  await page.getByRole('button', { name: 'Create rule' }).click();
  await expect(
    page.getByRole('list', { name: 'Download rules' }).getByText('E2E rule'),
  ).toBeVisible();

  // Rules can be switched off straight from the list.
  const enable = page.getByRole('switch', { name: 'Enable E2E rule' });
  await expect(enable).toHaveAttribute('aria-checked', 'true');
  await enable.click();
  await expect(enable).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByRole('switch', { name: 'Rule enabled' })).toHaveAttribute(
    'aria-checked',
    'false',
  );

  // Select several rules and delete them together.
  await page.getByRole('button', { name: 'New rule' }).click();
  await page.getByRole('textbox', { name: 'Rule name' }).fill('Second E2E rule');
  await page.getByRole('button', { name: 'Create rule' }).click();
  const list = page.getByRole('list', { name: 'Download rules' });
  await expect(list.getByText('Second E2E rule')).toBeVisible();
  const search = page.getByRole('searchbox', { name: 'Search rules' });
  await search.fill('second');
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await expect(page.getByText('Rules (1 of 2)')).toBeVisible();
  await search.fill('no such rule');
  await expect(page.getByText('No rules match.')).toBeVisible();
  await search.fill('');
  await page.getByRole('checkbox', { name: 'Select all rules' }).check();
  await expect(page.getByText('2 selected')).toBeVisible();
  await page.getByRole('button', { name: 'Delete 2 selected rules' }).click();
  await page
    .getByRole('dialog', { name: 'Delete 2 rules?' })
    .getByRole('button', { name: 'Delete 2 rules' })
    .click();
  await expect(list.getByRole('listitem')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Create a rule' })).toBeVisible();
});

test('settings persist (speed limit in KiB/s)', async ({ page, request }) => {
  await page.goto('/settings');
  const limit = page.getByRole('spinbutton', { name: 'Download limit in KiB/s' });
  await limit.fill('500');
  await limit.press('Enter');
  await expect
    .poll(async () => (await (await request.get('/api/settings')).json()).settings.downloadLimit)
    .toBe(512000);
  await page.reload();
  await expect(page.getByRole('spinbutton', { name: 'Download limit in KiB/s' })).toHaveValue(
    '500',
  );
  const seed = page.getByRole('spinbutton', { name: 'Seeding time limit (minutes)' });
  await seed.fill('90');
  await seed.press('Enter');
  await expect
    .poll(
      async () => (await (await request.get('/api/settings')).json()).settings.seedTimeLimitMinutes,
    )
    .toBe(90);
  await seed.fill('0');
  await seed.press('Enter');
});

test('stats page shows live numbers; health and security headers', async ({ page, request }) => {
  await page.goto('/stats');
  await expect(page.getByText('Download speed')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Network health' })).toBeVisible();

  const health = await request.get('/api/health');
  expect(await health.json()).toMatchObject({ status: 'ok' });
  const res = await page.goto('/settings');
  expect(res?.headers()['content-security-policy']).toContain("script-src 'self'");
});
