import assert from 'node:assert/strict';
import {join} from 'node:path';

export async function openDialog(page, source, trigger = source.locator('summary')) {
  const beforeHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  const summary = source.locator('summary');
  assert.equal(await summary.getAttribute('aria-haspopup'), 'dialog');
  const id = await summary.getAttribute('aria-controls');
  assert.ok(id, 'trigger identifies its dialog');
  await trigger.click();
  const dialog = page.locator('#' + id);
  await dialog.waitFor({state: 'visible'});
  assert.equal(await dialog.evaluate(node => node.matches(':modal')), true, 'native modal makes background inert');
  assert.equal(await source.getAttribute('open'), null, 'source never expands inline');
  assert.equal(await page.evaluate(() => document.documentElement.scrollHeight), beforeHeight, 'opening does not stretch page');
  assert.equal(await dialog.evaluate(node => node.contains(document.activeElement)), true, 'initial focus is in modal');
  // Cycle farther than the number of focusable controls to verify focus cannot escape.
  const controls = await dialog.locator('a[href], button, input, select, textarea, [tabindex="0"]').count();
  for (let i = 0; i < controls + 2; i++) {
    await page.keyboard.press('Tab');
    assert.equal(await dialog.evaluate(node => node.contains(document.activeElement)), true, 'Tab stays inside modal');
  }
  await page.keyboard.press('Shift+Tab');
  assert.equal(await dialog.evaluate(node => node.contains(document.activeElement)), true);
  const box = await dialog.boundingBox();
  const viewport = page.viewportSize();
  assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1, 'dialog fits viewport');
  assert.equal(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true, 'dialog has no horizontal overflow');
  // Capture the initial view after keyboard cycling has exercised deeper controls.
  await dialog.locator('.app-dialog-close').focus();
  await dialog.locator('.app-dialog-body').evaluate(node => { node.scrollTop = 0; });
  return dialog;
}

export async function closeDialog(page, source, trigger = source.locator('summary'), method = 'escape') {
  const dialog = page.locator('#' + await source.locator('summary').getAttribute('aria-controls'));
  if (method === 'button') await dialog.locator('.app-dialog-close').click();
  else if (method === 'backdrop') await page.mouse.click(1, 1);
  else await page.keyboard.press('Escape');
  await dialog.waitFor({state: 'hidden'});
  // The native close event is queued after removing `open`; wait for its focus restoration.
  await page.waitForFunction(node => node === document.activeElement, await trigger.elementHandle());
  assert.equal(await trigger.evaluate(node => node === document.activeElement), true, 'closing restores initiating control focus');
  assert.equal(await source.getAttribute('open'), null);
}

async function verifyTooltip(page, owner) {
  const tooltip = page.locator('#app-tooltip');
  await owner.hover();
  await tooltip.waitFor({state: 'visible'});
  assert.equal(await tooltip.innerText(), await owner.getAttribute('data-tooltip'));
  assert.ok((await owner.getAttribute('aria-describedby') || '').split(' ').includes('app-tooltip'));
  const box = await tooltip.boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= page.viewportSize().width + 1, 'tooltip stays within viewport');
  await tooltip.hover();
  await page.waitForTimeout(200);
  assert.equal(await tooltip.isVisible(), true, 'pointer can enter tooltip without dismissing it');
  await page.keyboard.press('Escape');
  await tooltip.waitFor({state: 'hidden'});
  assert.ok(!(await owner.getAttribute('aria-describedby') || '').split(' ').includes('app-tooltip'));
  await page.mouse.move(1, 1);
  await owner.focus();
  await tooltip.waitFor({state: 'visible'});
  await page.keyboard.press('Escape');
  await tooltip.waitFor({state: 'hidden'});
  assert.equal(await owner.evaluate(node => node === document.activeElement), true, 'Escape dismisses help without stealing focus');
}

export async function verifyMemberDialogs({page, detail, member, screenshotDir}) {
  for (const width of [360, 390, 768, 1440]) {
    await page.setViewportSize({width, height: 900});
    for (const lang of ['en', 'zh-CN']) {
      await page.goto(detail + '?lang=' + lang);
      await page.locator('#members [data-list-search]').fill(member);
      const source = page.locator('#member-info-' + member);
      await verifyTooltip(page, source.locator('summary'));
      const dialog = await openDialog(page, source);
      const text = await dialog.innerText();
      assert.ok(text.includes(member) && text.includes('10.88.99.101'), 'member ID and assigned IP available on mobile too');
      assert.ok(text.includes(lang === 'en' ? 'Unknown' : '未知'), 'unobserved peer version and latency remain explicitly unknown');
      assert.ok(!text.includes('-1.-1.-1') && !text.includes('undefined') && !text.includes('NaN'), 'missing peer observations are not presented as measurements');
      assert.equal(await dialog.locator('[data-member-live="authorized"]').innerText(), lang === 'en' ? 'Disabled' : '未启用');
      assert.equal(await dialog.locator('[data-member-live="activeBridge"]').innerText(), lang === 'en' ? 'Enabled' : '已启用');
      assert.equal(await dialog.locator('a[href$="/ipAssignments"]').count(), 1);
      if (screenshotDir) await page.screenshot({path: join(screenshotDir, `member-dialog-${lang}-${width}.png`), fullPage: false});
      await closeDialog(page, source, undefined, width === 360 ? 'button' : width === 390 ? 'backdrop' : 'escape');
    }
  }
  await page.goto(detail + '?lang=en');
  await page.locator('#members [data-list-search]').fill(member);
  const source = page.locator('#member-info-' + member);
  const input = page.locator('.member-name-input[name="' + member + '"]');
  const saved = page.waitForResponse(r => r.url() === detail + '/members' && r.request().method() === 'POST');
  await input.fill('Live dialog alias');
  await input.press('Tab');
  assert.equal((await saved).status(), 204);
  await page.waitForFunction(id => !document.querySelector('.member-name-input[name="' + id + '"]').disabled, member);
  let dialog = await openDialog(page, source);
  assert.equal(await dialog.locator('[data-member-live="name"]').innerText(), 'Live dialog alias', 'successful autosave updates detached dialog');
  await closeDialog(page, source);
  await page.route('**/network/' + detail.split('/').at(-1) + '/members', route => route.fulfill({status: 503, body: 'Injected failure'}));
  await page.locator('.authCheck[value="' + member + '"]').check({force: true});
  await page.locator('#members-save-status.is-error').waitFor({state: 'visible'});
  await page.unroute('**/network/' + detail.split('/').at(-1) + '/members');
  dialog = await openDialog(page, source);
  assert.equal(await dialog.locator('[data-member-live="authorized"]').innerText(), 'Disabled', 'failed authorization does not leave stale enabled dialog');
  await closeDialog(page, source);
  const authSaved = page.waitForResponse(r => r.url() === detail + '/members' && r.request().method() === 'POST');
  await page.locator('.authCheck[value="' + member + '"]').check({force: true});
  assert.equal((await authSaved).status(), 204);
  await page.waitForFunction(id => !document.querySelector('.authCheck[value="' + id + '"]').disabled, member);
  dialog = await openDialog(page, source);
  assert.equal(await dialog.locator('[data-member-live="authorized"]').innerText(), 'Enabled', 'successful authorization updates detached dialog');
  await closeDialog(page, source);
  await page.route('**/network/' + detail.split('/').at(-1) + '/members', route => route.fulfill({status: 503, body: 'Injected failure'}));
  const nameFailed = page.waitForResponse(r => r.url() === detail + '/members' && r.request().method() === 'POST');
  await input.fill('Rejected dialog alias');
  await input.press('Tab');
  assert.equal((await nameFailed).status(), 503);
  await page.waitForFunction(id => !document.querySelector('.member-name-input[name="' + id + '"]').disabled, member);
  assert.equal(await input.inputValue(), 'Live dialog alias', 'failed name save restores input');
  await page.unroute('**/network/' + detail.split('/').at(-1) + '/members');
  dialog = await openDialog(page, source);
  assert.equal(await dialog.locator('[data-member-live="name"]').innerText(), 'Live dialog alias', 'failed name save restores dialog alias');
  await closeDialog(page, source);
  // The eleventh generated fixture is on page two; direct links must work without making its row visible.
  const hiddenMember = 'bb0000000b';
  await page.goto(detail + '?lang=en#member-info-' + hiddenMember);
  const hiddenSource = page.locator('#member-info-' + hiddenMember);
  await page.locator('#member-info-' + hiddenMember + '-dialog').waitFor({state: 'visible'});
  assert.equal(await hiddenSource.locator('summary').isVisible(), false, 'deep-link target remains outside current page');
  await closeDialog(page, hiddenSource, page.locator('#members [data-list-search]'));
  console.log('PASS: bilingual member dialogs fit four viewports, retain page height, contain/restore focus and reflect live saves/rollback');
}

export async function verifyRiskGuides({page, base, screenshotDir}) {
  for (const width of [360, 1440]) {
    await page.setViewportSize({width, height: 900});
    for (const lang of ['en', 'zh-CN']) {
      await page.goto(base + '/controller/monitor?lang=' + lang);
      const version = page.locator('#version-guidance');
      const dialog = await openDialog(page, version);
      assert.equal(await dialog.locator('a[href="https://www.zerotier.com/download/"]').count(), 1);
      assert.equal(await dialog.locator('a[href="https://github.com/kaaass/ZerotierFix/releases"]').count(), 1);
      assert.ok(await dialog.locator('ol li').count() >= 4, 'guide supplies preparation, upgrade and verification steps');
      if (screenshotDir) await page.screenshot({path: join(screenshotDir, `version-guide-${lang}-${width}.png`), fullPage: false});
      await closeDialog(page, version);
      const bridge = page.locator('#bridge-guidance');
      const badge = page.locator('a.risk-badge[data-dialog-open="bridge-guidance"]:visible').first();
      await openDialog(page, bridge, badge);
      await closeDialog(page, bridge, badge);
      await page.locator('#member-paths [data-list-search]').fill('bb00000001');
      const observedMember = page.locator('#observed-member-bb00000001');
      const observedDialog = await openDialog(page, observedMember);
      assert.ok((await observedDialog.innerText()).includes('bb00000001'));
      assert.ok(await observedDialog.locator('a[href*="/member/bb00000001"]').count() > 0, 'observed member provides a network-specific management action');
      await closeDialog(page, observedMember);
    }
  }
  console.log('PASS: actionable bilingual upgrade guidance and bridge risk badge open bounded modals');
}
