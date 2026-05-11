import App from "./App.svelte";

const target = document.getElementById("app");
if (!target) throw new Error("#app element missing in index.html");

const app = new App({ target });

export default app;
