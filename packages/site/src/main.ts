import { mount } from "svelte";
import App from "./App.svelte";
import "@supergit/ui/styles/tokens.css";
import "@supergit/ui/styles/base.css";
import "@supergit/ui/styles/popover.css";
import "@supergit/ui/styles/agent-row.css";
import "@supergit/ui/styles/worktree-row.css";
import "@supergit/ui/styles/wt-picker.css";
import "@supergit/ui/styles/notes.css";
import "@supergit/ui/styles/zen-row.css";
import "./app.css";

const app = mount(App, { target: document.getElementById("app")! });

export default app;
