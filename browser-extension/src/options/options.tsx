import React from "react";
import { createRoot } from "react-dom/client";
import { Form } from "./Form.js";

const root = document.getElementById("root");
if (root) createRoot(root).render(<Form />);
