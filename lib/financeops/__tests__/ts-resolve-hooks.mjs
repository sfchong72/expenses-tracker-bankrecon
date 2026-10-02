// Test-only module resolution hook. Repo source uses extensionless relative imports (like the rest of
// the app, resolved by the bundler); Node's built-in test runner needs a real file name. This hook
// retries an extensionless relative specifier with ".ts". It is loaded only by `npm run test:financeops`
// (via register-ts.mjs) so no repo-wide compiler/bundler setting has to change for test convenience.
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    const relative = specifier.startsWith("./") || specifier.startsWith("../");
    if (relative && !/\.[a-z]+$/i.test(specifier) && error && error.code === "ERR_MODULE_NOT_FOUND") {
      return nextResolve(`${specifier}.ts`, context);
    }
    throw error;
  }
}
