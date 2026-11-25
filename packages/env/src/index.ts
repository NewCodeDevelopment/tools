export type { Color, EnvConfig, EnvironmentConfig } from "./lib/config";
export { env } from "./lib/config";
export type { Environment } from "./lib/environment";
export {
  confirmEnvironment,
  currentEnvironment,
  listEnvironments,
  loadEnvironment,
} from "./lib/environment";
export { EnvironmentError } from "./lib/errors";
