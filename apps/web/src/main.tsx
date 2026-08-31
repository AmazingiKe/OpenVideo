import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { read_local_preferences } from "./app/local_preferences";
import { initialize_browser_brand } from "./browser_brand";
import {
  initialize_color_scheme,
  subscribe_color_scheme,
} from "./color_scheme";
import "./styles.css";

const local_preferences = read_local_preferences();
initialize_color_scheme(document, window, local_preferences.color_scheme);
initialize_browser_brand(document);
subscribe_color_scheme(() => initialize_browser_brand(document), document);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
