"use client";

export function PublicEnv() {
  return (
    <table>
      <tbody>
        <tr>
          <th>NEXT_PUBLIC_APP_ENV</th>
          <td>{process.env.NEXT_PUBLIC_APP_ENV ?? "not set"}</td>
        </tr>
      </tbody>
    </table>
  );
}
