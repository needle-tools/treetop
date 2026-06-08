import { expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  DEFAULT_APP_BUNDLE_ID,
  DEFAULT_APP_NAME,
  defaultAppPathFor,
} from "../../../scripts/build-launch";

test("build:launch defaults to the Treetop electrobun artifact names", () => {
  expect(DEFAULT_APP_NAME).toBe("Treetop");
  expect(DEFAULT_APP_BUNDLE_ID).toBe("tools.needle.supergit");
  expect(defaultAppPathFor("darwin", "arm64")).toBe(
    resolve("build/stable-macos-arm64/Treetop.app"),
  );
  expect(defaultAppPathFor("darwin", "x64")).toBe(
    resolve("build/stable-macos-x64/Treetop.app"),
  );
  expect(defaultAppPathFor("win32", "x64")).toBe(
    resolve("build/stable-win-x64/Treetop.exe"),
  );
  expect(defaultAppPathFor("linux", "x64")).toBe(
    resolve("build/stable-linux-x64/Treetop"),
  );
});
