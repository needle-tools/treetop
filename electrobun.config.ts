export default {
  app: {
    name: "Supergit",
    identifier: "tools.needle.supergit",
    version: "0.1.0",
  },
  build: {
    bun: {
      entrypoint: "src/electrobun/index.ts",
    },
    mac: {
      icons: "icon.iconset",
    },
  },
};
