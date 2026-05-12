import { mount } from "svelte";
import "./styles/tokens.css";
import App from "./App.svelte";

// Distinguish the dev tab from the prod tab in the browser. Bookmark
// suggestions and the tab title both surface this text, so two browser
// bookmarks named "supergit" / "supergit-dev" stay visually correct.
// `import.meta.env.DEV` is Vite's compile-time flag — true under
// `vite` (port 7779), false in the production `bun run start` build.
document.title = import.meta.env.DEV ? "supergit · dev" : "supergit";

const target = document.getElementById("app");
if (!target) throw new Error("#app element missing in index.html");

const app = mount(App, { target });

export default app;
