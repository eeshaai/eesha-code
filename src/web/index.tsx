// First, before anything that reaches the chat view: the chat view calls
// `serverApi()` the moment its code loads, and this defines it.
import "./bridge";

import React from "react";
import { createRoot } from "react-dom/client";

import "../view/theme.scss";
import "./page.scss";
import "./frame.scss";

import App from "./App";
import { dropUnfilledFontSize } from "./theme";

dropUnfilledFontSize();

createRoot(document.getElementById("root")!).render(<App />);
