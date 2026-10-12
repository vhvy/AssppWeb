// Type shim for the module built by scripts/unicorn-wasm-patch/build.sh.
declare const UnicornModuleFactory: (
  config?: Record<string, unknown>,
) => Promise<unknown>;
export default UnicornModuleFactory;
