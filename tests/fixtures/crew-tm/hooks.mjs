// Resolves the 'playwright' import of crew/tm.mjs to the stand-in in this folder (tests only).
export async function resolve(specifier, context, next) {
  if (specifier === 'playwright') return { url: new URL('./fake-playwright.mjs', import.meta.url).href, shortCircuit: true }
  return next(specifier, context)
}
