// Global test setup: jest-dom matchers + DOM cleanup between tests.
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { useFileFormat } from "../lib/region";

afterEach(() => {
  cleanup();
  // A test that set a home currency or region must not leave it for the next.
  useFileFormat.getState().reset();
  // TmIcon injects the SVG sprite once into <body>; drop it so each test
  // starts from a clean document.
  document.getElementById("tm-icon-sprite")?.remove();
});
