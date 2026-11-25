/**
 * A refusal: root env files, forbidden base keys, a missing or unknown environment, missing keys
 */
export class EnvironmentError extends Error {
  override name = "EnvironmentError";
}
