import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { initialize_browser_brand } from "./browser_brand";
import {
  initialize_color_scheme,
  subscribe_color_scheme,
} from "./color_scheme";
import "./styles.css";

initialize_color_scheme(document, window);
initialize_browser_brand(document);
subscribe_color_scheme(() => initialize_browser_brand(document), document);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
