import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

test("command URL hover preserves horizontal scrolling and remains clickable", { timeout: 30000 }, async () => {
  const uiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const fixture = await mkdtemp(join(uiRoot, "test/.command-row-"));
  const component =
    process.env.TREETOP_COMMAND_ROW_TEST_COMPONENT ||
    "/src/OpenInActions.svelte";
  let server;
  let browser;
  try {
    await writeFile(
      join(fixture, "index.html"),
      '<div id="app"></div><script type="module" src="./main.ts"></script>',
    );
    await writeFile(
      join(fixture, "main.ts"),
      `import { mount } from 'svelte'; import Harness from './Harness.svelte'; mount(Harness, {target: document.getElementById('app')});`,
    );
    await writeFile(
      join(fixture, "Harness.svelte"),
      `
      <script>
        import Actions from '${component}';
        import '/src/styles/tokens.css';
        import '/src/styles/base.css';
        import '/src/styles/worktree-row.css';
        let active = new Set(["0"]);
        const links = [
          ...Array.from({length: 18}, (_, i) => ({id: String(i), kind: 'command', name: 'Server command ' + i, cmd: 'npm run dev'})),
          ...Array.from({length: 12}, (_, i) => ({id: 'app-' + i, kind: 'url', name: 'App ' + i, url: 'https://example.com/app/' + i})),
        ];
      </script>
      <div style="width:500px; margin:40px">
        <Actions path="/test/project" customLinks={links} runningCommandIds={new Set(links.map(link => link.id))}
          commandUrls={{'12':['http://localhost:3000', 'http://localhost:3001'], '13':['http://localhost:4000']}}
          onEditCustomLink={() => {}}
          openIn={() => {}} openRemote={() => {}} />
      </div>
      <div style="width:900px; margin:40px">
        <Actions path="/test/project" customLinks={[...links.slice(0, 2), ...links.slice(18)]}
          openIn={() => {}} openRemote={() => {}} />
      </div>
      <div class="row-status" style="width:510px; margin:40px; box-sizing:border-box">
        <span style="flex:none">● 2</span>
        <Actions path="/test/project" customLinks={[...links.slice(0, 2), ...links.slice(18)]}
          openIn={() => {}} openRemote={() => {}} />
      </div>
      <div class="row-status" style="width:1380px; margin:40px; box-sizing:border-box">
        <span style="flex:none">●</span>
        <Actions path="/test/project" customLinks={links.slice(0, 2)}
          editors={[{name:'VSCode', cmd:'vscode'}]}
          remotes={[{name:'origin', provider:'github', url:'https://github.com/example/repo', webUrl:'https://github.com/example/repo'}]}
          onAddCustomLink={() => {}} onEditCustomLink={() => {}} openIn={() => {}} openRemote={() => {}} />
      </div>
      <div class="row-status" style="width:613px; margin:40px; box-sizing:border-box">
        <Actions path="/test/project" customLinks={[
          {id:'pwa', kind:'command', name:'dev:pwa', cmd:'npm run dev:pwa'},
          {id:'pub', kind:'command', name:'chrome:pub', cmd:'npm run chrome:pub'}
        ]}
          editors={[{name:'VSCode', cmd:'vscode'}]}
          onAddCustomLink={() => {}} onEditCustomLink={() => {}} openIn={() => {}} openRemote={() => {}} />
      </div>
      <div class="pending-command-fixture" style="width:500px; margin:40px">
        <Actions path="/test/project" customLinks={[{id:'build-pending',kind:'command',name:'Build pending',cmd:'bun run build'}]}
          onCommandClick={() => { window.commandClicks = (window.commandClicks || 0) + 1; return new Promise(resolve => { window.finishCommand = resolve; }); }}
          openIn={() => {}} openRemote={() => {}} />
      </div>
      <div class="overflow-command-fixture" style="width:500px; margin:40px">
        <Actions path="/test/project" customLinks={links.slice(0,18)} runningCommandIds={active}
          onCommandClick={link => { active = new Set([...active,link.id]); }}
          openIn={() => {}} openRemote={() => {}} />
      </div>
      <style>:global(.custom-link-wrap) {flex-shrink:0} :global(.custom-link-btn) {white-space:nowrap}</style>
    `,
    );
    server = await createServer({
      root: uiRoot,
      configFile: false,
      cacheDir: join(fixture, ".vite"),
      resolve: {
        alias: { "@treetop/nicifier": resolve(uiRoot, "../nicifier/src/index.ts") },
      },
      plugins: [svelte()],
      server: { host: "127.0.0.1", port: 0 },
      logLevel: "error",
    });
    await server.listen();
    const address = server.httpServer!.address();
    assert(address && typeof address !== "string");
    browser = await chromium.launch({
      channel: process.platform === "win32" ? "msedge" : "chrome",
      headless: true,
    });
    const page = await browser.newPage();
    await page.route("**/api/**", (route) => route.fulfill({ json: {} }));
    await page.goto(
      `http://127.0.0.1:${address.port}/test/${fixture.split(/[\\/]/).pop()}/index.html`,
    );
    const row = page.locator(".command-actions").first();
    const apps = page.locator(".app-actions").first();
    await row.waitFor();
    const fittingCommands = await page.locator(".command-actions").nth(1).evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));
    assert(fittingCommands.scrollWidth <= fittingCommands.clientWidth,
      "commands that fit should not acquire a scrollbar when apps overflow");
    const narrowCommands = await page.locator(".command-actions").nth(2).evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));
    assert(narrowCommands.scrollWidth <= narrowCommands.clientWidth,
      "commands should use the available width of a real worktree status row");
    const screenshotRow = page.locator(".row-status").nth(1);
    const screenshotCommands = await screenshotRow.locator(".command-actions").evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));
    assert(screenshotCommands.scrollWidth <= screenshotCommands.clientWidth,
      "the add button and built-in apps must leave both commands fully visible");
    const editableChip = screenshotRow.locator(".command-actions .custom-link-wrap").last();
    await editableChip.hover();
    const chipWidths = await editableChip.evaluate(el => ({
      wrap: el.getBoundingClientRect().width,
      button: el.querySelector(".custom-link-btn")!.getBoundingClientRect().width,
    }));
    assert(Math.abs(chipWidths.wrap - chipWidths.button) < 1,
      "editing must not reserve extra space beside command buttons");
    const editBounds = await screenshotRow.locator(".command-actions").evaluate((el) => ({
      clipTop: el.getBoundingClientRect().top,
      pencilTop: el.querySelector(".custom-link-edit")!.getBoundingClientRect().top,
      clipBottom: el.getBoundingClientRect().bottom,
      pencilBottom: el.querySelector(".custom-link-edit")!.getBoundingClientRect().bottom,
    }));
    assert(editBounds.pencilTop >= editBounds.clipTop,
      "hovered edit pencil must stay inside the command scrollport");
    assert(editBounds.pencilBottom <= editBounds.clipBottom,
      "hovered edit pencil must not extend below the command scrollport");
    const aligned = await screenshotRow.evaluate((el) => ({
      rowRight: el.getBoundingClientRect().right - parseFloat(getComputedStyle(el).paddingRight),
      actionsRight: el.querySelector(".row-actions")!.getBoundingClientRect().right,
    }));
    assert(Math.abs(aligned.rowRight - aligned.actionsRight) < 1,
      "the complete action strip should remain right-aligned");
    const buttonsRight = await screenshotRow.locator(".app-actions").evaluate(el =>
      el.lastElementChild!.getBoundingClientRect().right);
    assert(Math.abs(aligned.rowRight - buttonsRight) < 1,
      "app buttons should end at the right edge of the available row");
    const available = await screenshotRow.evaluate(el => {
      const style = getComputedStyle(el);
      const leading = el.firstElementChild as HTMLElement;
      const actions = el.querySelector(".row-actions")!;
      return {
        expectedLeft: leading.getBoundingClientRect().right + parseFloat(style.columnGap),
        actualLeft: actions.getBoundingClientRect().left,
      };
    });
    assert(Math.abs(available.actualLeft - available.expectedLeft) < 1,
      "command actions must use all row space after the leading status, without a blank left margin");
    const smallScreenshotCommands = await page.locator(".row-status").nth(2).locator(".command-actions").evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));
    assert(smallScreenshotCommands.scrollWidth <= smallScreenshotCommands.clientWidth,
      "two short commands must fit ahead of overflowing app buttons");
    assert.equal(await apps.locator(".custom-link-wrap").count(), 12);
    assert.equal(await row.locator(".custom-link-wrap").count(), 18);
    const appShare = await apps.evaluate((el) => el.clientWidth / el.parentElement!.clientWidth);
    assert(appShare >= 0.25,
      "long command lists must leave useful space for app actions");
    const tops = await page.locator(".row-actions").first().evaluate((el) => ({
      command: el.querySelector(".command-actions")!.firstElementChild!.getBoundingClientRect().top,
      app: el.querySelector(".app-actions")!.firstElementChild!.getBoundingClientRect().top,
    }));
    assert(Math.abs(tops.command - tops.app) < 1,
      "command and app buttons should align even when their scrollbars differ");
    const appOverflow = await apps.evaluate((el) => el.scrollWidth > el.clientWidth);
    assert(appOverflow, "app group should overflow independently");
    await apps.evaluate((el) => (el.scrollLeft = 100));
    assert.equal(await row.evaluate((el) => el.scrollLeft), 0);
    const appsBefore = await apps.evaluate((el) => el.scrollLeft);
    for (const number of [12, 13]) {
      const icon = page
        .locator(".custom-link-wrap")
        .nth(number)
        .locator(".cmd-url-inner");
      await icon.evaluate((el) =>
        el.scrollIntoView({ inline: "center", block: "nearest" }),
      );
      const before = await row.evaluate((el) => ({
        scroll: el.scrollLeft,
        width: el.scrollWidth,
      }));
      assert(before.scroll > 0, "fixture must be horizontally scrolled");
      const bounds = await icon.boundingBox();
      assert(bounds);
      await page.mouse.move(
        bounds.x + bounds.width / 2,
        bounds.y + bounds.height / 2,
      );
      await page.waitForTimeout(400);
      const after = await row.evaluate((el) => ({
        scroll: el.scrollLeft,
        width: el.scrollWidth,
      }));
      const clickTarget = await icon.evaluate(el => {
        const bounds = el.getBoundingClientRect();
        return document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)?.closest(".cmd-url-inner") === el;
      });
      assert(clickTarget, "hover-revealed edit pencil must not cover the command URL open button");
      assert.deepEqual(
        after,
        before,
        "hover must preserve scroll offset and extent",
      );
      assert.equal(await apps.evaluate((el) => el.scrollLeft), appsBefore);
      const hovered = await icon.boundingBox();
      assert(hovered);
      assert.equal(
        hovered.x,
        bounds.x,
        "URL button must stay under the cursor",
      );
      const opened = page.waitForRequest("**/api/open-default");
      await page.mouse.click(
        bounds.x + bounds.width / 2,
        bounds.y + bounds.height / 2,
      );
      const request = await opened;
      assert.equal(
        request.postDataJSON().path,
        number === 12 ? "http://localhost:3000" : "http://localhost:4000",
      );
      if (number === 12) {
        const choice = page.getByRole("button", {
          name: "localhost:3001",
          exact: true,
        });
        await choice.waitFor({ state: "visible" });
        const selected = page.waitForRequest("**/api/open-default");
        await choice.click();
        const next = await selected;
        assert.equal(next.postDataJSON().path, "http://localhost:3001");
      }
      await page.mouse.move(0, 0);
      await page.waitForTimeout(350);
    }
    await page.locator(".row-actions").first().evaluate((el) => {
      el.parentElement!.style.width = "6000px";
    });
    await page.waitForFunction(() => {
      const strips = document.querySelectorAll(".row-actions .command-actions, .row-actions .app-actions");
      return [...strips].slice(0, 2).every((el) => el.scrollWidth <= el.clientWidth);
    });
    const pendingBuild = page.locator(".pending-command-fixture .custom-link-btn");
    await pendingBuild.click();
    assert.equal(await pendingBuild.getAttribute("aria-busy"), "true");
    assert.equal(await pendingBuild.isDisabled(), true);
    await pendingBuild.evaluate((button: HTMLButtonElement) => button.click());
    assert.equal(await page.evaluate(() => (window as any).commandClicks), 1);
    await page.evaluate(() => (window as any).finishCommand());
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>(".pending-command-fixture .custom-link-btn")!.disabled);
    assert.equal(await pendingBuild.getAttribute("aria-busy"), "false");
    for (const strip of [row, apps]) {
      const size = await strip.evaluate((el) => ({
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
      }));
      assert(size.scrollWidth <= size.clientWidth, "fitting actions should have no scrollbar");
    }
    const overflow = page.locator(".overflow-command-fixture");
    const more = overflow.getByRole("button", {name:"Commands",exact:true});
    await more.waitFor();
    const gaps = await overflow.evaluate(el => ({
      row: getComputedStyle(el.querySelector('.row-actions')!).columnGap,
      chips: getComputedStyle(el.querySelector('.command-actions')!).columnGap,
    }));
    assert.equal(gaps.row,gaps.chips,'Add, running commands and Commands must use the same chip spacing');
    assert.equal(await overflow.locator(".command-actions .custom-link-animate:visible").count(),1);
    assert(await overflow.getByRole("button",{name:"Server command 0",exact:true}).isVisible());
    const placement = await overflow.evaluate(el => ({
      commandsRight: el.querySelector('.command-actions')!.getBoundingClientRect().right,
      menuLeft: el.querySelector('.command-overflow-anchor')!.getBoundingClientRect().left,
      appsLeft: el.querySelector('.app-actions')!.getBoundingClientRect().left,
      commandTop: el.querySelector('.command-actions .custom-link-btn')!.getBoundingClientRect().top,
      triggerTop: el.querySelector('.command-overflow-anchor button')!.getBoundingClientRect().top,
      appTop: el.querySelector('.app-actions button')!.getBoundingClientRect().top,
      triggerHeight: el.querySelector('.command-overflow-anchor button')!.getBoundingClientRect().height,
      appHeight: el.querySelector('.app-actions button')!.getBoundingClientRect().height,
    }));
    assert(placement.menuLeft >= placement.commandsRight && placement.menuLeft < placement.appsLeft,
      'More commands belongs between the command chips and app buttons');
    assert(Math.abs(placement.triggerTop-placement.commandTop)<1 && Math.abs(placement.triggerTop-placement.appTop)<1,
      'More commands must share the top alignment of the command and app chips');
    assert(Math.abs(placement.triggerHeight-placement.appHeight)<.5,
      'Commands trigger height must match neighboring app chips');
    await more.hover();
    const menu = page.getByRole("menu",{name:"Project commands",exact:true});
    await menu.waitFor();
    assert.equal(await menu.getByRole("menuitem").count(),17);
    assert.equal(await menu.locator('.custom-link-wrap .custom-link-btn').count(),17,
      'The dropdown must reuse actual command chips');
    assert.equal(await menu.getByRole('menuitem',{name:'Server command 0',exact:true}).count(),0,
      'Running commands are already inline and must not be duplicated in the dropdown');
    const grid = await menu.evaluate(el => ({columns:getComputedStyle(el).gridTemplateColumns.split(' ').length,
      widths:[el.scrollWidth,el.clientWidth]}));
    assert.equal(grid.columns,3,'Wide dropdowns should arrange idle chips in three columns');
    assert(grid.widths[0]<=grid.widths[1],'Grid chips must not introduce horizontal scrolling');
    assert(grid.widths[1]<600,'Short command chips should produce compact content-sized columns');
    const centered = await more.evaluate(trigger => {
      const button = trigger.getBoundingClientRect();
      const menu = document.querySelector('.command-overflow-menu')!.getBoundingClientRect();
      return Math.abs(menu.left - Math.max(8,Math.min((button.left+button.right-menu.width)/2,innerWidth-menu.width-8)))<1;
    });
    assert(centered,'Dropdown should center under its trigger and clamp to the viewport');
    const chipStyle = await menu.getByRole('menuitem',{name:'Server command 1',exact:true}).evaluate(el => {
      const inline = document.querySelector('.overflow-command-fixture .custom-link-btn')!;
      const a = getComputedStyle(el), b = getComputedStyle(inline);
      return {same:a.backgroundColor === b.backgroundColor && a.borderRadius === b.borderRadius && a.padding === b.padding,
        hasIcon:!!el.querySelector('.open-in-icon')};
    });
    assert(chipStyle.same && chipStyle.hasIcon,'Menu chips must retain inline styling and icons');
    if (process.env.TREETOP_COMMAND_OVERFLOW_SCREENSHOT) await page.screenshot({path:process.env.TREETOP_COMMAND_OVERFLOW_SCREENSHOT});
    await menu.getByRole("menuitem",{name:"Server command 3",exact:true}).click();
    await overflow.getByRole("button",{name:"Server command 3",exact:true}).waitFor();
    assert.equal(await menu.count(),0);
    await more.focus();
    await more.press("ArrowDown");
    await menu.waitFor();
    assert.equal(await menu.getByRole('menuitem',{name:'Server command 3',exact:true}).count(),0);
    await page.setViewportSize({width:700,height:800});
    assert.equal(await menu.evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length),2);
    await page.setViewportSize({width:390,height:800});
    assert.equal(await menu.evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length),1);
    const mobileBounds = await menu.boundingBox();
    assert(mobileBounds && mobileBounds.x>=7 && mobileBounds.x+mobileBounds.width<=383,'Mobile popover must stay on screen');
    await page.setViewportSize({width:1280,height:720});
    await page.keyboard.press("Escape");
    assert.equal(await menu.count(),0);
    await overflow.evaluate(el => (el as HTMLElement).style.width="6000px");
    await more.waitFor({state:"hidden"});
    assert.equal(await overflow.locator(".command-actions .custom-link-animate:visible").count(),18);
  } finally {
    await browser?.close();
    await server?.close();
    await rm(fixture, { recursive: true, force: true });
  }
});
