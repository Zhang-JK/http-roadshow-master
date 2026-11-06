import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';

test.describe.configure({ mode: 'serial' });

let page: Page;
let deckUrl = '';

const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function makePptx(slides: number): Promise<Buffer> {
  const require = createRequire(new URL('../../server/package.json', import.meta.url));
  const PptxGenJS = require('pptxgenjs');
  const p = new PptxGenJS();
  for (let i = 1; i <= slides; i++) p.addSlide().addText(`参考第 ${i} 页`, { x: 1, y: 1, w: 8, h: 1, fontSize: 32 });
  return (await p.write({ outputType: 'nodebuffer' })) as Buffer;
}

async function login(username: string, password: string) {
  await page.goto('/login');
  await page.fill('input[name=username]', username);
  await page.fill('input[name=password]', password);
  await page.click('button:has-text("登录")');
  await expect(page.locator('[data-testid=user-menu]')).toBeVisible();
}

async function logout() {
  await page.click('[data-testid=user-menu]');
  await page.click('text=退出登录');
  await expect(page.locator('.login-card')).toBeVisible();
}

const stage = () => page.frameLocator('.stage iframe');
const historyItems = () => page.locator('[data-testid=history-item]');

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
});

test('login rejects bad credentials and accepts admin', async () => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);
  await page.fill('input[name=username]', 'admin');
  await page.fill('input[name=password]', 'wrong');
  await page.click('button:has-text("登录")');
  await expect(page.locator('.form-error')).toContainText('用户名或密码错误');
  await login('admin', 'admin123');
  await expect(page.locator('.topnav')).toContainText('模型接入');
});

test('admin manages model endpoints and runs connectivity tests', async () => {
  await page.click('nav >> text=模型接入');
  const row = page.locator('[data-testid=endpoint-row]').first();
  await expect(row).toContainText('Mock LLM');
  await row.locator('[data-testid=test-endpoint]').click();
  await expect(row.locator('[data-testid=test-status]')).toContainText('多模态识别正确', { timeout: 20_000 });

  const mockUrl = await page.evaluate(() => fetch('/api/llm/endpoints').then((r) => r.json()).then((d) => d.endpoints[0].baseUrl));
  await page.click('[data-testid=add-endpoint]');
  await page.fill('input[name=ep-name]', 'Backup');
  await page.fill('input[name=ep-base]', mockUrl);
  await page.fill('input[name=ep-model]', 'textonly-model');
  await page.fill('input[name=ep-key]', 'good-key');
  await page.click('[data-testid=test-form]');
  await expect(page.locator('[data-testid=form-test-result]')).toContainText('多模态：不支持', { timeout: 20_000 });
  await page.fill('input[name=ep-model]', 'mock-vision-2');
  await page.click('[data-testid=test-form]');
  await expect(page.locator('[data-testid=form-test-result]')).toContainText('测试通过', { timeout: 20_000 });
  await page.click('[data-testid=save-endpoint]');
  await expect(page.locator('[data-testid=endpoint-row]')).toHaveCount(2);
  await expect(page.locator('.panel-card').first()).toContainText('admin');
});

test('system update page shows version and explains dev-mode instances cannot self-update', async () => {
  await page.click('nav >> text=系统更新');
  await expect(page.locator('[data-testid=current-version]')).toContainText(/\d+\.\d+\.\d+/);
  await expect(page.locator('.notice')).toContainText('deploy.sh install');
  await expect(page.locator('[data-testid=check-update]')).toHaveCount(0);
});

test('admin creates another user', async () => {
  await page.click('nav >> text=用户管理');
  await page.click('[data-testid=add-user]');
  await page.fill('input[name=new-username]', 'carol');
  await page.fill('input[name=new-display]', '卡罗尔');
  await page.fill('input[name=new-password]', 'carol123');
  await page.click('[data-testid=save-user]');
  await expect(page.locator('[data-testid=user-row]')).toHaveCount(2);
  await expect(page.locator('[data-testid=user-row]').nth(1)).toContainText('卡罗尔');
});

test('create a template through the dialog and watch it generate', async () => {
  await page.click('nav >> text=模板');
  await page.click('[data-testid=create-btn]');
  await page.fill('input[name=name]', 'E2E 模板');
  await page.click('.chip:has-text("科技深色")');
  await expect(page.locator('textarea[name=style]')).toHaveValue('科技深色');
  await page.click('.chip:has-text("融资路演")');
  await page.locator('[data-testid=file-input]').setInputFiles({
    name: 'logo.png',
    mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
  });
  await expect(page.locator('.file-list li')).toHaveCount(1);
  await page.click('[data-testid=submit-create]');
  await expect(page).toHaveURL(/\/p\//);
  await expect(page.locator('.gen-state')).toContainText('AI 正在生成');
  await expect(page.locator('[data-testid=page-thumb]')).toHaveCount(3, { timeout: 30_000 });
  await expect(page.locator('[data-testid=page-indicator]')).toHaveText('第 1 / 3 页');
  await expect(historyItems()).toHaveCount(1);
  await expect(historyItems().first()).toContainText('生成');
});

test('page navigation by buttons, keyboard and thumbnails', async () => {
  await page.click('button:has-text("下一页")');
  await expect(page.locator('[data-testid=page-indicator]')).toHaveText('第 2 / 3 页');
  await expect(stage().locator('h1')).toHaveText('第2页标题');
  await page.locator('body').press('ArrowRight');
  await expect(page.locator('[data-testid=page-indicator]')).toHaveText('第 3 / 3 页');
  await page.locator('[data-testid=page-thumb]').nth(1).click();
  await expect(page.locator('[data-testid=page-indicator]')).toHaveText('第 2 / 3 页');
});

test('click-select an element and edit it; the prompt carries page + element', async () => {
  await stage().locator('h1').click();
  await expect(page.locator('[data-testid=scope-chip]')).toHaveText('第 2 页 · 1 个元素');
  await expect(page.locator('.sel-chip')).toContainText('标题');
  await page.fill('[data-testid=prompt-input]', '把标题改为 MARK');
  await page.click('[data-testid=send-btn]');
  await expect(page.locator('.job-item')).toContainText('第 2 页 · 1 个元素');
  await expect(historyItems()).toHaveCount(2, { timeout: 30_000 });
  await expect(stage().locator('h1')).toContainText('已修改：MARK');
  const top = historyItems().first();
  await expect(top).toContainText('管理员');
  await expect(top).toContainText('第 2 页 · 1 个选中元素');
  await expect(top).toContainText('修改 1 个元素');
  await top.locator('button:has-text("详情")').click();
  await expect(top.locator('.el-group')).toContainText('<h1>');
});

test('shift-click multi-select, select parent, and marquee selection', async () => {
  await stage().locator('body').press('Escape');
  await expect(page.locator('[data-testid=scope-seg]')).toBeVisible();
  await stage().locator('li').first().click();
  await stage().locator('li').nth(1).click({ modifiers: ['Shift'] });
  await expect(page.locator('[data-testid=scope-chip]')).toHaveText('第 2 页 · 2 个元素');
  await page.click('button:has-text("选择上级")');
  await expect(page.locator('[data-testid=scope-chip]')).toHaveText('第 2 页 · 1 个元素');
  await expect(page.locator('.sel-chip')).toContainText('列表');
  await page.click('button:has-text("取消选择")');
  await expect(page.locator('[data-testid=scope-seg]')).toBeVisible();

  // Drag a marquee around the paragraph and the list (in screen coordinates of the scaled iframe).
  const frameBox = (await page.locator('.stage iframe').boundingBox())!;
  const scale = frameBox.width / 1920;
  const rects = await stage().locator('section.slide').evaluate((s) => {
    const r = (sel: string) => s.querySelector(sel)!.getBoundingClientRect();
    const p = r('p'), u = r('ul');
    const w = s.getBoundingClientRect().width;
    return { x1: Math.max(2, Math.min(p.left, u.left) - 10), y1: p.top - 10, x2: Math.min(w - 2, Math.max(p.right, u.right) + 10), y2: u.bottom + 10 };
  });
  await page.mouse.move(frameBox.x + rects.x1 * scale, frameBox.y + rects.y1 * scale);
  await page.mouse.down();
  await page.mouse.move(frameBox.x + ((rects.x1 + rects.x2) / 2) * scale, frameBox.y + ((rects.y1 + rects.y2) / 2) * scale, { steps: 5 });
  await page.mouse.move(frameBox.x + rects.x2 * scale, frameBox.y + rects.y2 * scale, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator('[data-testid=scope-chip]')).toHaveText('第 2 页 · 2 个元素');
  await expect(page.locator('.sel-chip').nth(0)).toContainText('段落');
  await expect(page.locator('.sel-chip').nth(1)).toContainText('列表');
  await page.click('button:has-text("取消选择")');
});

test('page-scope and whole-document edits', async () => {
  await page.click('[data-testid=scope-seg] button:has-text("仅第 2 页")');
  await page.fill('[data-testid=prompt-input]', '这一页加一段话');
  await page.keyboard.press('Control+Enter');
  await expect(historyItems()).toHaveCount(3, { timeout: 30_000 });
  await expect(historyItems().first()).toContainText('单页');
  await expect(stage().locator('section')).toContainText('整页新增段落');

  await page.click('[data-testid=scope-seg] button:has-text("整份材料")');
  await page.fill('[data-testid=prompt-input]', '整体换一个主色');
  await page.click('[data-testid=send-btn]');
  await expect(historyItems()).toHaveCount(4, { timeout: 30_000 });
  await expect(historyItems().first()).toContainText('整份材料');
  await expect(historyItems().first()).toContainText('样式变更');
});

test('page duplicate and delete', async () => {
  const thumb = page.locator('[data-testid=page-thumb]').first();
  await thumb.hover();
  await thumb.locator('button[title="复制此页"]').click();
  await expect(page.locator('[data-testid=page-thumb]')).toHaveCount(4);
  page.once('dialog', (d) => d.accept());
  const second = page.locator('[data-testid=page-thumb]').nth(1);
  await second.hover();
  await second.locator('[data-testid=page-delete]').click();
  await expect(page.locator('[data-testid=page-thumb]')).toHaveCount(3);
  await expect(historyItems().first()).toContainText('删除页面');
});

test('preview and revert a historical version', async () => {
  const v1 = historyItems().last();
  await v1.locator('button:has-text("预览")').click();
  await expect(page.locator('.preview-banner')).toContainText('v1');
  await page.locator('[data-testid=page-thumb]').nth(1).click();
  await expect(stage().locator('h1')).toHaveText('第2页标题');
  page.once('dialog', (d) => d.accept());
  await page.click('.preview-banner button:has-text("恢复此版本")');
  await expect(page.locator('.preview-banner')).toHaveCount(0);
  await expect(historyItems().first()).toContainText('恢复版本');
  await expect(historyItems().first()).toContainText('恢复到版本 v1');
});

test('export HTML, PDF and PPTX downloads', async () => {
  for (const [label, ext, magic] of [
    ['下载 HTML', 'html', '<!DOCTYPE'],
    ['导出 PDF（矢量', 'pdf', '%PDF'],
    ['导出 PDF（图片', 'pdf', '%PDF'],
    ['导出 PPT', 'pptx', 'PK'],
  ] as const) {
    await page.click('[data-testid=export-btn]');
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), page.click(`.dropdown button:has-text("${label}")`)]);
    expect(dl.suggestedFilename()).toBe(`E2E 模板.${ext}`);
    const file = await dl.path();
    const head = fs.readFileSync(file).subarray(0, 16).toString('latin1');
    expect(head.startsWith(magic)).toBe(true);
  }
});

test('rename project from the editor title', async () => {
  await page.click('.editor-title');
  await page.fill('.name-input', 'E2E 模板 · 改名');
  await page.keyboard.press('Enter');
  await expect(page.locator('.editor-title')).toHaveText('E2E 模板 · 改名');
});

test('create a deck: choose template, describe content, attach materials', async () => {
  await page.goto('/decks');
  await page.click('[data-testid=create-btn]');
  await expect(page.locator('.modal-head')).toContainText('选择模板');
  await expect(page.locator('[data-testid=next-step]')).toBeDisabled();
  await page.locator('[data-testid=template-option]').first().click();
  await page.click('[data-testid=next-step]');
  await page.fill('input[name=name]', 'E2E 路演');
  await expect(page.locator('[data-testid=submit-create]')).toBeDisabled();
  await page.fill('textarea[name=content]', '公司简介、产品、市场、团队、融资计划');
  await page.locator('[data-testid=file-input]').setInputFiles([
    { name: 'facts.txt', mimeType: 'text/plain', buffer: Buffer.from('ARR 1200 万') },
    { name: 'old-deck.pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', buffer: await makePptx(3) },
    { name: 'mood.png', mimeType: 'image/png', buffer: PNG_1x1 },
  ]);
  const list = page.locator('[data-testid=ref-file-list]');
  await expect(list).toContainText('逐页转图片参考');
  await list.locator('li:has-text("mood.png") button:has-text("仅参考")').click();
  await expect(list.locator('li:has-text("mood.png") button.on')).toHaveText('仅参考');
  await page.click('[data-testid=submit-create]');
  await expect(page.locator('[data-testid=page-thumb]')).toHaveCount(3, { timeout: 30_000 });
  await expect(page.locator('.editor-top')).toContainText('模板：E2E 模板 · 改名');
  await page.click('.tabs button:has-text("素材")');
  await expect(page.locator('.asset-list')).toContainText('facts.txt');
  await expect(page.locator('.asset-list li:has-text("old-deck.pptx")')).toContainText('3 页图片');
  await expect(page.locator('.asset-list li:has-text("mood.png")')).toContainText('仅参考');
  deckUrl = page.url();
});

test('a second user edits the same deck and history attributes the change', async () => {
  const url = page.url();
  await page.goto('/decks');
  await logout();
  await login('carol', 'carol123');
  await expect(page.locator('.topnav')).not.toContainText('模型接入');
  await expect(page.locator('.topnav')).not.toContainText('系统更新');
  await page.click('nav >> text=用户管理');
  await expect(page.locator('[data-testid=add-user]')).toHaveCount(0);
  await page.goto(url);
  await stage().locator('p').first().click();
  await page.fill('[data-testid=prompt-input]', 'MARK 段落');
  await page.click('[data-testid=send-btn]');
  await expect(historyItems()).toHaveCount(2, { timeout: 30_000 });
  await expect(historyItems().first()).toContainText('卡罗尔');
  await expect(historyItems().first()).toContainText('第 1 页 · 1 个选中元素');
  await expect(historyItems().last()).toContainText('管理员');
  await page.goto('/models');
  await expect(page).toHaveURL(/\/templates/);
});

test('attach a PPT to an edit from the prompt bar', async () => {
  await page.goto('/decks');
  await logout();
  await login('admin', 'admin123');
  await page.goto(deckUrl);
  await page.locator('[data-testid=attach-input]').setInputFiles({
    name: 'competitor.pptx',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    buffer: await makePptx(2),
  });
  await expect(page.locator('.composer [data-testid=ref-file-list]')).toContainText('competitor.pptx');
  await page.click('[data-testid=scope-seg] button:has-text("整份材料")');
  await page.fill('[data-testid=prompt-input]', '参考附件调整');
  await page.click('[data-testid=send-btn]');
  await expect(page.locator('.composer [data-testid=ref-file-list]')).toHaveCount(0);
  await expect(historyItems()).toHaveCount(3, { timeout: 30_000 });
  await page.click('.tabs button:has-text("素材")');
  await expect(page.locator('.asset-list li:has-text("competitor.pptx")')).toContainText('2 页图片');
});
