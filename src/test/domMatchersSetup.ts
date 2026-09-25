import * as matchers from "@testing-library/jest-dom/matchers";
import { expect } from "vitest";

declare module "vitest" {
  // Declaration merging requires Vitest's exact type parameters.
  /* eslint-disable @typescript-eslint/no-empty-object-type, @typescript-eslint/no-unused-vars */
  interface Matchers<
    R extends void | Promise<void> = void | Promise<void>,
    T = unknown
  > extends matchers.TestingLibraryMatchers<unknown, R> {}
  /* eslint-enable @typescript-eslint/no-empty-object-type, @typescript-eslint/no-unused-vars */
}

expect.extend(matchers);
