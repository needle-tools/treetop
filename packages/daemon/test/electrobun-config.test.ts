import { describe, expect, test } from "bun:test";
import electrobunConfig from "../../../electrobun.config";

describe("electrobun config", () => {
  test("mac native app keeps WebKit and declares microphone permission for voice", () => {
    expect(electrobunConfig.build.mac.bundleCEF).not.toBe(true);
    expect(electrobunConfig.build.mac.defaultRenderer ?? "native").toBe(
      "native",
    );
    expect(electrobunConfig.build.mac.entitlements).toMatchObject({
      "com.apple.security.device.audio-input":
        "Treetop uses the microphone for global voice mode.",
    });
  });
});
