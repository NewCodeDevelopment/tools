// Tries the script API: loads every environment from the files, without newenv in front
import * as newenv from "@newcode-team/env";

console.log(`current: ${newenv.currentEnvironment()}`);

for (const name of newenv.listEnvironments()) {
  const environment = await newenv.loadEnvironment(name);
  environment.require("DATABASE_URL");
  const keys = Object.keys(environment.values).sort().join(", ");
  console.log(`${name}: ${environment.files.join(" + ")} -> ${keys}`);
}
