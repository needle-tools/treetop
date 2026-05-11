import { mount } from "svelte";
import "./styles/tokens.css";
import App from "./App.svelte";

const target = document.getElementById("app");
if (!target) throw new Error("#app element missing in index.html");

const app = mount(App, { target });

export default app;
