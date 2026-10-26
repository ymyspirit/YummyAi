// The browser is independent of the project's unchanged Playwright driver.
// Archive and ELF pins must come from the reviewed Linux reproduction before use.
export const P2_CI_BROWSER_PIN = Object.freeze({
  version: 2,
  driver: Object.freeze({ version: "1.61.1", revision: "1228", browserVersion: "149.0.7827.55",
    registrySha256: "ee39bc924bc3d1bd895626c2910f1292d109bbfeeb5abd113acb45e1951cc942" }),
  sourcePackage: Object.freeze({ name: "playwright-core", version: "1.65.0-alpha-2026-10-23",
    gitHead: "20a2087ea43412b90c172c88faef80786ee18b8b",
    integrity: "sha512-2vqfxKkSB94itSPN4IeJlDiw3Ulsr+FVbqiS7HL2j/lE5gI5T7V7b4HkTG3om6ou35KTie0jaiGdCk3+FCxeKw==",
    url: "https://registry.npmjs.org/playwright-core/-/playwright-core-1.65.0-alpha-2026-10-23.tgz",
    relative: ".artifacts/toolchains/p2-linux-browser-157/source-package",
    registrySha256: "bbf8f51124fb831099d7a75830af240d0556bb56c537b953eb88cdda97c2c49d" }),
  browser: Object.freeze({ name: "chromium-headless-shell", revision: "1251", version: "157.0.8103.6",
    url: "https://cdn.playwright.dev/builds/cft/157.0.8103.6/linux64/chrome-headless-shell-linux64.zip",
    archiveSha256: "191f2a4f36421ae40f49913e3937dbee923071c985b96831f89dd2b51e14624d", archiveBytes: 127477393,
    executableSha256: "7903f2536bf4342e1b1a6f6e64b722713ccfdfeb2fa3d8592acd2ca8e3986630", executableBytes: 210230608 }),
});
