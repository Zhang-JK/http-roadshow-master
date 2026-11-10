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

test('the user menu credits the author and links to the GitHub repository', async () => {
  await page.click('[data-testid=user-menu]');
  await expect(page.locator('[data-testid=author]')).toContainText('Author: Zhang Jiekai');
  const link = page.locator('[data-testid=github-link]');
  await expect(link).toHaveAttribute('href', 'https://github.com/Zhang-JK/http-roadshow-master');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link.locator('svg')).toBeVisible();
  await page.click('[data-testid=user-menu]');
  await expect(link).toHaveCount(0);
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
  await expect(page.locator('.panel-card:has(h3:has-text("用户 → 首选接入点"))')).toContainText('admin');
});

test('generation settings default to staged multi-file output within a 200K context', async () => {
  await expect(page.locator('[data-testid=generate-mode]')).toHaveValue('files');
  await expect(page.locator('[data-testid=pages-per-call]')).toHaveValue('3');
  await expect(page.locator('[data-testid=max-tokens]')).toHaveValue('65536');
  await expect(page.locator('[data-testid=context-tokens]')).toHaveValue('200000');
  await page.selectOption('[data-testid=generate-mode]', 'single');
  await expect(page.locator('[data-testid=pages-per-call]')).toHaveCount(0);
  await page.selectOption('[data-testid=generate-mode]', 'files');
  await expect(page.locator('[data-testid=pages-per-call]')).toBeVisible();
  const s = await page.evaluate(() => fetch('/api/settings').then((r) => r.json()));
  expect(s.settings.generateMode).toBe('files');
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
  await expect(page.locator('.toast-success')).toContainText('交付检查通过');
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

test('double-click a text-only element to edit it in place, without the AI; each save is a version in history', async () => {
  await expect(page.locator('[data-testid=page-indicator]')).toHaveText('第 2 / 3 页');
  const count = await historyItems().count();
  const editBar = page.locator('[data-testid=text-edit-bar]');
  const body = stage().locator('p.body').first();
  const title = stage().locator('h1');
  await expect(body).toHaveText('第2页正文内容');

  await body.hover();
  await expect(stage().locator('[data-rs-ui] > div', { hasText: '段落 <p> · 双击改字' })).toBeVisible();

  // Enter saves; Shift+Enter is a line break.
  await body.dblclick();
  await expect(editBar).toBeVisible();
  await expect(body).toHaveAttribute('contenteditable', /plaintext-only|true/);
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('直接改的正文 <b>A&B</b>');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('第二行');
  await page.keyboard.press('Enter');
  await expect(editBar).toHaveCount(0);
  await expect(page.locator('.toast-success', { hasText: `文字已保存（v` })).toBeVisible();
  await expect(historyItems()).toHaveCount(count + 1);
  const top = historyItems().first();
  await expect(top).toContainText('直接改字');
  await expect(top).toContainText('管理员');
  await expect(top).toContainText('第 2 页 · 1 个选中元素');
  await expect(top.locator('[data-testid=hist-text] del')).toHaveText('第2页正文内容');
  expect(await top.locator('[data-testid=hist-text] ins').textContent()).toBe('直接改的正文 <b>A&B</b>\n第二行');
  await expect(top.locator('[data-testid=hist-cost]')).toHaveCount(0);
  await expect(body).not.toHaveAttribute('contenteditable');
  expect(await body.evaluate((el) => el.getAttribute('style'))).toBeNull();
  const projectId = new URL(page.url()).pathname.split('/').pop();
  const saved = async () => (await (await page.request.get(`/api/projects/${projectId}`)).json()).project.doc;
  expect((await saved()).pages[1].html).toMatch(/>直接改的正文 &lt;b&gt;A&amp;B&lt;\/b&gt;<br>第二行<\/p>/);

  // Esc, the bar's cancel button, and emptying the text all leave it as it was.
  await body.dblclick();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('SHOULD-NOT-SAVE');
  await page.keyboard.press('Escape');
  await expect(editBar).toHaveCount(0);
  await expect(body).toHaveText('直接改的正文 <b>A&B</b>第二行');
  await title.dblclick();
  await page.keyboard.type('XX');
  await page.click('[data-testid=text-edit-cancel]');
  await expect(editBar).toHaveCount(0);
  await expect(title).toHaveText('第2页标题');
  await body.dblclick();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Enter');
  await expect(page.locator('.toast-info', { hasText: '文字不能为空' })).toBeVisible();
  await expect(body).toHaveText('直接改的正文 <b>A&B</b>第二行');
  await expect(historyItems()).toHaveCount(count + 1);

  // The 直接改字 button on a selected element, then the bar's save button.
  await title.click();
  await expect(page.locator('[data-testid=scope-chip]')).toHaveText('第 2 页 · 1 个元素');
  await page.click('[data-testid=edit-text-btn]');
  await expect(editBar).toBeVisible();
  await page.keyboard.type(' · 按钮');
  await page.click('[data-testid=text-edit-save]');
  await expect(historyItems()).toHaveCount(count + 2);
  await expect(title).toHaveText('第2页标题 · 按钮');
  await expect(historyItems().first().locator('[data-testid=hist-text] ins')).toHaveText('第2页标题 · 按钮');

  // Clicking somewhere else saves too; a list holds more than text, so it is left to the AI.
  const li = stage().locator('li').first();
  await li.dblclick();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('新要点');
  await title.click();
  await expect(historyItems()).toHaveCount(count + 3);
  await expect(li).toHaveText('新要点');
  await expect(page.locator('[data-testid=edit-text-btn]')).toBeVisible();
  await stage().locator('ul').dispatchEvent('dblclick');
  await expect(page.locator('.toast-info', { hasText: '不能直接改字' })).toBeVisible();
  await expect(editBar).toHaveCount(0);
  await expect(page.locator('.sel-chip')).toContainText('列表');
  await expect(page.locator('[data-testid=edit-text-btn]')).toHaveCount(0);
  await page.click('button:has-text("取消选择")');

  // Someone else changed the same text meanwhile: nothing is overwritten and the stage shows their text.
  await body.dblclick();
  await page.keyboard.type(' 我的');
  const pageId = (await saved()).pages[1].id;
  const eid = await body.getAttribute('data-eid');
  const other = await page.request.put(`/api/projects/${projectId}/pages/${pageId}/elements/${eid}/text`, { data: { text: '别人改的正文' } });
  expect(other.ok()).toBe(true);
  await page.keyboard.press('Enter');
  await expect(page.locator('.toast-error', { hasText: '文字没有保存' })).toContainText('别人改的正文');
  await expect(body).toHaveText('别人改的正文');
  await expect(historyItems()).toHaveCount(count + 4);
});

test('export HTML, PDF and PPTX downloads', async () => {
  for (const [label, ext, magic] of [
    ['下载 HTML', 'html', '<!DOCTYPE'],
    ['导出 PDF（矢量', 'pdf', '%PDF'],
    ['导出 PDF（图片', 'pdf', '%PDF'],
    ['导出 PPT', 'pptx', 'PK'],
    ['下载源文件', 'zip', 'PK'],
  ] as const) {
    await page.click('[data-testid=export-btn]');
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), page.click(`.dropdown button:has-text("${label}")`)]);
    expect(dl.suggestedFilename()).toBe(`E2E 模板.${ext}`);
    const file = await dl.path();
    const head = fs.readFileSync(file).subarray(0, 16).toString('latin1');
    expect(head.startsWith(magic)).toBe(true);
  }
});

test('files tab shows README, styles and pages; README edits become a version', async () => {
  await page.click('[data-testid=tab-files]');
  const items = page.locator('[data-testid=file-item]');
  await expect(items).toHaveCount(6);
  await expect(items.nth(0)).toContainText('README.md');
  await expect(items.nth(1)).toContainText('styles/theme.css');
  await expect(items.nth(3)).toContainText('pages/cover.html');
  await expect(page.locator('[data-testid=file-content]')).toContainText('MOCK-README-NEED');
  await expect(page.locator('[data-testid=file-content]')).toContainText('## 页面规划');

  await items.nth(4).click();
  await expect(page.locator('[data-testid=file-content]')).toContainText('第2页标题');
  await page.locator('[data-testid=page-thumb]').first().click();
  await page.click('button:has-text("定位到此页")');
  await expect(page.locator('[data-testid=page-indicator]')).toHaveText('第 2 / 3 页');

  await items.nth(0).click();
  await page.click('[data-testid=readme-edit]');
  await page.fill('[data-testid=readme-text]', '# E2E 模板\n\n## 风格约定\n- 主色：墨绿 E2E-README');
  await page.click('[data-testid=readme-save]');
  await expect(page.locator('[data-testid=file-content]')).toContainText('E2E-README', { timeout: 10_000 });
  await page.click('.tabs button:has-text("修改历史")');
  await expect(historyItems().first()).toContainText('编辑 README');
  await expect(historyItems().first()).toContainText('README 更新');
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

test('attach an HTML deck as a page-by-page reference', async () => {
  await page.goto(deckUrl);
  const html = `<html><head><style>.slide{width:1280px;height:720px}</style></head><body>${[1, 2, 3]
    .map((i) => `<section class="slide"><h1>网页参考 ${i}</h1></section>`)
    .join('')}</body></html>`;
  await page.locator('[data-testid=attach-input]').setInputFiles({ name: 'old-site.html', mimeType: 'text/html', buffer: Buffer.from(html) });
  await expect(page.locator('.composer [data-testid=ref-file-list] li:has-text("old-site.html")')).toContainText('逐页转图片参考');
  await page.click('[data-testid=scope-seg] button:has-text("整份材料")');
  await page.fill('[data-testid=prompt-input]', '参考网页调整');
  await page.click('[data-testid=send-btn]');
  await expect(historyItems()).toHaveCount(4, { timeout: 30_000 });
  await expect(page.locator('.toast-success')).toContainText('修改已应用（自检：未修改；交付检查通过）');
  await page.click('.tabs button:has-text("素材")');
  await expect(page.locator('.asset-list li:has-text("old-site.html")')).toContainText('3 页图片');
});

test('the AI asks a question during generation; answering on the card resumes it', async () => {
  await page.goto('/templates');
  await page.click('[data-testid=create-btn]');
  await page.fill('input[name=name]', '提问模板');
  await page.fill('textarea[name=style]', '简约');
  await page.fill('textarea[name=notes]', 'ASK_ME');
  await page.click('[data-testid=submit-create]');
  await expect(page).toHaveURL(/\/p\//);
  const url = page.url();
  const card = page.locator('[data-testid=question-card]');
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.locator('[data-testid=question-text]')).toHaveText('MOCK-QUESTION 面向谁？');
  await expect(card).toContainText('AI 提问');
  await expect(page.locator('[data-testid=question-pill]')).toBeVisible();
  await page.goto('/templates');
  await expect(page.locator('[data-testid=project-card]:has-text("提问模板") [data-testid=asking-badge]')).toBeVisible();
  await page.goto(url);
  await page.locator('[data-testid=question-option]:has-text("投资人")').click();
  await expect(card).toHaveCount(0);
  await expect(page.locator('[data-testid=page-thumb]')).toHaveCount(3, { timeout: 30_000 });
  await page.click('[data-testid=tab-files]');
  await expect(page.locator('[data-testid=file-content]')).toContainText('ASK-RESULT 用户回答：「投资人」');
});

test('an element edit changes the selection, then asks before changing the same thing on other pages', async () => {
  await page.click('.tabs button:has-text("修改历史")');
  await page.locator('[data-testid=page-thumb]').nth(1).click();
  await stage().locator('h1').click();
  await expect(page.locator('[data-testid=scope-chip]')).toHaveText('第 2 页 · 1 个元素');
  await page.fill('[data-testid=prompt-input]', 'SIMILAR 标题改成红色');
  await page.click('[data-testid=send-btn]');
  const card = page.locator('[data-testid=question-card]');
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card).toContainText('修改范围');
  await expect(card.locator('[data-testid=question-text]')).toContainText('MOCK-SIMILAR 其他页面也有同样的标题');
  await expect(card.locator('[data-testid=question-option]')).toHaveText(['全部修改', '只改选中的']);
  await card.locator('[data-testid=question-option]:has-text("全部修改")').click();
  await expect(historyItems()).toHaveCount(2, { timeout: 30_000 });
  await expect(stage().locator('h1')).toHaveText('SIMILAR-DONE');
  await expect(page.locator('[data-testid=page-thumb]').nth(0).frameLocator('iframe').locator('h1')).toHaveText('SIMILAR-DONE');
  await expect(page.locator('[data-testid=page-thumb]').nth(2).frameLocator('iframe').locator('h1')).toHaveText('SIMILAR-DONE');
});

test('history shows the time, tokens and output speed of each AI change; the progress line shows tokens live', async () => {
  await page.goto(deckUrl);
  await page.click('.tabs button:has-text("修改历史")');
  const before = await historyItems().count();
  await page.click('[data-testid=scope-seg] button:has-text("整份材料")');
  await page.fill('[data-testid=prompt-input]', '统一一下字号');
  await page.click('[data-testid=send-btn]');
  await expect(page.locator('.job-item [data-testid=job-progress]')).toContainText(/输入 [\d,]+ \/ 输出 [\d,]+ tokens/, { timeout: 20_000 });
  await expect(historyItems()).toHaveCount(before + 1, { timeout: 30_000 });
  const cost = historyItems().first().locator('[data-testid=hist-cost]');
  await expect(cost).toContainText(/耗时 [\d.]+ 秒 · \d+ 次调用 · 输入 [\d,]+ \/ 输出 [\d,]+ tokens/);
  // The first version was generated with streamed pages, so its output speed is known.
  await expect(historyItems().last().locator('[data-testid=hist-cost]')).toContainText('tok/s');
});

test('a failed edit stays in the history, and another user retries it', async () => {
  await page.goto(deckUrl);
  await page.click('.tabs button:has-text("修改历史")');
  const versions = await historyItems().count();
  await page.click('[data-testid=scope-seg] button:has-text("整份材料")');
  await page.fill('[data-testid=prompt-input]', 'FAIL_ONCE 标题加粗');
  await page.click('[data-testid=send-btn]');
  const failed = page.locator('[data-testid=history-failed]');
  await expect(failed).toHaveCount(1, { timeout: 30_000 });
  await expect(failed).toContainText('FAIL_ONCE 标题加粗');
  await expect(failed).toContainText('model overloaded');
  await expect(failed).toContainText('管理员');
  await expect(failed.locator('[data-testid=hist-cost]')).toContainText('2 次调用');
  await expect(page.locator('.toast-error')).toContainText('已记入修改历史');
  await expect(page.locator('.tabs')).toContainText('1 失败');

  await page.goto('/decks');
  await logout();
  await login('carol', 'carol123');
  await page.goto(deckUrl);
  await expect(failed.locator('[data-testid=retry-btn]')).toBeVisible();
  await failed.locator('[data-testid=retry-btn]').click();
  await expect(failed.locator('[data-testid=retried]')).toHaveText('已重试');
  await expect(failed.locator('[data-testid=retry-btn]')).toHaveCount(0);
  await expect(historyItems()).toHaveCount(versions + 1, { timeout: 30_000 });
  await expect(historyItems().first()).toContainText('卡罗尔');
  await expect(historyItems().first()).toContainText('FAIL_ONCE 标题加粗');
  await expect(page.locator('.tabs')).not.toContainText('失败');
});

test('the dashboard marks a project being edited; admins follow live and past sessions', async () => {
  await page.goto('/decks');
  await logout();
  await login('admin', 'admin123');
  await page.goto(deckUrl);
  const deckName = (await page.locator('.editor-title').textContent())!.trim();
  await page.click('[data-testid=scope-seg] button:has-text("整份材料")');
  await page.fill('[data-testid=prompt-input]', 'ASK_ME 会话测试');
  await page.click('[data-testid=send-btn]');
  await expect(page.locator('[data-testid=question-card]')).toBeVisible({ timeout: 30_000 });

  await page.goto('/decks');
  const card = page.locator(`[data-testid=project-card]:has-text("${deckName}")`);
  await expect(card.locator('[data-testid=busy-badge] .spinner')).toBeVisible();
  await expect(page.locator('[data-testid=busy-badge]')).toHaveCount(1);

  await page.click('[data-testid=nav-sessions]');
  await expect(page.locator('[data-testid=live-count]')).toHaveText('1');
  const row = page.locator('[data-testid=session-row]');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('ASK_ME 会话测试');
  await expect(row).toContainText('等待回答：MOCK-QUESTION');
  await expect(row).toContainText(deckName);
  await expect(row).toContainText(/Mock LLM|Backup/);
  await row.click();
  await expect(page.locator('[data-testid=session-call]').first()).toContainText('成功');

  await page.goto(deckUrl);
  await page.locator('[data-testid=question-option]:has-text("蓝色")').click();
  await expect(page.locator('[data-testid=question-card]')).toHaveCount(0);
  await expect(historyItems().first()).toContainText('ASK_ME 会话测试', { timeout: 30_000 });
  await page.goto('/decks');
  await expect(page.locator('[data-testid=busy-badge]')).toHaveCount(0);

  await page.click('[data-testid=nav-sessions]');
  await expect(page.locator('[data-testid=live-count]')).toHaveText('0');
  await page.click('[data-testid=sessions-history]');
  const done = page.locator('[data-testid=session-row]:has-text("ASK_ME 会话测试")');
  await expect(done).toContainText('完成');
  await expect(page.locator('[data-testid=session-row]:has-text("FAIL_ONCE")')).toHaveCount(2);
  await expect(page.locator('[data-testid=session-row]:has-text("FAIL_ONCE"):has-text("model overloaded")')).toContainText('失败');
  await expect(page.locator('[data-testid=session-row]:has-text("FAIL_ONCE"):has-text("已保存")')).toContainText('重试');
  await expect(page.locator('[data-testid=session-row]').last()).toContainText('tok/s');
  await done.click();
  await expect(page.locator('[data-testid=session-call]').nth(1)).toBeVisible();
});

test('model access page shows usage with output speed above the user assignments, and the parallel limit', async () => {
  await page.click('nav >> text=模型接入');
  const usage = page.locator('[data-testid=usage-card]');
  await expect(usage).toBeVisible();
  const usageTop = (await usage.boundingBox())!.y;
  const assignTop = (await page.locator('h3:has-text("用户 → 首选接入点")').boundingBox())!.y;
  expect(usageTop).toBeLessThan(assignTop);
  await expect(usage.locator('[data-testid=model-stats-row]').first()).toContainText('Mock LLM');
  await expect(usage.locator('[data-testid=model-speed]', { hasText: 'tok/s' }).first()).toBeVisible();
  const row = page.locator('[data-testid=endpoint-row]').first();
  await expect(row.locator('[data-testid=endpoint-concurrency]')).toHaveText('0 / 不限');
  await row.locator('button:has-text("编辑")').click();
  await page.fill('[data-testid=ep-max-concurrency]', '2');
  await page.click('[data-testid=save-endpoint]');
  await expect(row.locator('[data-testid=endpoint-concurrency]')).toHaveText('0 / 2');
});

test('an endpoint can bypass the system proxy; the parallel test sends up to 5 requests at once and sets the limit', async () => {
  const row = page.locator('[data-testid=endpoint-row]').first();
  await row.locator('button:has-text("编辑")').click();
  await expect(page.locator('[data-testid=ep-use-proxy]')).toBeChecked();
  await expect(page.locator('[data-testid=proxy-hint]')).toContainText('服务器未配置系统代理');
  await page.click('.modal button:has-text("取消")');

  // As if the server ran behind a proxy: a local model address gets a warning until the endpoint connects directly.
  const list = '**/api/llm/endpoints';
  await page.route(list, async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), systemProxy: 'http://***@proxy.corp:8080' } });
  });
  await page.reload();
  await row.locator('button:has-text("编辑")').click();
  await expect(page.locator('[data-testid=proxy-hint]')).toContainText('经过代理 http://***@proxy.corp:8080');
  await expect(page.locator('[data-testid=proxy-local-warning]')).toBeVisible();
  await page.uncheck('[data-testid=ep-use-proxy]');
  await expect(page.locator('[data-testid=proxy-local-warning]')).toHaveCount(0);
  await page.click('[data-testid=save-endpoint]');
  await expect(row.locator('[data-testid=endpoint-direct]')).toHaveText('直连');
  await expect(page.locator('[data-testid=endpoint-direct]')).toHaveCount(1);
  await page.unroute(list);

  await row.locator('[data-testid=parallel-test]').click();
  const dialog = page.locator('.modal:has-text("并发测试 · Mock LLM")');
  await expect(dialog.locator('[data-testid=parallel-running]')).toBeVisible();
  await expect(row.locator('[data-testid=parallel-test]')).toBeDisabled();
  await expect(dialog.locator('[data-testid=parallel-result]')).toContainText('5 个请求都能同时处理', { timeout: 30_000 });
  const levels = dialog.locator('[data-testid=parallel-level]');
  await expect(levels).toHaveCount(5);
  await expect(levels.nth(4)).toContainText('5 / 5');
  await expect(levels.filter({ hasText: '✓ 并行' })).toHaveCount(5);
  await expect(dialog).toContainText('当前并发上限：2');
  await expect(dialog.locator('[data-testid=apply-parallel]')).toHaveText('将并发上限设为 不限');
  await dialog.locator('[data-testid=apply-parallel]').click();
  await expect(dialog).toHaveCount(0);
  await expect(row.locator('[data-testid=endpoint-concurrency]')).toHaveText('0 / 不限');
  await expect(row.locator('[data-testid=endpoint-direct]')).toHaveText('直连');
});

test('a model that never writes the style files: generation carries on and the delivery check has them written', async () => {
  await page.goto('/templates');
  await page.click('[data-testid=create-btn]');
  await page.fill('input[name=name]', '缺样式模板');
  await page.fill('textarea[name=style]', '简约');
  await page.fill('textarea[name=notes]', 'NO_CSS');
  await page.click('[data-testid=submit-create]');
  await expect(page).toHaveURL(/\/p\//);
  await expect(page.locator('[data-testid=page-thumb]')).toHaveCount(3, { timeout: 60_000 });
  await expect(page.locator('.toast-success')).toContainText('交付检查通过（修复 1 轮）');
  await page.click('[data-testid=tab-files]');
  await expect(page.locator('[data-testid=files-panel]')).toContainText('styles/theme.css');
  await page.locator('[data-testid=file-item]:has-text("theme.css")').click();
  await expect(page.locator('[data-testid=file-content]')).toContainText('CHECK-WROTE-STYLES');
});

test('errors the model never fixes fail the generation after three fix rounds, with the problems listed', async () => {
  await page.goto('/templates');
  await page.click('[data-testid=create-btn]');
  await page.fill('input[name=name]', '修不好的模板');
  await page.fill('textarea[name=style]', '简约');
  await page.fill('textarea[name=notes]', 'BAD_IMG CHECK_STUBBORN');
  await page.click('[data-testid=submit-create]');
  await expect(page).toHaveURL(/\/p\//);
  await expect(page.locator('.gen-state h2')).toHaveText('生成失败', { timeout: 60_000 });
  await expect(page.locator('.gen-state .error-box')).toContainText('交付检查 4 次未通过（已交回模型修复 3 次）');
  await expect(page.locator('.gen-state .error-box')).toContainText('图片无法加载');
  await expect(page.locator('[data-testid=regenerate-btn]')).toBeVisible();
  await expect(page.locator('.gen-state')).toContainText('已失败 1 次');
});
