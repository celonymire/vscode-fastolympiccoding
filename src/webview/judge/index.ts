import App from "./App.svelte";
import { mount } from "svelte";

const root = document.getElementById("root");
if (root) {
  mount(App, { target: root });
}
