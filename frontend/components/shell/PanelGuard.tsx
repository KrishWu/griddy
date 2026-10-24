"use client";
// Error boundary around each panel, so one module's bad data (e.g. a null where a
// number was expected) shows an error card instead of blanking the whole app.
// SHARED (foundation). AppShell keys it on the latest result, so the next Run resets it.
import { catchError, type ErrorInfo } from "next/error";

import { Panel } from "./Panel";

function PanelError(props: { name: string }, { error, reset }: ErrorInfo) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <Panel title={props.name}>
      <p className="text-xs text-red-600">
        {props.name} failed: {message}
      </p>
      <button className="mt-2 text-xs underline" onClick={() => reset()}>
        Try again
      </button>
    </Panel>
  );
}

export const PanelGuard = catchError(PanelError);
