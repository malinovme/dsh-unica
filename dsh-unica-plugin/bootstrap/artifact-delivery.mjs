/** An explicit profile setting overrides the environment in the native bridge. */
export function resolveArtifactDelivery(configured) {
  const mode = configured ?? process.env.UNICA_ARTIFACT_DELIVERY ?? 'background'
  if (!['background', 'eager', 'off'].includes(mode)) {
    throw new Error(`invalid artifactDelivery (UNICA_ARTIFACT_DELIVERY): ${JSON.stringify(mode)}; expected background, eager or off`)
  }
  return mode
}
