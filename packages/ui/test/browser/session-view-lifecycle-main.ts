import { mount } from "svelte";
import "../../src/styles/tokens.css";
import "../../src/styles/base.css";
import "../../src/styles/popover.css";
import "../../src/styles/header.css";
import SessionViewLifecycleHarness from "./SessionViewLifecycleHarness.svelte";

const target = document.getElementById("app");
if (!target) throw new Error("#app element missing");

mount(SessionViewLifecycleHarness, { target });
