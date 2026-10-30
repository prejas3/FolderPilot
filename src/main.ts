import { invoke } from "@tauri-apps/api/core";
import "./style.css";

// ponytail: placeholder until the UI card; proves the command bridge works.
invoke<unknown[]>("list_rules").then((rules) => {
  document.querySelector("#status")!.textContent = `${rules.length} rules`;
});
