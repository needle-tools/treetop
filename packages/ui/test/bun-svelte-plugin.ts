import { plugin } from "bun";
import { compileModule } from "svelte/compiler";

const transpiler = new Bun.Transpiler({ loader: "ts" });

plugin({
  name: "svelte-module",
  setup(build) {
    build.onLoad({ filter: /\.svelte\.ts$/ }, async (args) => {
      const source = await Bun.file(args.path).text();
      const js = transpiler.transformSync(source);
      const result = compileModule(js, {
        filename: args.path,
        dev: true,
      });
      return { contents: result.js.code, loader: "js" };
    });
  },
});
