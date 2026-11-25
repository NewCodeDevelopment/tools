import { currentEnvironment, listEnvironments, loadEnvironment } from "@newcode-team/env";
import { PublicEnv } from "./public-env";

// Read the env on every request, not once at build time
export const dynamic = "force-dynamic";

// The keys the fake env files set. Only fake values live in this app, so they're shown
const keys = ["APP_ENV", "APP_NAME", "DATABASE_URL", "NEXT_PUBLIC_APP_ENV"];

function Rows({ values }: { values: Record<string, string | undefined> }) {
  return keys.map((key) => (
    <tr key={key}>
      <th>{key}</th>
      <td className={values[key] === undefined ? "missing" : undefined}>
        {values[key] ?? "not set"}
      </td>
    </tr>
  ));
}

export default async function Page() {
  const environment = await loadEnvironment();

  return (
    <main>
      <h1>NewCode tools playground</h1>

      <h2>process.env</h2>
      <p>What the server got from the command that started it, e.g. newenv next dev.</p>
      <table>
        <tbody>
          <Rows values={process.env} />
        </tbody>
      </table>

      <h2>loadEnvironment()</h2>
      <p>
        What the script API reads from the files right now. Switch with{" "}
        <code>pnpm env:use staging</code> and reload: this changes, process.env doesn&apos;t.
      </p>
      <table>
        <tbody>
          <tr>
            <th>currentEnvironment()</th>
            <td>{currentEnvironment()}</td>
          </tr>
          <tr>
            <th>listEnvironments()</th>
            <td>{listEnvironments().join(", ")}</td>
          </tr>
          <tr>
            <th>files</th>
            <td>{environment.files.join(", ")}</td>
          </tr>
          <Rows values={environment.values} />
        </tbody>
      </table>

      <h2>Client</h2>
      <p>NEXT_PUBLIC_ values are inlined when the page is compiled.</p>
      <PublicEnv />
    </main>
  );
}
