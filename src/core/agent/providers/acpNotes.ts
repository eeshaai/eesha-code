/**
 * Session notes the provider keeps for ACP extensions - see
 * `AcpAgentSession.noteForExtensions` and `AcpExtensionTurn.noted`. A
 * file of its own so an extension can read the key without importing
 * the provider.
 */

/** The feature flags (`EngineSettings.features`) the session was opened with. */
export const ENGINE_FEATURES = "engine.features";
