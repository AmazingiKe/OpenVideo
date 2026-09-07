import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { initialize_browser_brand } from "./browser_brand";
import "./styles.css";

initialize_browser_brand(document);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
