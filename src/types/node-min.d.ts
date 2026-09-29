// The two Node functions `ipcContract.test.ts` needs to read commands.rs and
// ipc.ts off disk, declared here rather than pulling in @types/node.
//
// The alternative was adding a dependency and re-running `npm install` on the
// Windows machine for two function signatures. tsconfig's `types` is a closed
// list on purpose; this keeps it that way.
//
// `theme.test.ts` reads a file the same way and used to carry a
// `@ts-expect-error` for it. With these declarations that suppression is no
// longer needed, so it is gone.
declare module "node:fs" {
  export function readFileSync(path: string, encoding: string): string;
  /** `menuCoverage.test.ts` walks src/ looking for registrations. */
  export function readdirSync(path: string): string[];
  export function statSync(path: string): { isDirectory(): boolean };
}

declare module "node:path" {
  export function resolve(...parts: string[]): string;
  export function join(...parts: string[]): string;
}
