import { mount } from "svelte";
import { windowTitle } from "../../../product";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/popover.css";
import "./styles/agent-row.css";
import "./styles/new-session.css";
import "./styles/source-control.css";
import "./styles/zen-row.css";
import "./styles/overlays.css";
import "./styles/header.css";
import "./styles/diagnostics.css";
import "./styles/worktree-row.css";
import "./styles/wt-picker.css";
import "./styles/notes.css";
import "./styles/file-browser.css";
import CodexReplayLab from "./CodexReplayLab.svelte";

document.title = `${windowTitle(import.meta.env.DEV)} · Replay Lab`;

const target = document.getElementById("app");
if (!target) throw new Error("#app element missing in replay-lab.html");

const app = mount(CodexReplayLab, { target });

export default app;
