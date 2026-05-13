import { mount } from "svelte";
import "./styles/tokens.css";
import "./styles/popover.css";
import App from "./App.svelte";

// Distinguish the dev tab from the prod tab in the browser. Bookmark
// suggestions and the tab title both surface this text, so two browser
// bookmarks named "supergit" / "supergit-dev" stay visually correct.
// `import.meta.env.DEV` is Vite's compile-time flag — true under
// `vite` (port 7779), false in the production `bun run start` build.
document.title = import.meta.env.DEV ? "supergit · dev" : "supergit";

// Block browser back navigation (trackpad swipe, back button, Cmd+[).
// supergit is a single-screen dashboard; "going back" lands on whatever
// the user was on before, which is never what they want here. Seed one
// extra history entry and re-push on every popstate so the back gesture
// is a no-op.
history.pushState(null, "", location.href);
window.addEventListener("popstate", () => {
  history.pushState(null, "", location.href);
});

const target = document.getElementById("app");
if (!target) throw new Error("#app element missing in index.html");

const app = mount(App, { target });

export default app;
